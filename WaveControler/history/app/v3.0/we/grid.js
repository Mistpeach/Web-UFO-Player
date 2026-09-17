// ============================================================
// we/grid.js - 坐标系（固定范围，不做缩放/平移）
//   时间轴：恒为 [0, duration]（整周期全览，右端就是循环回绕点）
//   幅度轴：恒为 [-127, +127]（与 BLE 指令值域一致，0 永远在中线）
//   因此这里只有"像素 ↔ 数值"和"刻度取值"两件事，没有任何视窗状态。
//   将来若要恢复缩放，只需加回 t0/t1/a0/a1 的读写即可。
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};
  var U = WE.util;

  var AMP_LIMIT = 127;      // 与 BLE 指令值域一致

  var g = {
    dur: 1,                             // 波形循环周期（秒）
    x0: 0, y0: 0, w: 1, h: 1            // 绘图区像素范围（由 canvasWrap 的尺寸决定）
  };

  // 固定边界（只读，供绘制/吸附查询）
  Object.defineProperty(g, 't0', { get: function () { return 0; } });
  Object.defineProperty(g, 't1', { get: function () { return g.dur; } });
  Object.defineProperty(g, 'a0', { get: function () { return -AMP_LIMIT; } });
  Object.defineProperty(g, 'a1', { get: function () { return AMP_LIMIT; } });

  // ---------------- 尺寸 ----------------
  g.resize = function (w, h) {
    g.w = Math.max(1, w);
    g.h = Math.max(1, h);
  };

  g.setDuration = function (sec) {
    var d = (U.isNum(sec) && sec > 0) ? sec : 1;
    g.dur = d;
  };

  // ---------------- 像素 ↔ 数值 ----------------
  g.timeToX = function (t) { return (t / g.dur) * g.w; };
  g.xToTime = function (x) { return (x / g.w) * g.dur; };
  // 幅度向上为正：y = 0 在绘图区顶部
  g.ampToY = function (a) { return (AMP_LIMIT - a) / (AMP_LIMIT * 2) * g.h; };
  g.yToAmp = function (y) { return AMP_LIMIT - (y / g.h) * (AMP_LIMIT * 2); };

  g.tSpan = function () { return g.dur; };
  g.aSpan = function () { return AMP_LIMIT * 2; };
  g.AMP_LIMIT = AMP_LIMIT;

  // ---------------- 刻度 ----------------
  // 时间刻度：挑一个"整齐"的步长（0.1/0.2/0.5/1/2/5/10… 秒，含毫秒档），
  // 让整个周期上的刻度数量落在 [4, 14] 之间，保证不会挤成一团也不会太空。
  var T_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

  g.timeStep = function () {
    for (var i = 0; i < T_STEPS.length; i++) {
      if (g.dur / T_STEPS[i] <= 14) return T_STEPS[i];
    }
    return T_STEPS[T_STEPS.length - 1];
  };

  // 返回 [0, step, 2*step, …, dur]（含终点），吸附与绘制共用同一组取值，保证"看到刻度就能吸到"
  g.timeTicks = function () {
    var step = g.timeStep();
    var out = [], t = 0, guard = 0;
    while (t <= g.dur + 1e-9 && guard++ < 4000) {
      out.push(U.round3(t));
      t += step;
    }
    // 补齐终点：步长除不尽时最后一个刻度不等于 dur，但循环终点必须能吸到
    if (!out.length || Math.abs(out[out.length - 1] - g.dur) > 1e-9) out.push(U.round3(g.dur));
    return out;
  };

  // 幅度刻度：固定 25 一格（-125 … 125），0 一定在其中且落在中线
  g.ampTicks = function () {
    var out = [];
    for (var a = -125; a <= 125; a += 25) out.push(a);
    return out;
  };

  WE.grid = g;
})();
