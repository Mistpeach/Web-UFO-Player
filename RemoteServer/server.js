// ============================================================
// RemoteServer/server.js - Web-UFO-Player 远程控制「中继服务器」
//
//   这个文件是一个**零 npm 依赖**的单文件服务器：
//     - 自己实现 HTTP 服务（用 Node 内置 http 模块）
//     - 自己实现 WebSocket 服务端（RFC 6455 握手 + 帧解析，见本文件下半部分）
//     - 房间注册表 + 消息中继（只认传输层，永远不看 relay.payload 里是什么）
//     - 单行 JSON 日志（按天/按大小轮转，保留 N 天，访问日志与错误日志分开）
//
//   协议契约见同目录 PROTOCOL.md（客户端侧源头是 WaveControler/js/protocol.js 的 R.T / R.LIMITS）。
//   实现原理与容量估算见同目录 PRINCIPLE.md。
//
//   启动：node server.js            （读同目录 config.json，没有就用内置默认值）
//        node server.js --config /etc/ufo-remote/config.json
//   环境变量覆盖：UFO_PORT / UFO_HOST / UFO_LOG_LEVEL / UFO_LOG_DIR / UFO_LOG_IP_MODE
//                UFO_MAX_ROOM / UFO_TRUST_PROXY / UFO_CONFIG
// ============================================================
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- 版本与常量 ----------

const VERSION = '1.0.0';          // 服务器自身版本（/health 与启动日志里都有）
const PROTOCOL_VERSION = 1;       // 对应 WaveControler/js/protocol.js 的 R.VERSION

// WebSocket 握手用的魔法字符串（RFC 6455 §1.3）
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 帧 opcode（RFC 6455 §5.2）
const OP_CONT = 0x0;   // 续帧（分片消息的后续片）
const OP_TEXT = 0x1;   // 文本帧（本项目业务只走这个）
const OP_BIN = 0x2;    // 二进制帧（本项目不支持，收到即断）
const OP_CLOSE = 0x8;  // 关闭
const OP_PING = 0x9;   // 协议层 ping（与业务层 t:'ping' 不是一回事）
const OP_PONG = 0xA;   // 协议层 pong

// 关闭码（RFC 6455 §7.4.1）
const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_BAD_PAYLOAD = 1007;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const CLOSE_IDLE = 4000;          // 自定义：心跳/空闲超时
const CLOSE_BAD_MESSAGES = 4001;  // 自定义：畸形消息太多
const CLOSE_SERVER_BUSY = 4002;   // 自定义：连接数超限

// 日志级别（数字越大越严重）
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// ---------- 内置默认配置（config.json 里写什么就覆盖什么） ----------
// 每个字段在 config.example.json 里都有中文注释说明。
const DEFAULTS = {
  server: {
    host: '0.0.0.0',
    port: 8787,
    path: '/ws',            // WebSocket 升级端点
    healthPath: '/health',  // 健康检查端点
    trustProxy: true,       // 在 Caddy/Nginx 后面时必须为 true，才能拿到真实客户端 IP
    maxConnections: 5000    // 全局连接数上限，超过直接拒绝升级
  },
  room: {
    // 当前业务层强制 2 人（对应 protocol.js 的 R.LIMITS.MAX_ROOM = 2）。
    // 将来放开多人：只需要把这个值调大 —— 下面的转发逻辑本来就是「房间内除自己外的所有成员」。
    maxMembers: 2,
    idMin: 10000000,        // 房间号下限（含）
    idMax: 99999999,        // 房间号上限（含）
    maxIdAttempts: 64,      // 房间号查重时的最大重试次数
    idleMs: 600000          // 房间空闲 10 分钟自动回收（最后一个消息时间戳算起）
  },
  limits: {
    maxWireBytes: 65536,    // 单条 WS 文本消息上限，对齐 protocol.js 的 R.LIMITS.MAX_WIRE_BYTES
    maxBadMessages: 20,     // 同一连接累计多少条畸形消息后断开
    maxFragments: 128       // 单条分片消息最多几片（防止用无限分片撑爆内存）
  },
  timeout: {
    idleMs: 30000,          // 30 秒没收到任何帧就判定死连接（客户端业务心跳 2 秒一次）
    sweepMs: 30000,         // 巡检周期：扫死连接 + 扫空闲房间
    closeGraceMs: 500       // 优雅关闭时等对端收 close 帧的时间
  },
  rateLimit: {
    enabled: true,
    windowMs: 60000,        // 窗口长度：1 分钟
    maxCreatePerWindow: 10, // 每 IP 每分钟建房上限
    maxJoinPerWindow: 10    // 每 IP 每分钟加入上限
  },
  log: {
    dir: 'logs',            // 相对本文件所在目录
    level: 'info',          // error | warn | info | debug（debug 需手动开）
    ipMode: 'full',         // full | masked（masked 把 IPv4 最后一段变成 x）
    console: true,          // 是否同时打到标准输出
    maxFileBytes: 10485760, // 单文件 10MB 后轮转
    retainDays: 14,         // 保留 14 天
    statsIntervalMs: 300000 // 每 5 分钟打一条统计日志
  }
};

// ============================================================
// 0. 小工具
// ============================================================

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// 深合并：把 over 里的值盖到 base 上（只处理普通对象，数组整体替换）
function deepMerge(base, over) {
  const out = {};
  const keys = Object.keys(base);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const hasOver = isPlainObject(over) && Object.prototype.hasOwnProperty.call(over, k);
    if (isPlainObject(base[k])) {
      // 双方都是对象 → 递归合并（config.json 只需要写想改的字段）
      out[k] = deepMerge(base[k], hasOver && isPlainObject(over[k]) ? over[k] : {});
    } else {
      // 标量/数组 → over 有就用 over 的，否则用默认值
      out[k] = hasOver ? over[k] : base[k];
    }
  }
  // over 里有、base 里没有的键也保留（方便自建者加自己的字段）
  if (isPlainObject(over)) {
    const ek = Object.keys(over);
    for (let i = 0; i < ek.length; i++) {
      if (!(ek[i] in out)) out[ek[i]] = over[ek[i]];
    }
  }
  return out;
}

function toBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function toInt(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseInt(v, 10);
  return isFinite(n) ? n : undefined;
}

function nowMs() { return Date.now(); }

