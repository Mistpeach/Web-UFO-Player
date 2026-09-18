// ============================================================
// js/link.js - 传输抽象层
//
//   把"怎么把消息送到对端"从业务逻辑里彻底隔离出来：
//     · Broadcast  —— 同一浏览器的两个标签页之间（本地调试，零服务器）
//     · Websocket  —— 真实的远程连接
//     · Loopback   —— 自己跟自己（自动化测试用）
//   三种实现的接口完全一致，所以 session/sync 不需要知道底下是什么。
//
//   P1 阶段全部逻辑都跑在 Broadcast 上，P5 只需换成 Websocket，业务代码一行不改。
// ============================================================
(function () {
  'use strict';
  var W = window.WC = window.WC || {};
  var P = W.protocol;

  function noop() { }

  // 统一的连接对象接口：
  //   send(msg)           发送一个对象（自动 JSON 序列化 + 大小检查）
  //   close()             主动关闭
  //   onMessage           收到消息（已 JSON 解析）
  //   onOpen / onClose / onError
  //   isOpen()
  //   needsEnvelope       是否需要 {t:'relay', payload:{c,i,n,d}} 信封
  //
  // ⚠ needsEnvelope 是**连接的能力**，不要用 transportKind 去猜：
  //   只有真实的 WebSocket（前面有服务器拆信封）才需要信封；
  //   BroadcastChannel 与 Loopback 都是点对点直连，没有中间人，必须直接发业务消息。
  //   曾经因为用 transportKind === 'broadcast' 判断，导致 Loopback 走了信封分支，
  //   对端收到 t 为空的包裹直接丢弃 —— 这个坑已经踩过一次。
  function makeConn() {
    return {
      send: noop, close: noop, isOpen: function () { return false; },
      onMessage: null, onOpen: null, onClose: null, onError: null,
      kind: 'none', needsEnvelope: false
    };
  }

  function safeParse(text) {
    if (typeof text !== 'string') return null;
    if (text.length > P.LIMITS.MAX_WIRE_BYTES) return null;   // 超大消息直接丢
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // ============================================================
  // Broadcast：同源标签页之间（不需要服务器）
  // ============================================================
  // 约定：房间号就是频道名的一部分，所以"房间"天然成立。
  // 谁先到谁是房主（slave）：先 create 的成为 slave，后 join 的成为 master。
  var BroadcastLink = {
    kind: 'broadcast',
    supported: function () { return typeof window.BroadcastChannel !== 'undefined'; },

    create: function (room, opts) {
      return openBC(room, opts);
    },
    join: function (room, opts) {
      return openBC(room, opts);
    }
  };

  function openBC(room, opts) {
    var conn = makeConn();
    conn.kind = 'broadcast';
    conn.needsEnvelope = false;      // 标签页之间直连，没有服务器拆信封
    opts = opts || {};
    var ch = null, closed = false;

    try {
      ch = new BroadcastChannel('ufo-remote-' + String(room));
    } catch (e) {
      setTimeout(function () { if (conn.onError) conn.onError('broadcast-unavailable'); }, 0);
      return conn;
    }

    conn.isOpen = function () { return !closed; };

    conn.send = function (msg) {
      if (closed) return false;
      var text;
      try { text = JSON.stringify(msg); } catch (e) { return false; }
      if (text.length > P.LIMITS.MAX_WIRE_BYTES) return false;
      try { ch.postMessage({ __ufo: 1, d: text, from: opts.peerId || '' }); return true; }
      catch (e) { return false; }
    };

    conn.close = function () {
      if (closed) return;
      closed = true;
      try { ch.close(); } catch (e) { }
      if (conn.onClose) conn.onClose('closed-by-us');
    };

    ch.onmessage = function (ev) {
      var raw = ev && ev.data;
      if (!raw || raw.__ufo !== 1) return;
      if (opts.peerId && raw.from === opts.peerId) return;   // 不回自己
      var msg = safeParse(raw.d);
      if (!msg) return;
      if (conn.onMessage) conn.onMessage(msg);
    };

    // BroadcastChannel 没有"连接建立"事件，异步报一次 open 让上层流程统一
    setTimeout(function () {
      if (!closed && conn.onOpen) conn.onOpen();
    }, 0);

    return conn;
  }

  // ============================================================
  // WebSocket：真实远程连接
  // ============================================================
  // 只需传一个地址，形如 wss://example.com/ws（不接受 http(s) 前缀，由调用方规范化）
  var WebsocketLink = {
    kind: 'websocket',
    supported: function () { return typeof window.WebSocket !== 'undefined'; },

    // opts: { url, onOpen, onClose, onError, onMessage }
    open: function (opts) {
      var conn = makeConn();
      conn.kind = 'websocket';
      conn.needsEnvelope = true;     // 前面有服务器，业务消息要包成 relay
      opts = opts || {};
      var ws = null, closed = false, opened = false;

      var url = normWsUrl(opts.url);
      if (!url) {
        setTimeout(function () { if (opts.onError) opts.onError('bad-url'); }, 0);
        return conn;
      }

      try { ws = new WebSocket(url); }
      catch (e) {
        setTimeout(function () { if (opts.onError) opts.onError('ws-open-failed'); }, 0);
        return conn;
      }

      conn.isOpen = function () { return opened && !closed; };

      conn.send = function (msg) {
        if (closed || !opened || ws.readyState !== 1) return false;
        var text;
        try { text = JSON.stringify(msg); } catch (e) { return false; }
        if (text.length > P.LIMITS.MAX_WIRE_BYTES) return false;
        try { ws.send(text); return true; } catch (e) { return false; }
      };

      conn.close = function () {
        if (closed) return;
        closed = true;
        try { ws.close(1000, 'bye'); } catch (e) { }
      };

      ws.onopen = function () {
        opened = true;
        if (opts.onOpen) opts.onOpen();
      };
      ws.onmessage = function (ev) {
        var msg = safeParse(ev && ev.data);
        if (!msg) return;
        if (opts.onMessage) opts.onMessage(msg);
      };
      ws.onerror = function () {
        if (opts.onError) opts.onError('ws-error');
      };
      ws.onclose = function (ev) {
        var wasOpen = opened;
        opened = false;
        closed = true;
        if (opts.onClose) opts.onClose(wasOpen ? 'closed' : 'connect-failed', ev && ev.code);
      };

      return conn;
    }
  };

  // 地址规范化：允许用户只填 "example.com:8080" 或 "https://example.com"
  // 规则：
  //   已经是 ws:// 或 wss://  → 直接补 /ws
  //   http:// 或 https://     → 换成 ws/wss，补 /ws
  //   带 :端口 但没有协议      → 用 ws://（本机调试常见）
  //   其它                    → 默认 wss://（公网必须有 TLS）
  function normWsUrl(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    if (/^wss?:\/\//i.test(s)) {
      return s.replace(/\/+$/, '') + (/\/ws$/i.test(s) ? '' : '/ws');
    }
    if (/^https?:\/\//i.test(s)) {
      var u = s.replace(/^http/i, 'ws').replace(/\/+$/, '');
      return u + (/\/ws$/i.test(u) ? '' : '/ws');
    }
    // 纯主机/主机:端口 —— 本机调试用 ws，公网用 wss
    var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(s);
    return (isLocal ? 'ws://' : 'wss://') + s.replace(/\/+$/, '') + '/ws';
  }
  W.normWsUrl = normWsUrl;

  // ============================================================
  // Loopback：自己跟自己，用于自动化测试（不需要第二个标签页）
  // 用法：Loopback.pair() 返回 [a, b] 两个互相连通的 conn
  // ============================================================
  function pair() {
    var a = makeConn(), b = makeConn();
    a.kind = b.kind = 'loopback';
    a.needsEnvelope = b.needsEnvelope = false;   // 点对点直连，不需要信封
    var openA = true, openB = true;

    a.isOpen = function () { return openA; };
    b.isOpen = function () { return openB; };
    a.send = function (m) { if (!openA || !openB) return false; setTimeout(function () { if (b.onMessage) b.onMessage(m); }, 0); return true; };
    b.send = function (m) { if (!openA || !openB) return false; setTimeout(function () { if (a.onMessage) a.onMessage(m); }, 0); return true; };
    a.close = function () { openA = false; setTimeout(function () { if (b.onClose) b.onClose('peer-closed'); }, 0); };
    b.close = function () { openB = false; setTimeout(function () { if (a.onClose) a.onClose('peer-closed'); }, 0); };
    setTimeout(function () { if (a.onOpen) a.onOpen(); if (b.onOpen) b.onOpen(); }, 0);
    return [a, b];
  }

  // ============================================================
  // 服务器消息的构造与解析（传输层）
  // ============================================================
  var T = P.T;

  W.link = {
    Broadcast: BroadcastLink,
    Websocket: WebsocketLink,
    Loopback: { pair: pair },
    normWsUrl: normWsUrl,

    // ---- 客户端 → 服务器 ----
    msgCreate: function () { return { t: T.CREATE }; },
    msgJoin: function (room) { return { t: T.JOIN, room: String(room) }; },
    msgLeave: function () { return { t: T.LEAVE }; },
    msgRelay: function (payload) { return { t: T.RELAY, payload: payload }; },
    msgPing: function (c) { return { t: T.PING, c: c }; },

    // ---- 服务器 → 客户端，做一次形状校验（防畸形消息） ----
    parseServer: function (msg) {
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return null;
      switch (msg.t) {
        case T.CREATED:
        case T.JOINED:
          if (typeof msg.room !== 'string') return null;
          if (msg.role !== P.ROLE.MASTER && msg.role !== P.ROLE.SLAVE) return null;
          return msg;
        case T.PEER:
          if (msg.event !== 'joined' && msg.event !== 'left') return null;
          return msg;
        case T.ERROR:
          if (typeof msg.code !== 'string') return null;
          return msg;
        case T.RELAY:
          if (!msg.payload || typeof msg.payload !== 'object') return null;
          return msg;
        case T.PONG:
          return msg;
        default:
          return null;
      }
    }
  };
})();
