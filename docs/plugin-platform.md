# win-host 插件平台 — 设计

> 目标:让任意 opencode 插件(或任何进程)在 **win 侧**拥有「配置表单 + 面板 + 把工具汇聚给 agent」的能力,而**不用改 / 重编 win-host**。插件起来就出现,停掉就消失。

本文先讲平台本身,再用你真实的 **`opencode-plugin-serial`** 走一遍如何接入,最后给完全插件化的路线图。

---

## 1. 两层能力模型

| | 内建能力(built-in) | 外部插件(external) |
|---|---|---|
| 形态 | 编译进 daemon 的 `Capability` 对象 | 独立进程 + 一份 manifest |
| 加一个 | 写模块 + 改 `capabilities/index.ts` + 重编 | `POST /capabilities/register`,**零改动** |
| 工具 | 直接进 `/mcp` | 进 `/mcp`(调用代理回插件 HTTP) |
| 面板 | 打包进 console 的 SolidJS 组件 | iframe 指向插件自己 serve 的页面 |
| 配置 | `configSchema` → 管理页表单 | 同左(manifest 里带 `configSchema`) |
| 隔离 | 同进程 | 进程隔离 + iframe 跨源隔离 |

平台的本质:**daemon 退化成「注册中心 + 配置表单生成器 + iframe 宿主 + MCP 代理 + 原生桥」**。插件不往 daemon 进程里塞代码。

---

## 2. 协议(全是 HTTP)

### Manifest

```jsonc
{
  "id": "serial",                 // 唯一,不能撞内建(chat/mailflow/notify/clipboard/exp)
  "title": "串口",
  "icon": "plug",                 // 内置图标名(小写短横线)
  "apiBaseUrl": "http://127.0.0.1:PORT",  // 你的 HTTP 服务;/cap/<id>/* 反代到这,工具调 POST {base}/tools/<name>
  "panel":  { "url": "http://127.0.0.1:PORT/monitor" }, // iframe 面板
  "configSchema": { "fields": [ /* → 管理页自动生成表单 */ ] },
  "tools":  [ { "name": "...", "description": "...", "inputSchema": {…} } ],
  "events": ["serial:opened"],    // 你会 emit 的事件类型(SSE 给前端)
  "ttlSeconds": 60                // 超时未心跳就被摘除
}
```

### Daemon 端点

| 方法 路径 | 作用 |
|---|---|
| `POST /capabilities/register` | 提交 manifest → `{ ok, token, config, enabled }` |
| `POST /capabilities/heartbeat` | `{ id, token }` → `{ ok, config, enabled }`(配置随心跳下发) |
| `POST /capabilities/unregister` | `{ id, token }`(**必须带 token**) |
| `POST /capabilities/event` | `{ id, token, type, payload }` → 推上事件总线(host 命名为 `<id>:<type>`) |
| `POST /cap/<id>/<path>` | 反代到 `apiBaseUrl/<path>` |
| `POST /cap/notify/test` | **原生桥**:弹 Windows 通知 |

### 插件端要实现

| 方法 路径 | 作用 |
|---|---|
| `GET /`(= `panel.url`) | 你的面板页 |
| `POST /tools/<name>` | host 代理的工具调用,body `{ arguments }`,返回 `{ text, isError? }` |

### 生命周期

```
插件启动 → register(拿 token) → 每 N 秒 heartbeat(顺便拉最新配置)
        → 用户在管理页改配置 → 下次 heartbeat 收到 → 自行应用
        → 退出 → unregister(或心跳超时被自动摘除)
host 重启 → 心跳 404 → SDK 自动重新 register → 面板再次出现
```

SDK:`examples/serial-plugin/winhost-plugin.mjs`(`start / stop / emit / notify`,~70 行)。

---

## 3. 安全模型

daemon 绑全网卡(WSL 的 agent 要用局域网 IP 连 `/mcp`),所以外部接口做了:

- **回环校验**:`apiBaseUrl` / `panel.url` 必须 http(s) 指向 `127.0.0.1`/`localhost` —— 否则 daemon 会变成打内网/元数据的 SSRF 代理。**这条直接影响拓扑选择(见 §4)**。
- **id 抢占防护**:同 id 重复注册必须同 `apiBaseUrl`(幂等续约,沿用 token),不同则拒绝。
- **token 化**:注销 / 推事件需正确 token(常数时间比较)。
- **工具名冲突**:不能撞内建或别的插件的工具名。
- **代理护栏**:工具/反代有 15s 超时、5MB 上限、不跟随重定向。
- **secret 字段**:`configSchema` 里 `secret:true` 的字段在公开 `/capabilities` 里打码,真值只随(带 token 的)心跳回给插件本身。
- **可选共享 token**:daemon 带 `WIN_HOST_PLUGIN_TOKEN` 启动后,`/capabilities/*` 全需 `x-winhost-token` 头(**公司内网工位建议开**)。

---

## 4. 把 `opencode-plugin-serial` 接进来

你的串口插件现状(读 src 得到):

- `export default { id:"serial", server }`,通过 opencode 的 `tool` hook 注册 `serial_*` 工具;
- 自托管 `/serial` REST + WebSocket(Hono + `Bun.serve`,端口写进 `api.json` 供发现);
- TUI 监视器是**单独模块**(`tui.json` 加载),终端里跑。