function isoOf(ms) { return new Date(ms).toISOString(); }

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// 'YYYYMMDD'
function dateStamp(d) {
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

// 'YYYYMMDD-HHmmss'
function tsStamp(d) {
  return dateStamp(d) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// 把 ::ffff:1.2.3.4 这类 IPv4-mapped IPv6 还原成 IPv4，方便日志与限流
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  let s = String(ip);
  if (s.indexOf('::ffff:') === 0) s = s.slice(7);
  const pct = s.indexOf('%');           // 去掉 scope id，如 fe80::1%eth0
  if (pct > 0) s = s.slice(0, pct);
  return s;
}

// masked 模式：IPv4 把最后一段打码；IPv6 把最后一段打码
function maskIp(ip) {
  if (!ip) return ip;
  const s = String(ip);
  if (s.indexOf('.') >= 0 && s.indexOf(':') < 0) {
    const parts = s.split('.');
    if (parts.length === 4) { parts[3] = 'x'; return parts.join('.'); }
    return s;
  }
  const seg = s.split(':');
  for (let i = seg.length - 1; i >= 0; i--) {
    if (seg[i] !== '') { seg[i] = 'x'; break; }
  }
  return seg.join(':');
}

// 只留「浏览器名 + 大版本」。绝不落盘完整 User-Agent（隐私要求）。
function parseUa(ua) {
  if (!ua || typeof ua !== 'string') return 'unknown';
  let m;
  if ((m = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/))) return 'Edge/' + m[1];
  if ((m = ua.match(/(?:OPR|Opera)\/(\d+)/))) return 'Opera/' + m[1];
  if ((m = ua.match(/Chrome\/(\d+)/))) return 'Chrome/' + m[1];
  if ((m = ua.match(/Firefox\/(\d+)/))) return 'Firefox/' + m[1];
  // Safari 的版本号在 Version/ 里，UA 尾巴固定是 Safari/xxx
  if (/Safari\//.test(ua) && (m = ua.match(/Version\/(\d+)/))) return 'Safari/' + m[1];
  if ((m = ua.match(/curl\/(\d+)/))) return 'curl/' + m[1];
  if (/wscat/i.test(ua)) return 'wscat';
  if (/(undici|node|axios|got|ws)/i.test(ua)) return 'node-client';
  // 其他一律只取第一段 token，且截断，避免整条 UA 落盘
  const first = ua.split(/[\s;/]/)[0].replace(/[^A-Za-z0-9._-]/g, '');
  return (first || 'unknown').slice(0, 24);
}

// 严格 UTF-8 校验（RFC 6455 要求文本帧必须是合法 UTF-8，否则用 1007 关闭）
function isValidUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let need = 0;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return false;
    if (i + need >= buf.length) return false;      // 续字节不够，截断的序列
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k];
      if (c === undefined || c < 0x80 || c > 0xbf) return false;
    }
    // 排除过长编码 / 代理区 / 超出 U+10FFFF
    if (need === 2) {
      if (b === 0xe0 && buf[i + 1] < 0xa0) return false;
      if (b === 0xed && buf[i + 1] > 0x9f) return false;
    }
    if (need === 3) {
      if (b === 0xf0 && buf[i + 1] < 0x90) return false;
      if (b === 0xf4 && buf[i + 1] > 0x8f) return false;
    }
    i += need + 1;
  }
  return true;
}

// ============================================================
// 1. 配置加载
// ============================================================

function loadConfig() {
  const argv = process.argv.slice(2);
  let cfgPath = process.env.UFO_CONFIG || '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) cfgPath = argv[i + 1];
    if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法: node server.js [--config <配置文件路径>]');
      console.log('默认读取同目录 config.json（不存在则使用内置默认值）。');
      console.log('环境变量: UFO_PORT UFO_HOST UFO_LOG_LEVEL UFO_LOG_DIR UFO_LOG_IP_MODE UFO_MAX_ROOM UFO_TRUST_PROXY');
      process.exit(0);
    }
  }

  let fileCfg = {};
  let usedPath = '';
  const candidates = cfgPath ? [cfgPath] : [
    path.join(__dirname, 'config.json'),
    path.join(process.cwd(), 'config.json')
  ];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        fileCfg = JSON.parse(raw);
        usedPath = p;
        break;
      }
    } catch (e) {
      console.error('[config] 读取失败 ' + p + ' : ' + (e && e.message));
      if (cfgPath) process.exit(1);
    }
  }

  const cfg = deepMerge(DEFAULTS, fileCfg);

  // 环境变量优先级最高（方便 systemd / pm2 / docker 覆盖）
  const envPort = toInt(process.env.UFO_PORT);
  if (envPort) cfg.server.port = envPort;
  if (process.env.UFO_HOST) cfg.server.host = process.env.UFO_HOST;
  if (process.env.UFO_LOG_LEVEL) cfg.log.level = process.env.UFO_LOG_LEVEL;
  if (process.env.UFO_LOG_DIR) cfg.log.dir = process.env.UFO_LOG_DIR;
  if (process.env.UFO_LOG_IP_MODE === 'masked' || process.env.UFO_LOG_IP_MODE === 'full') {
    cfg.log.ipMode = process.env.UFO_LOG_IP_MODE;
  }
  const envRoom = toInt(process.env.UFO_MAX_ROOM);
  if (envRoom) cfg.room.maxMembers = envRoom;
  const envTrust = toBool(process.env.UFO_TRUST_PROXY);
  if (envTrust !== undefined) cfg.server.trustProxy = envTrust;

  // 兜底修正，避免配置写错把服务器搞死
  if (!LEVELS[cfg.log.level]) cfg.log.level = 'info';
  if (cfg.log.ipMode !== 'masked') cfg.log.ipMode = 'full';
  if (cfg.log.retainDays < 1) cfg.log.retainDays = 1;
  if (cfg.log.maxFileBytes < 4096) cfg.log.maxFileBytes = 4096;
  if (cfg.limits.maxWireBytes < 1024) cfg.limits.maxWireBytes = 1024;
  if (cfg.room.maxMembers < 1) cfg.room.maxMembers = 1;
  if (cfg.room.idMax <= cfg.room.idMin) { cfg.room.idMin = 10000000; cfg.room.idMax = 99999999; }
  if (cfg.timeout.idleMs < 1000) cfg.timeout.idleMs = 1000;
  if (cfg.timeout.sweepMs < 1000) cfg.timeout.sweepMs = 1000;
  if (cfg.log.statsIntervalMs < 1000) cfg.log.statsIntervalMs = 1000;
  if (cfg.server.path.charAt(0) !== '/') cfg.server.path = '/' + cfg.server.path;

  cfg.__loadedFrom = usedPath || '(内置默认值)';
  return cfg;
}

const CFG = loadConfig();

// ============================================================
// 2. 日志
//
//   格式：单行 JSON，字段固定以 ts / level / event 开头，后面跟事件自己的字段。
//   落盘策略：
//     - info/warn/debug → access.log（访问日志）
//     - error           → error.log（错误日志）
//     - 轮转：文件到 maxFileBytes(10MB) 或跨天时，改名成 access.<YYYYMMDD-HHmmss>.log
//     - 清理：超过 retainDays(14) 天的轮转文件自动删除
//   写入方式刻意用**同步追加**：日志量极小（不记录任何 payload），
//   同步写换来的是轮转时不会出现「流没 flush 完就改名」的竞态，自建者也更好读。
// ============================================================

