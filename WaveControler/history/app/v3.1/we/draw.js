// ============================================================
// we/draw.js - 波形曲线与断点绘制
//   配色/分区规则照抄 js/scope.js（正转上半绿、反转下半紫红、0 中线）
//   区别：这里是"编辑视图" —— 断点画成可点选的圆点，A/B 用实线/虚线区分，
//         并且 hold 模式画真实阶梯而不是采样折线（编辑时看的就是真值）
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};
  var U = WE.util, G = WE.grid, P = U.PAL;
  var F = window.WC.format;

  var d = {
    showA: true, showB: true
  };

  // 折线按正负分段着色（同一段连续符号只下一次笔）
  function strokeSignColored(ctx, pts) {
    if (pts.length < 2) return;
    var i = 0;
    while (i < pts.length - 1) {
      var sign = pts[i][1] <= 0 ? -1 : 1;
      var start = i;
      while (i < pts.length - 1 && ((pts[i + 1][1] <= 0 ? -1 : 1) === sign)) i++;
      // 把跨过中线的那一小段也带上，避免断口
      var end = Math.min(pts.length - 1, i + 1);
      ctx.beginPath();
      ctx.strokeStyle = sign > 0 ? P.POS : P.NEG;
      ctx.moveTo(pts[start][0], pts[start][1]);
      for (var k = start + 1; k <= end; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.stroke();
      if (i === start) i++; else i = end;
      if (i >= pts.length - 1) break;
    }
  }

  // 采样曲线（hold/linear 都由 sampleWave 决定真实形态）
  function sampleLine(ctx, wave, ch, dashed) {
    var w = G.w, out = [], px, t;
    ctx.save();
    if (dashed) { ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.85; }
    ctx.lineWidth = dashed ? 1.6 : 2.2;
    ctx.lineJoin = 'round';
    for (px = 0; px <= w; px++) {
      t = G.xToTime(px);
      out.push([px, G.ampToY(F.sampleWave(wave, ch, t))]);
    }
    strokeSignColored(ctx, out);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // hold 模式：真实阶梯（水平段 + 垂直跳变），比采样折线更能反映"真值"
  function stepLine(ctx, wave, ch, dashed) {
    var pts = (wave.channels && wave.channels[ch]) || [];
    if (!pts.length) return;
    var dur = F.durationOf(wave);
    // 末尾若没到 duration，补一点让最后一段水平线保持到循环终点
    var ext = [], i;
    for (i = 0; i < pts.length; i++) ext.push([pts[i][0], pts[i][1]]);
    if (ext[ext.length - 1][0] < dur - 1e-9) ext.push([dur, ext[ext.length - 1][1]]);

    // 转成像素，并裁掉远离视窗的点（左右各多留一个，保证线能延伸出画布）
    var vis = [];
    for (i = 0; i < ext.length; i++) vis.push([G.timeToX(ext[i][0]), G.ampToY(ext[i][1])]);
    var first = 0, last = vis.length - 1;
    while (first < last && vis[first + 1][0] < -800) first++;
    while (last > first && vis[last - 1][0] > G.w + 800) last--;
    if (last <= first) return;

    ctx.save();
    if (dashed) { ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.85; }
    ctx.lineWidth = dashed ? 1.6 : 2.2;
    ctx.lineJoin = 'miter';

    for (i = first; i < last; i++) {
      var xa = vis[i][0], ya = vis[i][1];
      var xb = vis[i + 1][0], yb = vis[i + 1][1];
      var va = ext[i][1];
      // 水平段：保持当前值，颜色按该值的符号
      ctx.beginPath();
      ctx.strokeStyle = va > 0 ? P.POS : (va < 0 ? P.NEG : P.HEAD);
      ctx.moveTo(xa, ya); ctx.lineTo(xb, ya);
      ctx.stroke();
      // 垂直跳变：连到下一个值
      if (Math.abs(yb - ya) > 0.5) {
        var vb = ext[i + 1][1];
        ctx.beginPath();
        ctx.strokeStyle = Math.abs(vb) > Math.abs(va) ? (vb > 0 ? P.POS : P.NEG) : (va > 0 ? P.POS : (va < 0 ? P.NEG : P.HEAD));
        ctx.moveTo(xb, ya); ctx.lineTo(xb, yb);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ---------------- 断点圆点（画到 SVG 覆盖层，方便点选/悬停） ----------------
  function renderDots(wave, ch) {
    var gid = ch === 'A' ? U.$('ovA') : U.$('ovB');
    if (!gid) return;
    U.clear(gid);
    if (!wave || !wave.channels) return;
    var pts = wave.channels[ch] || [];
    var sel = WE.editor ? WE.editor.getSelection() : null;
    var color = ch === 'A' ? P.DOT_A : P.DOT_B;
    for (var i = 0; i < pts.length; i++) {
      var x = G.timeToX(pts[i][0]);
      if (x < -20 || x > G.w + 20) continue;      // 视窗外不渲染，省节点
      var y = G.ampToY(pts[i][1]);
      var isSel = !!(sel && sel.ch === ch && sel.idx === i);
      var c = U.svg('circle', {
        cx: x, cy: y, r: isSel ? 6 : 4.5,
        class: 'pt' + (isSel ? ' sel' : ''),
        fill: color,
        'data-ch': ch, 'data-idx': i
      });
      gid.appendChild(c);
    }
  }

  // ---------------- 主入口 ----------------
  d.render = function (ctx, view) {
    var wave = WE.data ? WE.data.getWave() : null;
    if (!wave) {
      U.clear(U.$('ovA')); U.clear(U.$('ovB'));
      return;
    }
    var isHold = wave.mode !== 'linear';
    var chs = [];
    if (d.showA) chs.push({ ch: 'A', dashed: false });
    if (d.showB) chs.push({ ch: 'B', dashed: true });

    // 淡色目标曲线
    for (var i = 0; i < chs.length; i++) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      if (isHold) stepLine(ctx, wave, chs[i].ch, chs[i].dashed);
      else sampleLine(ctx, wave, chs[i].ch, chs[i].dashed);
      ctx.restore();
    }

    // 断点圆点
    U.clear(U.$('ovA')); U.clear(U.$('ovB'));
    for (i = 0; i < chs.length; i++) renderDots(wave, chs[i].ch);
  };

  // 只重画圆点（拖动时高频调用，避免整幅重绘）
  d.renderDotsOnly = function () {
    var wave = WE.data ? WE.data.getWave() : null;
    if (!wave) return;
    U.clear(U.$('ovA')); U.clear(U.$('ovB'));
    if (d.showA) renderDots(wave, 'A');
    if (d.showB) renderDots(wave, 'B');
  };

  WE.draw = d;
})();
