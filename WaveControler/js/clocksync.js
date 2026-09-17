// ============================================================
// js/clocksync.js - 时钟偏差与网络延迟估算（两端共用）
//
//   为什么需要它：
//     performance.now() 是各浏览器自己的基线，两端数值完全不可比。
//     主控的 812345.6 和被控的 2301.2 直接相减毫无意义。
//     要让"被控此刻该输出什么"能在主控本地算出来（全帧率画示波器），
//     以及让两端"从头播"对齐，必须先估出两端的时钟偏差。
//
//   方法：NTP 式四点估算
//     主控 t1 ──► 服务器 ──► 被控 t2
//     主控 t4 ◄── 服务器 ◄── 被控 t3
//     往返 RTT = (t4 - t1) - (t3 - t2)
//     偏差 offset = ((t2 - t1) + (t3 - t4)) / 2     // offset = 被控时钟 - 主控时钟
//
//   取多次样本后取「最小 RTT 的那几个」再平均 —— 这是 NTP 的做法：
//   RTT 最小的样本受网络抖动污染最少，比简单平均准确得多。
// ============================================================
(function () {
  'use strict';
  var W = window.WC = window.WC || {};
  var P = W.protocol;

  var KEEP = 8;          // 保留最近多少个样本
  var BEST = 4;          // 用 RTT 最小的几个样本求平均
  var MAX_RTT = 5000;    // 超过这个 RTT 的样本直接丢弃（明显不可信）

  function Clocksync() {
    this.samples = [];        // { rtt, offset }
    this.sent = null;         // 主控侧：{ t1 }
    this.lastPingAt = 0;
    this.lastResult = null;
    this.onUpdate = null;     // function(info)
  }

  Clocksync.prototype.reset = function () {
    this.samples = [];
    this.sent = null;
    this.lastPingAt = 0;
    this.lastResult = null;
  };

  // ---------- 主控侧：发起一次测量 ----------
  // 返回要发给被控的载荷（主控时钟读数 t1），由会话层包进 relay
  Clocksync.prototype.beginProbe = function (nowMs) {
    this.sent = { t1: nowMs };
    this.lastPingAt = nowMs;
    return { c: nowMs };
  };

  // ---------- 被控侧：收到探测，回带两个自己的时间戳 ----------
  //   t2 = 收到瞬间（被控时钟）
  //   t3 = 回复瞬间（被控时钟）
  // 两者都带上，主控才能做完整的四点估算
  Clocksync.prototype.answerProbe = function (probe, nowMs) {
    if (!probe || typeof probe.c !== 'number') return null;
    return { c: probe.c, t2: nowMs, t3: nowMs };
  };

  // ---------- 主控侧：收到回带，完成一次测量 ----------
  //   t1 = 主控发出（主控时钟）
  //   t2 = 被控收到（被控时钟）
  //   t3 = 被控回复（被控时钟）
  //   t4 = 主控收到（主控时钟）
  //   RTT    = (t4 - t1)                     // 两端都在本地测发起/收尾，往返即差值
  //   offset = ((t2 - t1) + (t3 - t4)) / 2   // offset = 被控时钟 - 主控时钟
  Clocksync.prototype.completeProbe = function (reply, nowMs) {
    if (!this.sent || !reply) return null;
    var t1 = this.sent.t1;
    var t2 = reply.t2, t3 = reply.t3, t4 = nowMs;
    this.sent = null;
    if (typeof t2 !== 'number' || typeof t3 !== 'number') return null;

    var rtt = t4 - t1;
    if (!(rtt >= 0) || rtt > MAX_RTT) return null;
    var offset = ((t2 - t1) + (t3 - t4)) / 2;
    this.push({ rtt: rtt, offset: offset, at: t4 });
    return this.lastResult;
  };

  Clocksync.prototype.push = function (sample) {
    this.samples.push(sample);
    if (this.samples.length > KEEP) this.samples.shift();
    this.lastResult = this.compute();
    if (typeof this.onUpdate === 'function') {
      try { this.onUpdate(this.lastResult); } catch (e) { }
    }
  };

  // 取 RTT 最小的若干样本求平均（NTP 思路）
  Clocksync.prototype.compute = function () {
    if (!this.samples.length) return null;
    var sorted = this.samples.slice().sort(function (a, b) { return a.rtt - b.rtt; });
    var take = sorted.slice(0, Math.min(BEST, sorted.length));
    var sumRtt = 0, sumOff = 0, i;
    for (i = 0; i < take.length; i++) { sumRtt += take[i].rtt; sumOff += take[i].offset; }
    var rtt = sumRtt / take.length;
    var offset = sumOff / take.length;
    // 样本离散度：偏差的波动。太大说明网络很不稳，界面要提示
    var maxOff = -Infinity, minOff = Infinity;
    for (i = 0; i < take.length; i++) {
      if (take[i].offset > maxOff) maxOff = take[i].offset;
      if (take[i].offset < minOff) minOff = take[i].offset;
    }
    return {
      rtt: rtt,
      offset: offset,                 // 被控时钟 - 主控时钟
      jitter: maxOff - minOff,        // 越小越可信
      samples: this.samples.length,
      stable: this.samples.length >= 3 && (maxOff - minOff) < 50
    };
  };

  Clocksync.prototype.info = function () { return this.lastResult; };

  // 主控侧工具：把"主控时钟的时刻"换算成"被控时钟的时刻"
  //   被控时钟 = 主控时钟 + offset
  Clocksync.prototype.toPeerClock = function (masterClock) {
    if (!this.lastResult) return null;
    return masterClock + this.lastResult.offset;
  };

  // 被控侧工具：把"主控时钟的时刻"换算成"自己的时钟时刻"
  //   自己的时钟 = 主控时钟 + offset（offset 定义同上）
  Clocksync.prototype.fromMasterClock = function (masterClock) {
    if (!this.lastResult) return null;
    return masterClock + this.lastResult.offset;
  };

  // ---------- 往返延迟测量（与时钟偏差同一批样本） ----------
  // 用于界面显示，不参与同步计算
  Clocksync.prototype.rtt = function () {
    return this.lastResult ? this.lastResult.rtt : null;
  };

  W.Clocksync = Clocksync;
})();
