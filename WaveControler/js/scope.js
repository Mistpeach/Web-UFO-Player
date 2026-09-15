// ============================================================
// scope.js - 双通道示波器
//   竖直：中线上半 = 正转（青绿），下半 = 反转（品红），0 值贴中线
//   淡色曲线 = 目标值（波形 × 强度），亮色折线 = 真正发出的值（阶梯）
//   竖线 = 播放头；超过 ±127 被夹取的部分用警示虚线画在上限处
// 绘制用 rAF 只读 engine 数据，绝不参与发送定时
// ============================================================
(function () {
  'use strict';
  var WC = window.WC = window.WC || {};
  var F = WC.format;

  var POS = '#3ddc97', NEG = '#e05fd8', GRID = 'rgba(15,52,96,0.9)',
      AXIS = 'rgba(83,52,131,0.9)', TARGET = 'rgba(167,139,250,0.45)',
      HEAD = 'rgba(224,224,224,0.85)', WARN = 'rgba(255,120,120,0.9)';

  var views = {};             // { A:{canvas,ctx,waveName}, B:{...} }
  var running = false, rafId = null, dirty = true;

  function attach(name, canvas) {
    views[name] = { canvas: canvas, ctx: canvas.getContext('2d'), wave: null };
    dirty = true;
  }

  function setWave(name, wave) {
    if (!views[name]) return;
    views[name].wave = wave || null;
    dirty = true;
  }

  // 每次绘制前同步画布尺寸：字体加载/窗口变化/抽屉开关都会改变布局，
  // 尺寸不同步会导致绘制缩放错位并留下未绘制的空白条
  function syncSize(v) {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(80, v.canvas.clientWidth || 320);
    var h = Math.max(40, v.canvas.clientHeight || 90);
    if (v.w === w && v.h === h && v.dpr === dpr) return false;
    v.w = w; v.h = h; v.dpr = dpr;
    v.canvas.width = Math.round(w * dpr);
    v.canvas.height = Math.round(h * dpr);
    v.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
    return true;
  }

  function resize() {
    for (var k in views) {
      if (!views.hasOwnProperty(k)) continue;
      syncSize(views[k]);
    }
    dirty = true;
  }

  function yOf(v, h, pad) { return h / 2 - (F.clamp(v, -127, 127) / 127) * (h / 2 - pad); }

  function drawBackground(v) {
    var ctx = v.ctx, w = v.w, h = v.h, mid = h / 2, pad = 6;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d1424';
    ctx.fillRect(0, 0, w, h);

    // 上下半区底色（正转/反转）
    ctx.fillStyle = 'rgba(61,220,151,0.055)';
    ctx.fillRect(0, 0, w, mid);
    ctx.fillStyle = 'rgba(224,95,216,0.055)';
    ctx.fillRect(0, mid, w, h - mid);

    // 网格
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    var i;
    for (i = 1; i < 8; i++) {
      var x = Math.round(w * i / 8) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, Math.round(h / 4) + 0.5); ctx.lineTo(w, Math.round(h / 4) + 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, Math.round(h * 3 / 4) + 0.5); ctx.lineTo(w, Math.round(h * 3 / 4) + 0.5); ctx.stroke();

    // 中线（0）
    ctx.strokeStyle = AXIS; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, Math.round(mid) + 0.5); ctx.lineTo(w, Math.round(mid) + 0.5); ctx.stroke();

    // 满量程刻度
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    var yTop = Math.round(yOf(127, h, pad)) + 0.5, yBot = Math.round(yOf(-127, h, pad)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, yTop); ctx.lineTo(w, yTop); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, yBot); ctx.lineTo(w, yBot); ctx.stroke();
    ctx.setLineDash([]);
    return { mid: mid, pad: pad };
  }

  // 双色描边：把同一折线分别裁剪到上半/下半，各用一次颜色
  function strokeBiColor(v, pts, lineWidth) {
    var ctx = v.ctx, h = v.h, mid = h / 2, i;
    if (pts.length < 2) return;
    var passes = [{ c: POS, top: 0, bot: mid }, { c: NEG, top: mid, bot: h }];
    for (var p = 0; p < 2; p++) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, passes[p].top, v.w, passes[p].bot - passes[p].top); ctx.clip();
      ctx.strokeStyle = passes[p].c; ctx.lineWidth = lineWidth; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (i = 0; i < pts.length; i++) {
        if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]); else ctx.lineTo(pts[i][0], pts[i][1]);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawTarget(v, name, info) {
    var wave = v.wave, i;
    if (!wave) return;
    var w = v.w, h = v.h, pad = info.pad;
    var dur = F.durationOf(wave);
    var c = WC.engine.ch[name];
    var k = c ? c.intensity : 1;
    var pts = [];
    for (i = 0; i <= w; i++) {
      var tt = (i === w) ? dur - 1e-6 : (i / w) * dur;   // 最右列取回绕前的值
      pts.push([i, yOf(F.sampleWave(wave, name, tt) * k, h, pad)]);
    }
    var ctx = v.ctx;
    ctx.globalAlpha = 0.45;
    strokeBiColor(v, pts, 1.5);
    ctx.globalAlpha = 1;

    // 被 ±127 夹取的区间用警示虚线标出
    ctx.save();
    ctx.setLineDash([3, 3]); ctx.lineWidth = 2; ctx.strokeStyle = WARN;
    var segStart = null, dir = 1;
    for (i = 0; i <= w; i++) {
      var ttv = (i === w) ? dur - 1e-6 : (i / w) * dur;
      var tv = F.sampleWave(wave, name, ttv) * k;
      var over = Math.abs(tv) > 127.5;
      if (over) dir = tv > 0 ? 1 : -1;
      if (over && segStart === null) segStart = i;
      if ((!over || i === w) && segStart !== null) {
        var yy = yOf(dir * 127, h, pad);
        ctx.beginPath(); ctx.moveTo(segStart, yy); ctx.lineTo(i, yy); ctx.stroke();
        segStart = null;
      }
    }
    ctx.restore();
  }

  function curLoopStartMs(now) {
    var c = { A: WC.engine.ch.A, B: WC.engine.ch.B };
    var dur = F.durationOf(c.A.wave || c.B.wave || { duration: 1 }) * 1000;
    var startAt = WC.engine.startAt();
    if (!dur) return startAt;
    return startAt + Math.floor((now - startAt) / dur) * dur;
  }

  function drawSent(v, name) {
    var ctx = v.ctx, h = v.h, pad = 6, i;
    var durMs = F.durationOf(v.wave) * 1000;
    var startAt = WC.engine.startAt();
    var loopStart = curLoopStartMs(nowMs());
    var pts = [], dots = [];
    for (i = 0; i < WC.engine.ring.length; i++) {
      var e = WC.engine.ring[i];
      if (e.t < loopStart) continue;
      var ph = ((e.t - startAt) % durMs) / durMs;
      if (ph < 0) continue;
      var val = (name === 'A' ? e.a : e.b);
      pts.push([ph * v.w, yOf(val, h, pad)]);
      dots.push(ph * v.w);
    }
    pts.sort(function (a, b) { return a[0] - b[0]; });
    ctx.globalAlpha = 1;
    strokeBiColor(v, pts, 2.2);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (i = 0; i < pts.length; i++) { ctx.fillRect(pts[i][0] - 1, pts[i][1] - 1, 2, 2); }
  }

  function drawHead(v, name) {
    var now = nowMs();
    var dur = F.durationOf(v.wave);
    if (!dur) return;
    var ph = WC.engine.phaseOf(name, now);
    var x = Math.round((ph / dur) * v.w) + 0.5;
    var ctx = v.ctx, h = v.h, pad = 6;
    ctx.strokeStyle = HEAD; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    var cur = WC.engine.ch[name].enabled ? WC.engine.valueOf(name, now) : 0;
    var y = yOf(cur, h, pad);
    ctx.fillStyle = cur > 0 ? POS : (cur < 0 ? NEG : '#cfcfe6');
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }

  function renderStatic(v, name) {
    var dpr = window.devicePixelRatio || 1;
    if (!v.bg) v.bg = document.createElement('canvas');
    v.bg.width = Math.round(v.w * dpr);
    v.bg.height = Math.round(v.h * dpr);
    var bctx = v.bg.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var real = v.ctx;
    v.ctx = bctx;                       // 复用同一套绘制函数，渲染到离屏画布
    try { drawTarget(v, name, drawBackground(v)); }
    finally { v.ctx = real; }
  }

  function renderOnce() {
    for (var name in views) {
      if (!views.hasOwnProperty(name)) continue;
      var v = views[name];
      syncSize(v);
      if (!v.w) continue;
      if (dirty && v.wave) renderStatic(v, name);
      v.ctx.clearRect(0, 0, v.w, v.h);
      if (v.bg) v.ctx.drawImage(v.bg, 0, 0, v.w, v.h);
      else { drawBackground(v); drawTarget(v, name, { pad: 6 }); }
      if (WC.engine.isRunning()) drawSent(v, name);
      if (v.wave) drawHead(v, name);
    }
    dirty = false;
  }

  function frame() {
    rafId = null;
    renderOnce();
    if (running) rafId = requestAnimationFrame(frame);
  }

  function startLoop() { if (!running) { running = true; if (!rafId) rafId = requestAnimationFrame(frame); } }
  function stopLoop() { running = false; if (rafId) { cancelAnimationFrame(rafId); rafId = null; } renderOnce(); }

  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  WC.scope = {
    POS: POS, NEG: NEG,
    views: views,
    attach: attach, setWave: setWave, resize: resize,
    markDirty: function () { dirty = true; },
    renderOnce: renderOnce, startLoop: startLoop, stopLoop: stopLoop,
    isRunning: function () { return running; }
  };

})();