它**已经有自己的 HTTP/WS 服务**了 —— 接入 win-host 只是再加薄薄一层。但先要选对拓扑,因为**串口设备(COM 口)在 Windows 侧**:

### 拓扑(关键)

| 拓扑 | 串口 | 工具怎么到 agent | win-host 角色 |
|---|---|---|---|
| **A. 插件在 WSL** | 只能开 Linux 口 `/dev/ttyUSB*` | opencode 直接给(`tool` hook) | 仅面板+配置;但插件 HTTP 在 WSL IP,**过不了回环校验**(见下) |
| **B. 插件在 Windows**(推荐,要开 COM) | 能开 `COMx` | 插件不在 WSL opencode 里 → 用 win-host `/mcp` 代理 | 面板 + 配置 + **工具汇聚** |
| **C. opencode 也在 Windows** | 能开 `COMx` | opencode 直接给 | 面板 + 配置 |

> 你现在 opencode 跑在 WSL,要开 Windows 的 COM 口 → **走 B**:把串口插件作为一个 **Windows 进程**单独跑(它本就能 `node` 起),注册到 win-host;agent 的串口工具经 win-host `/mcp` 拿。

### B 拓扑要补的三小块(都很小,复用已有的 `/serial` 服务)

1. **注册**:服务 bind 后(从 `api.json` 读到端口),用 SDK 注册:
   ```js
   import { createWinhostPlugin } from "winhost-plugin.mjs"
   const api = JSON.parse(fs.readFileSync(apiJsonPath))   // { url, port }
   const plugin = createWinhostPlugin({
     host: "http://127.0.0.1:8799",
     token: process.env.WIN_HOST_PLUGIN_TOKEN,
     manifest: {
       id: "serial", title: "串口", icon: "plug",
       apiBaseUrl: api.url,                       // 你的 Hono 服务(127.0.0.1 → 过回环校验)
       panel: { url: api.url + "/monitor" },      // 见 (2)
       configSchema: { fields: [
         { key: "defaultPort", label: "默认串口", type: "string", default: "COM3" },
         { key: "baud", label: "波特率", type: "select", options: ["9600","115200"], default: "115200" },
       ] },
       tools: SERIAL_TOOL_DEFS,                   // 见 (3)
       events: ["serial:line", "serial:opened"],
     },
     onConfig: (cfg) => Serial.applyDefaults(cfg),// 管理页改了配置 → 这里应用
   })
   await plugin.start({ heartbeatMs: 5000 })
   ```

2. **面板页 `/monitor`**:在 Hono app 上加一个静态 HTML 路由,页面连你**已有的** `/serial/:id/connect` WebSocket 渲染收发(ring-buffer replay 都现成)。等于把 TUI 监视器搬成一张网页 —— win-host 用 iframe 嵌进侧栏。

3. **工具 HTTP 化 `POST /tools/<name>`**:你的 `serial_*` 现在是 opencode `tool` hook;给 win-host 代理,加一组瘦 HTTP 端点,内部调同一个 `Serial` service:
   ```js
   app.post("/tools/serial_write", async (c) => {
     const { arguments: a } = await c.req.json()
     await Serial.write(a.id, a.data)
     return c.json({ text: `已写入 ${a.id}` })
   })
   // serial_list / serial_open / serial_read … 同理,薄包一层 service
   ```
   `SERIAL_TOOL_DEFS` 就是这些工具的 `{name,description,inputSchema}`(可由 `tools.ts` 复用)。

做完后:win 控制台侧栏出现「串口」面板(实时收发)、管理页有串口配置、**WSL 里的 agent 通过 win-host `/mcp` 拿到 `serial_*`**。设备租约 / 去噪 / 共享 session 这些插件本身的能力完全不动。

### 关于 A 拓扑(插件留在 WSL)

如果串口在 Linux 侧(`/dev/ttyUSB`),工具本就经 opencode 到 agent,只缺一个 win 面板。但插件的 HTTP 服务在 **WSL IP**(如 `172.x`),当前回环校验会**拒绝**这种 `apiBaseUrl`。两条出路(任选,属平台演进):
- 放宽回环校验:允许 daemon 已知的 WSL 子网(配置项);或
- 在 Windows 侧起一个一行的反代,把 `127.0.0.1:xxxx` 转发到 WSL 服务,用这个回环地址去注册。

---

## 5. 路线图:完全插件化

- **Tier-1(已实现)**:外部 manifest + iframe 面板 + 代理工具 + 原生桥。覆盖 90% 需求,默认走这条。
- **Tier-2(可选,给可信第一方)**:daemon 在启动时 `import()` 一个插件目录里的 JS,拿到完整 `Capability`(真 tool handler + 直接用 `ctx.native`)。更强,但代码进宿主进程、隔离更弱 —— 仅限你信任的插件。
- **内建迁移**:`mailflow` / `notify` / `exp` 都可逐步改写成「按同一协议注册」的形式,把 daemon 收敛成纯平台(`exp` 已经接近 —— 它本就是个只有配置、面板走 iframe 的能力)。`chat` 因深度依赖 opencode SDK,建议保留内建。

衡量标准:**接一个新插件 = 启动时 POST 一个 manifest,host 一行不改**。串口插件就是第一个按这个标准接入的真实样例。
