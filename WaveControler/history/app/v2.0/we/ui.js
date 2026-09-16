// ============================================================
// we/ui.js - 编辑器界面装配
//   波形库抽屉 / 模式切换 / 状态栏 / 坐标输入 / 覆盖确认 / 使用说明
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};
  var U = WE.util, G = WE.grid;
  var F = window.WC.format;

  var ui = {
    mode: 'gfx',
    pendingOpen: null
  };

  function $(id) { return U.$(id); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------- 波形库抽屉 ----------------
  function openLib() {
    $('sidebar').classList.add('open');
    $('backdrop').classList.add('open');
    $('sidebar').setAttribute('aria-hidden', 'false');
    renderLib();
  }
  function closeLib() {
    $('sidebar').classList.remove('open');
    $('backdrop').classList.remove('open');
    $('sidebar').setAttribute('aria-hidden', 'true');
  }
  function toggleLib() {
    if ($('sidebar').classList.contains('open')) closeLib(); else openLib();
  }

  function renderLib() {
    var q = ($('libSearch').value || '').trim().toLowerCase();
    var lib = WE.data.getLib();
    var groups = [{ title: '内置示例（只读）', items: [] }, { title: '我的波形', items: [] }];
    for (var i = 0; i < lib.length; i++) {
      var it = lib[i];
      if (q && it.name.toLowerCase().indexOf(q) < 0) continue;
      (it.builtin ? groups[0] : groups[1]).items.push(it);
    }
    var cur = WE.data.getWave();
    var html = '';
    for (i = 0; i < groups.length; i++) {
      if (!groups[i].items.length) continue;
      html += '<div class="libGroup">' + esc(groups[i].title) + ' <span class="cnt">' + groups[i].items.length + '</span></div>';
      for (var k = 0; k < groups[i].items.length; k++) {
        var it2 = groups[i].items[k];
        var isCur = cur && cur.id === it2.id;
        html += '<div class="libItem' + (isCur ? ' used' : '') + '" data-id="' + esc(it2.id) + '" data-builtin="' + (it2.builtin ? '1' : '0') + '" onclick="WE.ui.pick(this)">' +
          '<div class="libName">' + esc(it2.name) + (it2.builtin ? ' <span class="ro">只读</span>' : '') + '</div>' +
          '<div class="libMeta">' + (it2.meta.duration ? U.fmtSec(it2.meta.duration) + 's · ' : '') +
          (it2.meta.points || 0) + ' 断点 · ' + (it2.meta.mode === 'linear' ? '线性' : '阶梯') +
          (isCur ? ' · <b>编辑中</b>' : '') + '</div>' +
          '</div>';
      }
    }
    $('libList').innerHTML = html || '<div class="libEmpty">没有匹配的波形</div>';
    $('libCount').textContent = '(' + lib.length + ')';
  }

  // 点击库项：没有打开的文件→直接开；有打开的文件→先确认覆盖
  ui.pick = function (el) {
    var id = el.getAttribute('data-id');
    var builtin = el.getAttribute('data-builtin') === '1';
    if (!WE.data.needsConfirm()) { doOpen(id, builtin); return; }
    var dirty = WE.data.isDirty();
    ui.askConfirm({
      title: '⚠ 确认覆盖',
      text: '将覆盖右侧编辑区，请确定已经保存/导出后再继续。' +
        (dirty ? '<br><b style="color:#fbbf24">⚠ 当前波形有未保存的修改，继续将丢失这些修改。</b>' : ''),
      okLabel: '确定载入',
      onOk: function () { doOpen(id, builtin); }
    });
  };

  function doOpen(id, builtin) {
    if (builtin) {
      if (WE.data.loadPreset(id)) {
        closeLib();
        U.toast('已载入内置示例（只读，可「另存副本」后编辑）');
      }
      return;
    }
    WE.data.loadUser(id).then(function (r) {
      if (r) { closeLib(); U.toast('已载入波形'); }
    });
  }

  // ---------------- 统一确认弹窗 ----------------
  // 覆盖 / 删除 / 放弃未保存修改 三种场景共用，避免用浏览器原生 confirm
  var pendingConfirm = null;
  ui.askConfirm = function (opts) {
    pendingConfirm = opts || null;
    $('confirmTitle').textContent = (opts && opts.title) || '⚠ 确认';
    $('confirmText').innerHTML = (opts && opts.text) || '';
    $('confirmOk').textContent = (opts && opts.okLabel) || '确定';
    $('confirmOk').className = (opts && opts.danger) ? 'danger' : 'primary';
    $('confirmModal').classList.add('open');
  };
  ui.doConfirm = function () {
    var p = pendingConfirm;
    pendingConfirm = null;
    $('confirmModal').classList.remove('open');
    if (p && typeof p.onOk === 'function') p.onOk();
  };
  ui.cancelConfirm = function () {
    var p = pendingConfirm;
    pendingConfirm = null;
    $('confirmModal').classList.remove('open');
    if (p && typeof p.onCancel === 'function') p.onCancel();
  };
  ui.isConfirmOpen = function () { return $('confirmModal').classList.contains('open'); };

  // ---------------- 顶栏 ----------------
  ui.refreshName = function () {
    var w = WE.data.getWave();
    var nm = $('weName'), bd = $('weBadge');
    if (!w) {
      nm.textContent = '未打开波形';
      bd.textContent = '—'; bd.className = 'badge off';
    } else {
      nm.textContent = w.name + (WE.data.isDirty() ? ' *' : '');
      bd.textContent = WE.data.isReadonly() ? '内置示例（只读）' : '我的波形';
      bd.className = 'badge ' + (WE.data.isReadonly() ? 'off' : 'on');
    }
    var ro = WE.data.isReadonly() || !w;
    $('btnSave').disabled = ro;
    $('btnDel').disabled = ro;
    $('btnCopy').disabled = !w;
    $('btnSave').textContent = WE.data.isReadonly() ? '💾 保存（只读）' : '💾 保存';
  };
  ui.refreshTitle = ui.refreshName;

  ui.onWaveLoaded = function () {
    ui.refreshName();
    ui.refreshStatus();
    ui.syncHistButtons();
    var w = WE.data.getWave();
    var dur = $('weDur'), md = $('weMode');
    if (dur) { dur.value = w ? w.duration : ''; dur.disabled = !w || WE.data.isReadonly(); }
    if (md) { md.value = w ? (w.mode === 'linear' ? 'linear' : 'hold') : 'hold'; md.disabled = !w || WE.data.isReadonly(); }
    var empty = $('gfxEmpty');
    if (empty) empty.style.display = w ? 'none' : '';
  };

  // ---------------- 新建波形：先填参数 ----------------
  // 不直接生成"未命名波形"——名称和循环时长是决定用途的关键参数，必须让用户先定。
  function openInput() {
    $('inName').value = '';
    $('inDur').value = '1';
    $('inMode').value = 'hold';
    $('inputErr').textContent = '';
    $('inputModal').classList.add('open');
    setTimeout(function () { try { $('inName').focus(); } catch (e) { } }, 30);
  }
  ui.newBlank = function () {
    WE.data.canCreateBlank(openInput);
  };
  ui.doInput = function () {
    var name = ($('inName').value || '').trim();
    var dur = parseFloat($('inDur').value);
    var mode = $('inMode').value;
    var err = [];
    if (!name) err.push('请填写波形名称');
    if (name.length > 40) err.push('名称不能超过 40 个字符');
    if (!U.isNum(dur) || dur <= 0) err.push('循环时长必须是大于 0 的数字');
    if (U.isNum(dur) && dur > 3600) err.push('循环时长建议不超过 3600 秒');
    if (err.length) { $('inputErr').textContent = err.join('；'); return; }
    // 重名提醒（不阻止，只提示）
    var dup = false;
    var lib = WE.data.getLib();
    for (var i = 0; i < lib.length; i++) if (lib[i].name === name) dup = true;
    $('inputModal').classList.remove('open');
    WE.data.createBlank({ name: name, duration: dur, mode: mode });
    if (dup) U.toast('注意：已存在同名波形「' + name + '」，保存后会有两个同名项', 'warn');
  };
  ui.cancelInput = function () { $('inputModal').classList.remove('open'); };
  ui.isInputOpen = function () { return $('inputModal').classList.contains('open'); };

  // ---------------- 结果提示弹窗 ----------------
  // 保存 / 另存副本这类"操作已生效"的反馈用弹窗，比底部小字显著得多。
  function showInfo(title, html) {
    $('infoTitle').textContent = title || '提示';
    $('infoBody').innerHTML = html || '';
    $('infoModal').classList.add('open');
  }
  function closeInfo() { $('infoModal').classList.remove('open'); }
  function isInfoOpen() { return $('infoModal').classList.contains('open'); }
  ui.showInfo = showInfo;
  ui.closeInfo = closeInfo;
  ui.isInfoOpen = isInfoOpen;

  // ---------------- 撤销 / 重做 ----------------
  ui.syncHistButtons = function () {
    var u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = !WE.editor.canUndo() || WE.data.isReadonly();
    if (r) r.disabled = !WE.editor.canRedo() || WE.data.isReadonly();
  };
  ui.undo = function () {
    WE.editor.undo();
    ui.syncHistButtons();
    ui.refreshStatus();
  };
  ui.redo = function () {
    WE.editor.redo();
    ui.syncHistButtons();
    ui.refreshStatus();
  };

  // ---------------- 模式切换 ----------------
  ui.setMode = function (m) {
    ui.mode = (m === 'json') ? 'json' : 'gfx';
    $('paneGfx').classList.toggle('on', ui.mode === 'gfx');
    $('paneJson').classList.toggle('on', ui.mode === 'json');
    $('modeGfx').classList.toggle('on', ui.mode === 'gfx');
    $('modeJson').classList.toggle('on', ui.mode === 'json');
    if (ui.mode === 'gfx') {
      WE.view.resize();
      WE.view.draw();
    } else {
      WE.json.syncFromWave(true);      // 切到 JSON 时强制刷新一次内容
    }
  };

  // ---------------- 工具 / 通道按钮 ----------------
  ui.syncToolButtons = function () {
    var t = WE.editor.getTool();
    $('toolFree').classList.toggle('on', t === 'free');
    $('toolTwo').classList.toggle('on', t === 'two');
  };
  ui.setTool = function (t) { WE.editor.setTool(t); };
  // 编辑通道（A/B）由编辑器内部状态决定，界面上不再放切换按钮：
  // 一个波形就是一份数据，A/B 是它内部的两条通道曲线，不需要用户再选"编辑哪条"。

  ui.onSnapChk = function () {
    WE.snap.setEnabled($('chkSnap').checked);
    WE.view.snapped = null;
    WE.view.schedule();
  };

  // ---------------- 状态栏 ----------------
  // 只保留真正有用的：工具/吸附/坐标。视图范围与断点统计先撤掉（轴线方案定稿后再议）
  ui.refreshStatus = function (hover) {
    var w = WE.data.getWave();
    var pos = $('sbPos'), snapEl = $('sbSnap');
    ui.syncHistButtons();
    if (!w) {
      if (pos) pos.textContent = '';
      if (snapEl) snapEl.textContent = '';
      return;
    }
    var t = (hover && U.isNum(hover.t)) ? hover.t : WE.view.hoverT;
    var a = (hover && U.isNum(hover.a)) ? hover.a : null;
    if (pos) {
      pos.textContent = (U.isNum(t) ? '时间 ' + U.fmtSec(U.round3(t)) + 's' : '时间 —') +
        (a !== null ? '　幅度 ' + Math.round(a) : '');
    }
    if (snapEl) {
      var sp = WE.view.snapped;
      var kinds = [];
      if (sp && sp.t !== null && sp.t !== undefined) kinds.push('时间刻度');
      if (sp && sp.a !== null && sp.a !== undefined) kinds.push('幅度 0/±127');
      snapEl.textContent = (WE.snap.isEnabled() && sp) ? ('吸附: ' + kinds.join(' + ')) : (WE.snap.isEnabled() ? '' : '吸附: 关');
    }
  };

  // ---------------- 坐标输入 ----------------
  ui.doCoord = function () {
    var t = parseFloat($('inTime').value);
    var a = parseFloat($('inAmp').value);
    if (WE.editor.placeAt(t, a)) {
      $('inAmp').value = '';
      $('inTime').value = '';
      $('inTime').focus();
    }
  };
  ui.onCoordEnter = function (ev) {
    if (ev.target && (ev.target.id === 'inTime' || ev.target.id === 'inAmp')) ui.doCoord();
  };

  // ---------------- 文件动作 ----------------
  ui.save = function () { WE.data.save(); };
  ui.saveAsCopy = function () { WE.data.saveAsCopy(); };
  ui.del = function () { WE.data.del(); };
  // 注意：ui.newBlank 的定义在「新建波形：先填参数」那一节（会先弹输入框收集名称/时长/模式），
  // 这里不要再定义一次 —— 曾经因为重复定义，旧版本覆盖了新版，导致点了报错。

  ui.onDurChange = function () {
    var r = WE.data.setDuration($('weDur').value);
    if (r) {
      WE.view.draw(); WE.view.schedule();
      U.toast('循环时长已改为 ' + U.fmtSec(r) + 's（记得保存）');
      ui.refreshStatus();
    } else {
      var w = WE.data.getWave();
      if (w) $('weDur').value = w.duration;
    }
  };
  ui.onModeChange = function () {
    WE.data.setMode($('weMode').value);
    WE.view.draw(); WE.view.schedule();
    ui.refreshStatus();
  };

  ui.onViewChanged = function () { ui.refreshStatus(); };

  // ---------------- 说明 / Esc ----------------
  ui.openHelp = function () { $('helpModal').classList.add('open'); };
  ui.closeHelp = function () { $('helpModal').classList.remove('open'); };
  ui.onEsc = function () {
    if (isInfoOpen()) { closeInfo(); return; }
    if (ui.isInputOpen()) { ui.cancelInput(); return; }
    if ($('helpModal').classList.contains('open')) { ui.closeHelp(); return; }
    if (ui.isConfirmOpen()) { ui.cancelConfirm(); return; }
    closeLib();
  };

  // ---------------- 初始化 ----------------
  async function init() {
    window.WC.store.init();
    await WE.data.refreshLib();

    WE.view.init();
    WE.editor.init();
    WE.json.init();

    renderLib();
    ui.onWaveLoaded();
    ui.syncToolButtons();
    ui.setMode('gfx');

    // 状态栏高频刷新（悬停坐标）
    setInterval(function () { ui.refreshStatus(); }, 160);
    window.addEventListener('resize', function () { WE.view.resize(); });

    // 关页面前提醒未保存
    window.addEventListener('beforeunload', function (e) {
      if (WE.data.isDirty()) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    });

    U.toast('编辑器已就绪：从「☰ 波形库」选一个，或点「＋ 新建空白波形」');
  }

  ui.init = init;
  ui.renderLib = renderLib;
  ui.toggleLib = toggleLib;
  ui.openLib = openLib;
  ui.closeLib = closeLib;
  WE.ui = ui;

  function boot() { ui.init().catch(function (e) { console.log('编辑器初始化失败：', e); U.toast('初始化失败：' + (e && e.message || e), 'warn'); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
