// ============================================================
// js/virtualble.js - 把"远程会话"伪装成一个 BLE 通道（仅主控端使用）
//
//   为什么这样做：
//     主控端的界面可以完全复用本地控制器那套东西（通道卡、强度/相位、
//     启停勾选、示波器），而 engine.js 每 50ms 调用的 WC.ble.send() 不需要任何改动。
//     做法是把远程会话通过 ble.js 已有的 setMock() 注入成通道 ——
//     这个口子本来就是为"注入假通道"设计的。
//
//   ⚠ 一个必须说清楚的事实：
//     真正送到被控端的是「期望状态」（波形 + 强度 + 相位 + 启停），
//     由被控端在本地以 20Hz 生成实际指令并发给玩具。
//     WC.ble.send() 传进来的那两个数只是主控本地算出来的"影子值"，
//     用于界面显示与健康检查，**不是逐帧转发的数据**。
//     这正是整个方案能省流量的原因（见实施计划 §3.1）。
// ============================================================
(function () {
  'use strict';
  var W = window.WC = window.WC || {};

  var instance = null;

  function VirtualBle(opts) {
    opts = opts || {};
    this.session = opts.session || null;
    this.onSample = opts.onSample || null;      // function({a, b, t}) —— 给主控界面的影子值回调
    this.last = { a: 0, b: 0, t: 0 };
    this.writes = 0;
    this.installed = false;
    this._origConnect = null;
    this._origDisconnect = null;
  }

  // 注入为 ble 通道。返回一个卸载函数。
  VirtualBle.prototype.install = function () {
    if (this.installed) return;
    var self = this;
    var ble = W.ble;
    if (!ble || typeof ble.setMock !== 'function') {
      console.log('[virtualble] WC.ble.setMock 不存在，无法注入远程通道');
      return;
    }

    // 1) 用 mock 机制把"发送"接管过来（签名与真实通道一致）
    ble.setMock({
      write: function (bytes, a, b) { self.onWrite(bytes, a, b); },
      log: []
    });

    // 2) 把 connect / disconnect 也接管成"远程连接"语义，
    //    这样界面上"连接"这个动作不会被误当成去连本机蓝牙。
    this._origConnect = ble.connect;
    this._origDisconnect = ble.disconnect;
    ble.connect = function () { return Promise.resolve(true); };
    ble.disconnect = function () { if (self.onDisconnect) self.onDisconnect(); };

    this.installed = true;
  };

  VirtualBle.prototype.uninstall = function () {
    if (!this.installed) return;
    var ble = W.ble;
    try {
      ble.setMock(null);
      if (this._origConnect) ble.connect = this._origConnect;
      if (this._origDisconnect) ble.disconnect = this._origDisconnect;
    } catch (e) { }
    this.installed = false;
  };

  // engine 每 50ms（值变化时）会调到这里
  VirtualBle.prototype.onWrite = function (bytes, a, b) {
    this.writes++;
    this.last.a = a; this.last.b = b;
    this.last.t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (typeof this.onSample === 'function') {
      try { this.onSample({ a: a, b: b, t: this.last.t }); } catch (e) { }
    }
  };

  VirtualBle.prototype.stats = function () {
    return { writes: this.writes, a: this.last.a, b: this.last.b };
  };

  // ---------- 便捷工厂 ----------
  W.virtualble = {
    // 安装并返回实例；session 为已创建的会话
    install: function (session, opts) {
      opts = opts || {};
      opts.session = session;
      instance = new VirtualBle(opts);
      instance.install();
      return instance;
    },
    current: function () { return instance; },
    uninstall: function () { if (instance) instance.uninstall(); instance = null; }
  };
})();
