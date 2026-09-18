// ============================================================
// we/json.js - JSON 编辑器
//   与图形化编辑的是同一份数据，双向同步：
//     图形化改动 → syncFromWave() 刷新文本（用户正在输入时不打断）
//     文本改动   → 防抖后校验，通过则写回图形化；失败只报错、不覆盖
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};
  var U = WE.util, G = WE.grid;
  var F = window.WC.format;

  var j = { suppress: false };

  function ta() { return U.$('jsonText'); }
  function errEl() { return U.$('jsonErr'); }
  function stateEl() { return U.$('jsonState'); }

  function setState(text, cls) {
    var el = stateEl();
    if (!el) return;
    el.textContent = text || '';
    el.className = 'jsonState ' + (cls || '');
  }
  function setErr(text) {
    var el = errEl();
    if (el) el.textContent = text || '';
  }

  // 图形化 → 文本
  j.syncFromWave = function (force) {
    var t = ta();
    if (!t) return;
    var w = WE.data.getWave();
    if (!w) { t.value = ''; setState('', ''); setErr(''); return; }
    // 用户正在编辑时不要覆盖（除非强制）
    if (!force && document.activeElement === t) return;
    var obj = {
      format: w.format || F.FORMAT_ID,
      name: w.name,
      duration: w.duration,
      mode: w.mode,
      base: w.base,
      channels: { A: w.channels.A, B: w.channels.B },
      notes: w.notes || ''
    };
    j.suppress = true;
    t.value = JSON.stringify(obj, null, 2);
    j.suppress = false;
    t.disabled = WE.data.isReadonly();
    setState(WE.data.isReadonly() ? '内置示例 · 只读' : '已同步', WE.data.isReadonly() ? '' : 'ok');
    setErr('');
  };

  // 文本 → 图形化
  j.apply = function (quiet) {
    var t = ta();
    if (!t) return false;
    var w = WE.data.getWave();
    if (!w) { setErr('没有打开任何波形'); return false; }
    if (WE.data.isReadonly()) { setErr('内置示例是只读的，请先「另存副本」'); return false; }

    var raw = t.value;
    var obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      setErr('JSON 解析失败：' + (e.message || e));
      setState('有错误', 'err');
      return false;
    }
    var out;
    try {
      out = F.normalize(obj, { id: w.id });
    } catch (e) {
      setErr('数据校验失败：' + (e.message || e));
      setState('有错误', 'err');
      return false;
    }
    if (!out.channels.A.length && !out.channels.B.length) {
      setErr('A / B 两条通道都至少需要一个断点');
      setState('有错误', 'err');
      return false;
    }

    // 写回
    w.name = out.name;
    w.duration = out.duration;
    w.mode = out.mode;
    w.base = out.base;
    w.notes = out.notes;
    w.channels = out.channels;
    w.updatedAt = Date.now();

    G.setDuration(w.duration, true);
    WE.data.markDirty();
    if (WE.editor) WE.editor.clearSelection();
    WE.view.draw(); WE.view.schedule();
    if (WE.ui) { WE.ui.refreshStatus(); WE.ui.refreshName(); }

    setErr('');
    setState('已应用到图形化', 'ok');
    if (!quiet) U.toast('已应用到图形化编辑器（记得点「保存」写回本地数据）');
    return true;
  };

  // 防抖校验（输入时提示语法错误，但不在打字中途应用）
  var debouncedCheck = U.debounce(function () {
    var t = ta();
    if (!t) return;
    if (WE.data.isReadonly()) return;
    try {
      JSON.parse(t.value);
      setErr('');
      setState('语法正确，点「应用到图形化」或按 Ctrl+Enter 生效', 'ok');
    } catch (e) {
      setErr('JSON 解析失败：' + (e.message || e));
      setState('有错误', 'err');
    }
  }, 420);

  j.format = function () {
    var t = ta();
    if (!t || !t.value.trim()) return;
    try {
      t.value = JSON.stringify(JSON.parse(t.value), null, 2);
      setErr(''); setState('已格式化', 'ok');
    } catch (e) {
      setErr('JSON 解析失败，无法格式化：' + (e.message || e));
      setState('有错误', 'err');
    }
  };

  j.compact = function () {
    var t = ta();
    if (!t || !t.value.trim()) return;
    try {
      t.value = JSON.stringify(JSON.parse(t.value));
      setErr(''); setState('已压缩', 'ok');
    } catch (e) {
      setErr('JSON 解析失败，无法压缩：' + (e.message || e));
      setState('有错误', 'err');
    }
  };

  j.init = function () {
    var t = ta();
    if (!t) return;
    t.addEventListener('input', function () {
      if (j.suppress) return;
      setState('编辑中…', '');
      debouncedCheck();
    });
    t.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); j.apply(); }
      // 让 Tab 插入两个空格而不是跳焦点
      if (ev.key === 'Tab') {
        ev.preventDefault();
        var s = t.selectionStart, en = t.selectionEnd;
        t.value = t.value.slice(0, s) + '  ' + t.value.slice(en);
        t.selectionStart = t.selectionEnd = s + 2;
      }
    });
  };

  WE.json = j;
})();
