// ============================================================
// js/masterui.js - 主控端界面（RemoteMaster.html）
//
//   界面结构刻意与本地控制器保持一致（同样用 wc.css 的 .chCard / #toolbar），
//   但有三处本质差别，必须显式处理：
//     ① 本地蓝牙必须断开，且「连接蓝牙」按钮置灰 —— 避免主控误以为在控制本机设备
//     ② 状态条常驻「🌐 远程控制中」，并与被控蓝牙状态、三个延迟、同步状态、保持前台运行同一行
//     ③ 波形库来自主控自己（内置示例 + 本机缓存），选中后通过会话下发给被控，
//        **不是**在被控的库里选
// ============================================================
(function () {
  'use strict';
  var W = window.WC = window.WC || {};
  var $ = function (id) { return document.getElementById(id); };

  var M = {
    session: null,
    vble: null,
    serverUrl: '',
    room: '',
    sel: { A: null, B: null },      // 主控本地的波形选择 {id, waveKey}
    waveCache: {},                  // id → 波形对象
    lib: [],
    pendingConnect: false,
    locked: false,                  // 被控方急停后置真：主控归零并禁止再开启
    running: false,                 // 是否已下发"开始输出"
    sentInitialState: false         // 对端上线后是否已补推过一次初始状态
  };

  function toast(msg, level) {
    var el = $('toast');
    if (!el) return;
    el.className = 'toast show ' + (level || 'info');
    el.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = 'toast'; }, level === 'warn' ? 6000 : 3200);
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function fmtMs(v) { return (typeof v === 'number' && isFinite(v)) ? (Math.round(v) + 'ms') : '—'; }
  function latClass(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    return v < 150 ? 'good' : (v < 400 ? 'mid' : 'bad');
  }

  // ============================================================
  // 连接房间弹窗（按设计：必须先弹窗输入地址 + 房间号，再连接）
  // ============================================================
  function openConnect() {
    $('connectModal').classList.add('open');
    $('connectErr').textContent = '';
    $('inRoom').value = '';
    try { $('inUrl').focus(); } catch (e) { }
  }
  function closeConnect() {
    if (M.pendingConnect) return;                 // 连接中不允许关
    $('connectModal').classList.remove('open');
  }

  function doConnect() {
    var localMode = $('chkLocalMode') && $('chkLocalMode').checked;
    var url = ($('inUrl').value || '').trim();
    // 房间号保持字符串，并归一化成严格 8 位数字（补前导零），
    // 保证本地调试时 '00000001' 这类房间号两端完全一致。
    var room = String($('inRoom').value || '').replace(/\D/g, '').slice(0, 8);
    var err = [];
    // 每次发起连接都给一次干净的机会：上一次会话遗留的急停锁定必须清掉，
    //   否则一旦被锁定过，之后无论重新连多少次，通道复选框都永远是灰的（只能刷新整页）。
    M.locked = false;
    M.sentInitialState = false;

    if (localMode) {
      // 本地调试：不连服务器，直接在同浏览器的两个标签页之间建立会话。
      // 被控端本地调试固定用 00000001，这里也补成 8 位，避免前导零差异。
      if (room.length === 0) room = '00000001';
      if (room.length !== 8) room = ('00000000' + room).slice(-8);
      if (!/^\d{8}$/.test(room)) err.push('本地调试也要填 8 位房间号（推荐 00000001）');
      if (!W.link.Broadcast.supported()) err.push('此浏览器不支持 BroadcastChannel');
    } else {
      if (!url) err.push('请填写服务器地址');
      if (!/^\d{8}$/.test(room)) err.push('房间号必须是 8 位数字（不足 8 位请补前导零，例如 00000001）');
    }
    if (err.length) { $('connectErr').textContent = err.join('；'); return; }
    $('inRoom').value = room;                    // 回填归一化后的值，让用户看到实际用的房间号

    M.serverUrl = localMode ? 'local://debug' : url;
    M.room = room;
    M.pendingConnect = true;
    $('btnDoConnect').disabled = true;
    $('btnDoConnect').textContent = '连接中…';
    $('connectErr').textContent = '';

    var s = new W.Session({
      role: W.protocol.ROLE.MASTER,
      transport: localMode ? 'broadcast' : 'websocket',
      url: M.serverUrl,
      room: room,
      onStatus: onSessionStatus,
      onPeerStop: onPeerStop,
      onPeerResume: onPeerResume,
      onLog: function () { }
    });
    M.session = s;

    // 注入为 ble 通道：engine 照旧每 50ms 调 send()，值只用于界面显示
    M.vble = W.virtualble.install(s, {
      onSample: function (v) { M.shadow = v; }
    });

    s.start();
    // 10 秒连不上就报错
    setTimeout(function () {
      if (M.pendingConnect && (!M.session || !M.session.isOpen())) {
        M.pendingConnect = false;
        $('btnDoConnect').disabled = false;
        $('btnDoConnect').textContent = '连接';
        $('connectErr').textContent = localMode
          ? '本地调试模式建立会话失败（浏览器可能不支持 BroadcastChannel）。'
          : '连接超时。请确认地址、服务是否已启动、是否用了 wss。';
      }
    }, 10000);
  }

  function onSessionStatus(info) {
    // 只要会话建立了（不论是否已有对端），就退出连接弹窗进入远程界面。
    // 注意：本地调试（BroadcastChannel）不会有服务器回 joined，所以不能只等 peerOnline。
    if (M.pendingConnect && info.opened) {
      M.pendingConnect = false;
      $('btnDoConnect').disabled = false;
      $('btnDoConnect').textContent = '连接';
      $('connectModal').classList.remove('open');
      enterRemoteMode();
      toast(info.peerOnline
        ? ('已连接房间 ' + info.room)
        : ('已进入房间 ' + info.room + '，等待被控方…'));
    }
    if (info.error) {
      $('connectErr').textContent = ({
        'room-not-found': '房间不存在，请核对房间号，或让被控方重新创建。',
        'room-full': '该房间已满（一个房间只允许主控 + 被控两人）。',
        'bad-request': '请求被服务器拒绝。',
        'rate-limited': '操作太频繁，请稍后再试。'
      })[info.error] || ('服务器返回错误：' + info.error);
      if (M.pendingConnect) {
        M.pendingConnect = false;
        $('btnDoConnect').disabled = false;
        $('btnDoConnect').textContent = '连接';
      }
    }
    // ⚠ 绝不能在这里"只要对端在线就 pushState()"。
    //   onSessionStatus 是会话每次 _emit 都会回调的，而**收到被控 ACK 时也会 _emit**。
    //   于是形成自我维持的死循环：
    //     主控发状态 rev=N → 被控回 ACK(N) → 主控收 ACK → _emit → 又 pushState()
    //     → rev=N+1 → 被控 ACK(N+1) → …
    //   结果 lastSentRev 永远跑在 ackRev 前面，_onAck 里 msg.seq >= lastSentRev 永远不成立，
    //   同步状态永远停在 syncing / resending，并以每秒几十条的速率空刷网络。
    //
    //   正确做法：只在"这一版状态还没被对端确认过"时补推，且必须用
    //   syncState==='confirmed' 作判据 —— 它正是"对端已确认收到当前这一版"的意思。
    //   这样既能满足"重连后立刻恢复"，又不会在校验通过后继续空推。
    if (M.session && M.session.syncState === 'confirmed') {
      M.sentInitialState = true;          // 本版已被确认，不必补推
    }
    // 对端刚重新初始化过（收到它的 HELLO）→ 之前那版算送达已不作数，必须重推。
    //   这一步专门解决"被控掉线超时停机 → 恢复后被控一直停在临时停机"：
    //   主控自认为 confirmed 而只发保活，但保活不带状态，被控永远等不到解锁所需的 state。
    var resumed = false;
    try { resumed = !!(M.session && M.session.takePeerResumed && M.session.takePeerResumed()); } catch (e) { }
    if (resumed) M.sentInitialState = false;

    if (info.peerOnline && !M.sentInitialState) {
      // 对端在线、但当前状态还没被确认过 → 补推一次
      //   （重连恢复、被控端重开房间、主控自己没察觉掉线等情形都靠这一步救回来）
      M.sentInitialState = true;
      pushState();
    }
    if (!info.peerOnline) M.sentInitialState = false;   // 对端掉线：等它回来时重新补推
    renderBar(info);
    renderInfo(info);
  }

  // 被控方解除了急停锁定 → 主控同步解除自己的锁定，让通道复选框重新可用。
  //   主控无法自行解除急停锁定（安全设计），所以只能等被控明确告知。
  function onPeerResume(reason) {
    if (!M.locked) return;
    M.locked = false;
    M.sentInitialState = false;      // 允许把当前状态重新推给被控
    renderChannels();
    toast('✅ 被控方已解除急停锁定，现在可以重新勾选通道开启输出');
  }

  // 被控方按了急停 → 主控必须立刻归零且不许再自行开启
  function onPeerStop(reason) {
    M.locked = true;
    setRunning(false);
    ['A', 'B'].forEach(function (n) {
      var cb = $('en-' + n);
      if (cb) { cb.checked = false; cb.disabled = true; }
    });
    var btn = $('btnMasterStop');
    if (btn) { btn.disabled = false; }
    // ⚠ 必须走统一的渲染：disabled 与卡片高亮都由 renderChannels 决定。
    //   原先这里只手改 cb.disabled / cb.checked，从不重算卡片高亮，
    //   于是急停后卡片仍带着 on 类，看起来"还在输出"。
    renderChannels();
    toast('⚠ 被控方已急停并锁定（原因：' + esc(reason) + '）。主控无法解除，需被控方解锁。', 'warn');
  }

  // ============================================================
  // 进入远程模式：断开本地蓝牙 + 置灰按钮 + 显示远程标识
  // ============================================================
  function enterRemoteMode() {
    // ① 断开本地蓝牙（主控此时是被控方的遥控器，不应同时占用本机 BLE）
    try {
      if (W.ble.connected || (W.ble.isMock && W.ble.isMock())) {
        // virtualble 已经把 connect/disconnect 接管了，这里直接调即可
      }
      W.ble.disconnect();
    } catch (e) { }

    // ② 「连接房间」按钮：始终可用（远程模式下点它就是在切换/重连房间）。
    //   这里不再有「连接蓝牙」按钮 —— 主控端不持有蓝牙，那个按钮连同"远程模式下不可用"
    //   的提示都去掉了，换成一个有用处的「连接房间」。
    var joinBtn = $('btnJoinRoom');
    if (joinBtn) {
      joinBtn.classList.remove('remoteDisabled');
      joinBtn.title = '切换或重新连接房间';
    }

    $('tbTag').textContent = '🌐 远程控制中';
    $('tbTag').className = 'rbRemoteTag';
    $('tbRoom').textContent = M.room;

    // ③ 主控自己的引擎要跑起来，才有影子值给界面
    try {
      if (!W.engine.isRunning()) {
        W.engine.start();
        if (W.scope) W.scope.startLoop();
      }
    } catch (e) { }

    renderChannels();
  }

  function exitRemoteMode(reason) {
    // ① 断开之前先告别：让被控立刻停机，而不是白等 8 秒心跳超时。
    //   Broadcast 下没有"对端离开"事件、WebSocket 下也要靠服务器发现断连，
    //   所以必须主动发一条 bye，否则设备会多跑好几秒。
    try { if (M.session) M.session.sayBye(reason || 'master-exit'); } catch (e) { }
    try { W.virtualble.uninstall(); } catch (e) { }
    M.vble = null;
    // ② 让 bye 先飞出去：BroadcastChannel 是异步派发的，
    //    同步 send 之后立刻 close 会把还没送达的消息一起丢掉，所以延迟 120ms 再关。
    try { if (M.session) M.session.stop('exit', 120); } catch (e) { }
    M.session = null;
    M.locked = false;      // 退出即解除本地锁定，否则重新连接后通道复选框永远是灰的
    setRunning(false);
    // 复选框的 disabled / checked 统一交给渲染函数重算（此处不再手改 DOM，
    //   否则会与 renderChannels 的判定打架，也会漏掉卡片高亮的复位）。
    renderChannels();
    $('tbTag').textContent = '⚪ 未接入房间';
    $('tbTag').className = 'rbRemoteTag local';
    $('tbRoom').textContent = '';
    toast('已退出远程控制' + (reason ? '（' + reason + '）' : ''), 'warn');
    openConnect();
  }

  // ============================================================
  // 波形库（主控自己的：内置示例 + 本机缓存）
  // ============================================================
  async function loadLib() {
    var out = [], arr = window.UFO_WAVE_PRESETS || [], i, w;
    for (i = 0; i < arr.length; i++) {
      try {
        w = W.format.normalize(arr[i], { id: arr[i].id });
        w.builtin = true;
        M.waveCache[w.id] = w;
        out.push({ id: w.id, name: w.name, builtin: true, meta: { duration: w.duration, points: (w.channels.A || []).length + (w.channels.B || []).length } });
      } catch (e) { }
    }
    var metas = [];
    try { metas = await W.store.list(); } catch (e) { }
    for (i = 0; i < metas.length; i++) {
      out.push({ id: metas[i].id, name: metas[i].name, builtin: false, meta: metas[i] });
    }
    M.lib = out;
    renderLib();
  }

  function renderLib() {
    var q = ($('libSearch').value || '').trim().toLowerCase();
    var groups = [{ t: '内置示例', items: [] }, { t: '我的波形', items: [] }];
    M.lib.forEach(function (it) {
      if (q && it.name.toLowerCase().indexOf(q) < 0) return;
      (it.builtin ? groups[0] : groups[1]).items.push(it);
    });
    var target = $('libTarget') ? $('libTarget').value : 'A';
    var cur = M.sel[target];
    var html = '';
    groups.forEach(function (g) {
      if (!g.items.length) return;
      html += '<div class="libGroup">' + esc(g.t) + ' <span class="cnt">' + g.items.length + '</span></div>';
      g.items.forEach(function (it) {
        var used = (M.sel.A && M.sel.A.id === it.id) || (M.sel.B && M.sel.B.id === it.id);
        html += '<div class="libItem' + (cur && cur.id === it.id ? ' used' : '') + '" onclick="WC.masterui.pickWave(\'' + esc(it.id) + '\')">' +
          '<div class="libName">' + esc(it.name) + '</div>' +
          '<div class="libMeta">' + (it.meta.duration ? it.meta.duration + 's · ' : '') + (it.meta.points || 0) + ' 断点' +
          (used ? ' · <b>已下发</b>' : '') + '</div></div>';
      });
    });
    $('libList').innerHTML = html || '<div class="libEmpty">没有匹配的波形</div>';
  }

  async function getWave(id) {
    if (M.waveCache[id]) return M.waveCache[id];
    var w = null;
    try { w = await W.store.get(id); } catch (e) { }
    if (w) M.waveCache[id] = w;
    return w;
  }

  function openLib(forCh) {
    $('libTarget').value = forCh || 'A';
    $('sidebar').classList.add('open');
    $('backdrop').classList.add('open');
    renderLib();
  }
  function closeLib() {
    $('sidebar').classList.remove('open');
    $('backdrop').classList.remove('open');
  }

  async function pickWave(id) {
    var target = $('libTarget').value || 'A';
    var w = await getWave(id);
    if (!w) { toast('波形读取失败', 'warn'); return; }
    // 登记波形内容（指纹即会话里的身份），并把 waveKey 写进期望状态
    var fp = M.session ? M.session.offerWave(w) : null;
    M.sel[target] = { id: id, waveKey: fp || '' };
    W.engine.setWave(target, w);
    if (W.scope) W.scope.setWave(target, w);
    var cb = $('en-' + target);
    if (cb && !cb.disabled && !cb.checked) { /* 不自动开启：换波形不打断/不开启输出由用户决定 */ }
    renderChannels();
    pushState();
    closeLib();
    toast('已把「' + w.name + '」下发给通道 ' + target + '（远程模式下换波形不打断输出）');
  }

  // ============================================================
  // 下发期望状态
  // ============================================================
  function pushState() {
    if (!M.session) return;
    var chan = {};
    ['A', 'B'].forEach(function (n) {
      var cb = $('en-' + n);
      chan[n] = {
        enabled: !!(cb && cb.checked),
        intensity: (parseInt($('int-' + n).value, 10) || 100) / 100,
        phase: (parseInt($('ph-' + n).value, 10) || 0) / 100,
        waveKey: (M.sel[n] && M.sel[n].waveKey) || ''
      };
    });
    M.session.setState({ chan: chan, running: !!M.running });
  }

  function setRunning(on) {
    M.running = !!on;
    pushState();
    var btn = $('btnMasterRun');
    if (btn) btn.textContent = M.running ? '⏸ 暂停输出' : '▶ 开始输出';
  }

  // ============================================================
  // 通道卡（结构与本地控制器一致，但操作全部走会话）
  // ============================================================
  function buildCards() {
    $('cards').innerHTML = ['A', 'B'].map(function (n) {
      return '' +
        '<section class="chCard" id="card' + n + '">' +
        '  <div class="chHead">' +
        '    <label class="chToggle"><input type="checkbox" id="en-' + n + '" onchange="WC.masterui.onEnable(\'' + n + '\')"> <b>通道 ' + n + '</b></label>' +
        '    <button class="chWave" id="waveName-' + n + '" onclick="WC.masterui.openLib(\'' + n + '\')" title="点击选择波形（来自主控自己的波形库）">选择波形…</button>' +
        '    <span class="chPeak" id="peak-' + n + '"></span>' +
        '  </div>' +
        '  <div class="chCtl">' +
        '    <label>强度 <input type="range" id="int-' + n + '" min="10" max="150" step="1" value="100" oninput="WC.masterui.onIntensity(\'' + n + '\')"> <span class="num" id="intVal-' + n + '">100%</span></label>' +
        '    <label>相位 <input type="range" id="ph-' + n + '" min="0" max="100" step="1" value="0" oninput="WC.masterui.onPhase(\'' + n + '\')"> <span class="num" id="phVal-' + n + '">0%</span></label>' +
        '  </div>' +
        '  <div class="scopeWrap" style="min-height:60px">' +
        '    <canvas class="scope" id="scope-' + n + '"></canvas>' +
        '    <div class="scopeMeta"><span id="live-' + n + '">+0 / -0</span><span id="lim-' + n + '" class="lim"></span></div>' +
        '  </div>' +
        '</section>';
    }).join('');
  }

  function renderChannels() {
    var info = M.session ? M.session.info() : null;
    var online = !!(info && info.peerOnline);
    ['A', 'B'].forEach(function (n) {
      var sel = M.sel[n];
      var w = sel ? M.waveCache[sel.id] : null;
      var btn = $('waveName-' + n);
      if (btn) {
        btn.textContent = w ? w.name : '选择波形…';
        btn.classList.toggle('empty', !w);
      }
      var pk = $('peak-' + n);
      if (pk) pk.textContent = w ? ('原始峰值 ' + W.format.peakOf(w, n) + ' · ' + W.format.describe(w)) : '';
      var card = $('card' + n);
      var cb = $('en-' + n);
      // 高亮判据必须带上 !M.locked：急停后 onPeerStop 会把 checked 清掉，
      //   但 classList.toggle 只在"值变化"时才动 DOM —— 如果传入 false 之前
      //   卡片就已经处于 on 状态且这次算出来还是 true，类名会残留，
      //   视觉上看起来"还在输出"。加上 !M.locked 后急停时必然算出 false。
      if (card) card.classList.toggle('on', online && !M.locked && !!(cb && cb.checked));
      // ⚠ 通道勾选框的可用性必须在这里**每次重算**，不能只在 init 里置一次。
      //   原来 init 把两个复选框永久 disabled = true，而 renderChannels 从不恢复，
      //   于是就算远程连上了，A/B 也永远是灰的、选不中。
      //   真正该灰的只有一种情况：被控方按了急停，主控已被锁定（设计上主控无法自行解除）。
      if (cb) cb.disabled = !!M.locked;
    });
    // 状态栏同步
    var st = $('stRun');
    if (st) st.textContent = M.running ? '▶ 已下发输出' : '⏸ 未输出';
    var sc = $('stConn');
    if (sc) sc.textContent = online ? '🌐 远程（被控在线）' : '🌐 远程（等待被控）';
  }

  // ============================================================
  // 渲染：状态条与信息面板
  // ============================================================
  function renderBar(info) {
    var bar = $('remoteBar');
    if (!bar) return;
    info = info || (M.session ? M.session.info() : null);
    var inRemote = !!(info && info.opened);
    var lat = info && info.selfRtt;
    var sync = info && info.syncState;
    var syncTxt = { idle: '未同步', syncing: '同步中', confirmed: '已同步', resending: '重发中', lost: '已失联' }[sync] || '—';
    var html = '';
    html += '<span class="rbRemoteTag' + (inRemote ? '' : ' local') + '">' + (inRemote ? '🌐 远程控制中' : '⚪ 未接入房间') + '</span>';
    if (M.room) html += '<span class="rbSep">│</span><span class="rbItem">房间 <span class="rbRoom">' + esc(M.room) + '</span></span>';
    html += '<span class="rbSep">│</span><span class="rbItem">被控方 ' + (info && info.peerOnline ? '在线' : '离线') + '</span>';
    html += '<span class="rbSep">│</span><span class="rbItem"><span class="rbDot ' +
      (info && info.peerBle === 'connected' ? 'on' : (info && info.peerBle === 'unknown' ? '' : 'off')) + '"></span>被控蓝牙 ' +
      esc({ connected: '已连接', disconnected: '未连接', mock: '模拟', unknown: '未知' }[info && info.peerBle] || '未知') + '</span>';
    html += '<span class="rbSep">│</span><span class="rbItem">我↔服 <span class="rbLat ' + latClass(lat) + '">' + fmtMs(lat) + '</span></span>';
    html += '<span class="rbSep">│</span><span class="rbItem">被控↔服 <span class="rbLat ' + latClass(info && info.peerRtt) + '">' + fmtMs(info && info.peerRtt) + '</span></span>';
    html += '<span class="rbSep">│</span><span class="rbItem">端到端 <span class="rbLat ' + latClass(info && info.endToEndMs) + '">' + fmtMs(info && info.endToEndMs) + '</span></span>';
    html += '<span class="rbSep">│</span><span class="rbItem"><span class="rbSync ' + esc(sync) + '">' + syncTxt + '</span></span>';
    html += '<span class="rbSep">│</span><span class="rbItem">⏱ 保持前台运行<button class="rbHelp" onclick="WC.masterui.openTip()" title="为什么？">?</button></span>';
    bar.innerHTML = html;
  }

  function renderInfo(info) {
    if (!info) return;
    var g = $('infoGrid');
    if (!g) return;
    var rows = [
      ['房间号', M.room || '—', 'mono'],
      ['被控方', info.peerOnline ? '在线' : '离线', info.peerOnline ? 'ok' : 'bad'],
      ['被控方蓝牙', { connected: '已连接', disconnected: '未连接', mock: '模拟输出' }[info.peerBle] || '未知',
        info.peerBle === 'connected' ? 'ok' : 'bad'],
      ['被控方实际输出', 'A ' + (info.peerOut ? info.peerOut.a : 0) + ' / B ' + (info.peerOut ? info.peerOut.b : 0), 'mono'],
      ['发包错误计数', String(info.peerErr || 0), info.peerErr ? 'warn' : ''],
      ['我↔服务器延迟', fmtMs(info.selfRtt), latClass(info.selfRtt)],
      ['被控↔服务器延迟', fmtMs(info.peerRtt), latClass(info.peerRtt)],
      ['端到端估算', fmtMs(info.endToEndMs), latClass(info.endToEndMs)],
      ['时钟偏差', info.clockOffset === null || info.clockOffset === undefined ? '—' :
        (info.clockOffset > 0 ? '+' : '') + Math.round(info.clockOffset) + 'ms', info.clockStable ? 'ok' : 'warn']
    ];
    g.innerHTML = rows.map(function (r) {
      return '<div><span class="k">' + r[0] + '</span><span class="v ' + (r[2] || '') + '">' + esc(r[1]) + '</span></div>';
    }).join('');
  }

  function openTip() { $('tipModal').classList.add('open'); }
  function closeTip() { $('tipModal').classList.remove('open'); }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    W.store.init();
    buildCards();
    loadLib();

    // 示波器：必须显式 attach，否则 scope 内部的 views 是空的 ——
    //   setWave 第一行 `if (!views[name]) return;` 会直接返回，
    //   画布即使存在也永远是空白。本地控制器有这一步（ui.js 的 init），主控端以前漏了。
    try {
      if (W.scope && W.scope.attach) {
        W.scope.attach('A', $('scope-A'));
        W.scope.attach('B', $('scope-B'));
        W.scope.startLoop();          // 自身的 rAF 循环负责持续重绘
      }
    } catch (e) { }

    $('btnDoConnect').onclick = doConnect;
    $('btnConnectClose').onclick = closeConnect;
    $('connectModal').onclick = function (e) { if (e.target === $('connectModal')) closeConnect(); };
    $('inRoom').addEventListener('keydown', function (e) { if (e.key === 'Enter') doConnect(); });
    // 房间号只允许数字，且严格 8 位（含前导零）。
    // 本地调试时被控端固定用 '00000001'，如果这里把前导零吃掉变成 '0000001'，
    // 两端就会落在不同的频道上，表现为"被控方一直离线"。
    $('inRoom').addEventListener('input', function () {
      var v = String(this.value || '').replace(/\D/g, '').slice(0, 8);
      if (v !== this.value) this.value = v;
    });
    $('inUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('inRoom').focus(); });

    $('btnMasterRun').onclick = function () { setRunning(!M.running); };
    $('btnMasterStop').onclick = function () {
      M.locked = true;
      setRunning(false);
      ['A', 'B'].forEach(function (n) {
        var cb = $('en-' + n);
        if (cb) { cb.checked = false; }
      });
      try { W.ble.send(0, 0); } catch (e) { }
      pushState();
      renderChannels();
      toast('已远程急停并归零', 'warn');
    };
    $('btnExit').onclick = function () { exitRemoteMode('用户主动退出'); };

    // 直接关标签页 / 刷新时，也要在被控端还"看得见"我们的最后一刻把 bye 发出去。
    //   pagehide 里做同步的 send 是可靠的（BroadcastChannel.postMessage 是同步入队）；
    //   这里不调用 stop()，因为页面马上就要销毁，没必要再走关闭流程。
    // 窗口尺寸变化 → 重算画布尺寸并重绘（与本地控制器一致，否则缩放后波形会错位/留白）
    window.addEventListener('resize', function () {
      try { if (W.scope) { W.scope.resize(); W.scope.renderOnce(); } } catch (e) { }
    });

    window.addEventListener('pagehide', function () {
      try { if (M.session) M.session.sayBye('master-pagehide'); } catch (e) { }
    });
    $('btnLibToggle').onclick = function () { openLib('A'); };
    $('libClose').onclick = closeLib;
    $('backdrop').onclick = closeLib;
    $('tipClose').onclick = closeTip;
    $('tipModal').onclick = function (e) { if (e.target === $('tipModal')) closeTip(); };
    $('libTarget').onchange = renderLib;

    // 「连接房间」：点开连接弹窗（可用来重连或换房间）。
    //   蓝牙由被控方持有，主控端没有也不需要有"连接蓝牙"这个动作。
    var joinBtn = $('btnJoinRoom');
    if (joinBtn) {
      joinBtn.onclick = function () { openConnect(); };
      joinBtn.title = '打开连接房间弹窗（填服务器地址与 8 位房间号）';
    }

    // 通道勾选框的初始禁用**不再**在这里写死。
    //   原来这里 `boxes[i].disabled = true` 是一次性的，而 renderChannels 从不恢复，
    //   导致远程连接成功后 A/B 复选框依然是灰的、点不动。
    //   现在统一由 renderChannels() 依据 M.locked 每次重算：
    //   未连房间时 M.locked 为 undefined（等价 false），而此刻会话尚未建立、
    //   下发也无处可去；连上后即可正常勾选。
    renderBar(null);
    renderInfo({ peerBle: 'unknown', peerOut: { a: 0, b: 0 } });
    renderChannels();
    openConnect();
    setInterval(function () {
      var info = M.session ? M.session.info() : null;
      renderBar(info);
      renderInfo(info);
      // 影子值显示（主控本地算出来的值，仅用于界面）
      if (M.shadow) {
        ['A', 'B'].forEach(function (n) {
          var el = $('live-' + n);
          if (el) el.textContent = (M.shadow.a > 0 ? '+' : '') + Math.round(n === 'A' ? M.shadow.a : M.shadow.b);
        });
      }
    }, 300);
  }

  // ============================================================
  // 对外接口
  // ============================================================
  W.masterui = {
    init: init, state: M,
    openLib: openLib, closeLib: closeLib, pickWave: pickWave, renderLib: renderLib,
    openTip: openTip, closeTip: closeTip,
    openConnect: openConnect, closeConnect: closeConnect,
    pushState: pushState, exitRemoteMode: exitRemoteMode,
    // ⚠ 这三个处理器必须同时更新**本地引擎**，不能只 pushState() 下发。
    //   理由（见 virtualble.js 开头的设计说明）：主控端的界面完全复用本地控制器那一套，
    //   引擎每 50ms 算出的影子值供界面显示、示波器画实发轨迹。
    //   原先只下发不更新引擎，后果是：
    //     · engine.ch[n].enabled 永远是 false → 播放头相位恒为 0 → 扫描线一动不动
    //     · 强度/相位滑杆对影子值与图形没有任何影响
    onEnable: function (n) {
      var cb = $('en-' + n);
      W.engine.setEnabled(n, !!(cb && cb.checked));
      pushState();
      renderChannels();
    },
    onIntensity: function (n) {
      var k = (parseInt($('int-' + n).value, 10) || 100) / 100;
      W.engine.setIntensity(n, k);
      $('intVal-' + n).textContent = Math.round(k * 100) + '%';
      try { if (W.scope) { W.scope.markDirty(); W.scope.renderOnce(); } } catch (e) { }
      pushState();
    },
    onPhase: function (n) {
      var r = (parseInt($('ph-' + n).value, 10) || 0) / 100;
      W.engine.setPhase(n, r);
      $('phVal-' + n).textContent = Math.round(r * 100) + '%';
      pushState();
    }
  };

  function boot() { try { init(); } catch (e) { console.log('主控端初始化失败：', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
