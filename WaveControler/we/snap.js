// ============================================================
// we/snap.js - 自动吸附
//   候选目标：幅度 0 中线、幅度 ±127 上下限、时间 0、循环终点、整数式时间刻度、
//             已有断点（同通道 + 另一通道）、当前正在画的上一笔端点
//   阈值按"屏幕像素"判定（6px），所以缩放后手感不变
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};
  var U = WE.util, G = WE.grid, F = window.WC.format;
  var LIMIT = 127;

  var s = { on: true, PX: 6 };

  function pxPerSec() { return G.w / Math.max(1e-9, G.tSpan()); }
  function pxPerUnit() { return G.h / Math.max(1e-9, G.aSpan()); }

  // 时间刻度候选：直接用网格上真正画出来的那组刻度值，
  // 保证"看得到刻度就能吸得到"，不会出现肉眼对齐了但吸附不到的情况。
  function timeCandidates() {
    return G.timeTicks();
  }

  // 幅度候选：0 中线、±127 上下限，以及网格上的每一个刻度线
  function ampCandidates() {
    var out = [0, LIMIT, -LIMIT], ticks = G.ampTicks();
    for (var i = 0; i < ticks.length; i++) out.push(ticks[i]);
    return out;
  }

  function pickClosest(cur, cands, toPx) {
    var best = null, bestD = s.PX + 1e-9;
    for (var i = 0; i < cands.length; i++) {
      var d = Math.abs(toPx(cands[i]) - toPx(cur));
      if (d < bestD) { bestD = d; best = { value: cands[i], px: d }; }
    }
    return best;
  }

  // ---------------- 主入口 ----------------
  // t / a: 原始值；opts.ch: 当前编辑通道；opts.exclIdx: 拖动时要排除的断点索引
  // 返回 { t, a, snapped:{t:bool,a:bool}, kind:[...] }
  s.apply = function (t, a, opts) {
    opts = opts || {};
    var res = { t: U.clamp(t, 0, G.dur), a: U.clamp(Math.round(a), -LIMIT, LIMIT), kinds: [] };
    if (!s.on) return res;

    var wave = WE.data ? WE.data.getWave() : null;
    var ch = opts.ch || 'A';

    // ---- 断点吸附（时间 + 幅度一起吸，优先于刻度）----
    if (wave && wave.channels) {
      var names = ['A', 'B'], bi, best = null, bestD = s.PX + 1e-9;
      for (var n = 0; n < names.length; n++) {
        var pts = wave.channels[names[n]] || [];
        for (bi = 0; bi < pts.length; bi++) {
          if (names[n] === ch && opts.exclIdx === bi) continue;
          var dx = G.timeToX(pts[bi][0]) - G.timeToX(t);
          var dy = G.ampToY(pts[bi][1]) - G.ampToY(res.a);
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestD) { bestD = dist; best = { t: pts[bi][0], a: pts[bi][1], other: names[n] !== ch }; }
        }
      }
      if (best) {
        res.t = best.t; res.a = best.a;
        res.kinds.push(best.other ? '另一通道断点' : '断点');
        res.snapped = { t: true, a: true };
        return res;
      }
    }

    // ---- 上一笔端点（画线时接住起点）----
    if (opts.lastPoint) {
      var lp = opts.lastPoint;
      var ldx = G.timeToX(lp[0]) - G.timeToX(t);
      var ldy = G.ampToY(lp[1]) - G.ampToY(res.a);
      if (Math.sqrt(ldx * ldx + ldy * ldy) < s.PX) {
        res.t = lp[0]; res.a = lp[1];
        res.kinds.push('接续起点');
        res.snapped = { t: true, a: true };
        return res;
      }
    }

    // ---- 幅度：0 中线 / ±127 ----
    var ampHit = pickClosest(res.a, ampCandidates(), G.ampToY);
    if (ampHit) {
      res.a = ampHit.value;
      res.kinds.push(ampHit.value === 0 ? '幅度 0' : (ampHit.value > 0 ? '幅度 +127' : '幅度 -127'));
      res.snappedA = true;
    }

    // ---- 时间：0 / 循环终点 / 刻度 ----
    var tHit = pickClosest(res.t, timeCandidates(), G.timeToX);
    if (tHit) {
      res.t = U.round3(tHit.value);
      res.kinds.push(Math.abs(tHit.value) < 1e-9 ? '时间 0'
        : (Math.abs(tHit.value - G.dur) < 1e-9 ? '循环终点' : '时间刻度'));
      res.snappedT = true;
    }

    res.snapped = { t: !!res.snappedT, a: !!res.snappedA };
    return res;
  };

  // 只吸时间（用于拖动断点时锁住时间轴）或只吸幅度
  s.timeOnly = function (t, opts) {
    var r = s.apply(t, 0, opts);
    return r.t;
  };

  s.setEnabled = function (on) { s.on = !!on; };
  s.isEnabled = function () { return s.on; };

  WE.snap = s;
})();
