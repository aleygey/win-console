# win-host 外部插件协议 · 串口示例

让**任意 opencode 插件**(或任何独立进程)接入 win-host,**无需重新编译 host**。
插件起来 → win 控制台侧栏出现它的面板、「管理」里出现它的配置表单、agent 的 `/mcp` 里出现它的工具;插件停掉 → 自动消失。

本目录是一个可直接运行的**串口监视器**示例,也是你写真实串口插件的模板。

---

## 跑起来

1. 先启动 win-host(任选其一):
   - 完整版:双击 `opencode-win-host-portable.exe`
   - 轻量 daemon:`node D:\wsl-tmp\preview-server.mjs`(或仓库里的 preview-server)
   - 确认 `http://127.0.0.1:8799/health` 返回 `{"ok":true}`
2. 启动示例插件:
   ```bash
   node plugin.mjs
   ```
   看到 `✓ registered with http://127.0.0.1:8799` 即成功。
3. 打开 win 控制台:
   - 侧栏多出 **「串口」**(plug 图标)→ 点开是一个串口监视器(发送收到 `ACK`,每 4 秒一条 `tick`)。
   - **「管理」→ 串口** 出现配置表单(串口号 / 波特率 / 自动打开);改波特率,插件约 5 秒内(下次心跳拉到新配置)重开端口。
   - agent 端 `/mcp` 多出 `serial_send`、`serial_status` 两个工具,调用会被代理到本插件。
4. `Ctrl+C` 停止插件 → 侧栏的「串口」几秒内消失(心跳超时自动摘除)。

> host 重启了也不怕:插件心跳 404 会自动重新注册,面板会再次出现。

---

## 协议(全部是 HTTP,host 一行不改)

插件把一份 **manifest** POST 给 host 即可。核心字段:

| 字段 | 作用 |
|---|---|
| `id` / `title` / `icon` | 唯一 id、侧栏标题、图标名。`icon` 必须是 host 内置图标名(小写短横线,如 `plug` / `cpu` / `radio` / `terminal` / `activity`),非内置名会退化成默认图标 |
| `apiBaseUrl` | 你自己的 HTTP 服务地址。`/cap/<id>/*` 反代到这里;工具调用 POST 到 `apiBaseUrl/tools/<name>` |
| `panel.url` | 你自己 serve 的页面 → host 用 iframe 嵌进侧栏(完全 CSS 隔离,随便用什么框架) |
| `configSchema` | 声明配置项 → 「管理」自动渲染表单,host 持久化,通过心跳回传给你 |
| `tools[]` | agent 能看到的 MCP 工具(name/description/inputSchema),调用代理到你的 `/tools/<name>` |
| `ttlSeconds` | 心跳窗口,超时未心跳就被摘除(默认 60s) |

### host 端点

| 方法+路径 | 说明 |
|---|---|
| `POST /capabilities/register` | body=manifest;返回 `{ ok, token, config, enabled }`。**apiBaseUrl / panel.url 必须是本机回环**(127.0.0.1/localhost),否则拒绝(防 SSRF) |
| `POST /capabilities/heartbeat` | body=`{ id, token }`;返回 `{ ok, config, enabled }`(配置随心跳下发,**延迟 = 心跳间隔**) |
| `POST /capabilities/unregister` | body=`{ id, token }`(**必须带 token**);退出时调用 |
| `POST /capabilities/event` | body=`{ id, token, type, payload }`;把结构化事件推上 host 总线(SSE 给控制台),host 命名为 `<id>:<type>` |
| `POST /cap/<id>/<path>` | 反代到你的 `apiBaseUrl/<path>`(面板用它读写后端;仅 GET/POST,不转发自定义头) |
| `POST /cap/notify/test` | **原生桥**:弹 Windows 桌面通知(`{title,message,level}`) |

> 若 daemon 带 `WIN_HOST_PLUGIN_TOKEN` 启动,以上 `/capabilities/*` 都需带 `x-winhost-token` 头(SDK 的 `token` 参数或同名环境变量自动带上)。
> 同一 `id` 重复注册:**apiBaseUrl 相同** = 幂等续约(沿用原 token);**不同** = 拒绝(防 id 抢占)。

### 你(插件)要实现的端点