function createLogger(cfg) {
  const dir = path.isAbsolute(cfg.dir) ? cfg.dir : path.join(__dirname, cfg.dir);
  const minLevel = LEVELS[cfg.level];
  const state = {
    dir: dir,
    closed: false,
    size: { access: 0, error: 0 },
    day: { access: '', error: '' }
  };

  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { console.error('[log] 无法创建日志目录 ' + dir + ' : ' + (e && e.message)); }

  function activePath(kind) { return path.join(dir, kind + '.log'); }

  // 启动时把已存在文件的大小/日期读进来，避免重启后无限增长
  (function initSize() {
    const kinds = ['access', 'error'];
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i];
      try {
        const st = fs.statSync(activePath(k));
        state.size[k] = st.size;
        state.day[k] = dateStamp(new Date(st.mtimeMs));
      } catch (e) { /* 文件不存在，正常 */ }
    }
  })();

  // 轮转：把当前文件改名为带时间戳的历史文件
  function rotate(kind) {
    const p = activePath(kind);
    let exists = false;
    try { exists = fs.statSync(p).size > 0; } catch (e) { exists = false; }
    if (exists) {
      const base = path.join(dir, kind + '.' + tsStamp(new Date()) + '.log');
      let target = base, n = 0;
      while (fs.existsSync(target)) { n++; target = base.replace(/\.log$/, '-' + n + '.log'); }
      try { fs.renameSync(p, target); } catch (e) {
        try { console.error('[log] 轮转失败: ' + (e && e.message)); } catch (_) { }
      }
    }
    state.size[kind] = 0;
    state.day[kind] = dateStamp(new Date());
  }

  function ensure(kind) {
    const today = dateStamp(new Date());
    if (state.day[kind] && state.day[kind] !== today && state.size[kind] > 0) rotate(kind);
    if (state.size[kind] >= cfg.maxFileBytes) rotate(kind);
    state.day[kind] = today;
  }

  function write(kind, line) {
    if (state.closed) return;
    try {
      ensure(kind);
      fs.appendFileSync(activePath(kind), line + '\n');
      state.size[kind] += Buffer.byteLength(line) + 1;
    } catch (e) {
      try { console.error('[log] 写入失败: ' + (e && e.message)); } catch (_) { }
    }
  }

  // 删除超过保留期的轮转文件，返回删掉的文件名数组
  function cleanup() {
    const removed = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return removed; }
    const re = /^(access|error)\.\d{8}-\d{6}(-\d+)?\.log$/;
    const cutoff = nowMs() - cfg.retainDays * 86400000;
    for (let i = 0; i < names.length; i++) {
      if (!re.test(names[i])) continue;
      const full = path.join(dir, names[i]);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(full); removed.push(names[i]); }
      } catch (e) { /* 忽略单个文件的失败 */ }
    }
    return removed;
  }

  function record(level, event, fields) {
    if (LEVELS[level] < minLevel) return;
    const rec = { ts: isoOf(nowMs()), level: level, event: String(event) };
    if (isPlainObject(fields)) {
      const keys = Object.keys(fields);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === 'ts' || k === 'level' || k === 'event') continue; // 保留字段不允许被覆盖
        let v = fields[k];
        if (k === 'ip' && cfg.ipMode === 'masked' && typeof v === 'string') v = maskIp(v);
        if (v === undefined) continue;
        rec[k] = v;
      }
    }
    let line;
    try { line = JSON.stringify(rec); }
    catch (e) { line = JSON.stringify({ ts: rec.ts, level: 'error', event: 'log.serialize-failed', msg: String(e && e.message) }); }

    // 错误进 error.log，其余进 access.log
    write(level === 'error' ? 'error' : 'access', line);

    if (cfg.console) {
      if (level === 'error') console.error(line);
      else console.log(line);
    }
  }

  return {
    dir: dir,
    paths: function () { return { access: activePath('access'), error: activePath('error') }; },
    debug: function (event, fields) { record('debug', event, fields); },
    info: function (event, fields) { record('info', event, fields); },
    warn: function (event, fields) { record('warn', event, fields); },
    error: function (event, fields) { record('error', event, fields); },
    cleanup: cleanup,
    close: function () { state.closed = true; }
  };
}

const log = createLogger(CFG.log);

// ============================================================
// 3. 全局状态
// ============================================================

const startedAt = nowMs();

const rooms = new Map();   // roomCode(string) -> room 对象
const conns = new Map();   // peerId(string)    -> conn 对象
const rateBook = new Map();// 'ip|rule'         -> { start, count, warned }

const counters = {
  // 当前周期（统计日志之间）与累计值分开记
  periodMsgsIn: 0, periodMsgsOut: 0, periodBytesIn: 0, periodBytesOut: 0,
  msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0,
  peakConns: 0, peakRooms: 0,
  relays: 0, pings: 0, badMsgs: 0, rateLimited: 0, roomsCreated: 0, roomsReclaimed: 0
};

function newPeerId() {
  // 8 位十六进制，够用且不暴露任何信息（不是设备 ID）
  return crypto.randomBytes(4).toString('hex');
}

// ============================================================
// 4. 限流（单 IP 固定窗口）
// ============================================================

function rateLimitHit(ip, rule, max, windowMs) {
  if (!CFG.rateLimit.enabled) return false;
  const key = ip + '|' + rule;
  const t = nowMs();
  let slot = rateBook.get(key);
  if (!slot || t - slot.start >= windowMs) {
    slot = { start: t, count: 0, warned: false };
    rateBook.set(key, slot);
  }
  slot.count++;
  if (slot.count > max) {
    // 「只记一条 warn 日志」：同一窗口同一 IP 同一规则只告警一次，避免日志被刷爆
    if (!slot.warned) {
      slot.warned = true;
      log.warn('limit.rate', { ip: ip, rule: rule, count: slot.count, max: max, windowMs: windowMs });
    }
    counters.rateLimited++;
    return true;
  }
  return false;
}

function sweepRateBook() {
  const t = nowMs();
  const win = CFG.rateLimit.windowMs;
  const dead = [];
  rateBook.forEach(function (slot, key) {
    if (t - slot.start >= win * 2) dead.push(key);
  });
  for (let i = 0; i < dead.length; i++) rateBook.delete(dead[i]);
}

// ============================================================
// 5. 连接与房间
// ============================================================

function createConn(socket, req) {
  const ip = clientIpOf(req, socket);
  const ua = String(req.headers['user-agent'] || '');
  const conn = {
    peerId: newPeerId(),
    socket: socket,
    ip: ip,
    uaBrowser: parseUa(ua),   // 只记「浏览器名+大版本」，完整 UA 不落盘
    connectedAt: nowMs(),
    lastSeenAt: nowMs(),
    room: null,               // 房间号字符串，未入房为 null
    role: null,               // 'slave'（建房方）| 'master'（加入方）| 'viewer'（将来多人）
    joinedAt: 0,
    buf: Buffer.alloc(0),     // 帧解析缓冲
    frag: null,               // 分片消息状态 { opcode, chunks, bytes }
    closeSent: false,
    closed: false,
    endReason: '',            // 断开原因，写进日志
    bytesIn: 0,
    bytesOut: 0,
    msgsIn: 0,
    msgsOut: 0,
    badMsgs: 0
  };
  return conn;
}

function clientIpOf(req, socket) {
  if (CFG.server.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return normalizeIp(String(xff).split(',')[0].trim());
    const xr = req.headers['x-real-ip'];
    if (xr) return normalizeIp(String(xr).trim());
  }
  return normalizeIp(socket.remoteAddress || '');
}

// 向一个连接发送一条传输层消息对象（服务端发出的帧一律不加掩码）
function sendJson(conn, obj) {
  if (conn.closed) return false;
  let text;
  try { text = JSON.stringify(obj); } catch (e) { return false; }
  return sendTextFrame(conn, text);
}

function sendError(conn, code, extra) {
  const msg = { t: 'error', code: code, s: nowMs() };
  if (extra) {
    const keys = Object.keys(extra);
    for (let i = 0; i < keys.length; i++) msg[keys[i]] = extra[keys[i]];
  }
  sendJson(conn, msg);
  log.info('msg.error', { peerId: conn.peerId, ip: conn.ip, room: conn.room, code: code });
}

function roomOf(conn) {
  if (!conn.room) return null;
  return rooms.get(conn.room) || null;
}

