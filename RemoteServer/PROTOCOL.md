# 远程中继协议（客户端 ⇄ 服务器）

> 这是**服务器与客户端之间**的契约。自建服务器的人只需要看这一份文件。
> 客户端实现见 `WaveControler/js/protocol.js`（`R.T` 常量）与 `WaveControler/js/link.js`。

---

## 0. 一句话

服务器是**房间式中继**：两端凭同一个 8 位房间号见面，服务器**原样转发**它们之间的消息。

**服务器不解析业务内容。** 业务消息（波形、强度、相位、启停）被包在 `relay.payload` 里，
服务器只当它是一个不透明的对象，连字段名都不看。

---

## 1. 端点

| 项 | 值 |
|---|---|
| WebSocket 路径 | `/ws`（可用配置 `server.path` 修改） |
| 健康检查 | `GET /health`（可用配置 `server.healthPath` 修改） |
| 默认端口 | `8787`（**只应被反向代理本机访问，不要直接暴露到公网**） |
| 传输 | 公网**必须** `wss://`。页面是 `https://` 时浏览器会拦明文 `ws://` |
| 子协议 | 无（不使用 WebSocket subprotocol） |
| 消息格式 | 每条消息是一个 **JSON 文本帧** |

---

## 2. 消息总览

### 客户端 → 服务器

| `t` | 附加字段 | 说明 |
|---|---|---|
| `create` | — | 创建房间。服务器生成 8 位房间号 |
| `join` | `room` (string) | 加入已存在的房间 |
| `leave` | — | 主动离开房间（房间会保留直到空闲回收） |
| `relay` | `payload` (object) | **原样转发**给房间内其他成员 |
| `ping` | `c` (number) | 测延迟。服务器会把 `c` **原样带回** |

### 服务器 → 客户端

| `t` | 字段 | 说明 |
|---|---|---|
| `created` | `room`, `role`, `peerId`, `s`, `members`, `maxMembers` | 建房成功 |
| `joined` | `room`, `role`, `peerId`, `s`, `members`, `maxMembers` | 入房成功 |
| `peer` | `event`, `peerId`, `role`, `members`, `maxMembers`, `s` | 有成员加入 / 离开 |
| `relay` | `payload`, `s`, `from` | 转发过来的业务消息 |
| `pong` | `s`, `c` | 对 `ping` 的回应（`c` 原样带回） |
| `error` | `code`, `s` | 出错 |

> **`s` 是服务器自己的毫秒时间戳**，每次发送都会重新取。客户端用它估算「本端 ↔ 服务器」延迟。
> **`peerId`** 是服务器分配的短标识（不是设备 ID、不是蓝牙地址），仅用于区分房间成员。

---

## 3. 逐条说明

### 3.1 `create` —— 创建房间

```jsonc
// 客户端发送
{ "t": "create" }

// 服务器返回
{
  "t": "created",
  "room": "48192037",        // 8 位数字，10000000 ~ 99999999
  "role": "slave",           // 建房者固定是 slave（被控方）
  "peerId": "a91f3c2e",
  "members": 1,
  "maxMembers": 2,
  "s": 1737000000000
}
```

房间号由服务器生成并**查重**（最多重试 64 次）。它**与设备 ID、蓝牙地址无关**，不可反推。

### 3.2 `join` —— 加入房间

```jsonc
// 客户端发送
{ "t": "join", "room": "48192037" }

// 服务器返回
{
  "t": "joined",
  "room": "48192037",
  "role": "master",          // 加入者固定是 master（主控方）
  "peerId": "77bd0e51",
  "members": 2,
  "maxMembers": 2,
  "s": 1737000000001
}
```

加入成功后，服务器会向房间里**其他成员**推送一条 `peer`：

```jsonc
{ "t": "peer", "event": "joined", "peerId": "77bd0e51", "role": "master",
  "members": 2, "maxMembers": 2, "s": 1737000000001 }
```

### 3.3 `leave` / 断开 —— 成员离开

客户端主动发 `leave`，或 WebSocket 断开时，服务器向房间内其他成员推送：

```jsonc
{ "t": "peer", "event": "left", "peerId": "77bd0e51", "role": "master",
  "members": 1, "maxMembers": 2, "s": 1737000000010 }
```

> ⚠️ **这条消息对被控端是安全关键**：被控端收到 `event: "left"` 会**立即安全停机**。
> 服务器不需要知道这件事，它只负责如实通知。

### 3.4 `relay` —— 业务消息转发

