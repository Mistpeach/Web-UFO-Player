# RemoteServer · UFO 助手远程控制中继服务器

UFO 助手（Web-UFO-Player）的**远程控制**功能需要一台服务器做中转。
这就是那台服务器 —— **独立、可自建、零第三方依赖**。

```
主控方浏览器  ──wss──►  【本服务器】  ──wss──►  被控方浏览器  ──蓝牙──►  玩具
```

**服务器只做两件事**：让两端凭 8 位房间号找到对方、原样转发消息。
它**不碰蓝牙、不解析业务内容、不记录波形数据**。

---

## 3 步跑起来

```bash
# 1) 改配置（可选；不改就用内置默认值：监听 8787，日志在 ./logs）
cp config.example.json config.json

# 2) 启动
node server.js

# 3) 验证
curl http://127.0.0.1:8787/health
```

看到一段 JSON（在线房间数、连接数、运行时长、版本）就成功了。

> **前置条件：Node.js 18 或更高。** 本项目不用 `npm install`，没有任何第三方依赖。

---

## 目录说明

| 文件 | 作用 |
|---|---|
| `server.js` | 服务器主程序。**零依赖**，自己实现了 WebSocket 握手与帧解析 |
| `config.example.json` | 配置样例。复制成 `config.json` 再改，**只需写想改的字段**，其余自动继承默认值 |
| `PROTOCOL.md` | **客户端 ⇄ 服务器 协议契约**。自建者改造或对接别的客户端时看这个 |
| `PRINCIPLE.md` | 实现原理与设计取舍（为什么不解码 payload、为什么停机在客户端、容量估算） |
| `ecosystem.config.js` | pm2 配置 |
| `deploy/` | 部署教程与反代配置（见下表） |
| `docker/` | 容器化部署 |
| `logs/` | 运行日志（**不要提交进版本库**，已在 `.gitignore` 里排除） |

### `deploy/` 里有什么

| 文件 | 用途 |
|---|---|
| `部署教程-小白向.md` | **推荐先看这个**。阿里云轻量 ECS + Ubuntu + 宝塔面板 + 域名 + HTTPS，一步步截图级说明 |
| `部署教程-命令行.md` | 不用宝塔的纯命令行版（apt + Node + Caddy + systemd） |
| `Caddyfile` | Caddy 反代配置示例（**自动申请 HTTPS 证书**，最简单） |
| `nginx.conf.example` | Nginx 反代示例（宝塔用户常用，**含 WebSocket 必需的 Upgrade 头**） |
| `ufo-remote.service` | systemd 服务单元 |

---

## ⚠️ 三件必须知道的事

### 1. 公网必须用 HTTPS（`wss://`）

如果用户的网页是 `https://` 打开的，浏览器会**拦截明文 `ws://`**。
所以必须配一层能处理证书的反向代理（Caddy 或 Nginx）。
**这是必需项，不是可选项。**

### 2. 不要把 `8787` 开放到公网

它只应该被本机的反向代理访问。阿里云安全组里**只放行 80 和 443**。

### 3. 被控方的网页必须一直开着

玩具的蓝牙由**被控方浏览器**持有（浏览器安全模型决定的，没有例外）。
被控方关掉页面 = 会话结束 + 安全停机。

---

## 常用操作

```bash
# 看状态
curl http://127.0.0.1:8787/health

# pm2 管理
pm2 start ecosystem.config.js
pm2 logs ufo-remote
pm2 restart ufo-remote
pm2 save && pm2 startup     # 开机自启（startup 打印的那行命令也要执行一次）

# 看日志
ls logs/main/          # 主日志（按大小与日期轮转，默认保留 14 天）
ls logs/error.log      # 错误日志
tail -f logs/main/*.log
```

---

## 配置速查

只列常用字段，完整含义见 `config.example.json` 里的注释。

```jsonc
{
  "server": {
    "port": 8787,          // 监听端口（只需本机可达）
    "path": "/ws",         // WebSocket 端点
    "trustProxy": true,    // 在反代后面必须为 true，否则日志记不到真实 IP
    "maxConnections": 5000
  },
  "room": {
    "maxMembers": 2,       // 一个房间最多几人（当前业务是主控+被控）
    "idleMs": 600000       // 房间空闲 10 分钟回收
  },
  "rateLimit": {
    "enabled": true,
    "maxCreatePerWindow": 10,   // 每 IP 每分钟建房上限
    "maxJoinPerWindow": 10
  },
  "log": {
    "level": "info",       // error | warn | info | debug（debug 会逐条记 relay，日志量很大）
    "ipMode": "full",      // full | masked（masked 把 IP 最后一段变成 x）
    "retainDays": 14
  }
}
```

支持用环境变量覆盖（容器部署方便）：

| 环境变量 | 覆盖的配置 |
|---|---|
| `UFO_CONFIG` | 配置文件路径（默认 `<本目录>/config.json`） |
| `UFO_HOST` | `server.host` |
| `UFO_PORT` | `server.port` |
| `UFO_TRUST_PROXY` | `server.trustProxy` |
| `UFO_MAX_ROOM` | `room.maxMembers` |
| `UFO_LOG_LEVEL` | `log.level` |
| `UFO_LOG_DIR` | `log.dir` |
| `UFO_LOG_IP_MODE` | `log.ipMode`（只接受 `full` / `masked`） |

具体见 `server.js` 的配置加载段。

---

## 能力与边界

**它能做：**
- 8 位数字房间号，服务端生成并查重
- 原样转发，协议升级不需要改服务器
- 只在本机监听 + 强制 wss
- 每 IP 限流、超大消息断开、畸形消息容忍上限
- 分级日志 + 轮转 + 保留期清理，**记录连接事件与 IP 便于追溯**
- `/health` 健康检查（含各类计数器与峰值）

**它不做（有意为之）：**
- 不解析业务内容（连字段名都不看）
- 不记录波形/参数等业务数据
- 不做鉴权（房间号即凭证）
- 不做端到端加密（服务器能看到业务明文，虽然不记录）

这四条取舍的理由写在 `PRINCIPLE.md` 第 10 节。

---

## 相关文档

- 部署操作 → `deploy/部署教程-小白向.md`（推荐）或 `deploy/部署教程-命令行.md`
- 协议字段 → `PROTOCOL.md`
- 设计原理 → `PRINCIPLE.md`
- 客户端实现 → 仓库 `WaveControler/js/protocol.js`、`link.js`、`session.js`
- 免服务器的集成自测 → 仓库 `WaveControler/tests/remote-selftest.html`