// 建房：8 位数字房间号 + 查重
function generateRoomCode() {
  const min = CFG.room.idMin, max = CFG.room.idMax;
  const span = max - min + 1;
  for (let i = 0; i < CFG.room.maxIdAttempts; i++) {
    // 优先用 randomInt（无模偏差）；老版本 Node 退回 randomBytes
    let n;
    if (typeof crypto.randomInt === 'function') n = crypto.randomInt(min, max + 1);
    else n = min + (crypto.randomBytes(4).readUInt32BE(0) % span);
    const code = String(n);
    if (!rooms.has(code)) return code;
  }
  return null; // 极端情况：连续撞号，交给调用方报 server-busy
}

// 角色分配：建房方是 slave（被控端/持蓝牙那台），加入方是 master（主控端）。
// 多人放开后：第一个加入者是 master，其余是 viewer —— 当前上限 2 人时走不到 viewer 分支。
function pickRole(room) {
  if (room.members.length === 0) return 'slave';
  for (let i = 0; i < room.members.length; i++) {
    if (room.members[i].role === 'master') return 'viewer';
  }
  return 'master';
}

function addMember(room, conn, role) {
  const member = {
    peerId: conn.peerId,
    role: role,
    ip: conn.ip,
    joinedAt: nowMs()
  };
  room.members.push(member);
  room.lastActivityAt = nowMs();
  conn.room = room.code;
  conn.role = role;
  conn.joinedAt = member.joinedAt;
  return member;
}

function removeMember(room, peerId) {
  for (let i = 0; i < room.members.length; i++) {
    if (room.members[i].peerId === peerId) return room.members.splice(i, 1)[0];
  }
  return null;
}

// 通知房间内「除 exceptPeerId 以外的所有成员」：有人来了 / 有人走了
// 被控端就是靠这条消息触发「主控离开 → 立即停机」的。
function broadcastPeer(room, event, exceptPeerId, member) {
  for (let i = 0; i < room.members.length; i++) {
    const m = room.members[i];
    if (m.peerId === exceptPeerId) continue;
    const c = conns.get(m.peerId);
    if (!c) continue;
    sendJson(c, {
      t: 'peer',
      event: event,
      peerId: member.peerId,
      role: member.role,
      members: room.members.length,
      maxMembers: CFG.room.maxMembers,
      s: nowMs()
    });
  }
}

// 离开房间（主动 leave 或连接断开都会走到这里）
function leaveRoom(conn, reason) {
  const room = roomOf(conn);
  const roomCode = conn.room;
  const role = conn.role;
  if (!room) { conn.room = null; conn.role = null; return; }

  const member = removeMember(room, conn.peerId) || { peerId: conn.peerId, role: role };
  conn.room = null;
  conn.role = null;

  log.info('room.leave', {
    room: roomCode,
    peerId: conn.peerId,
    role: role,
    ip: conn.ip,
    reason: reason,
    left: room.members.length,
    maxMembers: CFG.room.maxMembers
  });

  broadcastPeer(room, 'left', conn.peerId, member);

  // 房间空了不立即删：留到空闲回收（10 分钟），这样弱网闪断可以重新 join 回同一个房间。
  // 想改成「空了立刻删」就把这里打开：
  // if (room.members.length === 0) reclaimRoom(room, 'empty');
  room.lastActivityAt = nowMs();
}

function reclaimRoom(room, reason) {
  // 通知还在房间里的成员（正常情况不会有，因为 2 秒一次的心跳会让房间一直"有消息"）
  for (let i = 0; i < room.members.length; i++) {
    const c = conns.get(room.members[i].peerId);
    if (!c) continue;
    sendError(c, 'room-closed', { room: room.code });
    c.room = null;
    c.role = null;
  }
  rooms.delete(room.code);
  counters.roomsReclaimed++;
  log.info('room.reclaim', {
    room: room.code,
    reason: reason,
    ageMs: nowMs() - room.createdAt,
    idleMs: nowMs() - room.lastActivityAt,
    members: room.members.length
  });
}

// ============================================================
// 6. 传输层消息处理（严格按 protocol.js 的 R.T 定义）
// ============================================================

function handleMessage(conn, msg) {
  const t = msg.t;
  switch (t) {
    case 'create': return onCreate(conn);
    case 'join': return onJoin(conn, msg);
    case 'leave': return onLeave(conn);
    case 'relay': return onRelay(conn, msg);
    case 'ping': return onPing(conn, msg);
    default:
      // created/joined/peer/error/pong 是服务器 → 客户端的方向，客户端发来就是错的
      badMessage(conn, 'unknown-type:' + String(t).slice(0, 24));
      sendError(conn, 'bad-type');
  }
}

function onCreate(conn) {
  if (rateLimitHit(conn.ip, 'create', CFG.rateLimit.maxCreatePerWindow, CFG.rateLimit.windowMs)) {
    return sendError(conn, 'rate-limited');
  }
  if (conn.room) return sendError(conn, 'already-in-room');

  const code = generateRoomCode();
  if (!code) {
    log.error('room.create.failed', { ip: conn.ip, peerId: conn.peerId, reason: 'no-free-room-id' });
    return sendError(conn, 'server-busy');
  }

  const room = {
    code: code,
    members: [],              // 数组维护：将来放开多人只需要改 room.maxMembers
    createdAt: nowMs(),
    lastActivityAt: nowMs()
  };
  rooms.set(code, room);
  counters.roomsCreated++;
  if (rooms.size > counters.peakRooms) counters.peakRooms = rooms.size;

  const member = addMember(room, conn, 'slave');

  log.info('room.create', {
    room: code,
    ip: conn.ip,
    peerId: conn.peerId,
    role: member.role,
    members: room.members.length,
    maxMembers: CFG.room.maxMembers
  });

  // 按契约：{t:'created', room, role:'slave', peerId}
  sendJson(conn, {
    t: 'created',
    room: code,
    role: 'slave',
    peerId: conn.peerId,
    members: room.members.length,
    maxMembers: CFG.room.maxMembers,
    s: nowMs()
  });
}

function onJoin(conn, msg) {
  const roomCode = typeof msg.room === 'string' ? msg.room : (typeof msg.room === 'number' ? String(msg.room) : '');
  const digits = String(CFG.room.idMax).length;   // 默认 8 位

  if (rateLimitHit(conn.ip, 'join', CFG.rateLimit.maxJoinPerWindow, CFG.rateLimit.windowMs)) {
    return sendError(conn, 'rate-limited');
  }
  if (conn.room) return sendError(conn, 'already-in-room');

  if (!/^[0-9]+$/.test(roomCode) || roomCode.length !== digits) {
    log.warn('room.join.fail', { room: roomCode, ip: conn.ip, peerId: conn.peerId, reason: 'bad-room-format' });
    return sendError(conn, 'bad-room');
  }

  const room = rooms.get(roomCode);
  if (!room) {
    log.warn('room.join.fail', {
      room: roomCode, ip: conn.ip, peerId: conn.peerId, reason: 'room-not-found'
    });
    return sendError(conn, 'room-not-found');
  }
  if (room.members.length >= CFG.room.maxMembers) {
    log.warn('room.join.fail', {
      room: roomCode, ip: conn.ip, peerId: conn.peerId, reason: 'room-full',
      members: room.members.length, maxMembers: CFG.room.maxMembers
    });
    return sendError(conn, 'room-full');
  }

  const role = pickRole(room);
  const member = addMember(room, conn, role);

  log.info('room.join', {
    room: roomCode, ip: conn.ip, peerId: conn.peerId, role: role,
    members: room.members.length, maxMembers: CFG.room.maxMembers
  });

  // 按契约：{t:'joined', room, role:'master', peerId}
  sendJson(conn, {
    t: 'joined',
    room: roomCode,
    role: role,
    peerId: conn.peerId,
    members: room.members.length,
    maxMembers: CFG.room.maxMembers,
    s: nowMs()
  });

  // 先给新成员回 joined，再通知房间里其他人 peer joined
  broadcastPeer(room, 'joined', conn.peerId, member);
}

