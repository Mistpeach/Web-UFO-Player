// ============================================================
// ui.js - 界面装配（工具栏 / 通道卡 / 波形库抽屉 / 导入导出模态框 / 状态栏）
// 全部走 WC.* 的公开接口，不重复实现业务逻辑
// ============================================================
(function () {
  'use strict';
  var WC = window.WC = window.WC || {};
  var F = WC.format;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    lib: [],                 // [{id, name, builtin, meta}]
    cache: {},               // id -> wave
    presetsById: {},
    sel: { A: null, B: null },
    settings: {},
    pickFor: null,           // 打开抽屉时希望被赋值的通道
    pending: null,           // 待确认的导入
    tab: 'import'
  };

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg, level) {
    var el = $('toast');
    if (!el) return;
    el.className = 'toast show ' + (level || 'info');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, level === 'warn' ? 6000 : 3200);
  }

  // ---------------- 通道卡片 ----------------
  function buildCards() {
    var html = ['A', 'B'].map(function (n) {
      return '' +
        '<section class="chCard" id="card' + n + '">' +
        '  <div class="chHead">' +
        '    <label class="chToggle"><input type="checkbox" id="en-' + n + '" onchange="WC.ui.toggleCh(\'' + n + '\')"> <b>通道 ' + n + '</b></label>' +
        '    <button class="chWave" id="waveName-' + n + '" onclick="WC.ui.pickFor(\'' + n + '\')" title="点击选择波形">选择波形…</button>' +
        '    <span class="chPeak" id="peak-' + n + '"></span>' +
        '  </div>' +
        '  <div class="chCtl">' +
        '    <label>强度 <input type="range" id="int-' + n + '" min="10" max="150" step="1" value="100" oninput="WC.ui.onIntensity(\'' + n + '\')"> <span class="num" id="intVal-' + n + '">100%</span></label>' +
        '    <label>相位 <input type="range" id="ph-' + n + '" min="0" max="100" step="1" value="0" oninput="WC.ui.onPhase(\'' + n + '\')"> <span class="num" id="phVal-' + n + '">0%</span></label>' +
        '    <button id="test-' + n + '" class="ghost" onclick="WC.ui.testPulse(\'' + n + '\')">▶ 试一下</button>' +
        '  </div>' +
        '  <div class="scopeWrap">' +
        '    <canvas class="scope" id="scope-' + n + '"></canvas>' +
        '    <div class="scopeMeta"><span id="live-' + n + '">+0 / -0</span><span id="lim-' + n + '" class="lim"></span></div>' +
        '  </div>' +
        '</section>';
    }).join('');
    $('cards').innerHTML = html;
  }

  function updateCard(n) {
    var id = state.sel[n];
    var w = id ? state.cache[id] : null;
    var btn = $('waveName-' + n);
    if (btn) btn.textContent = w ? w.name : '选择波形…';
    if (btn) btn.classList.toggle('empty', !w);
    var card = $('card' + n);
    if (card) card.classList.toggle('on', !!WC.engine.ch[n].enabled);
    var pk = $('peak-' + n);
    if (pk) pk.textContent = w ? ('原始峰值 ' + F.peakOf(w, n) + ' · ' + F.describe(w)) : '';
    var lim = $('lim-' + n);
    if (lim) {
      var k = WC.engine.ch[n].intensity;
      var over = w && F.peakOf(w, n) * k > 127.5;
      lim.textContent = over ? '⚠ 强度×原始峰值已超过 127，超出的部分会被夹到上限' : '';
    }
  }

  function updateRunUI() {
    var run = WC.engine.isRunning();
    var br = $('btnRun'), bs = $('btnStop');
    if (br) br.textContent = run ? '⏸ 暂停' : '▶ 开始';
    if (bs) {
      bs.classList.toggle('armed', run);
      bs.textContent = run ? '⏹ 急停(双击)' : '⏹ 急停(双击)';
      if (!run) clearStopArm();
    }
  }

  function startEngine() {
    if (!WC.ble.isReady()) toast('未连接设备：正在离线预览，不会真的输出到玩具', 'warn');
    WC.engine.start();
    WC.scope.startLoop();
    updateRunUI();
  }

  function stopEngine(reason) {
    WC.engine.stop(reason || 'user');
    updateRunUI();
  }

  function saveSettings() {
    state.settings.selA = state.sel.A;
    state.settings.selB = state.sel.B;
    state.settings.intA = WC.engine.ch.A.intensity;
    state.settings.intB = WC.engine.ch.B.intensity;
    state.settings.phA = WC.engine.ch.A.phase;
    state.settings.phB = WC.engine.ch.B.phase;
    state.settings.enA = WC.engine.ch.A.enabled;
    state.settings.enB = WC.engine.ch.B.enabled;
    WC.store.saveSettings(state.settings);
  }

  // ---------------- 波形库（抽屉） ----------------
  function loadPresets() {
    var arr = window.UFO_WAVE_PRESETS || [];
    for (var i = 0; i < arr.length; i++) {
      try {
        var w = F.normalize(arr[i], { id: arr[i].id });
        state.presetsById[w.id] = w;
        state.cache[w.id] = w;
      } catch (e) { console.log('示例波形无效：', arr[i], e); }
    }
  }

  async function refreshLib() {
    var metas = await WC.store.list(), id, i;
    state.lib = [];
    for (id in state.presetsById) {
      if (!state.presetsById.hasOwnProperty(id)) continue;
      var w = state.presetsById[id];
      state.lib.push({
        id: w.id, name: w.name, builtin: true,
        meta: { duration: w.duration, points: w.channels.A.length + w.channels.B.length }
      });
    }
    for (i = 0; i < metas.length; i++) state.lib.push({ id: metas[i].id, name: metas[i].name, builtin: false, meta: metas[i] });
    renderLib();
  }

  function renderLib() {
    var q = ($('libSearch').value || '').trim().toLowerCase();
    var groups = [{ title: '内置示例（只读）', items: [] }, { title: '我的波形', items: [] }], i, j;
    for (i = 0; i < state.lib.length; i++) {
      var it = state.lib[i];
      if (q && it.name.toLowerCase().indexOf(q) < 0) continue;
      (it.builtin ? groups[0] : groups[1]).items.push(it);
    }
    var html = '';
    for (i = 0; i < groups.length; i++) {
      if (!groups[i].items.length) continue;
      html += '<div class="libGroup">' + esc(groups[i].title) + ' <span class="cnt">' + groups[i].items.length + '</span></div>';
      for (j = 0; j < groups[i].items.length; j++) {
        var e = groups[i].items[j];
        var inA = state.sel.A === e.id, inB = state.sel.B === e.id;
        html += '<div class="libItem' + (inA || inB ? ' used' : '') + '" data-id="' + esc(e.id) + '" onclick="WC.ui.pick(\'' + esc(e.id) + '\')">' +
          '<div class="libName">' + esc(e.name) + '</div>' +
          '<div class="libMeta">' + (e.meta.duration ? e.meta.duration + 's · ' : '') + (e.meta.points || 0) + ' 断点' +
          (inA ? ' · <b>已用于 A</b>' : '') + (inB ? ' · <b>已用于 B</b>' : '') + '</div>' +
          '</div>';
      }
    }
    $('libList').innerHTML = html || '<div class="libEmpty">没有匹配的波形</div>';
    $('libCount').textContent = '(' + state.lib.length + ')';
  }

  async function getWave(id) {
    if (!id) return null;
    if (state.cache[id]) return state.cache[id];
    var w = await WC.store.get(id);
    if (w) state.cache[id] = w;
    return w;
  }

  // 选波形只做「赋值」，绝不改变输出状态 —— 不勾选复选框、不启动引擎。
  // 理由：用户选完波形通常还要调强度/相位，切换波形时刺激强度会变，必须先手动确认再开启输出。
  // 想直接看/听效果请用通道卡上的「▶ 试一下」（它临时试 2 个完整周期，结束后自动停机并恢复原状态）。
  // opts.quiet 静默赋值（初始化还原时用，不弹提示）
  async function selectWave(name, id, opts) {
    opts = opts || {};
    var w = await getWave(id);
    if (!w) { toast('波形读取失败（可能已被删除）', 'warn'); return false; }
    state.sel[name] = id;
    WC.engine.setWave(name, w);
    WC.scope.setWave(name, w);
    updateCard(name);
    WC.scope.markDirty();
    saveSettings();
    renderLib();
    if (opts.quiet !== true) toast('通道 ' + name + ' 已选用「' + w.name + '」（输出状态未改变，确认参数后再勾选启用）');
    return true;
  }

  // 波形库的目标通道：点了卡片就赋给该通道；否则优先第一个还没选波形的通道，都选了则用 A
  function pickTarget() {
    if (state.pickFor) return state.pickFor;
    if (!state.sel.A) return 'A';
    if (!state.sel.B) return 'B';
    return 'A';
  }

  async function pick(id) {
    var target = pickTarget();
    var ok = await selectWave(target, id);
    state.pickFor = null;
    if (ok) closeLib();
  }

  function openLib(forCh) {
    state.pickFor = forCh || null;
    var target = pickTarget();
    $('libFoot').innerHTML = '👆 点击波形即赋给「通道 ' + target + '」（不会开启输出，需自行勾选启用并调节强度）｜点遮罩、Esc 或「关闭」收起';
    $('sidebar').classList.add('open');
    $('backdrop').classList.add('open');
    var bl = $('btnLib'); if (bl) bl.classList.add('drawer-on');
    $('sidebar').setAttribute('aria-hidden', 'false');
    renderLib();
  }

  function closeLib() {
    $('sidebar').classList.remove('open');
    $('backdrop').classList.remove('open');
    var bl2 = $('btnLib'); if (bl2) bl2.classList.remove('drawer-on');
    $('sidebar').setAttribute('aria-hidden', 'true');
  }

  function toggleLib() {
    if ($('sidebar').classList.contains('open')) closeLib(); else openLib(null);
  }

  // ---------------- 状态栏 / 实时值 ----------------
  var rate = { lastAt: 0, lastSends: 0, lastTicks: 0, sps: 0, tps: 0 };

  function renderStatus() {
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!rate.lastAt) { rate.lastAt = now; rate.lastSends = WC.ble.stats.sent; rate.lastTicks = WC.engine.stats.ticks; }
    var dt = (now - rate.lastAt) / 1000;
    if (dt >= 0.45) {
      rate.sps = Math.round((WC.ble.stats.sent - rate.lastSends) / dt);
      rate.tps = Math.round((WC.engine.stats.ticks - rate.lastTicks) / dt);
      rate.lastSends = WC.ble.stats.sent; rate.lastTicks = WC.engine.stats.ticks; rate.lastAt = now;
    }
    var u = WC.store.usage();
    $('stConn').textContent = WC.ble.isMock() ? '🧪 模拟输出' : (WC.ble.connected ? '🔵 已连接' : '⚪ 未连接');
    $('stRun').textContent = WC.engine.isRunning() ? '▶ 运行中' : '⏸ 已停止';
    $('stRate').textContent = rate.tps + ' tick/s · ' + rate.sps + ' 包/s';
    $('stErr').textContent = '错误 ' + WC.ble.stats.errors + (WC.ble.stats.lastError ? '（' + WC.ble.stats.lastError.slice(0, 20) + '）' : '');
    $('stStore').textContent = '用户波形 ' + u.count + ' 个 · ' + Math.round(u.bytes / 1024) + 'KB / ' + Math.round(u.hard / 1024) + 'KB' + (WC.store.available ? '' : ' · ⚠ 存储不可用');
  }

  function renderLive() {
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    ['A', 'B'].forEach(function (n) {
      var c = WC.engine.ch[n];
      var v = (c.enabled && WC.engine.isRunning()) ? WC.engine.valueOf(n, now) : 0;
      var el = $('live-' + n);
      if (el) el.textContent = (v > 0 ? '+' : '') + v + (c.enabled ? '' : '（停用）');
    });
  }

  // ---------------- 工具栏动作 ----------------
  async function connect() { await WC.ble.connect(); }

  function emergencyStop() {
    cancelAllTests();
    var was = WC.engine.stop('emergency');
    WC.scope.stopLoop();
    updateRunUI(); renderStatus();
    if (!was) toast('已归零（本来就没有在运行）', 'warn');
  }

  // ---------- 全部停止：防误触，需在 0.8 秒内连点两次 ----------
  // 用「两次 click + 时间窗」而不是 ondblclick —— 触屏上 dblclick 不可靠
  var STOP_WINDOW_MS = 800;
  var stopArm = { armed: false, timer: null };

  function clearStopArm() {
    stopArm.armed = false;
    if (stopArm.timer) { clearTimeout(stopArm.timer); stopArm.timer = null; }
    var b = $('btnStop');
    if (b) b.classList.remove('confirm');
  }

  function requestStop() {
    if (!WC.engine.isRunning()) { emergencyStop(); return; }   // 没在输出，无需确认
    if (stopArm.armed) { clearStopArm(); emergencyStop(); return; }
    stopArm.armed = true;
    var b = $('btnStop');
    if (b) b.classList.add('confirm');
    toast('⚠ 防误触：请在 0.8 秒内再点一次「急停」才会立即归零', 'warn');
    stopArm.timer = setTimeout(clearStopArm, STOP_WINDOW_MS);
  }

  function toggleRun() {
    cancelAllTests();      // 先作废试听定时器，否则它稍后会把「试听前的勾选状态」弹回来
    if (WC.engine.isRunning()) {
      WC.engine.stop('user'); WC.scope.stopLoop(); updateRunUI(); toast('已暂停（输出已归零）');
    } else startEngine();
  }

  function toggleCh(n) {
    var on = $('en-' + n).checked;
    WC.engine.setEnabled(n, on);
    updateCard(n);
    saveSettings();
    // 关断时立刻补发一条 0,0：引擎下一 tick 归零虽也会发，但明确停机更稳妥，
    // 尤其波形首位非 0 时用户会期望「一取消勾选就停」。
    if (!on) { try { WC.ble.send(0, 0); } catch (e) { } }
  }

  function onIntensity(n) {
    var k = (parseInt($('int-' + n).value, 10) || 100) / 100;
    WC.engine.setIntensity(n, k);
    $('intVal-' + n).textContent = Math.round(k * 100) + '%';
    WC.scope.markDirty(); WC.scope.renderOnce();
    updateCard(n); saveSettings();
  }

  function onPhase(n) {
    var r = (parseInt($('ph-' + n).value, 10) || 0) / 100;
    WC.engine.setPhase(n, r);
    $('phVal-' + n).textContent = Math.round(r * 100) + '%';
    saveSettings();
  }

  // ---------- 「▶ 试一下」：完整播放 2 个波形周期后自动停机 ----------
  // 三条硬约束（都是踩过的坑）：
  //   1) 周期结束后必须发停机指令 —— 波形首位可能不是 0，只撤 enabled 还不够，
  //      必须确认真的把 0 发出去了，否则电机会一直转。
  //   2) 绝不碰引擎的启停状态（不 start / 不 stop），急停的恢复状态由急停自己管。
  //   3) 勾选即把该通道时间轴归零，所以试听一定从波形 t=0 开始，不会从中间切入。
  var testTimers = { A: null, B: null };
  var TEST_CYCLES = 2;           // 试听几个完整周期
  var TEST_MAX_MS = 300000;      // 极端时长的兜底；只截断整周期数，不会把波形切一半

  function cancelTest(n) {
    var t = testTimers[n];
    if (!t) return;
    clearTimeout(t.id);
    testTimers[n] = null;
    t.done();
  }

  function cancelAllTests() {
    ['A', 'B'].forEach(function (n) {
      if (testTimers[n]) cancelTest(n);
    });
  }

  function testPulse(n) {
    if (!WC.ble.isReady()) { toast('未连接设备（也没开模拟输出），无法测试输出', 'warn'); return; }
    if (!WC.engine.ch[n].wave) { toast('通道 ' + n + ' 还没选波形：请先点「选择波形…」选一个', 'warn'); return; }

    cancelTest(n);                     // 连点同一通道：上一次试听作废，不留会还原状态的野定时器

    var was = WC.engine.ch[n].enabled;
    var oneMs = F.durationOf(WC.engine.ch[n].wave) * 1000;
    // 只允许裁掉整周期，绝不把波形切一半：超长波形至少也要完整播完 1 个周期
    var cycles = Math.max(1, Math.min(TEST_CYCLES, Math.floor(TEST_MAX_MS / oneMs)));
    var durMs = oneMs * cycles;

    // 不必手动对齐相位：setEnabled(n, true) 会把该通道的时间原点挪到此刻，
    // 所以试听天然从波形 t=0 开始（相位滑杆的偏移照旧生效，不会被清掉）。

    // 引擎没在跑（刚急停过）时才拉起来；已在跑则完全不动它
    if (!WC.engine.isRunning()) startEngine();

    WC.engine.setEnabled(n, true);     // 放在 startEngine 之后：确保时间原点取的是引擎已就绪的时刻
    var box = $('en-' + n);
    if (box) box.checked = true;
    updateCard(n);

    var finish = function () {
      WC.engine.setEnabled(n, was);
      var b2 = $('en-' + n);
      if (b2) b2.checked = was;
      updateCard(n);
      // 关键：波形结束就明确发一条停机指令。撤 enabled 只是让引擎不再输出非零值，
      // 这里再补一发 0,0，确保首位非 0 的波形不会让电机继续转。
      try { WC.ble.send(0, 0); } catch (e) { }
    };

    testTimers[n] = {
      id: setTimeout(function () {
        testTimers[n] = null;
        finish();
      }, durMs),
      done: finish
    };
    toast('通道 ' + n + ' 正在试听 ' + cycles + ' 个完整周期（' + (durMs / 1000).toFixed(2) + ' 秒），结束会自动停机…');
  }

  // ---------------- 导入导出模态框 ----------------
  var HELP_IMPORT = '' +
    '<b>怎么用</b>：① 选文件 / 选文件夹 → ② 看下面的「转换提示 + 预览」→ ③ 确认导入。<br>' +
    '<b>「选择文件」能吃三种东西</b>：单个波形（<code>.json</code> / <code>.csv</code>）、一次多选多个文件、以及<b>波形包</b>（一个 <code>.json</code>，里面是 <code>{ waves: [...] }</code> 打包了多个波形）—— 程序按文件内容自动识别，不需要挑按钮。<br>' +
    '<b>批量导入</b>：直接「选择文件夹」，程序会递归扫描里面的 <code>.json/.csv</code>，<u>不需要压缩包</u>。<br>' +
    '<b>重要</b>：本程序<u>底层只使用 JSON</u>。CSV 只是交换格式，导入时会被自动转换，转换可能出现偏差 —— 请务必核对转换提示。';

  var HELP_EXPORT = '' +
    '<b>导出会包含什么</b>：波形名、循环时长、插值模式(阶梯/线性)、原始速度基准、A/B 两通道全部断点。<br>' +
    '<b>JSON</b>（推荐）= 完整无损、可再次导入；<b>CSV</b> = 只有时间戳/方向/速度，<u>会丢失名称、时长、线性插值等元数据</u>，仅用于和旧脚本互通。<br>' +
    '<b>批量导出</b>：①「下载全部（波形包 JSON）」一个文件搞定，便于备份/分享；②「写入文件夹」每个波形一个独立文件（可读、可用 git 管理），<u>不需要压缩包</u>。<br>' +
    '<b>建议</b>：清空浏览器数据会丢本地波形，请定期导出备份。';

  function openIo(tab) { state.tab = tab || 'import'; renderIo(); $('ioModal').classList.add('open'); }
  function closeIo() { $('ioModal').classList.remove('open'); }
  function setTab(t) { state.tab = t; renderIo(); }

  function renderIo() {
    var tabs = [['import', '📥 导入'], ['export', '📤 导出'], ['manage', '🧹 管理'], ['help', '📖 说明']];
    $('ioTabs').innerHTML = tabs.map(function (t) {
      return '<button class="ioTab' + (state.tab === t[0] ? ' on' : '') + '" onclick="WC.ui.setTab(\'' + t[0] + '\')">' + t[1] + '</button>';
    }).join('');
    $('ioBody').innerHTML = state.tab === 'export' ? exportHtml()
      : state.tab === 'manage' ? manageHtml()
        : state.tab === 'help' ? helpHtml() : importHtml();
  }

  function importHtml() {
    return '' +
      '<div class="helpBox">' + HELP_IMPORT + '</div>' +
      '<div class="ioRow">' +
      '<button class="primary" onclick="WC.ui.chooseFiles()">📄 选择文件（可多选）</button>' +
      '<button onclick="WC.ui.chooseFolder()">📁 选择文件夹（批量）</button>' +
      '</div>' +
      '<div class="ioRow"><label>遇到重名波形时：<select id="conflict">' +
      '<option value="copy">保留两份（新的加「副本」）</option>' +
      '<option value="overwrite">覆盖同名波形</option>' +
      '<option value="skip">跳过不导入</option>' +
      '</select></label></div>' +
      '<div id="importPreview"></div>';
  }

  function wavePreviewTable(waves) {
    var rows = waves.map(function (w, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(w.name) + '</td><td>' + w.duration + 's</td><td>' +
        (w.channels.A.length + w.channels.B.length) + '</td><td>' + F.peakOf(w, 'A') + ' / ' + F.peakOf(w, 'B') +
        '</td><td>' + (w.mode === 'linear' ? '线性' : '阶梯') + '</td></tr>';
    }).join('');
    return '<table class="prev"><tr><th>#</th><th>名称</th><th>循环时长</th><th>断点</th><th>峰值 A/B</th><th>模式</th></tr>' + rows + '</table>';
  }

  function warnList(list) {
    if (!list.length) return '';
    return '<ul class="warnList">' + list.map(function (w) {
      return '<li class="' + (w.level === 'warn' ? 'w' : 'i') + '">' +
        (w.file ? '<span class="fname">' + esc(w.file) + '</span> ' : '') + esc(w.text) + '</li>';
    }).join('') + '</ul>';
  }

  function showPreview(parsed, label) {
    state.pending = parsed;
    var warns = parsed.warnings.filter(function (w) { return w.level === 'warn'; });
    var infos = parsed.warnings.filter(function (w) { return w.level === 'info'; });
    var html = '';

    if (parsed.csvCount) {
      html += '<div class="warnBig">' +
        '<div class="warnTitle">⚠ 检测到 ' + parsed.csvCount + ' 个 CSV 文件：需要转换成 JSON，请先看清下面几点</div>' +
        '<ul>' +
        '<li>本程序<u>底层只使用 JSON</u>（ufo-wave/1），CSV 仅是交换格式；导入时会被<b>自动转换</b>，转换是<b>有损/近似</b>的。</li>' +
        '<li><b>时间单位</b>：按「1 单位 = 0.1 秒」解析（沿用原脚本约定，时间戳 6636 = 663.6 秒）；若你的文件是以秒为单位，请在文件头加 <code>#unit=s</code> 再重新导入。</li>' +
        '<li><b>方向</b>：CSV 的「方向 = 1(反转)」会被转成<b>负值</b>；本程序 JSON 没有方向列，用正负号表示正/反转。</li>' +
        '<li><b>速度</b>：绝对值超过 127 会被<b>夹取</b>到 127（BLE 指令上限），实际会比原文件弱一点。</li>' +
        '<li><b>3 列格式</b>（时间戳/方向/速度）：A/B 两通道会变成<b>完全相同</b>的波形。</li>' +
        '<li><b>循环结束点</b>：最后一个断点若正好落在 t = 时长处，循环回绕时它<b>不会被播放</b>。</li>' +
        '<li><b>元数据会丢失</b>：CSV 记不了名称/时长/线性插值，转换后这些用默认值补齐（名称取文件名、模式=阶梯、时长=最后一个时间戳）。</li>' +
        '<li><b>不可逆</b>：再导出成 CSV 只会得到时间戳/方向/速度。若要长期保存请导出 JSON。</li>' +
        '</ul>' +
        '<div class="warnFoot">下面表格里每个波形都已经过上述转换，请核对（尤其「循环时长」是否符合预期）后再确认导入。</div>' +
        '</div>';
    }

    html += '<div class="prevBox"><div class="prevHead">解析结果（' + esc(label || '') + '）：共 ' + parsed.waves.length + ' 个波形' +
      (parsed.jsonCount ? '，JSON ' + parsed.jsonCount + ' 个' : '') + (parsed.csvCount ? '，CSV ' + parsed.csvCount + ' 个' : '') + '</div>';
    html += wavePreviewTable(parsed.waves);
    if (warns.length) html += '<div class="sub">⚠ 需要留意的提示</div>' + warnList(warns);
    if (infos.length) html += '<div class="sub">ℹ 转换说明</div>' + warnList(infos);
    if (parsed.errors.length) {
      html += '<div class="sub">❌ 无法解析的文件</div>' +
        warnList(parsed.errors.map(function (t) { return { level: 'warn', text: t }; }));
    }
    html += '<div class="ioRow"><button class="primary" onclick="WC.ui.confirmImport()">确认导入 ' + parsed.waves.length + ' 个波形</button>' +
      '<button onclick="WC.ui.cancelImport()">取消</button></div></div>';

    $('importPreview').innerHTML = html;
  }

  function cancelImport() { state.pending = null; renderIo(); }

  async function runImport(items, label) {
    try {
      var parsed = await WC.io.parseFiles(items);
      if (!parsed.waves.length) {
        state.pending = null;
        $('importPreview').innerHTML = '<div class="warnBig">没有解析出任何波形。' +
          warnList(parsed.errors.map(function (t) { return { level: 'warn', text: t }; })) + '</div>';
        return;
      }
      showPreview(parsed, label);
    } catch (e) {
      toast('导入失败：' + (e.message || e), 'warn');
    }
  }

  function chooseFiles() { $('fileInput').click(); }

  async function onFiles(input) {
    if (!input.files || !input.files.length) return;
    var items = await WC.io.readFiles(input.files);
    input.value = '';
    await runImport(items, '已选 ' + items.length + ' 个文件');
  }

  async function chooseFolder() {
    try {
      var items = await WC.io.pickFolderToImport();
      await runImport(items, '文件夹 → ' + items.length + ' 个文件');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('文件夹导入失败：' + (e.message || e), 'warn');
    }
  }

  async function confirmImport() {
    if (!state.pending) return;
    var sel = $('conflict');
    var how = sel ? sel.value : 'copy';
    var res = await WC.store.importBundle({ waves: state.pending.waves }, { onConflict: how });
    state.pending = null;
    for (var k in state.cache) if (!state.presetsById[k]) delete state.cache[k];
    await refreshLib();
    var msg = '导入完成：新增 ' + res.added + '，覆盖 ' + res.overwritten + '，副本 ' + res.copied + '，跳过 ' + res.skipped;
    if (res.errors.length) msg += '；失败 ' + res.errors.length + ' 个：' + res.errors.slice(0, 2).join(' / ');
    WC.ui.lastImportResult = res;
    toast(msg, res.errors.length ? 'warn' : 'info');
    renderIo();
    renderStatus();
  }

  function exportHtml() {
    var user = state.lib.filter(function (it) { return !it.builtin; });
    var u = WC.store.usage();
    var curA = state.sel.A ? (state.cache[state.sel.A] || {}).name : '';
    var curB = state.sel.B ? (state.cache[state.sel.B] || {}).name : '';
    return '' +
      '<div class="helpBox">' + HELP_EXPORT + '</div>' +
      '<div class="ioRow">' +
      '<button class="primary" onclick="WC.ui.exportAll()">📦 下载全部（波形包 JSON）</button>' +
      '<button onclick="WC.ui.exportFolder()">📁 写入文件夹（每个波形一个文件）</button>' +
      '</div>' +
      '<div class="ioRow">' +
      '<button onclick="WC.ui.exportCurrent(\'A\')">⬇ 通道 A：导出 JSON</button>' +
      '<button onclick="WC.ui.exportCurrent(\'A\',true)">⬇ 通道 A：导出 CSV</button>' +
      '<button onclick="WC.ui.exportCurrent(\'B\')">⬇ 通道 B：导出 JSON</button>' +
      '<button onclick="WC.ui.exportCurrent(\'B\',true)">⬇ 通道 B：导出 CSV</button>' +
      '</div>' +
      '<div class="sub">当前状态</div>' +
      '<div class="kv">我的波形：<b>' + user.length + '</b> 个（内置示例 ' + (state.lib.length - user.length) + ' 个不参与导出）</div>' +
      '<div class="kv">本地存储占用：约 ' + Math.round(u.bytes / 1024) + ' KB / 上限 ' + Math.round(u.hard / 1024) + ' KB</div>' +
      '<div class="kv">通道 A：' + (curA ? esc(curA) : '未选择') + '　通道 B：' + (curB ? esc(curB) : '未选择') + '</div>' +
      (WC.store.available ? '' : '<div class="warnBig">⚠ 本地存储不可用：' + esc(WC.store.reason) + '（仍可导入/导出文件）</div>');
  }

  function manageHtml() {
    var user = state.lib.filter(function (it) { return !it.builtin; });
    if (!user.length) {
      return '<div class="helpBox">还没有你自己的波形。用「📥 导入」把波形文件导进来，之后就能在这里重命名 / 改时长 / 删除。</div>' +
        '<div class="ioRow"><button class="primary" onclick="WC.ui.setTab(\'import\')">去导入</button></div>';
    }
    var rows = user.map(function (it) {
      return '<div class="mgItem">' +
        '<div class="mgMain"><div class="mgName">' + esc(it.name) + '</div>' +
        '<div class="mgMeta">' + (it.meta.duration || '?') + 's · ' + (it.meta.points || 0) + ' 断点 · ' +
        (it.meta.mode === 'linear' ? '线性' : '阶梯') + '</div></div>' +
        '<div class="mgBtns">' +
        '<button onclick="WC.ui.renameWave(\'' + esc(it.id) + '\')">重命名</button>' +
        '<button onclick="WC.ui.editDuration(\'' + esc(it.id) + '\')">改时长</button>' +
        '<button onclick="WC.ui.exportById(\'' + esc(it.id) + '\')">导出</button>' +
        '<button onclick="WC.ui.viewRaw(\'' + esc(it.id) + '\')">看 JSON</button>' +
        '<button class="danger" onclick="WC.ui.deleteWave(\'' + esc(it.id) + '\')">删除</button>' +
        '</div></div>';
    }).join('');
    return '<div class="helpBox">管理你导入/创建的波形（内置示例不可修改）。<b>改时长</b>会影响循环周期：如果最后一个断点正好在时长处，把它改大就能让末尾有停顿。</div>' +
      rows + '<div id="rawView"></div>';
  }

  function helpHtml() {
    return '' +
      '<div class="helpBox">' +
      '<b>波形 = 短小的循环动作模板</b>（几秒~几十秒），和「脚本」不同：脚本是 10~20 分钟的长流程，波形选定后会<b>一直循环</b>。<br>' +
      '<b>两个通道独立</b>：A/B 各自的波形、强度、相位互不影响；每 50ms（20Hz）把两个值打进<b>同一个 BLE 包</b>发给玩具。<br><br>' +

      '<b>JSON 格式（底层格式 ufo-wave/1）</b>' +
      '<pre>{ "format":"ufo-wave/1", "name":"心跳", "duration":1.4, "mode":"hold", "base":100,' +
      '  "channels": { "A":[[0,95],[0.18,0],[0.36,-60]], "B":[[0,60],[0.7,-60]] } }</pre>' +
      '· <code>duration</code> = 循环周期（秒）；<code>mode</code> = <code>hold</code> 阶梯保持 / <code>linear</code> 线性插值<br>' +
      '· 每个断点是 <code>[时间(秒), 速度]</code>，速度范围 <b>-127~127</b>，<b>负值 = 反转</b><br>' +
      '· 循环规则：从最后一个断点保持到 <code>duration</code>，然后回绕到第一个断点（若断点正好在 t=duration，它不会被播放）<br><br>' +

      '<b>CSV 只是交换格式</b>（导入会被自动转成 JSON，转换有损）<br>' +
      '· 5 列：<code>时间戳(0.1秒), 左方向(0正/1反), 左速度, 右方向(0正/1反), 右速度</code><br>' +
      '· 3 列：<code>时间戳, 方向, 速度</code>（A/B 相同）；2 列：<code>时间戳, 带符号速度</code><br>' +
      '· 可选注释行：<code>#name= #duration= #mode= #base= #unit=s|0.1s</code><br><br>' +

      '<b>常见问题</b><br>' +
      '· 波形"没效果"：BLE 每 50ms 一包，有效波形频率上限约 10Hz；太快的变化电机跟不上。<br>' +
      '· 强度越大转速越快：强度是乘数（10%~150%），超上限会被夹到 127（示波器会用红色虚线标出来）。<br>' +
      '· 数据存哪：浏览器 localStorage（清缓存会丢），请定期用「导出」备份；不同浏览器/本地文件不共享数据。<br>' +
      '· 播放器页与波形页不能同时控制同一台玩具（BLE 单连接）。<br>' +
      '</div>';
  }

  // ---------------- 导出 / 管理的动作 ----------------
  function pickFor(ch) { openLib(ch); }

  async function exportAll() {
    var bundle = await WC.store.exportBundle(null);
    if (!bundle.waves.length) { toast('没有可导出的用户波形（内置示例不参与导出）', 'warn'); return; }
    WC.io.exportBundle(bundle);
    toast('已导出 ' + bundle.waves.length + ' 个波形（波形包 JSON）');
  }

  async function exportFolder() {
    try {
      var metas = await WC.store.list(), waves = [], i, w;
      for (i = 0; i < metas.length; i++) { w = await getWave(metas[i].id); if (w) waves.push(w); }
      if (!waves.length) { toast('没有可导出的用户波形', 'warn'); return; }
      var n = await WC.io.writeToFolder(waves, false);
      WC.ui.lastExportCount = n;
      toast('已写入 ' + n + ' 个 .json 文件（含 README.txt 格式说明）');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('写入文件夹失败：' + (e.message || e), 'warn');
    }
  }

  async function exportCurrent(ch, asCsv) {
    var id = state.sel[ch];
    if (!id) { toast('通道 ' + ch + ' 还没有选择波形', 'warn'); return; }
    var w = await getWave(id);
    if (!w) { toast('波形读取失败', 'warn'); return; }
    WC.io.exportOne(w, !!asCsv);
    toast('已导出「' + w.name + '」为 ' + (asCsv ? 'CSV（会丢元数据）' : 'JSON'));
  }

  async function exportById(id) {
    var w = await getWave(id);
    if (w) { WC.io.exportOne(w, false); toast('已导出「' + w.name + '」'); }
  }

  async function renameWave(id) {
    var w = await getWave(id);
    if (!w) return;
    var name = prompt('新的波形名：', w.name);
    if (name === null) return;
    name = String(name).trim().slice(0, 40);
    if (!name) { toast('名称不能为空', 'warn'); return; }
    w.name = name; w.updatedAt = Date.now();
    await WC.store.put(w);
    await refreshLib();
    if (state.sel.A === id) updateCard('A');
    if (state.sel.B === id) updateCard('B');
    toast('已重命名为「' + name + '」');
    renderIo(); renderStatus();
  }

  async function editDuration(id) {
    var w = await getWave(id);
    if (!w) return;
    var s = prompt('循环时长（秒），当前 ' + w.duration + '：', String(w.duration));
    if (s === null) return;
    var d = parseFloat(s);
    if (!isFinite(d) || d <= 0) { toast('时长无效', 'warn'); return; }
    var maxT = 0;
    ['A', 'B'].forEach(function (n) {
      var pts = w.channels[n] || [];
      if (pts.length) maxT = Math.max(maxT, pts[pts.length - 1][0]);
    });
    var fixed = F.normalize({ name: w.name, duration: d, mode: w.mode, base: w.base, channels: w.channels, notes: w.notes, createdAt: w.createdAt }, { id: id });
    state.cache[id] = fixed;
    await WC.store.put(fixed);
    if (d < maxT) toast('时长小于最后一个断点（' + maxT + 's），已自动拉长为 ' + fixed.duration + 's', 'warn');
    if (state.sel.A === id) { WC.engine.setWave('A', fixed); WC.scope.setWave('A', fixed); updateCard('A'); }
    if (state.sel.B === id) { WC.engine.setWave('B', fixed); WC.scope.setWave('B', fixed); updateCard('B'); }
    WC.scope.markDirty(); WC.scope.renderOnce();
    await refreshLib();
    toast('时长已改为 ' + fixed.duration + 's');
    renderIo();
  }

  async function viewRaw(id) {
    var w = await getWave(id);
    var el = $('rawView');
    if (el) el.innerHTML = '<div class="sub">原始 JSON（可复制后修改，再重新导入）</div><pre class="raw">' + esc(JSON.stringify(w, null, 2)) + '</pre>';
  }

  async function deleteWave(id) {
    var w = await getWave(id);
    if (!w) return;
    if (!confirm('删除波形「' + w.name + '」？不可撤销（建议先导出备份）。')) return;
    await WC.store.remove(id);
    delete state.cache[id];
    ['A', 'B'].forEach(function (n) {
      if (state.sel[n] === id) {
        state.sel[n] = null;
        WC.engine.setWave(n, null); WC.scope.setWave(n, null); updateCard(n);
      }
    });
    await refreshLib();
    saveSettings();
    toast('已删除「' + w.name + '」');
    renderIo(); renderStatus();
  }

  // ---------------- 打开时的强制提醒（测试版 / 导出备份） ----------------
  var pendingNotice = '';

  function isNoticeOpen() {
    var m = $('noticeModal');
    return !!(m && m.classList.contains('open'));
  }

  function setNoticeInert(on) {
    var arr = [$('layout'), $('toolbar')];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && ('inert' in arr[i])) arr[i].inert = on;   // 遮罩期间禁止操作背后的界面
    }
  }

  function showNotice() {
    var m = $('noticeModal');
    if (!m) return;
    var chk = $('noticeChk'), btn = $('noticeBtn');
    if (chk) chk.checked = false;
    if (btn) btn.disabled = true;
    m.classList.add('open');
    setNoticeInert(true);
    var t = $('toast'); if (t) t.className = 'toast';
    try { m.focus(); } catch (e) { }
  }

  function onNoticeCheck() {
    var chk = $('noticeChk'), btn = $('noticeBtn');
    if (btn) btn.disabled = !(chk && chk.checked);
  }

  function closeNotice() {
    var m = $('noticeModal'), chk = $('noticeChk');
    if (!m || !chk || !chk.checked) return;        // 没勾选不许关闭
    m.classList.remove('open');
    setNoticeInert(false);
    WC.ui.noticeAcknowledged = true;
    if (pendingNotice) { toast(pendingNotice, 'warn'); pendingNotice = ''; }
    else if (!state.sel.A && !state.sel.B) toast('先点通道卡上的「选择波形…」选一个波形，选定后会立即开始循环播放');
    else toast('已确认。记得定期用「📥 导入 / 导出」备份波形数据');
  }

  // ---------------- 初始化 ----------------
  async function init() {
    buildCards();
    loadPresets();
    WC.store.init();
    state.settings = await WC.store.settings();

    WC.scope.attach('A', $('scope-A'));
    WC.scope.attach('B', $('scope-B'));
    WC.scope.resize();

    WC.engine.onStop = function (reason) {
      cancelAllTests();      // 引擎停了（用户暂停 / 急停 / 页面关闭），试听定时器必须一起作废
      updateRunUI();
      if (reason === 'emergency') toast('已急停并归零', 'warn');
    };

    WC.ble.onState = function (on, detail) {
      $('bleLabel').textContent = on ? '已连接' : '未连接';
      $('bleLabel').className = 'badge ' + (on ? 'on' : 'off');
      if (detail) toast(detail, on ? 'info' : 'warn');
      // 默认打开：连上设备就让引擎跑起来（时钟+50ms tick）。
      // 真正决定电机转不转的是两个通道的复选框，顶部按钮只承担急停/暂停职责。
      if (on && !WC.engine.isRunning()) startEngine();
      renderStatus();
      updateRunUI();
    };

    var s = state.settings, i, names = ['A', 'B'], key;
    for (i = 0; i < 2; i++) {
      key = names[i];
      if (typeof s['int' + key] === 'number') {
        $('int-' + key).value = Math.round(s['int' + key] * 100);
        $('intVal-' + key).textContent = Math.round(s['int' + key] * 100) + '%';
        WC.engine.setIntensity(key, s['int' + key]);
      }
      if (typeof s['ph' + key] === 'number') {
        $('ph-' + key).value = Math.round(s['ph' + key] * 100);
        $('phVal-' + key).textContent = Math.round(s['ph' + key] * 100) + '%';
        WC.engine.setPhase(key, s['ph' + key]);
      }
    }

    await refreshLib();
    // 恢复上次选中的波形（静默，不弹提示）；是否启用单独在下面按保存的勾选状态恢复
    if (s.selA) await selectWave('A', s.selA, { quiet: true });
    if (s.selB) await selectWave('B', s.selB, { quiet: true });
    for (i = 0; i < 2; i++) {
      key = names[i];
      if (typeof s['en' + key] === 'boolean') {
        $('en-' + key).checked = s['en' + key];
        WC.engine.setEnabled(key, s['en' + key]);
      }
      updateCard(key);
    }

    setInterval(renderStatus, 500);
    setInterval(renderLive, 120);
    window.addEventListener('resize', function () { WC.scope.resize(); WC.scope.renderOnce(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (isNoticeOpen()) return;                 // 强制确认期间，Esc 无效
      closeLib();
      if ($('ioModal').classList.contains('open')) closeIo();
    });

    updateRunUI(); renderStatus(); renderLive(); WC.scope.renderOnce();

    if (!WC.store.available) pendingNotice = '本地存储不可用：' + WC.store.reason + '（仍可导入 / 导出，但无法保存）';
    showNotice();                    // 打开即强制提醒：勾选后才能关闭
    WC.ui.ready = true;
  }

  WC.ui = {
    init: init, state: state,
    // 波形库抽屉
    toggleLib: toggleLib, openLib: openLib, closeLib: closeLib, pick: pick, pickFor: pickFor, pickTarget: pickTarget, renderLib: renderLib,
    // 通道控制
    toggleCh: toggleCh, onIntensity: onIntensity, onPhase: onPhase, testPulse: testPulse, selectWave: selectWave,
    // 工具栏
    connect: connect, emergencyStop: emergencyStop, requestStop: requestStop, toggleRun: toggleRun,
    // 模态框 / 导入导出 / 管理
    openIo: openIo, closeIo: closeIo, setTab: setTab,
    chooseFiles: chooseFiles, chooseFolder: chooseFolder,
    onFiles: onFiles, runImport: runImport, confirmImport: confirmImport, cancelImport: cancelImport,
    exportAll: exportAll, exportFolder: exportFolder, exportCurrent: exportCurrent, exportById: exportById,
    renameWave: renameWave, editDuration: editDuration, viewRaw: viewRaw, deleteWave: deleteWave,
    // 调试 / 测试用
    renderStatus: renderStatus, renderLive: renderLive, startEngine: startEngine, stopEngine: stopEngine,
    cancelTest: cancelTest, cancelAllTests: cancelAllTests, testTimers: testTimers,
    showNotice: showNotice, closeNotice: closeNotice, onNoticeCheck: onNoticeCheck, isNoticeOpen: isNoticeOpen,
    importHtml: importHtml, exportHtml: exportHtml, manageHtml: manageHtml, helpHtml: helpHtml,
    lastImportResult: null, lastExportCount: 0, ready: false
  };

  function boot() { WC.ui.init().catch(function (e) { console.log('初始化失败：', e); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();







})();