```jsonc
// 客户端发送（payload 是业务消息，服务器不看它的内容）
{
  "t": "relay",
  "payload": {
    "t": "state",              // ← 业务层的东西，服务器不关心
    "rev": 12,
    "channels": { "...": "..." },
    "waves": { "...": "..." }
  }
}

// 服务器转发给房间内其他成员（只额外补一个 s）
{
  "t": "relay",
  "from": "77bd0e51",
  "payload": { "t": "state", "rev": 12, "...": "..." },   // ← 逐字不变
  "s": 1737000000002
}
```

**服务器的三条保证：**
1. `payload` **逐字不变**（不解析、不裁剪、不重排字段）
2. 只额外添加 `s`（服务器时间戳）与 `from`（发送者 peerId）
3. 发给房间内**除发送者外的所有成员**（当前上限 2 人，所以就是"对端"）

#### 业务消息类型一览（`payload.t`，服务器完全不解析）

| `t` | 方向 | 含义 |
|---|---|---|
| `hello` | 双向 | 握手，交换版本与角色 |
| `state` | 主控 → 被控 | 期望状态（含波形），带 `rev` 与 `digest` |
| `ack` | 被控 → 主控 | 确认 `seq`/`digest`，并捎带被控的蓝牙状态、实际输出、时钟读数、`rtt` |
| `ka` | 主控 → 被控 | 保活（无状态变化时每 2 秒一次） |
| `stop` | 双向 | 急停请求：**执行并进入锁定**，主控无法解除，只有被控方能解锁 |
| `bye` | 主控 → 被控 | 主控主动告别（退出远程 / 关闭页面）：被控**立即安全停机**，不锁定 |
| `resume` | 被控 → 主控 | 被控**解除了急停锁定**：主控据此同步解除自己的锁定，通道复选框恢复可勾 |

> `resume` 是"急停必须由被控方解除"这条安全设计的必要配套。
> 主控**无法自行**解除急停锁定，所以被控点了解锁后必须明确告知主控；
> 没有它的话，被控这边解锁了，主控界面上的通道复选框却一直是灰的、点不动。
> 该消息会重发几次直到主控回一条带 `ackResume: true` 的 `ack` 为止（非状态同步，不参与 `digest`）。

> `bye` 与 §3.3 的服务器层 `leave` 互补，但层次不同、用途不同：
> `leave` 只在 **WebSocket 模式**下由服务器在检测到断连后补发；
> `bye` 是**业务层主动发送**的，因此在 `BroadcastChannel`（本地调试）下同样有效 ——
> 没有它的话，主控关掉标签页时被控只能等心跳超时（8 秒）才停机，设备会多跑好几秒。

**分片**：客户端会把超过 8KB 的业务消息切成多片，每片都是一个独立的 `relay`。
服务器**不知道也不关心**分片的存在 —— 它只是转发更多条 `relay` 而已。

### 3.5 `ping` —— 延迟测量

```jsonc
// 客户端发送
{ "t": "ping", "c": 812345.6 }        // c = 客户端自己的时钟读数

// 服务器返回
{ "t": "pong", "c": 812345.6, "s": 1737000000003 }
```

客户端用 `收到时刻 - c` 算出**往返延迟**。所以 **`c` 必须原样带回**，否则客户端算不出来。

> 客户端每 **2 秒**测一次。两个角色都会测：主控测「主控↔服务器」，
> 被控测「被控↔服务器」，后者会通过业务层的 ACK 回报给主控，用于显示端到端估算。

---

## 4. 错误码

```jsonc
{ "t": "error", "code": "room-not-found", "s": 1737000000004 }
```

| `code` | 含义 | 客户端应怎么做 |
|---|---|---|
| `room-not-found` | 房间不存在（房号错 / 已回收） | 提示用户核对房间号 |
| `room-full` | 房间人数已满（上限 2） | 提示该房间已满 |
| `already-in-room` | 该连接已经在某个房间里 | 先 `leave` 再 `join` |
| `not-in-room` | 发了 `relay` 但不在任何房间 | 内部错误，重连 |
| `bad-room` | `room` 字段格式非法（不是 8 位数字字符串） | 检查输入 |
| `bad-type` | 无法识别的 `t` | 检查协议版本 |
| `too-large` | 单条消息超过上限（默认 64KB） | 改用分片 |
| `rate-limited` | 触发限流（默认每 IP 每分钟 10 次建房/加入） | 稍后重试 |
| `server-busy` | 连接数超过 `server.maxConnections` | 稍后重试 |
| `server-error` | 服务器内部异常 | 重连 |

