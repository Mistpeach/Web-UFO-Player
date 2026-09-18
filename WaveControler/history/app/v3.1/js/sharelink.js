// ============================================================
// js/sharelink.js - 「控制链接」的生成与解析（被控端 ↔ 主控端共用）
//
//   被控端创建房间后，除了房间号，还给出一个**带参数的控制链接**：
//     主控页地址?srv=<服务器地址>&room=<8位房间号>[&local=1]
//   主控端打开这个链接就自动把服务器地址与房间号填好，用户只需按「连接房间」。
//
//   参数名故意取短（srv/room/local），方便口头或聊天工具里传播。
//
//   ⚠ 安全考虑：srv 是要连的服务器地址，属于**外部输入**。
//     只接受 ws / wss / http / https 这几种协议，其它（javascript:、data: 等）
//     一律忽略 —— 否则恶意链接可以把主控端引到任意地方去。
// ============================================================
(function () {
  'use strict';
  var W = window.WC = window.WC || {};

  // 应用版本号（顶栏标题与页面 <title> 用同一个）。
  //   升级版本时**只需要改这一处** —— 以前版本号散落在 4 个页面的 <title> 里，
  //   改一次要翻 4 个文件，很容易漏掉某一个。
  //   注意这个文件必须在这两个页面的 UI 脚本**之前**加载（HTML 里已保证）。
  var APP_VERSION = 'v3.1 Beta';
  var APP_NAME = 'WaveControler';

  // 顶栏标题文案：🌊 WaveControler v3.1 Beta · 远程主控
  function titleOf(role) {
    return '🌊 ' + APP_NAME + ' ' + APP_VERSION + (role ? (' · ' + role) : '');
  }

  // 写入顶栏标题元素（页面里写死的是同样的文案，JS 跑起来后覆盖一次，
  //   这样即使 JS 没加载，顶栏也不会是空白）
  function applyTitle(role) {
    var el = null;
    try { el = document.getElementById('tbTitle'); } catch (e) { return; }
    if (el) el.textContent = titleOf(role);
  }

  // 服务器地址允许的协议（http/https 会被 normWsUrl 转成 ws/wss）
  var OK_SCHEME = /^(wss?|https?):\/\//i;
  // 纯主机名/主机:端口 也允许（用户手填时的常见写法，例如 rc.example.cn:8080）
  var OK_BARE = /^[A-Za-z0-9._\-]+(:\d{1,5})?(\/[\w\-./]*)?$/;

  function isSafeServer(s) {
    if (!s) return false;
    if (OK_SCHEME.test(s)) return true;
    return OK_BARE.test(s);
  }

  // 主控页相对于被控页的文件名（两页同目录，所以直接换文件名即可）
  var MASTER_FILE = 'RemoteMaster.html';

  function masterPageUrl() {
    try {
      var u = String(location.href).split('#')[0].split('?')[0];
      var i = u.lastIndexOf('/');
      return (i >= 0 ? u.slice(0, i + 1) : '') + MASTER_FILE;
    } catch (e) { return MASTER_FILE; }
  }

  // 生成控制链接。
  //   opts = { serverUrl, room, localMode }
  //   服务器地址原样带上（用户在从哪个地址连，主控就填哪个，避免"我填的和你连的不是一回事"）。
  function build(opts) {
    opts = opts || {};
    var parts = [];
    var room = String(opts.room || '').replace(/\D/g, '');
    if (opts.localMode) {
      parts.push('local=1');
    } else if (opts.serverUrl) {
      parts.push('srv=' + encodeURIComponent(String(opts.serverUrl)));
    }
    if (room) parts.push('room=' + encodeURIComponent(room));
    return masterPageUrl() + (parts.length ? ('?' + parts.join('&')) : '');
  }

  // 解析控制链接参数（从 location.search 或传入的字符串）。
  //   返回 { serverUrl:'', room:'', localMode:false, hasAny:false }
  function parse(search) {
    var q = (search === undefined || search === null) ? String(location.search || '') : String(search);
    q = q.replace(/^\?/, '');
    var out = { serverUrl: '', room: '', localMode: false, hasAny: false };
    if (!q) return out;

    var pairs = q.split('&');
    for (var i = 0; i < pairs.length; i++) {
      if (!pairs[i]) continue;
      var eq = pairs[i].indexOf('=');
      var k = eq >= 0 ? pairs[i].slice(0, eq) : pairs[i];
      var v = eq >= 0 ? pairs[i].slice(eq + 1) : '';
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* 保留原样 */ }
      k = k.toLowerCase();

      if (k === 'room') {
        var r = v.replace(/\D/g, '').slice(0, 8);
        if (r) { out.room = r; out.hasAny = true; }
      } else if (k === 'srv' || k === 'server' || k === 'url') {
        if (isSafeServer(v)) { out.serverUrl = v.trim(); out.hasAny = true; }
      } else if (k === 'local' || k === 'localmode') {
        if (v === '1' || v === 'true' || v === '' || v === 'yes') {
          out.localMode = true; out.hasAny = true;
        }
      }
    }
    return out;
  }

  // 复制文本：优先用剪贴板 API，失败退回到 textarea + execCommand。
  //   ⚠ navigator.clipboard.writeText 返回 Promise，**同步 try/catch 抓不到它的失败**，
  //     而且在 file:// 下常常直接不可用（非安全上下文）。所以必须带后退方案，
  //     否则用户点了「复制」看起来成功、其实什么都没进剪贴板。
  function copyText(text, onDone) {
    function done(ok, msg) { if (typeof onDone === 'function') { try { onDone(ok, msg); } catch (e) { } } }

    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      var ok = false;
      try {
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        ok = document.execCommand('copy');
      } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok, ok ? '' : '复制被浏览器拒绝，请手动选中复制');
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(text).then(function () { done(true, ''); },
          function () { legacy(); });
        return;
      } catch (e) { /* 落到 legacy */ }
    }
    legacy();
  }

  W.sharelink = {
    VERSION: APP_VERSION,
    NAME: APP_NAME,
    titleOf: titleOf,
    applyTitle: applyTitle,
    build: build,
    parse: parse,
    copyText: copyText,
    isSafeServer: isSafeServer,
    masterPageUrl: masterPageUrl
  };
})();