function onLeave(conn) {
  if (!conn.room) return sendError(conn, 'not-in-room');
  leaveRoom(conn, 'client-leave');
}

// 中继：payload 一个字都不改，只额外补一个服务器毫秒时间戳 s
function onRelay(conn, msg) {
  const room = roomOf(conn);
  if (!room) return sendError(conn, 'not-in-room');
  if (!isPlainObject(msg.payload)) return badMessage(conn, 'relay-bad-payload');

  room.lastActivityAt = nowMs();

  const outObj = { t: 'relay', s: nowMs(), payload: msg.payload };
  let out;
  try { out = JSON.stringify(outObj); }
  catch (e) { return badMessage(conn, 'relay-serialize-failed'); }

  // 中继信封会加上约 40 字节，如果贴到客户端的 64KB 上限就会被对端拒收。
  // 这种情况直接拒绝并告知，避免"发出去但对方断线"这种难排查的故障。
  const outBytes = Buffer.byteLength(out);
  if (outBytes > CFG.limits.maxWireBytes) {
    log.warn('relay.too-large', {
      ip: conn.ip, peerId: conn.peerId, room: room.code, bytes: outBytes, limit: CFG.limits.maxWireBytes
    });
    return sendError(conn, 'too-large', { bytes: outBytes, limit: CFG.limits.maxWireBytes });
  }

  // 转发目标是「房间内除自己外的所有成员」—— 不是写死的"对端"
  let targets = 0;
  for (let i = 0; i < room.members.length; i++) {
    const m = room.members[i];
    if (m.peerId === conn.peerId) continue;
    const c = conns.get(m.peerId);
    if (!c || c.closed) continue;
    if (sendTextFrame(c, out)) targets++;
  }
  counters.relays++;
  log.debug('relay', { room: room.code, peerId: conn.peerId, bytes: outBytes, targets: targets });
}

// 心跳：把客户端的 c 原样带回来，服务器只补 s。客户端靠这两个值算 RTT 与时钟偏差。
function onPing(conn, msg) {
  const pong = { t: 'pong', s: nowMs() };
  if (Object.prototype.hasOwnProperty.call(msg, 'c')) pong.c = msg.c;   // 原样带回，一个字节都不动
  sendJson(conn, pong);
  counters.pings++;
  const room = roomOf(conn);
  if (room) room.lastActivityAt = nowMs();
}

// 畸形消息：记一条 warn 后忽略；累计太多就断开这条连接
function badMessage(conn, reason) {
  conn.badMsgs++;
  counters.badMsgs++;
  log.warn('msg.bad', {
    ip: conn.ip, peerId: conn.peerId, room: conn.room,
    reason: reason, count: conn.badMsgs, limit: CFG.limits.maxBadMessages
  });
  if (conn.badMsgs >= CFG.limits.maxBadMessages) {
    closeConn(conn, 'too-many-bad-messages', CLOSE_BAD_MESSAGES, 'too many malformed messages');
  }
}

// 收到一条完整的文本消息
function onTextMessage(conn, text) {
  conn.msgsIn++;
  counters.msgsIn++;
  counters.periodMsgsIn++;
  conn.lastSeenAt = nowMs();

  // 消息大小上限（帧层已经拦过一次，这里是双保险）
  if (Buffer.byteLength(text) > CFG.limits.maxWireBytes) {
    log.warn('limit.wire', {
      ip: conn.ip, peerId: conn.peerId, bytes: Buffer.byteLength(text), limit: CFG.limits.maxWireBytes
    });
    return closeConn(conn, 'message-too-big', CLOSE_TOO_BIG, 'message too big');
  }

  let msg;
  try { msg = JSON.parse(text); }
  catch (e) {
    badMessage(conn, 'json-parse');
    return;
  }
  if (!isPlainObject(msg) || typeof msg.t !== 'string') {
    badMessage(conn, 'bad-envelope');
    return;
  }
  // 注意：relay.payload 的内容永远不解析、不校验、不落盘 —— 那是客户端业务层的事
  try { handleMessage(conn, msg); }
  catch (e) {
    log.error('handler.exception', {
      ip: conn.ip, peerId: conn.peerId, room: conn.room, type: (e && e.name) || 'Error',
      msg: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ')
    });
    sendError(conn, 'server-error');
  }
}

// ============================================================
// 7. WebSocket 服务端实现（RFC 6455）
//
//   握手：客户端发 Upgrade，服务器回 101 + Sec-WebSocket-Accept
//   帧：自己解析字节流，支持文本/续帧/close/ping/pong、掩码、126/127 扩展长度
//   服务端发出的帧不加掩码（RFC 规定）
// ============================================================

function computeAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

// 尝试从 buffer 头部解析一帧。返回：
//   null                     → 数据还不够，继续等
//   { err:{code,reason} }    → 协议错误，应关闭连接
//   { fin, opcode, payload, size } → 解析成功，size 是这一帧占用的总字节数
function tryParseFrame(buf, maxWireBytes) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const rsv = b0 & 0x70;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  if (rsv !== 0) return { err: { code: CLOSE_PROTOCOL_ERROR, reason: 'rsv-not-zero' } };

  if (len === 126) {                                   // 16 位扩展长度
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {                            // 64 位扩展长度
    if (buf.length < off + 8) return null;
    const hi = buf.readUInt32BE(off);
    const lo = buf.readUInt32BE(off + 4);
    if (hi !== 0) return { err: { code: CLOSE_TOO_BIG, reason: 'payload-too-large' } };
    len = lo;
    off += 8;
  }

  // 控制帧（close/ping/pong）必须 <=125 字节且不可分片
  if (opcode >= 0x8) {
    if (len > 125) return { err: { code: CLOSE_PROTOCOL_ERROR, reason: 'control-frame-too-large' } };
    if (!fin) return { err: { code: CLOSE_PROTOCOL_ERROR, reason: 'control-frame-fragmented' } };
  }

  // 超大帧：不等它传完就直接关，避免为一个 100MB 的声明分配内存
  if (len > maxWireBytes) return { err: { code: CLOSE_TOO_BIG, reason: 'message-too-big' } };

  // 客户端 → 服务端必须带掩码（RFC 6455 §5.1）
  if (!masked) return { err: { code: CLOSE_PROTOCOL_ERROR, reason: 'client-frame-not-masked' } };

  const need = off + 4 + len;                          // 头部 + 掩码键 + 载荷
  if (buf.length < need) return null;

  const mask = buf.subarray(off, off + 4);
  off += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];

  return { fin: fin, opcode: opcode, payload: payload, size: need };
}

// 编码一个服务端帧（不加掩码）
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);      // 高位永远 0（< 4GB）
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;         // FIN=1，RSV=0
  return Buffer.concat([header, payload]);
}

function rawWrite(conn, buf) {
  if (conn.closed) return false;
  try {
    conn.socket.write(buf);
    conn.bytesOut += buf.length;
    counters.bytesOut += buf.length;
    counters.periodBytesOut += buf.length;
    return true;
  } catch (e) {
    return false;
  }
}

