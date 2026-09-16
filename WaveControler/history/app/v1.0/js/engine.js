// ============================================================
// engine.js - 波形调度器
//   固定 50ms(20Hz) tick，时钟用 performance.now()（抗抖动/抗节流漂移）
//   两个通道算完后「一次性」发包（一个 BLE 包同时带 A/B，流量最小）
//   只有值变化才发（变化检测）；失败不更新 last → 下个 tick 自动重试
//   安全：急停 / 页面隐藏 / 关闭页面 / 断开 → 必发 0,0
// ============================================================
(function () {
  'use strict';
  var WC = window.WC = window.WC || {};
  var F = WC.format;

  var TICK_MS = 50;
  var RING = 300;
  var SOFT_START_MS = 0;      // >0 时从 0 线性升到目标强度（可用 WC.engine.setSoftStart 打开）

  var ch = {
    A: { enabled: false, wave: null, intensity: 1.0, phase: 0 },
    B: { enabled: false, wave: null, intensity: 1.0, phase: 0 }
  };
  var timer = null, running = false, latched = false, startAt = 0;
  var last = { a: 0, b: 0 };
  var ring = [];
  var stats = { ticks: 0, attempts: 0, sends: 0, errors: 0, startedAt: 0, lastTickMs: 0, maxTickMs: 0 };
  var onTick = null, onStop = null;

  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function push(t, a, b) {
    ring.push({ t: t, a: a, b: b });
    while (ring.length > RING) ring.shift();
  }

  function valueOf(name, now) {
    var c = ch[name];
    if (!c.enabled || !c.wave) return 0;
    var dur = F.durationOf(c.wave);
    var t = F.phaseAt(startAt, now, dur, c.phase);
    var k = c.intensity;
    if (SOFT_START_MS > 0) {
      var el = now - startAt;
      if (el < SOFT_START_MS) k = c.intensity * Math.max(0, el / SOFT_START_MS);
    }
    return F.sampleScaled(c.wave, name, t, k);
  }

  // 公共同步 tick：测试可手动传入 now 做确定性验证
  function tickOnce(now) {
    var t0 = nowMs();
    stats.ticks++;
    var a = valueOf('A', now), b = valueOf('B', now);
    var changed = (a !== last.a || b !== last.b);
    if (changed) {
      stats.attempts++;
      var p;
      try { p = WC.ble.send(a, b); } catch (e) { p = Promise.reject(e); }
      if (p && typeof p.then === 'function') {
        p.then(function () { last.a = a; last.b = b; stats.sends++; push(now, a, b); })
         .catch(function () { stats.errors++; });        // 不更新 last → 下个 tick 重试
      } else {
        last.a = a; last.b = b; stats.sends++; push(now, a, b);
      }
    }
    if (typeof onTick === 'function') { try { onTick(now, a, b, changed); } catch (e) { } }
    stats.lastTickMs = nowMs() - t0;
    if (stats.lastTickMs > stats.maxTickMs) stats.maxTickMs = stats.lastTickMs;
  }

  function start() {
    if (running) return true;
    latched = false;
    startAt = nowMs();
    ring.length = 0;
    last.a = 0; last.b = 0;
    stats.startedAt = startAt;
    running = true;
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (running) tickOnce(nowMs()); }, TICK_MS);
    tickOnce(nowMs());
    return true;
  }

  // reason: 'user' | 'emergency' | 'hidden' | 'unload' | 'error'
  function stop(reason) {
    if (timer) { clearInterval(timer); timer = null; }
    var was = running;
    running = false;
    if (reason === 'emergency') latched = true;
    try { WC.ble.send(0, 0); } catch (e) { }
    last.a = 0; last.b = 0;
    if (was && typeof onStop === 'function') { try { onStop(reason); } catch (e) { } }
    return was;
  }

  function emergencyStop() { stop('emergency'); }

  function phaseOf(name, now) {
    var c = ch[name];
    if (!c.wave) return 0;
    return F.phaseAt(startAt, now, F.durationOf(c.wave), c.phase);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && running) stop('hidden');       // 安全优先：切后台即归零
  });
  window.addEventListener('pagehide', function () { if (running || last.a || last.b) stop('unload'); });
  window.addEventListener('beforeunload', function () { if (running || last.a || last.b) stop('unload'); });

  WC.engine = {
    TICK_MS: TICK_MS, RING: RING,
    ch: ch, ring: ring, stats: stats,
    tickOnce: tickOnce,
    valueOf: valueOf,
    phaseOf: phaseOf,
    start: start, stop: stop, emergencyStop: emergencyStop,
    isRunning: function () { return running; },
    isLatched: function () { return latched; },
    startAt: function () { return startAt; },
    out: function () { return { a: last.a, b: last.b }; },
    setSoftStart: function (ms) { SOFT_START_MS = Math.max(0, ms || 0); },
    setWave: function (name, wave) { ch[name].wave = wave; },
    setEnabled: function (name, on) { ch[name].enabled = !!on; },
    setIntensity: function (name, k) { ch[name].intensity = F.clamp(k, 0, 2); },
    setPhase: function (name, r) { ch[name].phase = (r || 0) % 1; },
    set onTick(fn) { onTick = fn; },
    set onStop(fn) { onStop = fn; }
  };
})();
