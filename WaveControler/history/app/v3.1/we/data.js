// ============================================================
// we/data.js - 编辑器数据层
//   内置示例（只读常量）+ 用户波形（localStorage，与控制器共用同一份）
//   所有写入都经 WC.store，控制器侧靠 storage 事件自动同步
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};
  var U = WE.util, G = WE.grid;
  var F = window.WC.format, S = window.WC.store;

  var d = {
    cur: null,          // 当前波形对象（编辑器内直接改它）
    readonly: true,
    dirty: false,
    lib: []             // [{ id, name, builtin, meta }]
  };

  // ---------------- 内置示例（从 presets.js 现取，保证与控制器一致） ----------------
  function presetById(id) {
    var arr = window.UFO_WAVE_PRESETS || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }
  function getPreset(id) {
    var raw = presetById(id);
    if (!raw) return null;
    try { return F.normalize(raw, { id: raw.id }); } catch (e) { return null; }
  }

  // ---------------- 库列表 ----------------
  d.refreshLib = async function () {
    var arr = window.UFO_WAVE_PRESETS || [], i, w, out = [];
    for (i = 0; i < arr.length; i++) {
      try {
        w = F.normalize(arr[i], { id: arr[i].id });
        out.push({
          id: w.id, name: w.name, builtin: true,
          meta: { duration: w.duration, points: (w.channels.A || []).length + (w.channels.B || []).length, mode: w.mode }
        });
      } catch (e) { }
    }
    var metas = [];
    try { metas = await S.list(); } catch (e) { metas = []; }
    for (i = 0; i < metas.length; i++) {
      out.push({
        id: metas[i].id, name: metas[i].name, builtin: false,
        meta: { duration: metas[i].duration, points: metas[i].points || 0, mode: metas[i].mode, size: metas[i].size }
      });
    }
    d.lib = out;
    return out;
  };

  d.getLib = function () { return d.lib; };
  d.getWave = function () { return d.cur; };
  d.isReadonly = function () { return d.readonly; };
  d.isDirty = function () { return d.dirty; };
  d.markDirty = function () { d.dirty = true; if (WE.ui && WE.ui.refreshTitle) WE.ui.refreshTitle(); };
  d.markClean = function () { d.dirty = false; if (WE.ui && WE.ui.refreshTitle) WE.ui.refreshTitle(); };

  // ---------------- 载入 ----------------
  d.loadPreset = function (id) {
    var w = getPreset(id);
    if (!w) { U.toast('找不到该内置示例', 'warn'); return false; }
    w.builtin = true;
    var ok = d.setCurrent(w, true);
    if (ok) notifyWaveChanged();
    return ok;
  };

  d.loadUser = async function (id) {
    var w = null;
    try { w = await S.get(id); } catch (e) { w = null; }
    if (!w) { U.toast('波形读取失败（可能已被删除）', 'warn'); return false; }
    w.builtin = false;
    var ok = d.setCurrent(w, false);
    if (ok) notifyWaveChanged();
    return ok;
  };

  d.setCurrent = function (w, ro) {
    d.cur = w;
    d.readonly = !!ro;
    d.dirty = false;
    G.setDuration(F.durationOf(w));   // 视图固定为「整周期 × ±127」，只需更新周期值
    if (WE.editor) { WE.editor.clearSelection(); WE.editor.cancelPending(); WE.editor.resetHistory(); }
    if (WE.json) WE.json.syncFromWave(true);
    if (WE.ui) WE.ui.onWaveLoaded();
    WE.view.resize();
    WE.view.draw();
    return true;
  };

  // ---------------- 新建 ----------------
  // 由 ui.js 弹输入框收集名称/时长/模式后再调这里
  function createBlank(opts) {
    opts = opts || {};
    var dur = parseFloat(opts.duration);
    if (!U.isNum(dur) || dur <= 0) dur = 1.0;
    var w = F.normalize({
      name: (opts.name || '未命名波形'),
      duration: dur,
      mode: (opts.mode === 'linear') ? 'linear' : 'hold',
      base: 127,
      channels: { A: [[0, 0]], B: [[0, 0]] },
      notes: '由编辑器新建'
    });
    w.builtin = false;
    d.cur = w; d.readonly = false; d.dirty = true;
    G.setDuration(w.duration);
    if (WE.editor) { WE.editor.clearSelection(); WE.editor.resetHistory(); }
    if (WE.json) WE.json.syncFromWave(true);
    if (WE.ui) WE.ui.onWaveLoaded();
    WE.view.resize();
    WE.view.draw();
    notifyWaveChanged();                       // 告诉控制器：用户换波形了
    U.toast('已新建「' + w.name + '」（' + U.fmtSec(w.duration) + 's · ' +
      (w.mode === 'linear' ? '线性' : '阶梯') + '），改完记得点「保存」');
  }
  d.createBlank = createBlank;

  // 新建前的脏数据检查；通过后由 ui.js 弹输入框
  d.canCreateBlank = function (onOk) {
    if (d.cur && d.dirty) {
      ask({
        title: '⚠ 有未保存的修改',
        text: '当前波形「' + d.cur.name + '」有未保存的修改，新建将丢失这些修改。',
        okLabel: '放弃修改并新建',
        danger: true,
        onOk: onOk
      });
      return false;
    }
    onOk();
    return true;
  };

  // ---------------- 说明 ----------------
  // 编辑器不连蓝牙、不持有输出状态，所以这里**不做**任何"关断控制器输出"的动作，
  // 只是把"用户换了波形"这个意图广播出去，由控制器自己决定怎么处理。
  // 控制器侧实现在 js/ui.js 的 cancelOutputs + setupEditorChannel。
  function notifyWaveChanged() {
    try {
      if (window.opener && !window.opener.closed) window.opener.postMessage('wave-change', '*');
    } catch (e) { /* 跨源或已关闭，忽略 */ }
  }

  // ---------------- 结果提示 ----------------
  // 保存 / 另存副本这种"操作已生效"的反馈改用弹窗，比底部小字显著得多
  function info(title, html) {
    if (WE.ui && WE.ui.showInfo) WE.ui.showInfo(title, html);
    else U.toast(String(html || '').replace(/<[^>]+>/g, ' '));
  }

  // ---------------- 保存 ----------------
  d.save = async function () {
    if (!d.cur) { info('💾 保存失败', '<p class="warnText">没有打开任何波形。</p>'); return false; }
    if (d.readonly) { info('💾 保存失败', '<p class="warnText">内置示例是只读的，请用「另存副本」。</p>'); return false; }
    var out;
    try {
      out = F.normalize(d.cur, { id: d.cur.id });
    } catch (e) {
      info('💾 保存失败', '<p class="warnText">' + (e.message || e) + '</p>');
      return false;
    }
    out.builtin = false;
    out.updatedAt = Date.now();
    try {
      await S.put(out);
    } catch (e) {
      info('💾 保存失败', '<p class="warnText">' + (e.message || e) + '</p>');
      return false;
    }
    d.cur = out;
    d.markClean();
    if (WE.ui) WE.ui.refreshName();
    try {
      if (window.opener && !window.opener.closed) window.opener.postMessage('wave-saved', '*');
    } catch (e) { /* 忽略 */ }
    info('💾 保存成功', '<div class="kv ok">已自动同步到控制器 app。</div>' +
      '<div class="kv">若未同步，请回到控制器页面刷新页面。</div>');
    return true;
  };

  d.saveAsCopy = async function () {
    if (!d.cur) { info('📄 另存失败', '<p class="warnText">没有打开任何波形。</p>'); return false; }
    var copy = F.normalize({
      name: (d.cur.name + '（副本）').slice(0, 40),
      duration: d.cur.duration, mode: d.cur.mode, base: d.cur.base,
      channels: { A: d.cur.channels.A, B: d.cur.channels.B },
      notes: d.cur.notes || ''
    });
    copy.builtin = false;
    try {
      await S.put(copy);
    } catch (e) {
      info('📄 另存失败', '<p class="warnText">' + (e.message || e) + '</p>');
      return false;
    }
    d.cur = copy; d.readonly = false; d.markClean();
    if (WE.ui) WE.ui.refreshName();
    await d.refreshLib();
    if (WE.ui) WE.ui.renderLib();
    try {
      if (window.opener && !window.opener.closed) window.opener.postMessage('wave-saved', '*');
    } catch (e) { /* 忽略 */ }
    info('📄 另存成功', '<div class="kv">已另存为「<b>' + copy.name + '</b>」。</div>' +
      '<div class="kv ok">已自动同步到控制器 app。</div>' +
      '<div class="kv">若未同步，请回到控制器页面刷新页面。</div>');
    return true;
  };

  d.del = async function () {
    if (!d.cur) return false;
    if (d.readonly) { U.toast('内置示例不能删除', 'warn'); return false; }
    var target = d.cur;
    ask({
      title: '⚠ 确认删除',
      text: '删除波形「' + target.name + '」？不可撤销（建议先在控制器页面导出备份）。',
      okLabel: '确定删除',
      danger: true,
      onOk: function () { doDelete(target.id); }
    });
    return true;
  };

  async function doDelete(id) {
    try { await S.remove(id); } catch (e) { }
    d.cur = null; d.dirty = false; d.readonly = true;
    await d.refreshLib();
    if (WE.ui) { WE.ui.renderLib(); WE.ui.onWaveLoaded(); }
    WE.view.draw();
    U.toast('已删除，控制器 app 会同步移除');
  }

  // ---------------- 确认对话框 ----------------
  // 统一走编辑器自己的弹窗（WE.ui.askConfirm），不用浏览器原生 confirm，
  // 避免"同一个界面里混着两种弹窗"的割裂感。回调式，所以是异步的。
  // 万一 ui 还没就绪（init 期间）就直接放行并记日志，绝不退回原生 confirm。
  function ask(opts) {
    if (WE.ui && WE.ui.askConfirm) { WE.ui.askConfirm(opts); return; }
    console.log('WE.ui 尚未就绪，确认对话框降级为直接执行：', opts && opts.text);
    if (opts && typeof opts.onOk === 'function') opts.onOk();
  }

  // ---------------- 覆盖前确认 ----------------
  // 有打开的文件时，切换波形需要用户确认（由 ui.js 弹窗）
  d.needsConfirm = function () { return !!d.cur; };

  // 切换波形/新建前统一走这里；返回 true 表示可以继续（无脏数据）
  d.warnDirty = function (onProceed) {
    if (d.cur && d.dirty) {
      ask({
        title: '⚠ 有未保存的修改',
        text: '当前波形「' + d.cur.name + '」有未保存的修改，继续将丢失这些修改。',
        okLabel: '放弃修改并继续',
        danger: true,
        onOk: onProceed
      });
      return false;
    }
    onProceed();
    return true;
  };
  // 兼容旧调用（同步语义）：只在确实无脏数据时返回 true
  d.confirmDiscard = function () { return !(d.cur && d.dirty); };

  // ---------------- 改时长 / 模式 ----------------
  d.setDuration = function (sec) {
    if (!d.cur || d.readonly) return false;
    var v = parseFloat(sec);
    if (!U.isNum(v) || v <= 0) { U.toast('时长无效', 'warn'); return false; }
    var maxT = 0;
    ['A', 'B'].forEach(function (n) {
      var pts = d.cur.channels[n] || [];
      if (pts.length) maxT = Math.max(maxT, pts[pts.length - 1][0]);
    });
    var out = F.normalize({
      id: d.cur.id, name: d.cur.name, duration: v, mode: d.cur.mode, base: d.cur.base,
      channels: d.cur.channels, notes: d.cur.notes, createdAt: d.cur.createdAt
    });
    d.cur.duration = out.duration;
    G.setDuration(out.duration);
    if (WE.view && WE.view.refreshAxes) WE.view.refreshAxes();
    d.markDirty();
    if (WE.json) WE.json.syncFromWave();
    return out.duration;
  };

  d.setMode = function (mode) {
    if (!d.cur || d.readonly) return false;
    d.cur.mode = (mode === 'linear') ? 'linear' : 'hold';
    d.markDirty();
    if (WE.json) WE.json.syncFromWave();
    return true;
  };

  WE.data = d;
})();