function sendTextFrame(conn, text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > CFG.limits.maxWireBytes) return false;
  conn.msgsOut++;
  counters.msgsOut++;
  counters.periodMsgsOut++;
  return rawWrite(conn, encodeFrame(OP_TEXT, payload));
}

function sendControlFrame(conn, opcode, payload) {
  const p = payload || Buffer.alloc(0);
  return rawWrite(conn, encodeFrame(opcode, p.length > 125 ? p.subarray(0, 125) : p));
}

function sendPong(conn, payload) { sendControlFrame(conn, OP_PONG, payload); }

function sendCloseFrame(conn, code, reason) {
  if (conn.closeSent) return;
  conn.closeSent = true;
  const rbuf = Buffer.from(String(reason || '').slice(0, 100), 'utf8');
  const payload = Buffer.allocUnsafe(2 + rbuf.length);
  payload.writeUInt16BE(code || CLOSE_NORMAL, 0);
  rbuf.copy(payload, 2);
  try {
    conn.socket.write(encodeFrame(OP_CLOSE, payload));
    conn.bytesOut += payload.length + 2;
  } catch (e) { /* 对端可能已经没了 */ }
}

// 统一关连接入口：记日志 → 回 close 帧 → 宽限期后销毁 socket
function closeConn(conn, reason, code, text) {
  if (conn.closed) return;
  conn.closed = true;
  conn.endReason = reason;

  if (conn.room) leaveRoom(conn, reason);

  conns.delete(conn.peerId);

  log.info('ws.close', {
    ip: conn.ip,
    peerId: conn.peerId,
    browser: conn.uaBrowser,
    reason: reason,                    // client-close | client-leave | socket-error | idle-timeout | ...
    code: code || CLOSE_NORMAL,
    durationMs: nowMs() - conn.connectedAt,
    bytesIn: conn.bytesIn,
    bytesOut: conn.bytesOut,
    msgsIn: conn.msgsIn,
    msgsOut: conn.msgsOut,
    badMsgs: conn.badMsgs
  });

  if (!conn.closeSent) sendCloseFrame(conn, code || CLOSE_NORMAL, text || reason);
  try { conn.socket.end(); } catch (e) { /* ignore */ }
  // 宽限期后强拆 socket：确保 close 帧有机会发出去，同时不会留下僵尸连接
  const t = setTimeout(function () {
    try { conn.socket.destroy(); } catch (e) { /* ignore */ }
  }, CFG.timeout.closeGraceMs);
  if (t.unref) t.unref();
}

// 帧解析主循环：把 socket 上收到的字节喂进来
function feed(conn, chunk) {
  conn.bytesIn += chunk.length;
  counters.bytesIn += chunk.length;
  counters.periodBytesIn += chunk.length;
  conn.lastSeenAt = nowMs();

  conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;

  while (!conn.closed) {
    const f = tryParseFrame(conn.buf, CFG.limits.maxWireBytes);
    if (f === null) break;
    if (f.err) {
      log.warn('ws.protocol-error', {
        ip: conn.ip, peerId: conn.peerId, code: f.err.code, reason: f.err.reason, bufferedBytes: conn.buf.length
      });
      conn.buf = Buffer.alloc(0);
      return closeConn(conn, 'protocol-error:' + f.err.reason, f.err.code, f.err.reason);
    }
    conn.buf = conn.buf.subarray(f.size);

    if (f.opcode === OP_CLOSE) {
      let code = CLOSE_NORMAL, reason = '';
      if (f.payload.length >= 2) {
        code = f.payload.readUInt16BE(0);
        reason = f.payload.subarray(2, 60).toString('utf8');
      }
      log.info('ws.close-frame', { ip: conn.ip, peerId: conn.peerId, code: code, reason: reason.slice(0, 60) });
      // 回一个 close 帧后收工；closeConn 会统一处理退房、日志、销毁
      const echo = (code >= 1000 && code <= 4999) ? code : CLOSE_NORMAL;
      return closeConn(conn, 'client-close', echo, '');
    }

    if (f.opcode === OP_PING) { sendPong(conn, f.payload); continue; }
    if (f.opcode === OP_PONG) { continue; }   // 服务端不发协议 ping，收到 pong 只当心跳

    if (f.opcode === OP_BIN) {
      log.warn('ws.binary-unsupported', { ip: conn.ip, peerId: conn.peerId, bytes: f.payload.length });
      return closeConn(conn, 'binary-not-supported', CLOSE_UNSUPPORTED_DATA, 'binary frames not supported');
    }

    if (f.opcode === OP_TEXT || f.opcode === OP_CONT) {
      const isText = f.opcode === OP_TEXT;
      if (isText && conn.frag) {
        log.warn('ws.protocol-error', { ip: conn.ip, peerId: conn.peerId, reason: 'new-data-frame-while-fragmented' });
        return closeConn(conn, 'protocol-error:new-data-frame', CLOSE_PROTOCOL_ERROR, 'new data frame while fragmented');
      }
      if (!isText && !conn.frag) {
        log.warn('ws.protocol-error', { ip: conn.ip, peerId: conn.peerId, reason: 'orphan-continuation' });
        return closeConn(conn, 'protocol-error:orphan-continuation', CLOSE_PROTOCOL_ERROR, 'orphan continuation');
      }

      if (isText && f.fin) {
        // 未分片的普通文本帧（绝大多数情况）
        if (!isValidUtf8(f.payload)) {
          log.warn('ws.bad-utf8', { ip: conn.ip, peerId: conn.peerId, bytes: f.payload.length });
          return closeConn(conn, 'invalid-utf8', CLOSE_BAD_PAYLOAD, 'invalid utf-8');
        }
        onTextMessage(conn, f.payload.toString('utf8'));
        continue;
      }

      // 分片：累积
      if (!conn.frag) conn.frag = { opcode: f.opcode, chunks: [], bytes: 0 };
      conn.frag.chunks.push(f.payload);
      conn.frag.bytes += f.payload.length;
      if (conn.frag.chunks.length > CFG.limits.maxFragments || conn.frag.bytes > CFG.limits.maxWireBytes) {
        const seenBytes = conn.frag.bytes, seenFrags = conn.frag.chunks.length;
        conn.frag = null;
        log.warn('limit.wire', {
          ip: conn.ip, peerId: conn.peerId, bytes: seenBytes, fragments: seenFrags,
          maxFragments: CFG.limits.maxFragments, limit: CFG.limits.maxWireBytes
        });
        return closeConn(conn, 'message-too-big', CLOSE_TOO_BIG, 'fragmented message too big');
      }
      if (!f.fin) continue;

      const frag = conn.frag;
      conn.frag = null;
      if (frag.opcode !== OP_TEXT) {
        // 二进制分片消息：本项目不支持
        return closeConn(conn, 'binary-not-supported', CLOSE_UNSUPPORTED_DATA, 'binary frames not supported');
      }
      const whole = Buffer.concat(frag.chunks, frag.bytes);
      if (!isValidUtf8(whole)) {
        log.warn('ws.bad-utf8', { ip: conn.ip, peerId: conn.peerId, bytes: whole.length });
        return closeConn(conn, 'invalid-utf8', CLOSE_BAD_PAYLOAD, 'invalid utf-8');
      }
      onTextMessage(conn, whole.toString('utf8'));
      continue;
    }

    // 0x3-0x7 / 0xB-0xF 都是保留 opcode
    log.warn('ws.protocol-error', { ip: conn.ip, peerId: conn.peerId, reason: 'reserved-opcode:' + f.opcode });
    return closeConn(conn, 'protocol-error:reserved-opcode', CLOSE_PROTOCOL_ERROR, 'reserved opcode');
  }
}