---

## 5. 健康检查

```bash
curl https://你的域名/health
```

```jsonc
{
  "ok": true,
  "service": "web-ufo-player-remote-relay",
  "version": "1.0.0",
  "protocol": 1,
  "startedAt": "2026-09-17T10:00:00.000Z",
  "uptimeSec": 3600,
  "rooms": 3,
  "connections": 6,
  "maxMembersPerRoom": 2,
  "maxWireBytes": 65536,
  "counters": {
    "msgsIn": 120, "msgsOut": 118, "bytesIn": 15400, "bytesOut": 15200,
    "relays": 90, "pings": 40, "roomsCreated": 5, "roomsReclaimed": 2,
    "badMsgs": 0, "rateLimited": 0, "peakConnections": 8, "peakRooms": 4
  },
  "now": 1737003600000
}
```

---

## 6. 手工测试

### 用浏览器 Console（最省事）

打开任意 `https://` 页面（或本地 `about:blank` 不行，必须是 http/https 页面），按 F12 粘贴：

```js
// 把域名换成你自己的
const ws = new WebSocket('wss://你的域名/ws');
ws.onopen = () => { console.log('已连接'); ws.send(JSON.stringify({ t: 'create' })); };
ws.onmessage = e => console.log('收到:', e.data);
ws.onerror = () => console.log('连接失败');
ws.onclose = e => console.log('关闭', e.code, e.reason);
```

期望看到 `created` 并拿到 8 位房间号。

### 完整双端测试（两个 Console 窗口）

**窗口 A（当被控）**

```js
window.A = new WebSocket('wss://你的域名/ws');
A.onmessage = e => console.log('[A]', e.data);
A.onopen = () => A.send(JSON.stringify({ t: 'create' }));
// 从输出里记下房间号 ROOM
```

**窗口 B（当主控）**

```js
const ROOM = '把上面的房间号填这里';
window.B = new WebSocket('wss://你的域名/ws');
B.onmessage = e => console.log('[B]', e.data);
B.onopen = () => B.send(JSON.stringify({ t: 'join', room: ROOM }));
// 应当看到 joined，且窗口 A 会收到 peer event:"joined"
```

**B 发一条业务消息（应被转发到 A）**

```js
B.send(JSON.stringify({ t: 'relay', payload: { t: 'hello', version: 1, role: 'master' } }));
```

**测延迟**

```js
B.send(JSON.stringify({ t: 'ping', c: performance.now() }));
// 收到 pong 后：performance.now() - pong.c 就是往返延迟
```

**验证房间满**

```js
// 再开一个窗口 C，用同样的 ROOM 去 join → 应收到 {t:'error', code:'room-full'}
```

**验证离开通知**

```js
B.close();   // 窗口 A 应收到 { t:'peer', event:'left', ... }
```

### 用 wscat

```bash
npm i -g wscat
wscat -c wss://你的域名/ws
> {"t":"create"}
```

---

## 7. 限制与约定

| 项 | 默认值 | 配置字段 |
|---|---|---|
| 单房间人数上限 | 2 | `room.maxMembers` |
| 房间空闲回收 | 10 分钟 | `room.idleMs` |
| 单条消息上限 | 64 KB | `limits.maxWireBytes` |
| 畸形消息容忍度 | 20 条后断开 | `limits.maxBadMessages` |
| 单条分片消息片数上限 | 128 | `limits.maxFragments` |
| 空闲连接超时 | 30 秒 | `timeout.idleMs` |
| 建房/加入限流 | 每 IP 每分钟 10 次 | `rateLimit.*` |
| 全局连接上限 | 5000 | `server.maxConnections` |

> 客户端业务心跳是 2 秒一次，所以 30 秒的空闲超时不会误杀正常连接；
> 只有真正死掉的连接才会被清掉。

---

## 8. 将来放开多人

协议**已经为多人预留**：

- 服务器内部用 `members[]` 数组维护成员，转发目标是"房间内除自己外的所有成员"（不是写死的"对端"）
- `peer` 消息带 `members` / `maxMembers`，客户端能感知人数变化
- `role` 字段是开放字符串，将来可以加 `viewer` 等

**放开多人只需要把 `room.maxMembers` 调大**，服务器转发逻辑不用改。
但客户端业务层（`WaveControler/js/protocol.js` 的 `R.LIMITS.MAX_ROOM`）也要同步放开，
否则客户端自己会拒绝。这一点在改之前请先确认客户端已支持。