| 方法+路径 | 说明 |
|---|---|
| `GET /`(= `panel.url`) | 你的面板页面 |
| `POST /tools/<name>` | host 代理的工具调用,body=`{ arguments }`,返回 `{ text, isError? }` |
| 任意其它路径 | 面板通过 `/cap/<id>/*` 反代访问,或同源直接访问 |

接入只需 `winhost-plugin.mjs` 这个小工具:
```js
import { createWinhostPlugin } from "./winhost-plugin.mjs"
const plugin = createWinhostPlugin({
  host: "http://127.0.0.1:8799",
  manifest,                              // 上面那份
  token: process.env.WIN_HOST_PLUGIN_TOKEN, // 若 host 开了鉴权;否则可省
  onConfig: (cfg, enabled) => { /* 用户在「管理」改了配置,这里收到 */ },
})
await plugin.start({ heartbeatMs: 5000 }) // 注册 + 自动心跳(心跳间隔 = 配置下发延迟)
// 退出时 await plugin.stop()
// 弹桌面通知:    await plugin.notify("标题", "内容")
// 推结构化事件:  await plugin.emit("opened", { port: "COM3" })   // → host 事件 "serial:opened"
```

**面板怎么和后端通信**:面板页是你自己 serve 的(同源),直接 `fetch("/your-route")` 访问你自己的后端最省事(demo 就是这么做的)。需要用 host 能力(通知等)时,用面板 URL 里带的 `?host=` 参数去调 `/cap/notify/test`——但更推荐让你的**后端**去调 host,面板只跟自己后端打交道。

---

## 改成真实串口插件

把 `plugin.mjs` 里 `openPort()` / `writeSerial()` 的 mock 段换成 [serialport](https://serialport.io/):

```bash
npm i serialport
```
```js
import { SerialPort } from "serialport"
let port
function openPort() {
  port = new SerialPort({ path: cfg.port, baudRate: Number(cfg.baud) })
  port.on("data", (d) => pushLine("rx", d.toString()))
  opened = true
}
function writeSerial(data) { pushLine("tx", data); port.write(data + "\n") }
function closePort() { port?.close(); opened = false }
```
manifest / 面板 / 工具 / 注册逻辑**完全不用动**。

> 串口设备在 **Windows** 侧(COM 口)。如果 opencode 跑在 WSL,WSL 直接访问 COM 口很麻烦——所以让这个插件作为一个 **Windows 进程**运行最省事:它能直接开 COM 口,win-host 负责把它的工具/面板/配置聚合给 agent 和控制台。

---

## 安全

daemon 绑全网卡(WSL 里的 agent 要用局域网 IP 访问 `/mcp`),所以外部插件接口做了这些加固:

- **回环校验**:`apiBaseUrl` / `panel.url` 必须是 http(s) 且指向 `127.0.0.1`/`localhost`,否则注册被拒——防止 daemon 被人当成 SSRF 代理去打内网/元数据地址,也防止 iframe 加载外站页面。
- **可选共享 token**:daemon 带 `WIN_HOST_PLUGIN_TOKEN=xxx` 启动后,`/capabilities/*` 全部需要 `x-winhost-token` 头。**在公司内网工位强烈建议开**(否则同网段任何机器都能注册能力)。
- **id 抢占防护**:重复注册同 id 必须同 `apiBaseUrl`(幂等),否则拒绝;注销必须带正确 token(常数时间比较)。
- **代理限制**:工具/反代调用有超时(15s)、响应大小上限(5MB)、不跟随重定向。
- **iframe 沙箱**:`sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`,禁顶层导航等。
- **secret 字段**:`configSchema` 里 `secret:true` 的字段在公开的 `/capabilities` 列表里会被打码(`••••••`),真实值只通过(带 token 的)心跳回给插件本身;管理页用密码框渲染。**注意:落盘仍是明文**(`config.json`),别放高敏密钥。
- 外部能力配置存在 host 的 `config.capabilities[<id>]`,和内建能力同一套持久化;`id` 不能和内建能力(chat/mailflow/notify/clipboard/exp)冲突。

仍待办(非 demo 必需):反代不转发自定义头/只支持 GET·POST;配置下发是心跳轮询(非即时推送);超大/流式工具输出需走事件通道而非单次响应。
