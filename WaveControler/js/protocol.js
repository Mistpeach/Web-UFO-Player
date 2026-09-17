// ============================================================
// js/protocol.js - 远程控制的消息契约（主控与被控共用）
//
//   两层协议，不要混淆：
//     传输层（服务器只认这层）：{ t:'create'|'join'|'leave'|'relay'|'ping' }
//     业务层（服务器完全不看）：包在传输层 relay.payload 里，本文件定义
//
//   设计原则：
//     1. 服务器不理解业务 —— 所以业务协议升级不需要动服务器
//     2. 所有收到的消息必须过 validate() 才能使用 —— 畸形消息一律丢弃
//     3. 越界值直接拒绝，不做"静默夹取" —— 静默夹取会掩盖同步错误
//     4. 波形用「内容指纹」标识，不用本地 id —— 两端波形库是两套独立数据
// ============================================================
(function () {
  'use strict';
  var W = window.WC = window.WC || {};
  var R = {};

  // 版本号：两端不一致时拒绝建立会话（避免新旧协议互发导致难以排查的问题）
  R.VERSION = 1;

  // ---------- 传输层消息类型（服务器看得懂的只有这些） ----------
  R.T = {
    CREATE: 'create',     // → 服务器：创建房间
    JOIN: 'join',         // → 服务器：加入房间
    LEAVE: 'leave',       // → 服务器：离开房间
    RELAY: 'relay',       // ↔ 服务器：转发 payload 给房间内对端
    PING: 'ping',         // ↔ 服务器：测延迟 / 时钟，服务器补 s 字段
    // 服务器 → 客户端
    CREATED: 'created',
    JOINED: 'joined',
    PEER: 'peer',         // event: joined | left
    ERROR: 'error',
    PONG: 'pong'
  };

  R.ROLE = { MASTER: 'master', SLAVE: 'slave' };

  // ---------- 业务层消息类型（服务器看不见） ----------
  R.B = {
    HELLO: 'hello',       // 双向：握手，交换版本与角色
    STATE: 'state',       // 主控 → 被控：期望状态（含波形）
    ACK: 'ack',           // 被控 → 主控：确认 + 捎带被控状态（见 §3.5）
    KEEPALIVE: 'ka',      // 主控 → 被控：保活（无状态变化时也发）
    STOP: 'stop',         // 双向：急停请求（被控执行，且会进入锁定）
    // 主控 → 被控：我要走了（主动退出 / 关闭页面）。
    //   与 STOP 的区别：STOP 是"急停并锁定"，BYE 只是"我不再控制你了，立刻停机"。
    //   没有它的话，主控关掉标签页时被控只能等 8 秒心跳超时才停 —— 设备会多跑好几秒。
    BYE: 'bye',
    // 被控 → 主控：急停已解除，主控可以重新开启输出。
    //   没有它的话，被控点了解锁，主控那边仍停留在"被锁定"状态、通道复选框一直是灰的，
    //   因为主控无法自行解除急停锁定（这是安全设计），只能靠被控明确告知。
    RESUME: 'resume'
  };

  // ---------- 容量限制 ----------
  R.LIMITS = {
    MAX_WIRE_BYTES: 64 * 1024,      // 单条 WS 文本消息上限（超过直接断开该连接）
    CHUNK_BYTES: 8 * 1024,          // 业务 payload 超过这个大小就分片
    MAX_CHUNKS: 24,                 // 分片数上限（≈192KB，足够容纳超长波形）
    MAX_WAVES: 8,                   // 会话内缓存的"来自主控"的波形数量上限
    MAX_ROOM: 2,                    // 房间人数上限（业务层强制，协议层已为多人预留）
    KEEPALIVE_MS: 2000,             // 主控保活间隔
    PING_MS: 2000,                  // 延迟/时钟测量间隔
    LOST_MS: 8000,                  // 被控判定"失联"的心跳超时（安全阈值）
    RETRY_MS: [300, 600, 1200, 2000], // 重传退避
    AMP_LIMIT: 127,
    MAX_DURATION: 3600,
    MIN_DURATION: 0.05
  };

  // ---------- 通用校验工具 ----------
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isStr(v) { return typeof v === 'string'; }
  function inRange(v, lo, hi) { return isNum(v) && v >= lo && v <= hi; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  R.clamp = clamp;

  function clone(v) {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
  }
  R.clone = clone;

  // 稳定字符串化：对象键排序，保证同一份数据在任何浏览器上得到同样的字符串
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(stableStringify(v[i]));
      return '[' + out.join(',') + ']';
    }
    var keys = Object.keys(v).sort(), parts = [];
    for (var k = 0; k < keys.length; k++) {
      parts.push(JSON.stringify(keys[k]) + ':' + stableStringify(v[keys[k]]));
    }
    return '{' + parts.join(',') + '}';
  }
  R.stableStringify = stableStringify;

  // FNV-1a 32 位哈希 → 8 位十六进制。够用且快，不需要加密强度
  function hash32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  R.hash32 = hash32;

  // ---------- 波形指纹：用内容标识，不用 id ----------
  // 只取"决定动作输出"的字段。name 参与指纹（两端显示用），但不影响输出；
  // 之所以包含它，是为了让同名不同内容的波形能被区分开。
  function waveFingerprint(w) {
    if (!w) return '';
    var payload = {
      v: 1,
      name: String(w.name || '').slice(0, 40),
      duration: w.duration,
      mode: w.mode === 'linear' ? 'linear' : 'hold',
      base: w.base,
      loop: w.loop === false ? false : true,
      A: (w.channels && w.channels.A) || [],
      B: (w.channels && w.channels.B) || []
    };
    return hash32(stableStringify(payload));
  }
  R.waveFingerprint = waveFingerprint;

  // 把波形规整成"跨端传输用的最小载荷"：去掉 id / builtin / 时间戳等本机私有字段，
  // 但保留 fingerprint，让接收端能校验、能去重。
  function wavePayload(w) {
    if (!w) return null;
    return {
      fp: waveFingerprint(w),
      name: String(w.name || '').slice(0, 40),
      duration: w.duration,
      mode: w.mode === 'linear' ? 'linear' : 'hold',
      base: w.base,
      loop: w.loop === false ? false : true,
      notes: String(w.notes || '').slice(0, 200),
      channels: {
        A: ((w.channels && w.channels.A) || []).map(function (p) { return [p[0], p[1]]; }),
        B: ((w.channels && w.channels.B) || []).map(function (p) { return [p[0], p[1]]; })
      }
    };
  }
  R.wavePayload = wavePayload;

  // 指纹就是波形在会话里的"身份"，也是缓存的键
  function waveKeyOf(payload) { return payload && payload.fp ? payload.fp : ''; }
  R.waveKeyOf = waveKeyOf;

  // 校验一个"来自对端"的波形载荷是否合法且自洽
  function validateWavePayload(p) {
    if (!isObj(p)) return 'wave-not-object';
    if (!isStr(p.fp) || !/^[0-9a-f]{8}$/.test(p.fp)) return 'wave-bad-fp';
    if (!isStr(p.name) || p.name.length === 0 || p.name.length > 40) return 'wave-bad-name';
    if (!inRange(p.duration, R.LIMITS.MIN_DURATION, R.LIMITS.MAX_DURATION)) return 'wave-bad-duration';
    if (p.mode !== 'hold' && p.mode !== 'linear') return 'wave-bad-mode';
    if (!inRange(p.base, 1, R.LIMITS.AMP_LIMIT)) return 'wave-bad-base';
    if (!isObj(p.channels)) return 'wave-bad-channels';
    var names = ['A', 'B'], i, j, pts;
    for (i = 0; i < 2; i++) {
      pts = p.channels[names[i]];
      if (!Array.isArray(pts)) return 'wave-bad-channel-' + names[i];
      if (pts.length > 4000) return 'wave-too-many-points';
      var prevT = -1;
      for (j = 0; j < pts.length; j++) {
        var pt = pts[j];
        if (!Array.isArray(pt) || pt.length < 2) return 'wave-bad-point';
        if (!inRange(pt[0], 0, p.duration)) return 'wave-point-time-out-of-range';
        if (pt[0] <= prevT) return 'wave-points-not-ascending';
        if (!inRange(pt[1], -R.LIMITS.AMP_LIMIT, R.LIMITS.AMP_LIMIT)) return 'wave-point-amp-out-of-range';
        prevT = pt[0];
      }
    }
    // 指纹必须与内容一致 —— 防止"内容被改过但指纹没变"（服务器篡改或传输损坏）
    var re = waveFingerprint(p);
    if (re !== p.fp) return 'wave-fingerprint-mismatch';
    return null;
  }
  R.validateWavePayload = validateWavePayload;

  // ---------- 期望状态（主控 → 被控 的同步对象） ----------
  // {
  //   rev: 12,                        // 版本号，每次变化 +1（必须单调递增）
  //   running: true,                  // 总开关：是否希望输出
  //   beatKey: 812345.6,              // 起播时刻（主控时钟读数），两端据此对齐相位
  //   ch: { A: { enabled, intensity, phase, waveKey }, B: {...} },
  //   waves: { <fp>: <wavePayload> }, // 本次携带的波形（只带被控缺少的那几个）
  // }
  R.newState = function () {
    return {
      rev: 0,
      running: false,
      beatKey: 0,
      ch: {
        A: { enabled: false, intensity: 1.0, phase: 0, waveKey: '' },
        B: { enabled: false, intensity: 1.0, phase: 0, waveKey: '' }
      },
      waves: {}
    };
  };

  function stateEqual(a, b) {
    if (!a || !b) return false;
    return stableStringify(a) === stableStringify(b);
  }
  R.stateEqual = stateEqual;

  // 状态摘要：用于 ACK 里回带，比全量小得多，够主控比对"你说的和我发的是不是一回事"
  function digestOf(state) {
    if (!state) return '';
    var ch = state.ch || {};
    return hash32(stableStringify({
      rev: state.rev,
      running: !!state.running,
      A: ch.A ? [!!ch.A.enabled, ch.A.intensity, ch.A.phase, ch.A.waveKey] : null,
      B: ch.B ? [!!ch.B.enabled, ch.B.intensity, ch.B.phase, ch.B.waveKey] : null
    }));
  }
  R.digestOf = digestOf;

  // ---------- 业务消息校验 ----------
  // 所有从网络上收进来的业务消息都必须先过这里；返回 null 表示合法，否则返回原因字符串。
  function validate(msg) {
    if (!isObj(msg)) return 'not-object';
    if (!isStr(msg.t)) return 'no-type';

    switch (msg.t) {
      case R.B.HELLO:
        if (msg.version !== R.VERSION) return 'version-mismatch';
        if (msg.role !== R.ROLE.MASTER && msg.role !== R.ROLE.SLAVE) return 'bad-role';
        return null;

      case R.B.KEEPALIVE:
        if (!isNum(msg.rev)) return 'bad-rev';
        if (!isNum(msg.at)) return 'bad-at';
        if (!isStr(msg.digest)) return 'bad-digest';
        return null;

      case R.B.STOP:
        if (!isStr(msg.reason)) return 'bad-reason';
        return null;

      case R.B.BYE:
        if (!isStr(msg.reason)) return 'bad-reason';
        return null;

      case R.B.RESUME:
        // 被控告知"急停已解除"。reason 可选，便于将来区分解除来源。
        if (msg.reason !== undefined && msg.reason !== null && !isStr(msg.reason)) return 'bad-reason';
        return null;

      case R.B.STATE:
        return validateState(msg);

      case R.B.ACK:
        if (!isNum(msg.seq)) return 'ack-bad-seq';
        if (!isStr(msg.digest)) return 'ack-bad-digest';
        if (!isStr(msg.ble)) return 'ack-bad-ble';
        if (!isObj(msg.out)) return 'ack-bad-out';
        if (!inRange(msg.out.a, -R.LIMITS.AMP_LIMIT, R.LIMITS.AMP_LIMIT)) return 'ack-out-a-range';
        if (!inRange(msg.out.b, -R.LIMITS.AMP_LIMIT, R.LIMITS.AMP_LIMIT)) return 'ack-out-b-range';
        if (!isNum(msg.err)) return 'ack-bad-err';
        if (!isNum(msg.clk)) return 'ack-bad-clk';
        if (!isNum(msg.wall)) return 'ack-bad-wall';
        // 可选：被控端测到的"被控↔服务器"延迟，主控据此显示端到端估算
        if (msg.rtt !== undefined && msg.rtt !== null && !inRange(msg.rtt, 0, 60000)) return 'ack-bad-rtt';
        return null;

      default:
        return 'unknown-type';
    }
  }
  R.validate = validate;

  function validateState(msg) {
    if (!isNum(msg.rev) || msg.rev < 0) return 'state-bad-rev';
    if (typeof msg.running !== 'boolean') return 'state-bad-running';
    if (msg.beatKey !== undefined && !isNum(msg.beatKey)) return 'state-bad-beatKey';
    // 可选：主控自己的「主控↔服务器」往返延迟。
    //   被控端界面要显示"主控↔服务器"和"端到端估算"，但这两个数只有主控能测出来
    //   （服务器不会替它广播），所以必须由主控在状态里捎带下来。
    if (msg.psr !== undefined && msg.psr !== null && !inRange(msg.psr, 0, 60000)) return 'state-bad-psr';
    // 可选：主控算出的时钟偏差（被控时钟 − 主控时钟，毫秒）。
    //   起播相位对齐用的是被控这边的偏移量，所以把这个值给被控，它才能显示偏差。
    if (msg.pco !== undefined && msg.pco !== null &&
        (!isNum(msg.pco) || msg.pco < -3600000 || msg.pco > 3600000)) return 'state-bad-pco';
    if (!isObj(msg.ch)) return 'state-bad-ch';
    var names = ['A', 'B'], i;
    for (i = 0; i < 2; i++) {
      var c = msg.ch[names[i]];
      if (!isObj(c)) return 'state-bad-ch-' + names[i];
      if (typeof c.enabled !== 'boolean') return 'state-bad-enabled';
      if (!inRange(c.intensity, 0, 2)) return 'state-bad-intensity';
      if (!inRange(c.phase, 0, 1)) return 'state-bad-phase';
      if (!isStr(c.waveKey)) return 'state-bad-waveKey';
      if (c.waveKey && !/^[0-9a-f]{8}$/.test(c.waveKey)) return 'state-bad-waveKey-format';
    }
    if (!isObj(msg.waves)) return 'state-bad-waves';
    var keys = Object.keys(msg.waves);
    if (keys.length > R.LIMITS.MAX_WAVES) return 'state-too-many-waves';
    for (i = 0; i < keys.length; i++) {
      var err = validateWavePayload(msg.waves[keys[i]]);
      if (err) return 'state-wave: ' + err;
      if (keys[i] !== msg.waves[keys[i]].fp) return 'state-wave-key-mismatch';
    }
    // 每个通道引用的 waveKey 必须在"本次携带"或"接收端缓存"里存在。
    // 这里只能校验"本次携带"的情况；缓存命中由接收端自己判断（见 sync.js）
    return null;
  }
  R.validateState = validateState;

  // ---------- 分片 ----------
  // 单条业务消息超过 CHUNK_BYTES 就切成多片；每片带 index/total，接收端集齐后重组。
  // 关键：重组完成后必须再走一次 validate()，绝不应用"半截数据"。
  R.chunk = function (businessMsg) {
    var text = JSON.stringify(businessMsg);
    if (text.length <= R.LIMITS.CHUNK_BYTES) {
      return [{ c: 1, i: 0, n: 1, d: businessMsg }];
    }
    var parts = [], size = R.LIMITS.CHUNK_BYTES;
    for (var p = 0; p < text.length; p += size) parts.push(text.slice(p, p + size));
    if (parts.length > R.LIMITS.MAX_CHUNKS) return null;   // 太大，调用方要报错
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      out.push({ c: 1, i: i, n: parts.length, d: parts[i] });
    }
    return out;
  };

  // 分片接收器：每个会话一个实例
  R.ChunkAssembler = function () {
    var pending = {};
    return {
      // 返回 { done:true, msg } / { done:false } / { error:'...' }
      push: function (part) {
        if (!isObj(part) || part.c !== 1) return { error: 'bad-chunk' };
        var n = part.n, i = part.i;
        if (!isNum(n) || !isNum(i) || n < 1 || n > R.LIMITS.MAX_CHUNKS || i < 0 || i >= n) {
          return { error: 'bad-chunk-index' };
        }
        if (n === 1) {
          if (isStr(part.d)) return { error: 'single-chunk-should-be-object' };
          return { done: true, msg: part.d };
        }
        var slot = pending[n] || (pending[n] = { need: n, got: 0, parts: new Array(n) });
        if (!isStr(part.d)) return { error: 'chunk-data-not-string' };
        if (slot.parts[i] === undefined) { slot.parts[i] = part.d; slot.got++; }
        if (slot.got < slot.need) return { done: false };
        delete pending[n];
        var text = slot.parts.join('');
        var msg;
        try { msg = JSON.parse(text); } catch (e) { return { error: 'chunk-json-broken' }; }
        return { done: true, msg: msg };
      },
      reset: function () { pending = {}; }
    };
  };

  // ---------- 构造业务消息的小工具 ----------
  R.hello = function (role) { return { t: R.B.HELLO, version: R.VERSION, role: role }; };
  R.keepalive = function (rev, digest, at) {
    return { t: R.B.KEEPALIVE, rev: rev, digest: digest, at: at };
  };
  R.stop = function (reason) { return { t: R.B.STOP, reason: reason }; };
  R.bye = function (reason) { return { t: R.B.BYE, reason: reason }; };
  R.resume = function (reason) { return { t: R.B.RESUME, reason: reason || 'slave-unlock' }; };
  R.ack = function (o) {
    return {
      t: R.B.ACK, seq: o.seq, digest: o.digest, ble: o.ble,
      out: { a: o.out.a, b: o.out.b }, err: o.err, clk: o.clk, wall: o.wall,
      // 可选字段：被控端自己测到的「被控↔服务器」往返延迟
      rtt: (typeof o.rtt === 'number' && isFinite(o.rtt)) ? Math.round(o.rtt) : null,
      // 可选字段：主控确认"已收到被控的解锁(resume)消息"，被控据此停止重发
      ackResume: !!o.ackResume
    };
  };

  W.protocol = R;
})();
