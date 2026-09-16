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

  // startedAt：本通道自己的时间原点（勾选/启动那一刻）。
  // 不用共享的引擎 startAt 算相位，是为了让「未启用 = 时间不走」真正成立：
  // 通道关断期间相位冻结在起点，重新勾选时从波形开头播放，而不是从中间切入。
  var ch = {
    A: { enabled: false, wave: null, intensity: 1.0, phase: 0, startedAt: 0 },
    B: { enabled: false, wave: null, intensity: 1.0, phase: 0, startedAt: 0 }
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
    var t = F.phaseAt(c.startedAt, now, dur, c.phase);
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
    // 所有通道的时间原点一起归零：引擎重启（急停后重新开始）时也要从波形开头播
    ch.A.startedAt = startAt;
    ch.B.startedAt = startAt;
    ring.length = 0;
    last.a = 0; last.b = 0;
    stats.startedAt = startAt;
    running = true;
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (running) tickOnce(nowMs()); }, TICK_MS);
    tickOnce(nowMs());
    return true;
  }

  // reason: 'user' | 'emergency' | 'unload' | 'error'（原 'hidden' 已取消：切后台不再停机）
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

  // 播放头用的相位。通道未启用时返回 0，与 valueOf 的语义一致：
  // 没启用 = 没输出 = 时间不走，播放头停在起点，重新勾选后从波形开头播。
  function phaseOf(name, now) {
    var c = ch[name];
    if (!c.wave) return 0;
    if (!c.enabled) return 0;
    return F.phaseAt(c.startedAt, now, F.durationOf(c.wave), c.phase);
  }

  // 切换标签页 / 挂到后台：故意「不停机」，让动作继续跑。
  // 代价要知道：浏览器会把后台页面的定时器降频（约 1 次/秒），所以后台期间发包频率会从 20Hz
  // 掉到 ~1Hz。相位是按 performance.now() 推算的，所以波形位置不会错乱，只是刷新变糙；
  // 波形周期越短（< 1 秒）这个粗糙感越明显。想停就手动取消勾选或按急停。
  //
  // 只保留「页面真的要走了」时才归零：pagehide / beforeunload。
  // 这里不是安全保护，而是避免把玩具留在最后一个动作上——页面已销毁，收不到后续指令了。
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
    // 勾选/取消勾选就是这条通道时间轴的开与停：
    //   开启 → 把时间原点挪到此刻，于是从波形开头播（相位滑杆的偏移依然生效）
    //   关闭 → startedAt 清 0，valueOf/phaseOf 都返回 0，时间轴彻底冻结
    // 不做「值没变就跳过」的优化：重复启用（例如连点两次「试一下」）也要重新从开头播。
    setEnabled: function (name, on) {
      var c = ch[name];
      var want = !!on;
      c.startedAt = want ? (running ? nowMs() : startAt) : 0;
      c.enabled = want;
    },
    setIntensity: function (name, k) { ch[name].intensity = F.clamp(k, 0, 2); },
    setPhase: function (name, r) { ch[name].phase = (r || 0) % 1; },
    set onTick(fn) { onTick = fn; },
    set onStop(fn) { onStop = fn; }
  };
})();
