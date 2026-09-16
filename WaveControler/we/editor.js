// ============================================================
// we/editor.js - 编辑核心
//   自由绘制（按 50ms 时间步量化）/ 两点式折线 / 选中断点拖动 / Shift 插入 /
//   坐标输入落点 / 撤销重做
//   所有数据改动都过 WC.format.normalize()，保证与控制器读到的格式完全一致
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};
  var U = WE.util, G = WE.grid, Sn = WE.snap;
  var F = window.WC.format;
  var LIMIT = 127;
  var QUANT_MS = 50;        // 自由绘制的时间步长，与控制器 20Hz 发包率一致
  var HIST_MAX = 60;

  var e = {
    tool: 'free',           // 'free' | 'two'
    ch: 'A',                // 编辑焦点通道
    sel: null,              // { ch, idx }
    drawing: false,
    twoPoint: null,         // 两点式的起点 {t, a}
    rubber: null,           // 鼠标预览 {t, a}
    hist: [],
    redoStack: []
  };

  function wave() { return WE.data ? WE.data.getWave() : null; }
  function readonly() { return WE.data ? WE.data.isReadonly() : true; }

  // ---------------- 撤销 ----------------
  function snapshot() {
    var w = wave();
    if (!w) return null;
    return { duration: w.duration, mode: w.mode, A: w.channels.A.map(function (p) { return [p[0], p[1]]; }),
      B: w.channels.B.map(function (p) { return [p[0], p[1]]; }) };
  }
  function restore(snap) {
    var w = wave();
    if (!w || !snap) return;
    w.duration = snap.duration;
    w.mode = snap.mode;
    w.channels.A = snap.A.map(function (p) { return [p[0], p[1]]; });
    w.channels.B = snap.B.map(function (p) { return [p[0], p[1]]; });
    e.sel = null;
  }
  function pushHist() {
    var snap = snapshot();
    if (!snap) return;
    e.hist.push(snap);
    if (e.hist.length > HIST_MAX) e.hist.shift();
    e.redoStack.length = 0;
  }
  e.undo = function () {
    if (readonly()) { U.toast('内置示例是只读的，请先「另存副本」', 'warn'); return; }
    if (!e.hist.length) { U.toast('没有可撤销的操作'); return; }
    var cur = snapshot();
    restore(e.hist.pop());
    if (cur) e.redoStack.push(cur);
    afterChange('撤销');
  };
  e.redo = function () {
    if (readonly()) return;
    if (!e.redoStack.length) { U.toast('没有可重做的操作'); return; }
    var cur = snapshot();
    restore(e.redoStack.pop());
    if (cur) e.hist.push(cur);
    afterChange('重做');
  };
  e.canUndo = function () { return e.hist.length > 0; };
  e.canRedo = function () { return e.redoStack.length > 0; };
  // 换了波形就清空历史：旧的快照对不上新数据，撤销会把 A/B 串到另一个波形上
  e.resetHistory = function () { e.hist.length = 0; e.redoStack.length = 0; };

  // ---------------- 归一化 + 重绘 ----------------
  function applyChannels(chA, chB, opts) {
    var w = wave();
    if (!w) return null;
    opts = opts || {};
    var keepSel = opts.keepSelection === undefined ? true : opts.keepSelection;
    var out;
    try {
      out = F.normalize({
        id: w.id, name: w.name, duration: w.duration, mode: w.mode, base: w.base,
        channels: { A: chA, B: chB }, notes: w.notes,
        createdAt: w.createdAt, builtin: w.builtin
      });
    } catch (err) {
      U.toast('数据非法：' + (err.message || err), 'warn');
      return null;
    }
    w.channels = out.channels;
    w.duration = out.duration;
    w.updatedAt = Date.now();
    if (out.duration !== G.dur) G.setDuration(out.duration, true);
    if (!keepSel) e.sel = null;
    return out;
  }

  function afterChange(msg) {
    if (WE.data) WE.data.markDirty();
    if (WE.json) WE.json.syncFromWave();
    WE.view.draw(); WE.view.schedule();
    if (WE.ui && WE.ui.refreshStatus) WE.ui.refreshStatus();
    if (msg) U.toast(msg);
  }

  // ---------------- 选择 ----------------
  e.getSelection = function () { return e.sel; };
  e.select = function (ch, idx) {
    e.sel = (ch === null || idx === null || idx === undefined) ? null : { ch: ch, idx: idx };
    WE.draw.renderDotsOnly();
  };
  e.clearSelection = function () { e.sel = null; WE.draw.renderDotsOnly(); };

  // ---------------- 命中测试 ----------------
  function hitPoint(t, a, tolPx) {
    var w = wave();
    if (!w) return null;
    var tol = tolPx || 8;
    var names = [e.ch], other = e.ch === 'A' ? 'B' : 'A';
    names.push(other);
    var best = null, bestD = tol;
    for (var n = 0; n < names.length; n++) {
      var pts = w.channels[names[n]] || [];
      for (var i = 0; i < pts.length; i++) {
        var dx = G.timeToX(pts[i][0]) - G.timeToX(t);
        var dy = G.ampToY(pts[i][1]) - G.ampToY(a);
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= bestD) { bestD = dist; best = { ch: names[n], idx: i }; }
      }
    }
    return best;
  }

  // ---------------- 增删改 ----------------
  function insertPoint(ch, t, a) {
    var w = wave();
    if (!w) return null;
    pushHist();
    var pts = w.channels[ch].map(function (p) { return [p[0], p[1]]; });
    var idx = 0;
    while (idx < pts.length && pts[idx][0] < t) idx++;
    pts.splice(idx, 0, [U.round3(t), Math.round(U.clamp(a, -LIMIT, LIMIT))]);
    var chA = ch === 'A' ? pts : w.channels.A;
    var chB = ch === 'B' ? pts : w.channels.B;
    applyChannels(chA, chB, { keepSelection: false });
    // 归一化可能去重，按时间重新定位
    var npts = wave().channels[ch];
    var ni = -1;
    for (var i = 0; i < npts.length; i++) if (Math.abs(npts[i][0] - U.round3(t)) < 1e-9) { ni = i; break; }
    e.sel = ni >= 0 ? { ch: ch, idx: ni } : null;
    return e.sel;
  }
  e.insertPoint = insertPoint;

  function movePoint(ch, idx, t, a, opts) {
    var w = wave();
    if (!w) return;
    var pts = w.channels[ch];
    if (idx < 0 || idx >= pts.length) return;
    var chA = w.channels.A.map(function (p) { return [p[0], p[1]]; });
    var chB = w.channels.B.map(function (p) { return [p[0], p[1]]; });
    var arr = ch === 'A' ? chA : chB;
    arr[idx] = [U.round3(U.clamp(t, 0, G.dur)), Math.round(U.clamp(a, -LIMIT, LIMIT))];
    applyChannels(chA, chB, { keepSelection: !!opts.keepSelection });
    if (!opts.keepSelection) e.sel = { ch: ch, idx: idx };
  }
  e.movePoint = movePoint;

  e.deleteSelected = function () {
    if (readonly()) return;
    if (!e.sel) { U.toast('先点选一个断点'); return; }
    var w = wave();
    if (!w) return;
    var pts = w.channels[e.sel.ch];
    if (pts.length <= 1) { U.toast('每条通道至少保留一个断点', 'warn'); return; }
    pushHist();
    var chA = w.channels.A.map(function (p) { return [p[0], p[1]]; });
    var chB = w.channels.B.map(function (p) { return [p[0], p[1]]; });
    (e.sel.ch === 'A' ? chA : chB).splice(e.sel.idx, 1);
    e.sel = null;
    applyChannels(chA, chB, { keepSelection: false });
    afterChange('已删除断点');
  };

  // ---------------- 自由绘制 ----------------
  function quantizeTime(t) {
    var step = QUANT_MS / 1000;
    var q = Math.round(t / step) * step;
    q = U.clamp(q, 0, G.dur);
    // duration 很大时按 50ms 量化会产生海量点，加一个"至少 1 像素"的保护
    return U.round3(q);
  }

  function freeDrawTo(sn) {
    var w = wave();
    if (!w) return;
    var ch = e.ch;
    var pts = w.channels[ch].map(function (p) { return [p[0], p[1]]; });
    var t = quantizeTime(sn.t), a = Math.round(sn.a);
    var idx = 0;
    while (idx < pts.length && pts[idx][0] < t) idx++;
    if (idx < pts.length && Math.abs(pts[idx][0] - t) < 1e-9) {
      pts[idx] = [t, a];                                  // 同一时间点直接改值
    } else {
      pts.splice(idx, 0, [t, a]);
    }
    // 绘制过程中不压历史、不整幅重绘（性能），结束后统一提交
    var chA = ch === 'A' ? pts : w.channels.A;
    var chB = ch === 'B' ? pts : w.channels.B;
    try {
      var out = F.normalize({
        id: w.id, name: w.name, duration: w.duration, mode: w.mode, base: w.base,
        channels: { A: chA, B: chB }, notes: w.notes, createdAt: w.createdAt, builtin: w.builtin
      });
      w.channels = out.channels; w.duration = out.duration;
    } catch (err) { /* 绘制中间态非法就忽略这一笔 */ }
  }

  // ---------------- 鼠标交互 ----------------
  function initPointer() {
    var wrap = U.$('canvasWrap');
    if (!wrap) return;
    var drag = null;    // { ch, idx, moved }
    var lastPt = null;  // 自由绘制的上一落点

    function posOf(ev) {
      var p = U.localPos(ev, wrap);
      return { t: G.xToTime(p.x), a: G.yToAmp(p.y), x: p.x, y: p.y };
    }

    function snapFor(p, exclIdx) {
      var r = Sn.apply(p.t, p.a, { ch: e.ch, exclIdx: exclIdx, lastPoint: lastPt });
      WE.view.snapped = r.snapped && (r.snapped.t || r.snapped.a) ? { t: r.snapped.t ? r.t : null, a: r.snapped.a ? r.a : null } : null;
      return r;
    }

    wrap.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      if (WE.view.spaceDown) return;                 // 空格 = 平移模式
      var p = posOf(ev);
      if (p.y < 0 || p.y > G.h) return;
      if (readonly()) { U.toast('内置示例是只读的，请先「另存副本」', 'warn'); return; }

      var hit = hitPoint(p.t, p.a, 9);
      if (hit) {
        // 选中并开始拖动。点的通道自动成为编辑焦点（不再需要界面上的 A/B 切换按钮）
        e.sel = { ch: hit.ch, idx: hit.idx };
        e.ch = hit.ch;
        drag = { ch: hit.ch, idx: hit.idx, moved: false, pushed: false };
        WE.draw.renderDotsOnly();
        wrap.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        return;
      }

      if (ev.shiftKey) {                              // Shift+点击：在曲线上插入断点
        var sn = snapFor(p);
        insertPoint(e.ch, sn.t, sn.a);
        afterChange('已插入断点，可在状态栏精确输入坐标');
        return;
      }

      if (e.tool === 'two') {
        // 两点式折线：第一次点定起点，第二次点定终点
        if (!e.twoPoint) {
          var s1 = snapFor(p);
          e.twoPoint = { t: s1.t, a: s1.a };
          lastPt = [s1.t, s1.a];
          U.toast('已定起点，再点一次确定终点（Esc 取消）');
        } else {
          var s2 = snapFor(p, null);
          pushHist();
          var t0 = e.twoPoint.t, a0 = e.twoPoint.a, t1 = s2.t, a1 = s2.a;
          if (t0 > t1) { var tt = t0; t0 = t1; t1 = tt; var aa = a0; a0 = a1; a1 = aa; }
          var chA = wave().channels.A.map(function (q) { return [q[0], q[1]]; });
          var chB = wave().channels.B.map(function (q) { return [q[0], q[1]]; });
          var arr = e.ch === 'A' ? chA : chB;
          // 移除区间内的旧点，再放两端点
          var kept = arr.filter(function (q) { return q[0] < t0 - 1e-9 || q[0] > t1 + 1e-9; });
          kept.push([U.round3(t0), Math.round(a0)]);
          if (Math.abs(t1 - t0) > 1e-9) kept.push([U.round3(t1), Math.round(a1)]);
          if (e.ch === 'A') chA = kept; else chB = kept;
          applyChannels(chA, chB, { keepSelection: false });
          e.twoPoint = null;
          afterChange('已生成两点式折线');
        }
        return;
      }

      // 自由绘制
      pushHist();
      drag = { free: true, pushed: true };
      lastPt = null;
      wrap.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      var sn0 = snapFor(p);
      freeDrawTo(sn0);
      lastPt = [quantizeTime(sn0.t), Math.round(sn0.a)];
      WE.view.draw();
    });

    wrap.addEventListener('pointermove', function (ev) {
      var p = posOf(ev);
      WE.view.hoverT = p.t;
      if (WE.ui && WE.ui.refreshStatus) WE.ui.refreshStatus(p);

      // 自由绘制中 / 拖动断点中：更新吸附提示与预览
      if (drag) {
        if (drag.free) {
          var sn = snapFor(p, null);
          freeDrawTo(sn);
          lastPt = [quantizeTime(sn.t), Math.round(sn.a)];
          WE.view.draw();
        } else {
          if (!drag.pushed) { pushHist(); drag.pushed = true; }     // 真正移动了才压历史
          var sn2 = Sn.apply(p.t, p.a, { ch: drag.ch, exclIdx: drag.idx });
          WE.view.snapped = sn2.snapped && (sn2.snapped.t || sn2.snapped.a)
            ? { t: sn2.snapped.t ? sn2.t : null, a: sn2.snapped.a ? sn2.a : null } : null;
          drag.moved = true;
          movePoint(drag.ch, drag.idx, sn2.t, sn2.a, { keepSelection: true });
          e.sel = { ch: drag.ch, idx: drag.idx };
          WE.view.draw();
        }
        return;
      }

      // 两点式：预览橡皮筋
      if (e.twoPoint) {
        var sn3 = snapFor(p, null);
        e.rubber = { t: sn3.t, a: sn3.a };
        drawRubber();
        WE.view.schedule();
        return;
      }

      // 普通悬停：显示吸附参考线
      if (p.y >= 0 && p.y <= G.h) {
        if (Sn.isEnabled()) { snapFor(p, null); } else { WE.view.snapped = null; }
      } else {
        WE.view.snapped = null;
      }
      WE.view.schedule();
    });

    function endDrag(ev) {
      if (!drag) return;
      var wasFree = drag.free;
      drag = null;
      lastPt = null;
      try { wrap.releasePointerCapture(ev.pointerId); } catch (err) { }
      WE.view.snapped = null;
      if (wasFree) afterChange('绘制完成');
      else afterChange(null);
      if (WE.data) WE.data.markDirty();
      if (WE.json) WE.json.syncFromWave();
    }
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);

    wrap.addEventListener('pointerleave', function () {
      WE.view.hoverT = null;
      if (!drag) { WE.view.snapped = null; WE.view.schedule(); }
    });
  }

  // 两点式橡皮筋
  function drawRubber() {
    var g = U.$('ovRubber');
    if (!g) return;
    U.clear(g);
    if (!e.twoPoint || !e.rubber) return;
    var x1 = G.timeToX(e.twoPoint.t), y1 = G.ampToY(e.twoPoint.a);
    var x2 = G.timeToX(e.rubber.t), y2 = G.ampToY(e.rubber.a);
    g.appendChild(U.svg('line', { x1: x1, y1: y1, x2: x2, y2: y2, class: 'rubber' }));
    g.appendChild(U.svg('circle', { cx: x1, cy: y1, r: 4, fill: '#a78bfa' }));
    g.appendChild(U.svg('circle', { cx: x2, cy: y2, r: 4, fill: '#a78bfa' }));
  }
  function clearRubber() {
    var g = U.$('ovRubber');
    if (g) U.clear(g);
  }

  // ---------------- 坐标输入落点 ----------------
  e.placeAt = function (t, a) {
    if (readonly()) { U.toast('内置示例是只读的，请先「另存副本」', 'warn'); return false; }
    if (!U.isNum(t) || !U.isNum(a)) { U.toast('请输入时间与幅度', 'warn'); return false; }
    if (t < 0 || t > G.dur) { U.toast('时间需在 0 ~ ' + U.fmtSec(G.dur) + ' 秒之间', 'warn'); return false; }
    if (a < -LIMIT || a > LIMIT) { U.toast('幅度需在 -127 ~ 127 之间', 'warn'); return false; }
    var sel = insertPoint(e.ch, t, a);
    afterChange(sel ? '已在 ' + U.fmtSec(U.round3(t)) + 's / ' + Math.round(a) + ' 落点' : '已落点');
    return true;
  };

  // ---------------- 工具/通道切换 ----------------
  e.setTool = function (t) {
    e.tool = (t === 'two') ? 'two' : 'free';
    e.twoPoint = null; clearRubber();
    if (WE.ui) WE.ui.syncToolButtons();
    WE.view.schedule();
  };
  e.getTool = function () { return e.tool; };
  // 编辑焦点通道：默认 A；点选某个点时会自动切到该点所属通道。
  // 界面上不再提供 A/B 切换按钮（一个波形就是一份数据，两条曲线同屏）。
  e.setCh = function (ch) {
    e.ch = (ch === 'B') ? 'B' : 'A';
    e.twoPoint = null; clearRubber();
    WE.view.schedule();
  };
  e.getCh = function () { return e.ch; };
  e.cancelPending = function () {
    if (e.twoPoint) { e.twoPoint = null; clearRubber(); U.toast('已取消两点式起点'); WE.view.schedule(); return true; }
    return false;
  };

  // ---------------- 键盘 ----------------
  function initKeys() {
    window.addEventListener('keydown', function (ev) {
      if (WE.view.isTyping(ev)) {
        // 输入框里回车 = 落点（状态栏的坐标输入）
        if (ev.key === 'Enter' && WE.ui && WE.ui.onCoordEnter) WE.ui.onCoordEnter(ev);
        return;
      }
      var key = ev.key;
      if ((ev.ctrlKey || ev.metaKey) && key.toLowerCase() === 'z') { ev.preventDefault(); e.undo(); return; }
      if ((ev.ctrlKey || ev.metaKey) && (key.toLowerCase() === 'y' || (ev.shiftKey && key.toLowerCase() === 'z'))) {
        ev.preventDefault(); e.redo(); return;
      }
      if (key === 'Delete' || key === 'Backspace') { ev.preventDefault(); e.deleteSelected(); return; }
      if (key === 'Escape') { if (!e.cancelPending() && WE.ui) WE.ui.onEsc(); return; }
      if (key === 'Enter') { if (e.cancelPending()) ev.preventDefault(); return; }
    });
  }

  e.init = function () {
    initPointer();
    initKeys();
  };

  WE.editor = e;
})();