// 升级失败时回一个普通 HTTP 响应，方便用浏览器直接打开排查
function rejectUpgrade(socket, status, text, extraHeaders) {
  const body = text + '\n';
  const head = 'HTTP/1.1 ' + status + '\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
    'Connection: close\r\n' +
    (extraHeaders || '') +
    '\r\n';
  try { socket.write(head + body); } catch (e) { /* ignore */ }
  try { socket.destroy(); } catch (e) { /* ignore */ }
}

// ============================================================
// 8. HTTP 服务 + 端点
// ============================================================

function healthPayload() {
  return {
    ok: true,
    service: 'web-ufo-player-remote-relay',
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    startedAt: isoOf(startedAt),
    uptimeSec: Math.round((nowMs() - startedAt) / 1000),
    rooms: rooms.size,              // 在线房间数
    connections: conns.size,        // 连接数
    maxMembersPerRoom: CFG.room.maxMembers,
    maxWireBytes: CFG.limits.maxWireBytes,
    counters: {
      msgsIn: counters.msgsIn,
      msgsOut: counters.msgsOut,
      bytesIn: counters.bytesIn,
      bytesOut: counters.bytesOut,
      relays: counters.relays,
      pings: counters.pings,
      roomsCreated: counters.roomsCreated,
      roomsReclaimed: counters.roomsReclaimed,
      badMsgs: counters.badMsgs,
      rateLimited: counters.rateLimited,
      peakConnections: counters.peakConns,
      peakRooms: counters.peakRooms
    },
    now: nowMs()
  };
}

const server = http.createServer(function (req, res) {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = req.url || '/'; }

  if (pathname === CFG.server.healthPath && (req.method === 'GET' || req.method === 'HEAD')) {
    const body = JSON.stringify(healthPayload(), null, 2) + '\n';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? '' : body);
    return;
  }

  if (pathname === CFG.server.path) {
    // 用浏览器/curl 直接打开 /ws 会走到这里：给出明确提示，而不是模糊的 404
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', 'Upgrade': 'websocket', 'Connection': 'Upgrade' });
    res.end('这里需要 WebSocket Upgrade 握手。\n' +
      '浏览器里请用: new WebSocket("wss://你的域名' + CFG.server.path + '")\n' +
      '命令行: wscat -c wss://你的域名' + CFG.server.path + '\n健康检查: ' + CFG.server.healthPath + '\n');
    return;
  }

  if (pathname === '/') {
    const body = 'Web-UFO-Player 远程控制中继服务器 v' + VERSION + '\n' +
      'WebSocket: ' + CFG.server.path + '\n' +
      '健康检查: ' + CFG.server.healthPath + '\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // 其他路径一律 404，避免"什么都返回 200"把健康检查/探测搞糊涂
  const body = '404 未知路径: ' + pathname.slice(0, 128) + '\n' +
    '本服务器只在 ' + CFG.server.path + ' 提供 WebSocket 中继，健康检查在 ' + CFG.server.healthPath + '\n';
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
});

server.on('upgrade', function (req, socket, head) {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = req.url || '/'; }

  const upgradeHdr = String(req.headers.upgrade || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];
  const ver = String(req.headers['sec-websocket-version'] || '');
  const ip = clientIpOf(req, socket);

  if (pathname !== CFG.server.path) {
    log.warn('ws.upgrade.reject', { ip: ip, path: pathname.slice(0, 64), reason: 'bad-path' });
    return rejectUpgrade(socket, '404 Not Found', '未知的 WebSocket 路径，本服务器只在 ' + CFG.server.path + ' 提供中继。');
  }
  if (upgradeHdr !== 'websocket') {
    log.warn('ws.upgrade.reject', { ip: ip, reason: 'not-websocket-upgrade' });
    return rejectUpgrade(socket, '400 Bad Request', '缺少 Upgrade: websocket 头。');
  }
  if (!key || ver !== '13') {
    // 反代（Nginx/Caddy）漏了 Upgrade/Connection 头时，最常见的就是这里失败
    log.warn('ws.upgrade.reject', { ip: ip, reason: 'bad-handshake', hasKey: !!key, version: ver.slice(0, 8) });
    return rejectUpgrade(socket, '400 Bad Request', '握手头不完整：需要 Sec-WebSocket-Key 与 Sec-WebSocket-Version: 13。\n' +
      '如果你用了反向代理，请确认 Upgrade / Connection 头被透传。');
  }
  if (conns.size >= CFG.server.maxConnections) {
    log.warn('ws.upgrade.reject', { ip: ip, reason: 'server-busy', connections: conns.size, limit: CFG.server.maxConnections });
    return rejectUpgrade(socket, '503 Service Unavailable', '连接数已达上限，稍后再试。');
  }

  const accept = computeAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n'
  );
  try { socket.setNoDelay(true); } catch (e) { /* ignore */ }
  try { socket.setTimeout(0); } catch (e) { /* ignore */ }   // 超时由我们自己的巡检管

  const conn = createConn(socket, req);
  conns.set(conn.peerId, conn);
  if (conns.size > counters.peakConns) counters.peakConns = conns.size;

  // 日志：IP、peerId、浏览器名+大版本（完整 UA 绝不落盘）
  log.info('ws.open', {
    ip: conn.ip,
    peerId: conn.peerId,
    browser: conn.uaBrowser,
    trustProxy: CFG.server.trustProxy,
    connections: conns.size
  });

  socket.on('data', function (chunk) {
    try { feed(conn, chunk); }
    catch (e) {
      log.error('feed.exception', {
        ip: conn.ip, peerId: conn.peerId, type: (e && e.name) || 'Error',
        msg: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ')
      });
      closeConn(conn, 'server-error', 1011, 'internal error');
    }
  });

  socket.on('error', function (err) {
    // 客户端网络中断（重置连接、Wi‑Fi 掉线等）会走到这里
    if (!conn.closed) {
      conn.endReason = 'socket-error';
      log.warn('ws.socket-error', {
        ip: conn.ip, peerId: conn.peerId, type: (err && err.code) || (err && err.name) || 'Error',
        msg: String(err && err.message || err).slice(0, 160)
      });
      closeConn(conn, 'socket-error', CLOSE_GOING_AWAY, 'socket error');
    }
  });

  // 【重要】对端半关闭（FIN）时必须立刻当作断开处理。
  // 原因：Node 的 http.Server 用 allowHalfOpen:true 建 socket，客户端拔网线/被强杀时
  // 只有 'end' 而没有 'close'，如果不管它，房间里的对端要等 30 秒心跳巡检才知道人走了 ——
  // 而「主控离开 → 被控立即停机」是安全路径，不能等。
  socket.on('end', function () {
    if (conn.closed) return;
    log.info('ws.end', { ip: conn.ip, peerId: conn.peerId, room: conn.room, bufferedBytes: conn.buf.length });
    closeConn(conn, 'network-error', CLOSE_GOING_AWAY, 'peer closed connection');
  });

  socket.on('close', function (hadError) {
    if (!conn.closed) {
      // 对端直接消失（没发 close 帧），例如拔网线、标签页被强杀
      if (conn.room) leaveRoom(conn, 'network-error');
      conn.closed = true;
      conn.endReason = 'network-error';
      conns.delete(conn.peerId);
      log.info('ws.close', {
        ip: conn.ip, peerId: conn.peerId, browser: conn.uaBrowser,
        reason: hadError ? 'socket-error' : 'network-error', code: 1006,
        durationMs: nowMs() - conn.connectedAt, bytesIn: conn.bytesIn, bytesOut: conn.bytesOut,
        msgsIn: conn.msgsIn, msgsOut: conn.msgsOut, badMsgs: conn.badMsgs
      });
    }
  });

  // 客户端可能在握手包之后紧跟数据（head），不能丢
  if (head && head.length) {
    try { feed(conn, head); } catch (e) { /* 上面的 data 处理里已有日志逻辑 */ }
  }
});

