// ============================================================
// ble.js - BLE 收发（协议与根目录 app.js 完全一致，改协议要同时改两处！）
//   Service 40ee0200-63ec-4b7f-8ce7-712efd55b90e
//   Char    40ee0202-63ec-4b7f-8ce7-712efd55b90e
//   数据包  [0x05, enc(A), enc(B)]   负值 = 反转
// 支持注入假通道（模拟输出 / 自动化测试），无需真机也能验证字节流
// ============================================================
(function () {
  'use strict';
  var WC = window.WC = window.WC || {};

  var SERVICE = '40ee0200-63ec-4b7f-8ce7-712efd55b90e';
  var CHAR = '40ee0202-63ec-4b7f-8ce7-712efd55b90e';
  var DEVICE_NAME = 'UFO-TW';

  var char = null, device = null, mock = null, connected = false;
  var onState = null;              // function(state, detail)
  var stats = { sent: 0, errors: 0, lastError: '' };

  // 与 app.js 逐字一致的编码：-127..127 → 0..255
  function enc(v) { return v < 0 ? ((~v + 129) & 0xFF) : (v & 0xFF); }

  function setState(s, detail) {
    connected = s;
    if (typeof onState === 'function') { try { onState(s, detail); } catch (e) { console.log(e); } }
  }

  async function connect() {
    if (mock) { setState(true, '模拟输出已开启'); return true; }
    if (!navigator.bluetooth) { setState(false, '此浏览器不支持 Web Bluetooth（请用 Chrome / Edge）'); return false; }
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ name: DEVICE_NAME }],
        optionalServices: [SERVICE]
      });
      device.addEventListener('gattserverdisconnected', function () {
        char = null; setState(false, '设备已断开');
      });
      var srv = await device.gatt.connect();
      var svc = await srv.getPrimaryService(SERVICE);
      char = await svc.getCharacteristic(CHAR);
      setState(true, '已连接 ' + (device.name || DEVICE_NAME));
      return true;
    } catch (e) {
      char = null;
      setState(false, (e && e.name === 'NotFoundError') ? '已取消选择设备' : ('连接失败：' + (e.message || e)));
      return false;
    }
  }

  function disconnect() {
    try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e) { }
    device = null; char = null; setState(false, '已断开');
  }

  function isReady() { return !!(mock || (char && connected)); }

  // 返回 Promise（真机）或 null（模拟/未连接）；调用方据此决定是否重试
  function send(a, b) {
    a = Math.round(WC.format.clamp(a, -127, 127));
    b = Math.round(WC.format.clamp(b, -127, 127));
    var buf = new Uint8Array([0x05, enc(a), enc(b)]);
    if (mock) {
      mock.write(buf, a, b);
      stats.sent++;
      return null;
    }
    if (!char) return null;
    try {
      var p = char.writeValueWithoutResponse(buf);
      stats.sent++;
      if (p && typeof p.catch === 'function') {
        return p.catch(function (e) {
          stats.errors++; stats.lastError = String(e && e.message || e);
          throw e;
        });
      }
      return null;
    } catch (e) {
      stats.errors++; stats.lastError = String(e && e.message || e);
      return Promise.reject(e);
    }
  }

  // 假通道：{ write: function(bytes, a, b), log: [...] }
  function setMock(m) {
    mock = m || null;
    if (mock) { char = null; setState(true, '模拟输出已开启（不连接真机）'); }
    else { setState(false, '已退出模拟输出'); }
  }

  function currentMock() { return mock; }

  WC.ble = {
    SERVICE: SERVICE, CHAR: CHAR, DEVICE_NAME: DEVICE_NAME,
    stats: stats,
    enc: enc,
    connect: connect, disconnect: disconnect, send: send, isReady: isReady, setMock: setMock,
    isMock: function () { return !!mock; },
    get __mockRef() { return mock; },
    get connected() { return connected; },
    set onState(fn) { onState = fn; }
  };
})();
