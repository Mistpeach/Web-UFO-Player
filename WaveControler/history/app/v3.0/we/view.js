// ============================================================
// we/view.js - 画布尺寸/DPR、标尺与网格绘制、视图交互（缩放/平移/滚动条）
//   只负责"视图"，不碰波形数据本身（数据编辑在 editor.js）
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};
  var U = WE.util, G = WE.grid, P = U.PAL;

  var v = {
    wave: null,          // 当前波形（由 editor/data 设置，仅供绘制参考线用）
    hoverT: null,        // 鼠标所在时间（用于状态栏）
    dpr: 1, w: 0, h: 0,
    snapped: null        // {t, a, kind} 吸附结果，供绘制参考线
  };

  var cv, ctx, wrap, plot, ovCursor, ovSnapH, ovSnapV;
  var raf = null, needDraw = true;

  // ---------------- 尺寸 ----------------
  // 视图固定（整周期 × ±127），画布铺满 #canvasWrap，无需任何视窗状态
  v.resize = function () {
    if (!wrap || !cv) return;
    var w = Math.max(1, Math.round(wrap.clientWidth));
    var h = Math.max(1, Math.round(wrap.clientHeight));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    v.w = w; v.h = h; v.dpr = dpr;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 覆盖层是 SVG，用 CSS 像素即可
    ov().setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    ov().setAttribute('width', w);
    ov().setAttribute('height', h);
    G.resize(w, h);
    updateAxes();
    v.draw();
  };

  function ov() { return U.$('ov'); }

  // ---------------- 绘制调度 ----------------
  v.invalidate = function () { needDraw = true; };

  v.draw = function () {
    needDraw = false;
    if (!ctx) return;
    drawBackground();
    if (WE.draw) WE.draw.render(ctx, v);
    drawOverlay();
  };

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = null;
      if (needDraw) v.draw();
    });
  }
  v.schedule = schedule;

  // ---------------- 背景 + 网格线 ----------------
  // 视图固定为「整周期 × ±127 全幅」，所以网格是稳定的：
  //   横向 = 幅度刻度线（25 一格，0 加粗）
  //   纵向 = 时间刻度线（步长由 grid.timeStep() 按周期自适应）
  // 轴上的刻度文字用 DOM 渲染（updateAxes），位置与这里的线一一对应。
  function drawBackground() {
    var w = v.w, h = v.h, mid = G.ampToY(0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = P.BG;
    ctx.fillRect(0, 0, w, h);

    // 上下半区底色（正转 / 反转），与示波器一致
    if (mid > 0) { ctx.fillStyle = P.POS_BG; ctx.fillRect(0, 0, w, Math.min(mid, h)); }
    if (mid < h) { ctx.fillStyle = P.NEG_BG; ctx.fillRect(0, Math.max(0, mid), w, h - Math.max(0, mid)); }

    ctx.save();
    // ---- 幅度网格线（横向）----
    var at = G.ampTicks();
    for (var i = 0; i < at.length; i++) {
      var a = at[i];
      var y = Math.round(G.ampToY(a)) + 0.5;
      ctx.beginPath();
      ctx.strokeStyle = (a === 0) ? P.AXIS : P.GRID;
      ctx.lineWidth = (a === 0) ? 2 : 1;
      ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // ---- 时间网格线（纵向）----
    var tt = G.timeTicks();
    for (i = 0; i < tt.length; i++) {
      var x = Math.round(G.timeToX(tt[i])) + 0.5;
      ctx.beginPath();
      ctx.strokeStyle = P.GRID;
      ctx.lineWidth = 1;
      ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.restore();

    // ---- 时间 0 与循环终点：虚线贯穿绘图区 ----
    [0, G.dur].forEach(function (mark, k) {
      var x = Math.round(G.timeToX(mark)) + 0.5;
      if (x < -1 || x > w + 1) return;
      ctx.beginPath();
      ctx.strokeStyle = k === 1 ? 'rgba(251,191,36,0.5)' : 'rgba(167,139,250,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  // ---------------- 轴刻度文字（DOM，按 grid 换算定位） ----------------
  function updateAxes() {
    var left = U.$('axLeft'), bottom = U.$('axBottom');
    if (!left || !bottom) return;
    U.clear(left); U.clear(bottom);

    // 幅度轴：每个刻度一条文字，0 加粗高亮
    var at = G.ampTicks();
    for (var i = 0; i < at.length; i++) {
      var a = at[i];
      var el = document.createElement('span');
      el.className = 'axTickA' + (a === 0 ? ' zero' : (Math.abs(a) === 125 ? ' limit' : ''));
      el.textContent = (a > 0 ? '+' : '') + a;
      el.style.top = G.ampToY(a) + 'px';
      left.appendChild(el);
    }

    // 时间标尺：每个刻度一条文字
    var tt = G.timeTicks();
    for (i = 0; i < tt.length; i++) {
      var t = tt[i];
      var el2 = document.createElement('span');
      el2.className = 'axTickT';
      el2.textContent = U.fmtSec(t);
      el2.style.left = G.timeToX(t) + 'px';
      bottom.appendChild(el2);
    }
    // 0 与循环终点的小三角标记
    [0, G.dur].forEach(function (mark, k) {
      var m = document.createElement('div');
      m.className = 'axMark ' + (k === 1 ? 'end' : 'start');
      m.style.left = G.timeToX(mark) + 'px';
      bottom.appendChild(m);
    });
  }

  // ---------------- 覆盖层（SVG）：十字准线 + 吸附参考线 ----------------
  function drawOverlay() {
    var sp = v.snapped;
    // 吸附参考线
    if (sp) {
      if (sp.t !== undefined && sp.t !== null) {
        var x = G.timeToX(sp.t);
        U.setAttr(ovSnapV, 'x1', x); U.setAttr(ovSnapV, 'x2', x);
        U.setAttr(ovSnapV, 'y1', 0); U.setAttr(ovSnapV, 'y2', v.h);
        ovSnapV.style.display = '';
      } else ovSnapV.style.display = 'none';

      if (sp.a !== undefined && sp.a !== null) {
        var y = G.ampToY(sp.a);
        U.setAttr(ovSnapH, 'x1', 0); U.setAttr(ovSnapH, 'x2', v.w);
        U.setAttr(ovSnapH, 'y1', y); U.setAttr(ovSnapH, 'y2', y);
        ovSnapH.style.display = '';
      } else ovSnapH.style.display = 'none';
    } else {
      ovSnapV.style.display = 'none';
      ovSnapH.style.display = 'none';
    }
  }

  v.setCursor = function (x, y, show) {
    if (!ovCursor) return;
    if (!show) { ovCursor.style.display = 'none'; return; }
    ovCursor.style.display = '';
    U.setAttr(ovCursor, 'x1', x); U.setAttr(ovCursor, 'x2', x);
    U.setAttr(ovCursor, 'y1', 0); U.setAttr(ovCursor, 'y2', v.h);
  };

  // ---------------- 鼠标交互 ----------------
  // 视图固定（整周期 × ±127 全幅），所以没有缩放/平移/滚动条。
  // 绘图区只用右键菜单屏蔽；编辑交互全部在 editor.js。
  function bindCanvas() {
    wrap.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function isTyping(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || t.isContentEditable;
  }
  v.isTyping = isTyping;

  // ---------------- 初始化 ----------------
  function init() {
    cv = U.$('cv');
    if (!cv) return false;
    ctx = cv.getContext('2d');
    wrap = U.$('canvasWrap');
    plot = U.$('plot');
    ovCursor = U.$('ovCursor');
    ovSnapH = U.$('ovSnapH');
    ovSnapV = U.$('ovSnapV');

    v.resize();
    bindCanvas();

    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { v.resize(); });
      ro.observe(wrap);
      ro.observe(plot);
    } else {
      window.addEventListener('resize', function () { v.resize(); });
    }
    v.draw();
    return true;
  }

  v.init = init;

  // 轴刻度是 DOM，周期变了要重排（data.js 改 duration 后会调）
  v.refreshAxes = function () { updateAxes(); v.draw(); };

  WE.view = v;
})();
