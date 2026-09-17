// ============================================================
// js/session.js - 远程控制会话状态机（主控 / 被控 两种角色共用一个实现）
//
//   它负责的事：
//     · 建立与服务器的连接（create / join），维护房间与角色
//     · 主控：把本地"期望状态"广播给被控，带 rev 版本号、重传退避、心跳保活
//     · 被控：校验并应用状态（波形指纹校验 + 分片重组），回 ACK 捎带自身状态
//     · 双向：延迟与时钟偏差测量（2 秒一次）
//     · 被控：失联判定（8 秒）→ 立即调用 onFailSafeStop（安全底线）
//
//   设计约束（照计划）：
//     · 停机逻辑全部在被控端本地执行；服务器只负责通知主控离开
//     · ACK 捎带"被控蓝牙状态 + 实际输出 + 时钟参考"，不额外开遥测通道
//     · 一切收到的数据都要过 protocol.validate() 才能使用
// ============================================================
(function () {
  'use strict';
  var W = window.WC = window.WC || {};
  var P = W.protocol, L = W.link;
  var B = P.B, T = P.T, LIM = P.LIMITS;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function wallMs() { return Date.now(); }

  // opts:
  //   role        'master' | 'slave'
  //   transport   'broadcast' | 'websocket' | 'loopback'
  //   room        房间号（websocket 时由服务器分配或加入）
  //   url         服务器地址（websocket 时必填）
  //   peerId      本端标识
  //   onStatus(info)        状态变化（界面用）
  //   onApplyState(state)   被控侧：请把状态应用到本地引擎
  //   onFailSafeStop(reason)被控侧：失联/主控离开 → 必须立即停机
  //   onPeerStop(reason)    主控侧：被控请求急停
  //   onPeerResume(reason)  主控侧：被控解除了急停锁定（主控据此恢复勾选）
  //   onLog(level, msg)     诊断日志

  // "已解锁"消息的重发节奏：每 400ms 一次，最多 6 次。
  //   它不是状态同步（不参与 digest），丢了只影响主控界面能否重新勾选，
  //   所以用轻量重发 + 收到 ACK 即停，不引入新的确认协议。
  var RESUME_RESEND_MS = 400;
  var RESUME_MAX_TRIES = 6;

  function Session(opts) {
    opts = opts || {};
    this.role = opts.role === P.ROLE.MASTER ? P.ROLE.MASTER : P.ROLE.SLAVE;
    this.isMaster = this.role === P.ROLE.MASTER;
    this.transportKind = opts.transport || 'broadcast';
    this.url = opts.url || '';
    this.room = opts.room || '';
    this.peerId = opts.peerId || ('p' + Math.random().toString(36).slice(2, 8));

    this.conn = null;
    this.opened = false;
    this.peerOnline = false;
    this.closedByUs = false;

    this.rev = 0;                     // 主控：本地状态版本；被控：已生效版本
    this.state = P.newState();        // 主控：期望状态
    this.lastSentDigest = '';         // 主控：当前在重传的那份状态摘要
    this.lastSentRev = 0;
    this.ackRev = -1;                 // 被控已确认到的版本
    this.sentAt = 0;
    this.retryIdx = 0;
    this.inflight = false;

    this.knownWaves = {};             // fp → payload（被控：收到的；主控：已确认对端拥有的）
    this._pendingWaves = {};          // fp → payload（主控：待发送的波形）
    this._dirty = false;
    this.lastSentWaves = [];          // 上一版状态里带了哪些波形
    this.assembler = P.ChunkAssembler();

    this.clock = new W.Clocksync();
    this.lastPeerMsgAt = 0;           // 被控：最后一次收到主控业务消息的时刻
    this.lastMasterBeatAt = 0;

    this.peerInfo = { ble: 'unknown', out: { a: 0, b: 0 }, err: 0, rtt: null };
    this.selfInfo = { ble: 'unknown', out: { a: 0, b: 0 }, err: 0 };
    this.net = { selfRtt: null, peerRtt: null, drift: null, stable: false };
    // 主控在状态里捎带下来的时钟偏差（被控侧用来显示，仅作兜底）
    this._masterClockOffset = null;
    this.syncState = 'idle';          // idle | syncing | confirmed | resending | lost
    this.error = '';

    this.timers = { tick: null, retry: null, probe: null };
    this._queuedAck = null;           // 排队待处理的确认（防止与发送状态写入交错）
    this.handlers = opts;
  }

  // ============================================================
  // 对外接口
  // ============================================================
  Session.prototype.start = function () {
    var self = this;
    var kind = this.transportKind;

    if (kind === 'websocket') {
      this.conn = L.Websocket.open({
        url: this.url,
        onOpen: function () { self.opened = true; self._onOpen(); },
        onMessage: function (m) { self._onServerMsg(m); },
        onClose: function (reason, code) { self._onClosed(reason, code); },
        onError: function (e) { self.error = e; self._emit(); }
      });
    } else if (kind === 'loopback') {
      var p = L.Loopback.pair();
      this.conn = p[0];
      this._externalPair = p[1];
      var c = this.conn;
      c.onOpen = function () { self.opened = true; self._onOpen(); };
      c.onMessage = function (m) { self._onServerMsg(m); };
      c.onClose = function (r) { self._onClosed(r); };
    } else {
      // Broadcast：房间号即频道，直接当"已在房间里"处理
      var room = this.room || ('local' + Math.floor(Math.random() * 900000 + 100000));
      this.room = room;
      this.conn = L.Broadcast[kind === 'broadcast' ? 'create' : 'create'](room, { peerId: this.peerId });
      var cc = this.conn;
      cc.onOpen = function () {
        self.opened = true;
        // ⚠ 这里**不能**直接 self.peerOnline = true：
        //   BroadcastChannel 没有"对方进来了"这种事件，onOpen 只代表自己的频道开好了，
        //   房间里完全可能只有自己一个标签页。之前无条件置真，导致被控端刚点「创建房间」
        //   就跳到 live、向导被隐藏，房间号一闪而过且没有退路。
        //   现在 peerOnline 一律由真实消息驱动：收到对端 HELLO / 状态 / 保活时才置真。
        self._startTimers();
        self._sendHello();
        self._emit();
      };
      cc.onMessage = function (m) { self._onServerMsg(m); };
      cc.onClose = function (r) { self._onClosed(r); };
    }

    this.lastPeerMsgAt = nowMs();
    return this;
  };

  // lingerMs：延迟这么久再真正关闭连接。
  //   给"最后一条消息"留出送出的时间 —— BroadcastChannel 是异步派发的，
  //   同步 send 之后立刻 close()，那条消息可能还没被其它标签页收到就被丢弃了。
  Session.prototype.stop = function (reason, lingerMs) {
    this.closedByUs = true;
    this._stopTimers();
    var self = this, conn = this.conn;
    var doClose = function () { try { if (conn) conn.close(); } catch (e) { } };
    if (lingerMs > 0) setTimeout(doClose, lingerMs); else doClose();
    this.opened = false;
    this.peerOnline = false;
    this.syncState = 'idle';
    this._emit();
  };

  Session.prototype.isOpen = function () { return this.opened; };
  Session.prototype.getRoom = function () { return this.room; };
  Session.prototype.getPeerId = function () { return this.peerId; };

  // 对端是否"刚重新初始化过"（收到过它的 HELLO）。
  //   主控据此判断：之前发出去的那一版状态不能算数了，应当补推一次。
  //   读取即清除，避免同一次恢复被重复补推。
  Session.prototype.takePeerResumed = function () {
    if (!this.peerResumed) return false;
    this.peerResumed = false;
    return true;
  };

  // ---------- 主控侧：改状态 ----------
  // patch.chan: { A: {enabled,intensity,phase,waveKey}, B: {...} }
  // patch.running: bool
  Session.prototype.setState = function (patch) {
    if (!this.isMaster) return;
    var s = this.state, i, names = ['A', 'B'];
    if (patch && patch.chan) {
      for (i = 0; i < 2; i++) {
        var n = names[i], src = patch.chan[n];
        if (!src) continue;
        if (typeof src.enabled === 'boolean') s.ch[n].enabled = src.enabled;
        if (typeof src.intensity === 'number') s.ch[n].intensity = P.clamp(src.intensity, 0, 2);
        if (typeof src.phase === 'number') s.ch[n].phase = P.clamp(src.phase, 0, 1);
        if (typeof src.waveKey === 'string') s.ch[n].waveKey = src.waveKey;
      }
    }
    if (patch && typeof patch.running === 'boolean') {
      if (patch.running && !s.running) s.beatKey = nowMs();   // 起播时刻（主控时钟）
      s.running = patch.running;
    }
    this.rev++;
    s.rev = this.rev;
    this._markDirty();
    return this.rev;
  };

  // 主控侧：登记一个"需要发给被控"的波形（由界面在选波形时提供）
  Session.prototype.offerWave = function (wave) {
    if (!this.isMaster || !wave) return null;
    var payload = P.wavePayload(wave);
    if (!payload) return null;
    this._pendingWaves = this._pendingWaves || {};
    // 只在"对端还没确认拥有"时才需要带上
    if (!this.knownWaves[payload.fp]) this._pendingWaves[payload.fp] = payload;
    return payload.fp;
  };

  // 主控侧：本地状态快照（供界面显示"我要同步什么"）
  Session.prototype.getState = function () { return P.clone(this.state); };

  // 被控侧：向主控上报自身真实状态（蓝牙/输出/错误），会附带在下一条 ACK 或心跳里
  Session.prototype.reportSelf = function (info) {
    if (this.isMaster || !info) return;
    if (typeof info.ble === 'string') this.selfInfo.ble = info.ble;
    if (info.out && typeof info.out.a === 'number' && typeof info.out.b === 'number') {
      this.selfInfo.out.a = Math.round(P.clamp(info.out.a, -LIM.AMP_LIMIT, LIM.AMP_LIMIT));
      this.selfInfo.out.b = Math.round(P.clamp(info.out.b, -LIM.AMP_LIMIT, LIM.AMP_LIMIT));
    }
    if (typeof info.err === 'number') this.selfInfo.err = info.err;
    // 立即回一次 ACK，让主控尽快看到最新状态（不额外增加消息类型）
    this._sendAck();
  };

  // 被控侧：本地急停（最高优先级，会进入锁定）
  Session.prototype.requestStop = function (reason) {
    this._send(P.stop(reason || 'local-stop'));
  };

  // ============================================================
  // 连接与服务器消息
  // ============================================================
  Session.prototype._onOpen = function () {
    if (this.transportKind === 'websocket') {
      // 被控创建房间，主控凭房间号加入
      if (this.isMaster) this.conn.send(L.msgJoin(this.room));
      else this.conn.send(L.msgCreate());
    }
    this._startTimers();
    this._emit();
  };

  Session.prototype._onClosed = function (reason, code) {
    this.opened = false;
    this.peerOnline = false;
    this._stopTimers();
    var was = this.syncState;
    this.syncState = 'lost';
    this._emit();
    // 被控：连接断了就必须停机（安全底线，不依赖任何远端通知）
    if (!this.isMaster && !this.closedByUs && was !== 'idle') {
      this._failSafe('transport-closed' + (reason ? ':' + reason : ''));
    }
  };

  Session.prototype._onServerMsg = function (msg) {
    // 与发送侧同一个原则：有没有 relay 信封由**连接**决定（见 link.js 的 needsEnvelope）。
    //   WebSocket → 收到的是 {t:'relay', payload} 或服务器事件，需要解析信封
    //   Broadcast / Loopback → 收到的直接就是业务消息，没有信封可解
    if (this.conn && !this.conn.needsEnvelope) return this._onBusiness(msg);

    var m = L.parseServer(msg);
    if (!m) return this._log('warn', 'drop malformed server msg');

    switch (m.t) {
      case T.CREATED:
        this.room = m.room;
        this.opened = true;
        this._sendHello();
        this._emit();
        break;
      case T.JOINED:
        this.room = m.room;
        this.opened = true;
        this.peerOnline = true;
        this._sendHello();
        this._emit();
        break;
      case T.PEER:
        this.peerOnline = (m.event === 'joined');
        if (m.event === 'left') {
          this.syncState = 'lost';
          this._emit();
          // 被控：主控离开 → 立即停机（计划里明确要求由被控端执行）
          if (!this.isMaster) this._failSafe('master-left');
        } else {
          if (this.isMaster) this._markDirty();   // 对端回来了，立刻重推状态
          this._emit();
        }
        break;
      case T.RELAY:
        // 服务器补的时间戳可用于估算本端↔服务器延迟
        if (typeof m.s === 'number') this._noteServerStamp(m.s);
        this._handleRelay(m.payload);
        break;
      case T.PONG:
        this._onPong(m);
        break;
      case T.ERROR:
        this.error = m.code;
        this.syncState = 'idle';
        this._emit();
        break;
    }
  };

  // 本端 ↔ 服务器 往返延迟（用自己发的 ping 的 c 与服务器回的 s 估算不了单向，
  // 所以这里只记录服务器时间戳用于其它用途；真正 RTT 由 ping 的往返测出）
  Session.prototype._noteServerStamp = function (s) {
    this._lastServerStamp = s;
  };

  // ============================================================
  // 业务消息
  // ============================================================
  Session.prototype._onBusiness = function (msg) {
    var err = P.validate(msg);
    if (err) return this._log('warn', 'drop invalid business msg: ' + err);

    switch (msg.t) {
      case B.HELLO:
        this.peerOnline = true;
        if (this.isMaster) {
          this._markDirty();
          // 对端发来 HELLO = 它刚（重新）初始化过 —— 之前那一版状态是否送达已不作数，
          //   必须让界面重新补推一次。否则会出现这种死局：
          //     被控掉线 → 心跳超时进入安全停机 → 恢复后主控自认为 syncState 仍是
          //     confirmed，于是只发保活；而保活**不带状态**，被控的解锁只发生在
          //     收到 state 的时候 → 被控永远停在"临时停机"，用户必须手动改个参数才恢复。
          this.peerResumed = true;
        }
        // 对端打招呼 = 链路活着 → 清掉失联标记
        this._notePeerAlive();
        this._emit();
        break;

      case B.KEEPALIVE:
        this.lastPeerMsgAt = nowMs();
        if (!this.isMaster) {
          this.ackRev = Math.max(this.ackRev, msg.rev);
          this._sendAck();
          if (this.syncState === 'lost') this.syncState = 'syncing';
        }
        // 收到对端的保活 = 链路活着 → 清掉失联标记，允许将来再次触发安全停机
        this._notePeerAlive();
        this._emit();
        break;

      case B.STATE:
        if (this.isMaster) return;                 // 被控才处理状态
        this._onMasterState(msg);
        break;

      case B.ACK:
        // 被控侧也要看一眼：主控会在 ACK 里捎带"已收到你的解锁消息"的确认，
        //   被控据此停止重发。除这一项外，被控不参与 ACK 状态机（下面立刻 return）。
        if (!this.isMaster) {
          if (msg.ackResume) {
            this._clearResumePending();
            this.lastPeerMsgAt = nowMs();
            this.peerOnline = true;
          }
          return;
        }
        this.lastPeerMsgAt = nowMs();
        this.peerOnline = true;
        this.peerInfo.ble = msg.ble;
        this.peerInfo.out.a = msg.out.a;
        this.peerInfo.out.b = msg.out.b;
        this.peerInfo.err = msg.err;
        // 被控端上报的"被控↔服务器"延迟 + 它当时的墙上时间（可粗估端到端单向）
        if (typeof msg.rtt === 'number') {
          this.net.peerRtt = msg.rtt;
          this._peerRttWall = msg.wall;
        }
        // 排队而不是立刻处理：这样 ACK 一定发生在 _pump 写完发送状态之后。
        // 否则当 ACK 同步到达（BroadcastChannel 很常见）时，会被 _pump 的写入覆盖，
        // 造成"永远在重传"的假象。
        this._queuedAck = msg;
        break;

      case B.STOP:
        // 被控请求急停 → 主控必须立即配合（主控界面自己归零，并锁定不允许再开）
        if (this.isMaster && typeof this.handlers.onPeerStop === 'function') {
          try { this.handlers.onPeerStop(msg.reason); } catch (e) { }
        }
        this._emit();
        break;

      case B.BYE:
        // 主控主动告别（退出远程 / 关闭页面）→ 被控立即安全停机，不必等 8 秒心跳超时。
        // 复用既有的 master-left 停机路径，语义完全一致（对端不在了，必须停）。
        if (!this.isMaster) this._failSafe('master-left');
        this._emit();
        break;

      case B.RESUME:
        // 被控解除了急停锁定 → 主控必须同步解除自己的锁定，否则通道复选框会一直是灰的。
        //   （主控无法自行解除急停锁定，这是安全设计；所以只能由被控明确告知。）
        if (this.isMaster) {
          if (typeof this.handlers.onPeerResume === 'function') {
            try { this.handlers.onPeerResume(msg.reason); } catch (e) { }
          }
          this._sendResumeAck();           // 主动回一条确认，让被控停止重发
        }
        this._emit();
        break;
    }
  };

  // 被控侧：告知主控"急停已解除"。
  //   用「发到确认为止」的方式，避免这条关键消息在链路刚恢复时被丢掉 ——
  //   丢了的话主控会一直停在锁定状态，用户看到的就是"复选框点不动"。
  Session.prototype.sayResume = function (reason) {
    if (this.isMaster || !this.opened) return false;
    var msg = P.resume(reason || 'slave-unlock');
    var ok = this._send(msg);
    if (ok) this._resumePending = msg;
    return ok;
  };

  // 主控确认已收到 resume（ACK 里带 ackResume 标记）
  Session.prototype._clearResumePending = function () {
    this._resumePending = null;
    this._resumeSentAt = 0;
    this._resumeTries = 0;
  };

  // 主控主动告别：在断开连接之前先把"我走了"发出去，
  // 让被控立刻停机，而不是白等一个心跳超时周期。
  Session.prototype.sayBye = function (reason) {
    if (!this.isMaster || !this.opened) return false;
    return this._send(P.bye(reason || 'master-bye'));
  };

  // 中继载荷 → 业务消息。
  //   ⚠ 收到的 payload 不是业务消息本身，而是**分片信封** {c,i,n,d}：
  //     发送侧 _send() 用 P.chunk() 包装，小消息是 {c:1,i:0,n:1,d:{业务消息}}，
  //     大消息会切成多片 {c:1,i:k,n:N,d:"JSON 片段"}。
  //     所以必须先过 ChunkAssembler 取出 d（必要时拼回完整 JSON），再交给 _onBusiness。
  //   曾经这里直接把信封当业务消息传下去，结果是 msg.t 为 undefined，
  //   被 validate() 判为 'no-type' 全部丢弃 —— 表现就是 WebSocket 模式下
  //   房间能建、能互相看到在线，但业务消息一条都过不去（主控永远"同步中"）。
  //   本地调试走 BroadcastChannel（needsEnvelope=false）不经过信封，所以一直没暴露。
  Session.prototype._handleRelay = function (payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!this.assembler) { this._onBusiness(payload); return; }

    var r;
    try { r = this.assembler.push(payload); }
    catch (e) { r = { error: 'assembler-threw' }; }

    if (r && r.error) {
      this._log('warn', 'relay chunk rejected: ' + r.error);
      return;
    }
    if (!r || !r.done) return;                 // 还有分片没到齐，继续等
    if (r.msg) this._onBusiness(r.msg);
  };

  Session.prototype._sendHello = function () {
    this._send(P.hello(this.role));
  };

  Session.prototype._send = function (businessMsg) {
    if (!this.conn || !this.conn.isOpen()) return false;
    // 要不要 relay 信封由**连接**决定（见 link.js 的 needsEnvelope）：
    //   真实 WebSocket → 需要（前面有服务器拆）
    //   Broadcast / Loopback → 不需要（点对点直连，没有中间人）
    // 不能用 transportKind 去猜 —— 测试用的 Loopback 声明成 broadcast 时曾经踩过坑。
    if (!this.conn.needsEnvelope) {
      return this.conn.send(businessMsg);
    }
    var parts = P.chunk(businessMsg);
    if (!parts) return false;                      // 太大（调用方应报错）
    var ok = true;
    for (var i = 0; i < parts.length; i++) {
      if (!this.conn.send(L.msgRelay(parts[i]))) ok = false;
    }
    return ok;
  };

  // ============================================================
  // 主控侧：状态广播 + 重传 + 心跳
  // ============================================================
  Session.prototype._markDirty = function () {
    this._dirty = true;
  };

  Session.prototype._buildSendState = function () {
    var s = this.state;
    var out = {
      rev: s.rev, running: s.running, beatKey: s.beatKey,
      ch: { A: P.clone(s.ch.A), B: P.clone(s.ch.B) },
      waves: {}
    };
    // 捎带"只有主控才知道"的两个诊断值，供被控端界面显示：
    //   psr = 主控↔服务器 往返延迟（服务器不会替主控广播这个数）
    //   pco = 时钟偏差（被控时钟 − 主控时钟），由主控的时钟探测算出
    // 它们**不参与 digest**（digestOf 只取 rev/running/各通道），所以不影响 ACK 比对；
    // 它们也不进 this.state，两端状态对象结构保持一致。
    if (typeof this.net.selfRtt === 'number') out.psr = Math.round(this.net.selfRtt);
    if (this.clock.lastResult && typeof this.clock.lastResult.offset === 'number') {
      out.pco = Math.round(this.clock.lastResult.offset);
    }
    // 只带对端尚未确认拥有的波形
    var pend = this._pendingWaves || {};
    for (var fp in pend) {
      if (!pend.hasOwnProperty(fp)) continue;
      if (this.knownWaves[fp]) continue;
      out.waves[fp] = pend[fp];
    }
    return out;
  };

  Session.prototype._pump = function () {
    if (!this.isMaster || !this.opened) return;
    var t = nowMs();

    // 该发状态了吗？—— 有变化，或有未确认的波形，或还在等 ACK
    var needSend = this._dirty || this.inflight;
    if (!needSend) return;
    if (this.inflight && (t - this.sentAt) < this._retryDelay()) return;

    var payload = this._buildSendState();
    payload.t = B.STATE;
    var digest = P.digestOf(payload);
    payload.digest = digest;

    if (this._send(payload)) {
      this.sentAt = t;
      this.inflight = true;
      this.lastSentRev = payload.rev;
      this.lastSentDigest = digest;
      // 记住这一版都带了哪些波形 —— 收到 ACK 后这些就可以记为"对端已拥有"
      this.lastSentWaves = Object.keys(payload.waves || {});
      this._dirty = false;
      this.syncState = 'syncing';
      this._emit();
    }
    // ⚠ 注意：绝不能在这里之后再处理 ACK。
    //   ACK 必须是"排队到下一个 tick"处理的（见 _onBusiness 里的 _queuedAck），
    //   否则如果 ACK 在 _send 内部同步到达，上面这几行写入会把"已确认"覆盖掉，
    //   导致主控永远认为还在重传。（仿真里已经复现过这个 bug）
  };

  Session.prototype._retryDelay = function () {
    var arr = LIM.RETRY_MS;
    var i = Math.min(this.retryIdx, arr.length - 1);
    return arr[i];
  };

  // 收到 ACK：比对摘要，一致才停止重传
  Session.prototype._onAck = function (msg) {
    var okRev = (msg.seq >= this.lastSentRev);
    var okDigest = (msg.digest === this.lastSentDigest);
    if (okRev && okDigest) {
      this.inflight = false;
      this.retryIdx = 0;
      this.syncState = 'confirmed';
      this.ackRev = msg.seq;
      // 对端已确认收到这一版 → 这一版带过去的波形它就有了，之后不再重传
      var sentWaves = this.lastSentWaves || [];
      for (var i = 0; i < sentWaves.length; i++) this.knownWaves[sentWaves[i]] = true;
    } else {
      // 版本或摘要不一致 → 继续重传，并退避
      this.retryIdx = Math.min(this.retryIdx + 1, LIM.RETRY_MS.length - 1);
      this.inflight = true;
      this._dirty = true;
      this.syncState = 'resending';
    }
    this._emit();
  };

  Session.prototype._sendKeepalive = function () {
    if (!this.isMaster || !this.opened) return;
    this._send(P.keepalive(this.rev, this.lastSentDigest || P.digestOf(this.state), nowMs()));
  };

  // ============================================================
  // 被控侧：接收并应用状态
  // ============================================================
  Session.prototype._onMasterState = function (msg) {
    this.lastPeerMsgAt = nowMs();
    this.peerOnline = true;

    // 旧版本消息直接忽略（防止乱序/重放把状态倒退）
    if (msg.rev < this.ackRev) {
      this._sendAck();
      return;
    }

    // 1) 波形：校验指纹并入库（新到的覆盖旧的；同一指纹视为同一波形）
    var keys = Object.keys(msg.waves || {});
    for (var i = 0; i < keys.length; i++) {
      var payload = msg.waves[keys[i]];
      var err = P.validateWavePayload(payload);
      if (err) {
        this._log('warn', 'reject wave ' + keys[i] + ': ' + err);
        continue;                                   // 丢弃这一条，其它继续
      }
      if (Object.keys(this.knownWaves).length >= LIM.MAX_WAVES && !this.knownWaves[payload.fp]) {
        // 超出缓存上限：清掉最旧的（简单策略：清空重来，反正会重传）
        this.knownWaves = {};
      }
      this.knownWaves[payload.fp] = payload;
    }

    // 2) 引用的波形必须都有（本次带的 或 之前缓存的），否则不能应用
    var names = ['A', 'B'], missing = [];
    for (i = 0; i < 2; i++) {
      var wk = msg.ch[names[i]].waveKey;
      if (wk && !this.knownWaves[wk]) missing.push(wk);
    }
    if (missing.length) {
      this._log('warn', 'state references unknown waves: ' + missing.join(','));
      // 不回 ACK（回 ACK 会让主控以为确认成功）；主控会因超时继续重传
      return;
    }

    // 3) 应用
    //   顺带接收主控捎带下来的诊断值（只有它能测出来）：
    //     psr → 主控↔服务器延迟；端到端 = 本端↔服务器 + 主控↔服务器
    //     pco → 主控算出的时钟偏差，作为界面显示的兜底
    //   ⚠ pco 只存到 _masterClockOffset，**绝不写进 clock.lastResult** —— 那个对象
    //     参与起播相位对齐（beatLocal = beatKey + offset），篡改它会导致相位错位。
    //     本端时钟探测成功时优先用本端自己的结果。
    if (typeof msg.psr === 'number') this.net.peerRtt = msg.psr;
    if (typeof msg.pco === 'number') this._masterClockOffset = msg.pco;

    var applied = {
      rev: msg.rev,
      running: msg.running,
      beatKey: msg.beatKey,
      ch: {},
      waves: {}
    };
    for (i = 0; i < 2; i++) {
      var n = names[i];
      applied.ch[n] = {
        enabled: msg.ch[n].enabled,
        intensity: msg.ch[n].intensity,
        phase: msg.ch[n].phase,
        waveKey: msg.ch[n].waveKey,
        wave: msg.ch[n].waveKey ? this.knownWaves[msg.ch[n].waveKey] : null
      };
    }
    // 起播时刻换算到本端时钟（offset = 本端时钟 - 主控时钟）
    applied.beatLocal = null;
    if (this.clock.lastResult && msg.beatKey) {
      applied.beatLocal = msg.beatKey + this.clock.lastResult.offset;
    }

    this.ackRev = msg.rev;
    this.syncState = 'confirmed';
    this.lastMasterBeatAt = nowMs();

    // ⚠ 必须把收到的状态存进 this.state。
    //   _sendAck() 用 P.digestOf(this.state) 作为回执摘要，主控拿它和自己发出去的比；
    //   如果这里不更新，被控回的永远是"初始空状态"的摘要，
    //   主控就会认为没确认成功 → 永远 resending → 波形也会一直重传。
    this.state = {
      rev: msg.rev,
      running: msg.running,
      beatKey: msg.beatKey,
      ch: {
        A: { enabled: msg.ch.A.enabled, intensity: msg.ch.A.intensity, phase: msg.ch.A.phase, waveKey: msg.ch.A.waveKey },
        B: { enabled: msg.ch.B.enabled, intensity: msg.ch.B.intensity, phase: msg.ch.B.phase, waveKey: msg.ch.B.waveKey }
      },
      waves: {}
    };

    if (typeof this.handlers.onApplyState === 'function') {
      try { this.handlers.onApplyState(applied); }
      catch (e) { this._log('error', 'onApplyState threw: ' + (e && e.message)); }
    }
    this._sendAck();
    this._emit();
  };

  Session.prototype._sendAck = function () {
    if (this.isMaster || !this.opened) return;
    this._send(P.ack({
      seq: this.ackRev,
      digest: P.digestOf(this.state),          // 被控当前生效状态的摘要
      ble: this.selfInfo.ble,
      out: { a: this.selfInfo.out.a, b: this.selfInfo.out.b },
      err: this.selfInfo.err,
      clk: nowMs(),
      wall: wallMs(),
      // 把"被控↔服务器"的延迟带上，主控才能显示端到端估算
      rtt: this.net.selfRtt
    }));
  };

  // 主控专用：立即回一条 ACK，用于确认"已收到被控的解锁消息"。
  //   正常情况下主控只在回应保活时才发 ACK，而解锁消息可能很久才有下一次保活，
  //   所以这里主动回一条，让被控尽快停止重发。
  Session.prototype._sendResumeAck = function () {
    if (!this.isMaster || !this.opened) return;
    this._send(P.ack({
      seq: this.ackRev,
      digest: P.digestOf(this.state),
      ble: this.selfInfo.ble,
      out: { a: this.selfInfo.out.a, b: this.selfInfo.out.b },
      err: this.selfInfo.err,
      clk: nowMs(),
      wall: wallMs(),
      rtt: this.net.selfRtt,
      ackResume: true
    }));
  };

  // ============================================================
  // 定时器：重传/心跳（主控）、失联判定（被控）、探测（双向）
  // ============================================================
  Session.prototype._startTimers = function () {
    var self = this;
    this._stopTimers();

    // 50ms 的调度节拍：主控用来决定"该重传了吗 / 该心跳了吗"，被控用来判失联
    this.timers.tick = setInterval(function () { self._tick(); }, 50);

    // 延迟与时钟探测：2 秒一次（按计划）
    this.timers.probe = setInterval(function () { self._probe(); }, LIM.PING_MS);
  };

  Session.prototype._stopTimers = function () {
    var t = this.timers;
    if (t.tick) { clearInterval(t.tick); t.tick = null; }
    if (t.probe) { clearInterval(t.probe); t.probe = null; }
    if (t.retry) { clearTimeout(t.retry); t.retry = null; }
  };

  Session.prototype._tick = function () {
    var t = nowMs();
    if (this.isMaster) {
      this._drainAck();                 // 先消化已排队的确认，再决定是否重传
      this._pump();
      if (this.opened && (t - (this._lastKeepaliveAt || 0)) >= LIM.KEEPALIVE_MS) {
        this._lastKeepaliveAt = t;
        this._sendKeepalive();
      }
      // 主控侧：对端静默太久 → 标记失联并**把 peerOnline 置回 false**（不停机，停机是被控的责任）。
      //   置回 false 很关键：对端恢复后 peerOnline 重新变 true 会触发 _markDirty()，
      //   主控因此会立刻重推一次状态。原来这里只改 syncState，peerOnline 一直是 true，
      //   于是"对端回来"这件事在主控眼里从未发生过，界面也一直显示对方在线。
      if (this.opened && this.peerOnline && (t - this.lastPeerMsgAt) > LIM.LOST_MS) {
        this.peerOnline = false;
        this.syncState = 'lost';
        this.inflight = true;        // 保证恢复后 _pump 一定会重推
        this._dirty = true;
        this._emit();
      }
    } else {
      // 被控侧：失联判定 —— 安全底线
      if (this.opened && this.peerOnline && (t - this.lastPeerMsgAt) > LIM.LOST_MS) {
        this._failSafe('heartbeat-timeout');
      }
      // 被控侧：把"已解锁"的消息重发几次，直到收到主控的确认。
      //   这条消息决定主控界面上的通道复选框能否重新勾选，丢一次用户就会觉得"解锁没生效"。
      if (this.opened && this._resumePending) {
        if ((t - (this._resumeSentAt || 0)) >= RESUME_RESEND_MS) {
          if ((this._resumeTries || 0) < RESUME_MAX_TRIES) {
            this._resumeTries = (this._resumeTries || 0) + 1;
            this._resumeSentAt = t;
            this._send(this._resumePending);
          } else {
            this._resumePending = null;    // 放弃（对端可能已不在），避免无限重发
          }
        }
      }
    }
  };

  // 消化排队的 ACK。单独一个函数是为了让"处理确认"这件事
  // 永远不会和"写入发送状态"交错（这是仿真里抓到的真 bug）。
  Session.prototype._drainAck = function () {
    var ack = this._queuedAck;
    if (!ack) return;
    this._queuedAck = null;
    this._onAck(ack);
  };

  // 被控侧：统一的安全停机出口（三条路径都走这里，保证不漏）
  Session.prototype._failSafe = function (reason) {
    if (this.isMaster) return;
    if (this._failedFor === reason) return;      // 同一次失联只处理一次
    this._failedFor = reason;
    this.peerOnline = false;
    this.syncState = 'lost';
    this._emit();
    this._log('warn', 'fail-safe stop: ' + reason);
    if (typeof this.handlers.onFailSafeStop === 'function') {
      try { this.handlers.onFailSafeStop(reason); }
      catch (e) { this._log('error', 'onFailSafeStop threw: ' + (e && e.message)); }
    }
  };

  // 重新连上后允许再次触发 fail-safe
  Session.prototype.clearFailSafe = function () { this._failedFor = null; };

  // 收到对端任何消息都说明链路是活的：把失联标记清掉，
  //   否则 `_failSafe` 开头那句 `if (this._failedFor === reason) return;`
  //   会让**同一次失联永远只处理一次** —— 对端回来后再次失联就再也不会停机了。
  //   注意：清标记不等于恢复输出，输出权限由被控端界面（slaveui）决定。
  Session.prototype._notePeerAlive = function () {
    if (this.isMaster) return;
    if (this._failedFor === null) return;
    this._failedFor = null;
    if (this.syncState === 'lost') this.syncState = 'syncing';
    this._log('info', 'peer alive again, fail-safe re-armed');
  };

  Session.prototype._probe = function () {
    if (!this.opened) return;

    // 无论哪个角色，都自己测一次「本端 ↔ 服务器」的往返延迟。
    // 被控端也必须测：主控界面要显示"被控↔服务器"的延迟，而那是被控端自己才知道的数。
    if (this.transportKind === 'websocket' && this.conn && this.conn.isOpen()) {
      this._pingAt = nowMs();
      this.conn.send(L.msgPing(this._pingAt));
    }

    // 时钟探测由主控发起（被控只负责应答）
    if (this.isMaster && this.peerOnline) {
      var probe = this.clock.beginProbe(nowMs());
      probe.k = 'probe';
      this._send(probe);
    }
  };

  Session.prototype._onPong = function (m) {
    // 服务器应把我们的 c 原样带回；没有 c 就算不出 RTT
    var sentAt = (typeof m.c === 'number') ? m.c : this._pingAt;
    if (typeof sentAt === 'number') {
      this.net.selfRtt = nowMs() - sentAt;
      this._pingAt = null;
      this._lastServerStamp = m.s;
      this._emit();
    }
    if (typeof m.peerRtt === 'number') this.net.peerRtt = m.peerRtt;
  };

  // 被控侧处理探测消息（业务层里 k==='probe' 的特殊消息）
  // 注意：探测消息走的是业务通道，所以要在 _onBusiness 之前拦一下
  var _origOnBusiness = Session.prototype._onBusiness;
  Session.prototype._onBusiness = function (msg) {
    if (msg && msg.k === 'probe' && typeof msg.c === 'number') {
      this.lastPeerMsgAt = nowMs();               // 探测也算"主控还活着"
      var reply = this.clock.answerProbe(msg, nowMs());
      if (reply) { reply.k = 'probe-reply'; this._send(reply); }
      return;
    }
    if (msg && msg.k === 'probe-reply' && this.isMaster) {
      this.lastPeerMsgAt = nowMs();
      this.clock.completeProbe({ t2: msg.t2, t3: msg.t3 }, nowMs());
      var info = this.clock.info();
      if (info) {
        this.net.selfRtt = info.rtt;
        this.net.drift = info.jitter;
        this.net.stable = info.stable;
      }
      this._emit();
      return;
    }
    return _origOnBusiness.call(this, msg);
  };

  // ============================================================
  // 状态对外播报（界面订阅）
  // ============================================================
  Session.prototype.info = function () {
    return {
      role: this.role,
      room: this.room,
      peerId: this.peerId,
      transport: this.transportKind,
      opened: this.opened,
      peerOnline: this.peerOnline,
      syncState: this.syncState,
      error: this.error,
      rev: this.isMaster ? this.rev : this.ackRev,
      // 网络
      selfRtt: this.net.selfRtt,
      peerRtt: this.net.peerRtt,
      endToEndMs: (typeof this.net.selfRtt === 'number' && typeof this.net.peerRtt === 'number')
        ? this.net.selfRtt + this.net.peerRtt : null,
      drift: this.net.drift,
      clockStable: this.net.stable,
      // 时钟偏差：优先用本端时钟探测的结果；本端还没测出来时，
      //   退回主控在状态里捎带下来的值（被控端就能显示了，而不是一直"—"）。
      clockOffset: (this.clock.lastResult && typeof this.clock.lastResult.offset === 'number')
        ? this.clock.lastResult.offset
        : (typeof this._masterClockOffset === 'number' ? this._masterClockOffset : null),
      // 被控方（主控侧关心）
      peerBle: this.peerInfo.ble,
      peerOut: { a: this.peerInfo.out.a, b: this.peerInfo.out.b },
      peerErr: this.peerInfo.err,
      // 本端（被控侧上报用）
      selfBle: this.selfInfo.ble,
      selfOut: { a: this.selfInfo.out.a, b: this.selfInfo.out.b },
      selfErr: this.selfInfo.err
    };
  };

  Session.prototype._emit = function () {
    if (typeof this.handlers.onStatus === 'function') {
      var info;
      try { info = this.info(); } catch (e) { return; }
      try { this.handlers.onStatus(info); } catch (e) { }
    }
  };

  Session.prototype._log = function (level, msg) {
    if (typeof this.handlers.onLog === 'function') {
      try { this.handlers.onLog(level, msg); } catch (e) { }
    }
  };

  W.Session = Session;
})();