server.on('clientError', function (err, socket) {
  try { socket.destroy(); } catch (e) { /* ignore */ }
});

// ============================================================
// 9. 定时巡检：死连接 / 空闲房间 / 统计 / 日志清理
// ============================================================

const sweepTimer = setInterval(function () {
  const t = nowMs();

  // 9.1 心跳超时：30 秒没收到任何帧（含协议层 ping/pong）就断开。
  // 客户端业务心跳是 2 秒一次，所以正常连接永远不会被误杀。
  const deadConns = [];
  conns.forEach(function (conn) {
    if (t - conn.lastSeenAt > CFG.timeout.idleMs) deadConns.push(conn);
  });
  for (let i = 0; i < deadConns.length; i++) {
    const c = deadConns[i];
    log.warn('heartbeat.timeout', {
      ip: c.ip, peerId: c.peerId, room: c.room, idleMs: t - c.lastSeenAt, limit: CFG.timeout.idleMs
    });
    closeConn(c, 'idle-timeout', CLOSE_IDLE, 'heartbeat timeout');
  }

  // 9.2 空闲房间回收：10 分钟没有任何消息
  const deadRooms = [];
  rooms.forEach(function (room) {
    if (t - room.lastActivityAt > CFG.room.idleMs) deadRooms.push(room);
  });
  for (let i = 0; i < deadRooms.length; i++) reclaimRoom(deadRooms[i], 'idle');

  sweepRateBook();

  // 9.3 日志清理：把超过保留期的轮转文件删掉
  const removed = log.cleanup();
  if (removed.length) log.info('log.cleanup', { removed: removed.length, files: removed.slice(0, 5) });
}, CFG.timeout.sweepMs);
sweepTimer.unref && sweepTimer.unref();

const statsTimer = setInterval(function () {
  log.info('stats', {
    rooms: rooms.size,
    connections: conns.size,
    msgsIn: counters.periodMsgsIn,
    msgsOut: counters.periodMsgsOut,
    bytesIn: counters.periodBytesIn,
    bytesOut: counters.periodBytesOut,
    totalRoomsCreated: counters.roomsCreated,
    totalRoomsReclaimed: counters.roomsReclaimed,
    totalMsgsIn: counters.msgsIn,
    totalMsgsOut: counters.msgsOut,
    totalBytesIn: counters.bytesIn,
    totalBytesOut: counters.bytesOut,
    relays: counters.relays,
    pings: counters.pings,
    badMsgs: counters.badMsgs,
    rateLimited: counters.rateLimited
  });
  counters.periodMsgsIn = 0; counters.periodMsgsOut = 0;
  counters.periodBytesIn = 0; counters.periodBytesOut = 0;
}, CFG.log.statsIntervalMs);
statsTimer.unref && statsTimer.unref();

// ============================================================
// 10. 启动 / 优雅关闭
// ============================================================

function configSummary() {
  return {
    host: CFG.server.host,
    port: CFG.server.port,
    path: CFG.server.path,
    maxMembersPerRoom: CFG.room.maxMembers,
    roomIdleMs: CFG.room.idleMs,
    idleTimeoutMs: CFG.timeout.idleMs,
    maxWireBytes: CFG.limits.maxWireBytes,
    rateLimit: CFG.rateLimit.enabled
      ? CFG.rateLimit.maxCreatePerWindow + '/' + (CFG.rateLimit.windowMs / 1000) + 's per ip (create)'
      : 'disabled',
    logLevel: CFG.log.level,
    logIpMode: CFG.log.ipMode,
    logRetainDays: CFG.log.retainDays,
    logMaxFileBytes: CFG.log.maxFileBytes,
    trustProxy: CFG.server.trustProxy
  };
}

server.on('error', function (err) {
  log.error('server.error', {
    type: (err && err.code) || (err && err.name) || 'Error',
    msg: String(err && err.message || err),
    port: CFG.server.port,
    hint: (err && err.code === 'EADDRINUSE') ? '端口被占用：换 UFO_PORT 或先停掉占用进程' : undefined
  });
  process.exitCode = 1;
  shutdown('server-error');
});

server.listen(CFG.server.port, CFG.server.host, function () {
  log.info('server.start', {
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    node: process.version,
    configFile: CFG.__loadedFrom,
    listen: CFG.server.host + ':' + CFG.server.port,
    ws: 'ws://' + (CFG.server.host === '0.0.0.0' ? 'localhost' : CFG.server.host) + ':' + CFG.server.port + CFG.server.path,
    health: 'http://' + (CFG.server.host === '0.0.0.0' ? 'localhost' : CFG.server.host) + ':' + CFG.server.port + CFG.server.healthPath,
    logAccess: log.paths().access,
    logError: log.paths().error,
    config: configSummary()
  });
  // 启动时清一次旧日志
  const removed = log.cleanup();
  if (removed.length) log.info('log.cleanup', { removed: removed.length, files: removed.slice(0, 5) });
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info('server.stop', {
    signal: String(signal),
    uptimeSec: Math.round((nowMs() - startedAt) / 1000),
    rooms: rooms.size,
    connections: conns.size,
    totalMsgsIn: counters.msgsIn,
    totalMsgsOut: counters.msgsOut,
    totalBytesIn: counters.bytesIn,
    totalBytesOut: counters.bytesOut
  });

  clearInterval(sweepTimer);
  clearInterval(statsTimer);
  try { server.close(); } catch (e) { /* ignore */ }

  // 给每个连接发 close 帧（1001 = going away），客户端会立刻知道是服务器下线
  conns.forEach(function (conn) {
    closeConn(conn, 'server-shutdown', CLOSE_GOING_AWAY, 'server shutdown');
  });

  setTimeout(function () {
    conns.forEach(function (conn) {
      try { conn.socket.destroy(); } catch (e) { /* ignore */ }
    });
    log.info('server.stopped', {
      durationMs: nowMs() - startedAt,
      finalRooms: rooms.size,
      finalConnections: conns.size
    });
    log.close();
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  }, CFG.timeout.closeGraceMs + 200);
}

process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });

process.on('uncaughtException', function (err) {
  log.error('process.uncaught-exception', {
    type: (err && err.name) || 'Error',
    msg: String(err && err.message || err),
    stack: String(err && err.stack || '').split('\n').slice(0, 6).join(' | ')
  });
  process.exitCode = 1;
  shutdown('uncaughtException');
});

process.on('unhandledRejection', function (reason) {
  log.error('process.unhandled-rejection', {
    type: (reason && reason.name) || typeof reason,
    msg: String((reason && reason.message) || reason).slice(0, 300),
    stack: String((reason && reason.stack) || '').split('\n').slice(0, 6).join(' | ')
  });
});
