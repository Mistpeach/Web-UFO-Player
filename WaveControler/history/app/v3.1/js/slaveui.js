// ============================================================
// js/slaveui.js - 被控端界面（RemoteSlave.html）
//
//   固定三步引导，不允许跳步：
//     ① 连接蓝牙（复用 js/ble.js 的真实 BLE）
//     ② 填写服务器地址（可先测试连接）
//     ③ 创建房间 → 得到 8 位房间号
//
//   进入会话后的职责：
//     · 把主控下发的"期望状态"应用到本地引擎（强度/相位/波形/启停）
//     · 把引擎的真实输出与蓝牙状态回报给主控（走 ACK 捎带）
//     · 失联 / 主控离开 / 传输断开 → 一律走统一的安全停机出口
//     · 参数完全不允许本地修改（按设计），但急停永远可用
// ============================================================
(function () {
  'use strict';
  var W = window.WC = window.WC || {};
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    session: null,
    step: 'ble',            // ble | server | room | live
    serverUrl: '',
    room: '',
    bluetoothOk: false,
    // 锁定 = 不允许输出。默认**不锁**：
    //   刚创建房间时还没发生任何危险情况，应当直接允许主控开启输出，
    //   不该让用户先去点一次「解锁」。（锁定只在真正需要时由 failSafeStop /
    //   manualStop / 蓝牙断开 这三处置位。）
    locked: false,
    // 锁定原因，决定它能不能被自动解除：
    //   'emergency' —— 被控方手动急停：**永久锁定**，只有被控方能解锁（安全底线）
    //   'failsafe'  —— 失联/主控离开/传输断开/蓝牙断开导致的安全停机：
    //                  主控重新下发即可自动恢复，不需要用户手动解锁
    //   空字符串   —— 未锁定
    lockedReason: '',
    lastApplied: null,
    netLog: []
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
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // ============================================================
  // 步骤 ①：连接蓝牙
  // ============================================================
  function bleStateText() {
    if (W.ble.isMock && W.ble.isMock()) return '模拟输出';
    if (W.ble.connected) return '已连接';
    return '未连接';
  }

  function bindWizard() {
    $('btnConnectBle').onclick = function () {
      if (!navigator.bluetooth) {
        $('bleErr').textContent = '此浏览器不支持 Web Bluetooth，请用 Chrome / Edge。';
        return;
      }
      $('bleErr').textContent = '';
      W.ble.connect().then(function (ok) {
        if (ok) {
          S.bluetoothOk = true;
          // 连上蓝牙就真正推进到第②步（填写服务器地址）。
          // 之前这里漏了这一步，S.step 一直是 'ble'，而按钮的可用性判据却要求
          // S.step === 'server' —— 结果地址框永远灰着、两个按钮永远点不动。
          if (S.step === 'ble') S.step = 'server';
          renderWizard();
          toast('蓝牙已连接，可以进入下一步');
        } else {
          $('bleErr').textContent = '连接失败或被取消，请重试。';
        }
      });
    };

    $('btnTestServer').onclick = function () {
      var url = ($('inServer').value || '').trim();
      if (!url) { $('serverErr').textContent = '请填写服务器地址'; return; }
      $('serverErr').textContent = '';
      $('serverTestOut').textContent = '正在测试…';
      testServer(url);
    };

    $('btnCreateRoom').onclick = function () {
      var localMode = $('chkLocalMode') && $('chkLocalMode').checked;
      if (localMode) {
        // 本地调试：不连服务器，直接在同一浏览器的两个标签页之间建立会话。
        // 房间号随便给一个固定值，主控端也用"本地调试"模式填同样的号即可。
        S.serverUrl = 'local://debug';
        createRoom(null, 'broadcast', '00000001');
        return;
      }
      var url = ($('inServer').value || '').trim();
      if (!url) { $('serverErr').textContent = '请填写服务器地址'; return; }
      S.serverUrl = url;
      createRoom(url, 'websocket', '');
    };

    // 步骤②的回车也触发测试
    $('inServer').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('btnTestServer').click(); }
    });

    // 「本地调试模式」勾选状态一变就必须重渲染向导。
    //   否则按钮的 disabled 状态和输入框的启用状态都不会更新 ——
    //   用户明明勾了本地模式，下面的「测试连接」「创建房间」却还是灰的，点不动。
    var chk = $('chkLocalMode');
    if (chk) chk.addEventListener('change', function () { renderWizard(); });

    // 「重新设置」：停掉当前会话，回到第②步，让用户能改服务器地址重来。
    //   没有它的话，一旦进入 room 步骤就没有任何退路（这是之前的一个设计漏洞）。
    var reset = $('btnReset');
    if (reset) reset.onclick = function () {
      if (S.session) { try { S.session.stop('user-reset'); } catch (e) { } S.session = null; }
      S.room = '';
      S.step = 'server';
      $('roomErr').textContent = '';
      $('serverErr').textContent = '';
      $('roomOut').innerHTML = '';
      // 本地调试模式下用户可能压根没连过蓝牙，不要把他卡在 ble；
      // 一律退回第②步（服务器地址），蓝牙没连的提示交给 renderWizard 与创建房间兜底。
      S.step = 'server';
      renderWizard();
      renderBar(null);
      toast('已重置，可以重新填写服务器地址');
    };
  }

  // 测试服务器连通性：只做一次 WS 握手 + ping，不建房
  function testServer(url) {
    var t0 = nowMs();
    var done = false;
    var conn;
    try {
      conn = W.link.Websocket.open({
        url: url,
        onOpen: function () {
          var tOpen = nowMs();
          conn.send(W.link.msgPing(tOpen));
        },
        onMessage: function (m) {
          if (m && m.t === W.protocol.T.PONG) {
            done = true;
            var rtt = nowMs() - t0;
            $('serverTestOut').innerHTML = '<span class="v ok">连接成功</span>　往返延迟 ' + fmtMs(rtt);
            try { conn.close(); } catch (e) { }
          }
        },
        onError: function () {
          if (!done) { $('serverTestOut').innerHTML = '<span class="v bad">连接失败</span>'; }
        },
        onClose: function (reason) {
          if (!done) {
            $('serverTestOut').innerHTML = '<span class="v bad">连接失败（' + esc(reason) + '）</span>';
            $('serverErr').textContent = '请检查地址是否正确、服务是否已启动、是否用了 wss。';
          }
        }
      });
    } catch (e) {
      $('serverTestOut').innerHTML = '<span class="v bad">地址格式不对</span>';
    }
  }

  function createRoom(url, transport, room) {
    $('serverErr').textContent = '';
    $('roomErr').textContent = '';
    // 被控方必须持有蓝牙：没有蓝牙就没有任何东西可以控制。
    // 放在这里兜底是为了让「本地调试模式」不必先连蓝牙也能操作界面（否则按钮点不动），
    // 但真正建房前必须补上。示例/自检页会先注入 mock，所以这里用"真机连上或 mock 已装"作判据。
    if (!W.ble.connected && !(W.ble.isMock && W.ble.isMock())) {
      $('roomErr').textContent = '还没连接蓝牙：请先回到第①步点「连接蓝牙」，被控方必须持有玩具的蓝牙连接。';
      S.step = 'ble';
      renderWizard();
      return;
    }
    if (S.session) { try { S.session.stop('recreate'); } catch (e) { } }
    if (transport === 'broadcast' && !W.link.Broadcast.supported()) {
      $('roomErr').textContent = '此浏览器不支持 BroadcastChannel，请改用服务器模式。';
      return;
    }

    // 新建房间 = 一次全新的会话，默认应当**直接允许输出**。
    //   清掉上一轮遗留的临时停机（失联/蓝牙断开）与旧的对端在线标记、状态基线，
    //   否则新房间里主控一上线发现"字段没变化"就不下发，用户看到的是"连上了但没反应"。
    //   ⚠ 手动急停（emergency）是用户的安全决定，重建房间也不解除，必须由本人点「解锁」。
    if (S.lockedReason !== 'emergency') {
      S.locked = false;
      S.lockedReason = '';
    }
    S.lastApplied = null;
    S.room = '';

    var s = new W.Session({
      role: W.protocol.ROLE.SLAVE,
      transport: transport || 'websocket',
      url: url || '',
      room: room || '',
      onStatus: onSessionStatus,
      onApplyState: applyState,
      onFailSafeStop: failSafeStop,
      onLog: function (level, msg) { S.netLog.push({ t: Date.now(), level: level, msg: msg }); }
    });
    S.session = s;
    S.transport = s.transportKind;
    s.start();
    S.step = 'room';
    renderWizard();
    $('roomOut').textContent = '正在创建房间…';
  }

  // 房间号卡片：房间号 + 「复制房间号」+ 「复制控制链接」
  //   控制链接把「服务器地址 + 房间号」都带上了，主控方打开就自动填好、只需按一下连接。
  //   这比口头报房间号少一轮"你填服务器、我填房间号"的对账，也避免两边填的地址不一致。
  function renderRoomCard() {
    var out = $('roomOut');
    if (!out) return;
    out.style.display = '';
    out.innerHTML =
      '<div class="roomBig" id="roomBig">' + esc(S.room) + '</div>' +
      '<div class="wzHint">把<b>控制链接</b>发给主控方最省事：他打开后服务器地址和房间号都已填好，' +
      '按一下「连接房间」即可。<br>' +
      '只发房间号也行，但主控方需要自己知道服务器地址。</div>';

    var localMode = (S.transport === 'broadcast' || S.serverUrl === 'local://debug');
    var link = W.sharelink ? W.sharelink.build({
      serverUrl: localMode ? '' : S.serverUrl,
      room: S.room,
      localMode: localMode
    }) : '';

    // 链接可读性：太长就截断显示，但复制的是完整内容
    var shown = link.length > 72 ? (link.slice(0, 69) + '…') : link;

    var wrap = document.createElement('div');
    wrap.className = 'roomActs';
    wrap.innerHTML =
      '<input type="text" class="roomLink" id="roomLinkText" readonly value="' + esc(link) + '">' +
      '<div class="roomBtns">' +
      '  <button class="wzBtn primary" id="btnCopyLink">🔗 复制控制链接</button>' +
      '  <button class="wzBtn" id="btnCopyRoom">📋 只复制房间号</button>' +
      '</div>' +
      '<div class="wzHint" id="linkNote">' +
      (localMode
        ? '本地调试模式：链接里带的是「本地直连」标记，主控方打开后会自动勾上本地调试。'
        : '主控方打开链接即可自动填好地址与房间号。') +
      (location.protocol === 'file:'
        ? '<br>⚠ 当前是本地文件打开（file://），链接里的路径只在这台电脑上有效；'
          + '要发给别人请用同一份网页的在线地址，或只发房间号。'
        : '') +
      '</div>';
    out.appendChild(wrap);

    function flash(msg, level) { toast(msg, level); }

    var bl = $('btnCopyLink');
    if (bl) bl.onclick = function () {
      W.sharelink.copyText(link, function (ok, why) {
        if (ok) {
          flash('控制链接已复制，发给主控方即可（他打开就能直接连）');
          var t = $('roomLinkText'); if (t) { t.focus(); t.select(); }
        } else {
          flash(why || '复制失败，请在下方框里手动选中复制', 'warn');
          var t2 = $('roomLinkText'); if (t2) { t2.focus(); t2.select(); }
        }
      });
    };
    var br = $('btnCopyRoom');
    if (br) br.onclick = function () {
      W.sharelink.copyText(S.room, function (ok, why) {
        flash(ok ? '房间号已复制' : (why || ('请手动记录：' + S.room)), ok ? 'info' : 'warn');
      });
    };
  }

  function onSessionStatus(info) {
    // 房间号一拿到就显示
    if (info.room && info.room !== S.room) {
      S.room = info.room;
      if (S.step === 'room') renderRoomCard();
    }
    if (info.peerOnline && S.step === 'room') {
      S.step = 'live';
      renderWizard();
      toast('主控已连接，现在由主控控制');
    }
    if (!info.peerOnline && S.step === 'live') {
      S.step = 'room';
      renderWizard();
    }
    renderBar(info);
    renderInfo(info);
  }

  // ============================================================
  // 应用主控下发的期望状态
  // ============================================================
  function applyState(applied) {
    var prev = S.lastApplied;

    // 主控重新下发 = 链路已经恢复。
    //   如果当前锁定是"失联导致的安全停机"，就自动放行，让主控重新开启输出 ——
    //   否则掉线超过 8 秒之后，主控即使重连成功、状态也下发到了，输出仍被挡住，
    //   用户必须手动点「解锁」，看起来就像"必须重新开一次房间才能恢复"。
    //   ⚠ 手动急停（lockedReason==='emergency'）绝不能被这里解除，那是安全底线。
    if (S.locked && S.lockedReason !== 'emergency') {
      S.locked = false;
      S.lockedReason = '';
      if (S.session) { try { S.session.clearFailSafe(); } catch (e) { } }
      toast('已与主控恢复连接，输出权限已自动放开');
      renderInfo();
    }

    S.lastApplied = applied;
    var eng = W.engine;
    if (!eng) return;

    // ⚠ 这里必须做「只应用真正变化的部分」，否则 A/B 会互相干扰。
    //   引擎的 setEnabled 是有意设计成"每次调用都把时间原点挪到此刻"的
    //   （见 engine.js：连点两次「试一下」也要从波形开头重播）。
    //   而远程同步是一条**幂等**的状态流 —— 主控只是改了 B 通道的参数，
    //   下发的状态里 A 的字段一个都没变；如果这里对 A 也照调一遍 setEnabled，
    //   A 的 startedAt 就会被重置到现在，表现就是"A 的波形突然从头开始播"。
    //   所以逐通道比对，没变化的通道一律不碰引擎。
    var startingUp = false;                 // 本次同步里是否有通道「刚被开启」
    var names = ['A', 'B'];

    names.forEach(function (n) {
      var c = applied.ch[n];
      var p = prev && prev.ch ? prev.ch[n] : null;

      // 1) 波形：指纹变了才换（同一指纹视为同一波形）
      var keyChanged = !p || p.waveKey !== c.waveKey;
      var waveMissing = c.wave && (!eng.ch[n].wave);
      if (keyChanged || waveMissing) {
        if (c.wave) {
          var w = W.protocol.clone(c.wave);
          w.id = 'remote_' + c.waveKey;      // 本机私有 id，仅用于展示
          w.builtin = false;
          eng.setWave(n, w);
          if (W.scope) W.scope.setWave(n, w);
        } else {
          eng.setWave(n, null);
          if (W.scope) W.scope.setWave(n, null);
        }
      }

      // 2) 强度 / 相位：值真的变了才写
      if (!p || p.intensity !== c.intensity) eng.setIntensity(n, c.intensity);
      if (!p || p.phase !== c.phase) eng.setPhase(n, c.phase);
    });

    // 3) 启停：同样只在状态翻转时调用。
    //   setEnabled 会把 startedAt 重置为"此刻"，重复调用 = 波形从头播。
    var running = applied.running && !S.locked;
    names.forEach(function (n) {
      var on = running && applied.ch[n].enabled;
      var was = !!(eng.ch[n] && eng.ch[n].enabled);
      if (on !== was) {
        eng.setEnabled(n, on);
        if (on) startingUp = true;
      }
      syncChk(n, on);
    });

    // 4) 起播相位对齐：只在"有通道刚刚被开启"时做一次。
    //   主控发的是主控时钟下的起播时刻，换算到本端后据此算此刻应处于哪个相位。
    //   注意引擎的 startAt 是连接设备时设的（不在过去），所以用"补相位"而不是改时钟。
    //   绝不能每条状态都做：那样相位会被反复重算，且会掩盖第 3 步真正的时间原点。
    if (startingUp && applied.beatLocal && W.format) {
      names.forEach(function (n) {
        var c = applied.ch[n];
        if (!c.wave || !c.enabled) return;
        if (!eng.ch[n].enabled) return;
        var dur = W.format.durationOf(c.wave);
        if (!(dur > 0)) return;
        var elapsed = (nowMs() - applied.beatLocal) / 1000;
        eng.setPhase(n, ((elapsed % dur) + dur) % dur / dur);
      });
    }

    if (running && !eng.isRunning()) {
      try {
        eng.start();
        if (W.scope) W.scope.startLoop();
      } catch (e) { }
    }
  }

  // 把通道勾选框同步成实际状态（被控端的参数由主控决定，勾选框只是显示）
  function syncChk(n, on) {
    var cb = $('en-' + n);
    if (cb && cb.checked !== !!on) cb.checked = !!on;
  }

  // ============================================================
  // 安全停机：三条路径（自己断 / 服务器通知 / 心跳超时）的唯一出口
  // ============================================================
  function failSafeStop(reason) {
    var eng = W.engine;
    // 这是"失联导致的安全停机"，不是用户主动急停 —— 主控重新下发就应当自动恢复输出。
    //   原来这里一律写成 locked=true 且没有任何解除路径，导致掉线超过 8 秒之后
    //   主控即使重新连上、状态也下发到了（rev 正常推进），输出仍然被死死挡住。
    S.locked = true;
    S.lockedReason = 'failsafe';
    // 与 manualStop 同理：这一步只是"尽最大努力停机"，失败也不能让它阻断
    // 下面必然要执行的 UI 提示与状态刷新（否则界面会停留在"看起来还在跑"的样子）。
    if (eng) {
      try {
        eng.setEnabled('A', false);
        eng.setEnabled('B', false);
        eng.stop('remote-failsafe');
      } catch (e) { }
    }
    try { W.ble.send(0, 0); } catch (e) { }    // 明确补发停机指令
    syncChk('A', false); syncChk('B', false);
    var map = {
      'heartbeat-timeout': '与主控失联超过 8 秒',
      'master-left': '主控已离开房间',
      'transport-closed': '与服务器的连接已断开'
    };
    toast('⚠ 已安全停机：' + (map[reason] || reason) + '（需主控重新下发才能恢复输出）', 'warn');
    S.step = 'room';
    renderWizard();
  }

  function manualStop() {
    var eng = W.engine;
    S.locked = true;
    S.lockedReason = 'emergency';      // 用户主动急停：永久锁定，主控无权解除
    if (eng) {
      try { eng.setEnabled('A', false); eng.setEnabled('B', false); }
      catch (e) { }
    }
    // ⚠ 这两个动作必须各自独立 try。
    //   原来它们和 eng.setEnabled 挤在同一个 try 里，只要 ble.send 先抛异常
    //   （蓝牙刚断开时很常见：mock.write is not a function / GATT 写入失败），
    //   requestStop 就永远不会执行 —— 主控完全收不到急停，仍以为一切正常并继续下发命令。
    //   急停是安全路径，绝不能依赖蓝牙是否健康。
    try { W.ble.send(0, 0); } catch (e) { }
    try { if (S.session) S.session.requestStop('slave-emergency'); } catch (e) { }
    syncChk('A', false); syncChk('B', false);
    toast('已急停并锁定。主控无法解除，只有你能解锁。', 'warn');
    renderInfo();
  }

  function unlock() {
    S.locked = false;
    S.lockedReason = '';
    if (S.session) S.session.clearFailSafe();
    // 必须告诉主控：它无法自行解除急停锁定（安全设计），
    //   不发这条消息的话，被控这边解锁了，主控端的通道复选框却一直是灰的、点不动。
    var ok = false;
    try { ok = !!(S.session && S.session.sayResume && S.session.sayResume('slave-unlock')); } catch (e) { }
    toast(ok ? '已解锁：已通知主控，可以重新开启输出'
             : '已解锁，但没能通知主控（未连接？）：主控界面的勾选框需要等它重新收到状态');
    renderInfo();
  }

  // ============================================================
  // 持续回报本机状态给主控（走 ACK 捎带，不额外开遥测通道）
  //   每隔一小段时间把「蓝牙状态 + 当前实际输出 + 错误计数」塞进 ACK，
  //   主控据此在设备栏显示被控方蓝牙是否正常、并校准它本地推算的示波器。
  // ============================================================
  function reportSelf() {
    if (!S.session || !S.session.isOpen()) return;
    var bleState = 'disconnected';
    if (W.ble.isMock && W.ble.isMock()) bleState = 'mock';
    else if (W.ble.connected) bleState = 'connected';
    var out = { a: 0, b: 0 };
    try {
      if (W.engine && W.engine.out) { out = W.engine.out(); }
    } catch (e) { }
    var err = (W.ble.stats && W.ble.stats.errors) || 0;
    S.session.reportSelf({ ble: bleState, out: { a: out.a, b: out.b }, err: err });
  }

  // ============================================================
  // 渲染
  // ============================================================
  function renderWizard() {
    var order = ['ble', 'server', 'room', 'live'];
    var cur = order.indexOf(S.step);
    ['ble', 'server', 'room'].forEach(function (name, i) {
      var el = $('wz-' + name);
      if (!el) return;
      el.classList.toggle('active', S.step === name);
      el.classList.toggle('done', i < cur && S.step !== name);
    });
    $('wizard').style.display = (S.step === 'live') ? 'none' : '';
    $('slaveMain').style.display = (S.step === 'live') ? '' : 'none';

    // 步骤可用性
    // ⚠ 这里曾经有两个叠加的坑，导致"服务器地址打不了字 / 按钮全灰点不动"：
    //   ① S.step 从来没有被赋值为 'server'（只有 ble / room / live），
    //      所以任何 `S.step === 'server'` 的判据恒为 false；
    //   ② 判据又写成 `S.step !== 'server'`，一进 room 步骤就永久性全锁死，没有退路。
    //   现在改成与"是否已经过了第①步"绑定：只要蓝牙已连上、或处在服务器/房间步骤，
    //   第②步的输入框和两个按钮就一直可用。
    var localMode = !!($('chkLocalMode') && $('chkLocalMode').checked);
    var btOk = !!(S.bluetoothOk || W.ble.connected || (W.ble.isMock && W.ble.isMock()));
    var atServer = (S.step === 'server' || S.step === 'room' || S.step === 'live');
    // 创建房间必须真的持有蓝牙，但界面不因此灰掉按钮 ——
    // 灰掉按钮用户只会以为"点不动"，保留可点并在点击时给出明确原因才是有用的提示。
    var canBuild = localMode || btOk;

    $('btnConnectBle').disabled = (S.step === 'live');        // 进入会话前都可重连
    $('inServer').disabled = localMode;
    $('btnTestServer').disabled = !(canBuild || S.step === 'ble');
    $('btnCreateRoom').disabled = !canBuild;
    if (S.step === 'room') $('roomOut').style.display = '';
    else $('roomOut').style.display = 'none';

    $('bleStateMini').textContent = bleStateText();
    $('bleStateMini').className = 'v ' + (btOk ? 'ok' : 'bad');

    // 本地调试模式的视觉反馈
    if ($('inServer')) {
      $('inServer').placeholder = localMode
        ? '本地调试模式：不需要服务器，直接点下面的「创建房间」'
        : '例如 wss://你的域名 或 你的域名:8080';
    }
    var hint = $('localModeHint');
    if (hint) hint.style.display = localMode ? '' : 'none';
    // 还没连蓝牙时给出明确引导，别让用户以为是按钮坏了
    if ($('wizardHint')) {
      if (!btOk) {
        $('wizardHint').style.display = '';
        $('wizardHint').textContent = '⚠ 还没连接蓝牙：被控方必须持有玩具的蓝牙连接。'
          + (localMode ? '本地调试可以先建房间，但真正操作设备前必须先回到第①步连上蓝牙。'
            : '请先点步骤①的「连接蓝牙」。');
      } else if (S.step === 'room') {
        $('wizardHint').style.display = '';
        $('wizardHint').textContent = '已创建房间。把房间号发给主控方；想改用其它服务器就点上面的「重新设置」。';
      } else {
        $('wizardHint').style.display = 'none';
      }
    }
    // 「重新设置」按钮：仅在已经进入 room 步骤后出现，给用户一条退路
    if ($('btnReset')) $('btnReset').style.display = (S.step === 'room') ? '' : 'none';
  }

  // 顶栏标题：页面名称 + 版本号（版本号来自 sharelink 的常量，升级只改一处）
  function setTbTitle() {
    var el = $('tbTitle');
    if (!el) return;
    el.textContent = (W.sharelink && W.sharelink.titleOf)
      ? W.sharelink.titleOf('远程被控')
      : '🌊 WaveControler · 远程被控';
  }

  function renderBar(info) {
    var bar = $('remoteBar');
    if (!bar) return;
    var inRemote = (S.step === 'live' && info && info.peerOnline);
    var lat = (info && typeof info.selfRtt === 'number') ? info.selfRtt : null;
    var html = '';
    html += '<span class="rbRemoteTag' + (inRemote ? '' : ' local') + '">' +
      (inRemote ? '🌐 远程被控中' : '⚪ 未接入主控') + '</span>';
    if (S.room) html += '<span class="rbSep">│</span><span class="rbItem">房间 <span class="rbRoom">' + esc(S.room) + '</span></span>';
    html += '<span class="rbSep">│</span><span class="rbItem"><span class="rbDot ' +
      (W.ble.connected || (W.ble.isMock && W.ble.isMock()) ? 'on' : 'off') + '"></span>本机蓝牙 ' + esc(bleStateText()) + '</span>';
    html += '<span class="rbSep">│</span><span class="rbItem">主控 ' +
      (info && info.peerOnline ? '在线' : '离线') + '</span>';
    html += '<span class="rbSep">│</span><span class="rbItem">我↔服务器 <span class="rbLat ' + latClass(lat) + '">' + fmtMs(lat) + '</span></span>';
    if (info && typeof info.peerRtt === 'number') {
      html += '<span class="rbSep">│</span><span class="rbItem">主控↔服务器 <span class="rbLat ' +
        latClass(info.peerRtt) + '">' + fmtMs(info.peerRtt) + '</span></span>';
    }
    html += '<span class="rbSep">│</span><span class="rbItem">⏱ 保持前台运行' +
      '<button class="rbHelp" onclick="WC.slaveui.openTip()" title="为什么？">?</button></span>';
    bar.innerHTML = html;
  }

  function renderInfo(info) {
    if (!info) return;
    var st = info.syncState || 'idle';
    var syncTxt = { idle: '未同步', syncing: '同步中', confirmed: '已同步', resending: '重发中', lost: '已失联' }[st] || st;
    var app = S.lastApplied;
    var rows = [
      ['本机蓝牙', bleStateText(), (W.ble.connected || (W.ble.isMock && W.ble.isMock())) ? 'ok' : 'bad'],
      ['主控状态', info.peerOnline ? '在线' : '离线', info.peerOnline ? 'ok' : 'bad'],
      ['同步状态', syncTxt, st === 'confirmed' ? 'ok' : (st === 'lost' ? 'bad' : 'warn')],
      ['当前状态版本', 'rev ' + (info.rev === undefined ? '—' : info.rev), 'mono'],
      ['我↔服务器', fmtMs(info.selfRtt), latClass(info.selfRtt)],
      ['主控↔服务器', fmtMs(info.peerRtt), latClass(info.peerRtt)],
      ['端到端估算', fmtMs(info.endToEndMs), latClass(info.endToEndMs)],
      ['时钟偏差', info.clockOffset === null || info.clockOffset === undefined ? '—' :
        (info.clockOffset > 0 ? '+' : '') + Math.round(info.clockOffset) + 'ms',
        info.clockStable ? 'ok' : 'warn']
    ];
    var html = rows.map(function (r) {
      return '<div><span class="k">' + r[0] + '</span><span class="v ' + (r[2] || '') + '">' + esc(r[1]) + '</span></div>';
    }).join('');
    html += '<div><span class="k">输出通道</span><span class="v">' +
      (app ? ('A ' + (app.ch.A.enabled ? '开' : '关') + ' · B ' + (app.ch.B.enabled ? '开' : '关')) : '—') + '</span></div>';
    html += '<div><span class="k">当前波形</span><span class="v">' +
      esc(app && app.ch.A.wave ? app.ch.A.wave.name : '—') + '</span></div>';
    $('infoGrid').innerHTML = html;

    // 锁定的性质不同，提示也必须不同：
    //   emergency —— 用户急停，只有本人能解
    //   failsafe  —— 失联/蓝牙断开导致的临时停机，主控一恢复就自动放行
    if (S.locked && S.lockedReason === 'emergency') {
      $('lockState').innerHTML = '<div class="lockNote">🔒 已急停并锁定：' +
        '主控无法开启输出，只有你能解锁。</div>';
    } else if (S.locked) {
      $('lockNote') && ($('lockNote').className = 'lockNote');
      $('lockState').innerHTML = '<div class="lockNote">⏸ 已临时停机：' +
        '与主控失联或蓝牙已断开。链路恢复后主控一重新下发就会自动继续，无需手动解锁。</div>';
    } else {
      $('lockState').innerHTML = '';
    }
    // 临时停机没必要让用户点「解锁」（会自动恢复），只有急停才需要那个按钮
    $('btnUnlock').style.display = (S.locked && S.lockedReason === 'emergency') ? '' : 'none';
  }

  // ============================================================
  // 保持前台运行说明（复用控制器那条提示的文案）
  // ============================================================
  function openTip() {
    $('tipModal').classList.add('open');
  }
  function closeTip() { $('tipModal').classList.remove('open'); }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    W.store.init();
    bindWizard();
    $('btnManualStop').onclick = manualStop;
    $('btnUnlock').onclick = unlock;
    $('tipClose').onclick = closeTip;
    $('tipModal').onclick = function (e) { if (e.target === $('tipModal')) closeTip(); };

    // 蓝牙状态变化时刷新界面（含断开），并立刻回报主控
    W.ble.onState = function (on, detail) {
      S.bluetoothOk = !!on;
      // 蓝牙断开时本机已经没有任何输出通道，必须停机并挡住主控下发；
      //   但这是"链路问题"而非用户急停，所以标成 failsafe —— 蓝牙接回来之后
      //   主控重新下发即可自动恢复，不必让用户再去点「解锁」。
      if (!on) {
        S.locked = true;
        S.lockedReason = 'failsafe';
      }
      renderWizard();
      renderBar(S.session ? S.session.info() : null);
      reportSelf();
      if (detail) toast(detail, on ? 'info' : 'warn');
    };

    // 真的断开蓝牙时也要停机并回传状态
    window.addEventListener('beforeunload', function () {
      try { W.ble.send(0, 0); } catch (e) { }
    });

    renderWizard();
    renderBar(null);
    renderInfo({ syncState: 'idle' });
    setTbTitle();

    // 每 500ms 轮询一次：刷新界面 + 回报本机状态给主控
    setInterval(function () {
      renderWizard();
      var info = S.session ? S.session.info() : null;
      renderBar(info);
      reportSelf();
    }, 500);
  }

  W.slaveui = {
    init: init, state: S,
    openTip: openTip, closeTip: closeTip,
    failSafeStop: failSafeStop, applyState: applyState
  };

  function boot() { try { init(); } catch (e) { console.log('被控端初始化失败：', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
