# super-work-host

把原来的 **win-console 桌面 App** 拆成「**一个常驻 daemon + 多个瘦前端**」。日常用 **Obsidian** 当统一入口,原生能力(Outlook / 通知 / 全局热键 / 托盘)留在后台 daemon 里,**不依赖 Obsidian 开不开**;Electron 控制台降级为**管理端**(配置 / 能力开关 / 健康)。新增插件 = 写一个 Capability,自动出现在三处:agent 工具、前端面板、控制台配置。

```
                        ┌──────────────────────────────────────┐
                        │  win-host daemon (Electron·托盘常驻)    │
                        │   capabilities/*  →  注册一次,三处出现   │
   opencode serve ◄─────┤   /mcp     agent 自动发现工具           │
   (agent 在 VM)        │   /cap/*   UI 调用                      │
                        │   /events  SSE(新邮件/热键唤起)         │
                        │   /config  单一配置源                   │
                        │   全局热键 + spotlight + 控制台窗口       │
                        └──────────────────────────────────────┘
                            ▲                 ▲                ▲
              HTTP/SSE      │                 │                │
        ┌───────────────────┘                 │                └──────────────┐
   ┌────┴──────────────┐         ┌────────────┴────────┐        ┌────────────┴───────┐
   │  Obsidian 插件     │         │  Electron 控制台      │        │  spotlight 浮窗      │
   │  日常统一入口        │         │  管理端(配置/开关)     │        │  热键兜底(无 Obsidian)│
   │  panels→ItemView   │         │  panels + 管理面板     │        │  仅 chat 面板         │
   └───────────────────┘         └─────────────────────┘        └────────────────────┘
```

## 目录

```
src/
  contracts/        唯一的“缝”:Capability / NativeHost / WinHostClient / 事件 / 配置(零依赖)
  host/             daemon
    index.ts        Electron 入口:托盘 + 热键策略 + spotlight/控制台窗口 + 起服务
    server.ts       HTTP + SSE + MCP(纯 node,smoke 可测)
    registry.ts     能力注册表:聚合 tools(MCP)/routes(HTTP)/configSchema
    config.ts       单一配置源(注入文件路径,不 import electron)
    events.ts       事件总线 → SSE
    mcp.ts          MCP over Streamable HTTP(工具来自 registry)
    chat.ts         opencode SDK(多 session)
    capabilities/   chat · mailflow · notify · clipboard · exp  ← 加内建能力就丢这里
    native/         outlook(COM)· notify · clipboard · icon · index(真 NativeHost)
    shell/          tray · hotkey · windows · obsidian(检测/前置)
    preload/        console · spotlight(只注入 daemon 自身 URL)
  panels/           共享 SolidJS 面板(沿用 registry.ts 契约)
    bridge.ts       api:WinHostClient(替代原 IPC preload)
    host-client.ts  HTTP/SSE 客户端
    panels/{chat,outlook,notify,exp}/   原样接入
  console-ui/       管理端 renderer(含 manage 面板:configSchema → 表单)
  spotlight-ui/     热键浮窗 renderer(仅 chat)
  obsidian-plugin/  manifest + main.ts + view.tsx(ItemView 挂 panels)
```

## 跑起来

```sh
npm install
npm run smoke         # 无 electron / 无 opencode,验证 daemon 全部 HTTP 接缝(已通过)
npm run typecheck     # host / web / obsidian 三套 tsconfig(均通过)
npm run build:all     # 产出 out/host out/console out/spotlight out/obsidian
npm start             # 构建 + 启动 daemon(托盘常驻,无主窗口)
```

### 连 opencode(对话面板需要)

在 Linux VM 上:

```sh
opencode serve --hostname 0.0.0.0 --port 4096
```

在控制台「管理 · 全局设置」里把 `opencode serve 地址` 指向 VM 的 IP(或环境变量 `OPENCODE_URL`)。

### 让 agent 用上 outlook / notify(纯 MCP,推荐)

把 `opencode.example.jsonc` 的 `mcp` 块合进你工程的 `opencode.jsonc`,`url` 指向 Windows 宿主机 IP 的 `:8799/mcp`。以后**加工具只改 daemon**,opencode 永不动。

### 经验库(exp · playbook)

后端是独立服务,**跑在 VM 上**(`opencode-plugin-playbook`,Hono API,已开放 CORS):

```sh
# 在 VM 上(库目录里)
EXP_PORT=53550 bun scripts/serve.ts        # 或 EXP_WORKTREE=/path 指定另一个库
```

前端(exp 面板)是 super-work-host 共享面板的一员,**直连**这个后端——不经 daemon 代理(避免把后端的 PUT/PATCH/DELETE/204 语义穿过来)。但后端地址**只在一处配置**:控制台「管理」里的 `exp · playbook 后端地址`(即 exp 能力的 `playbookUrl`)。各前端开面板时从 daemon 的 `/capabilities` 读这个地址,再直连 VM。Obsidian 设置里那个「经验库地址」留空即跟随 host;只想本 vault 用别的才填。

> 即:exp 是一个**只有配置、没有路由/工具**的 Capability。它把「该连哪个后端」这件事纳入统一管理,同时让后端保持在 VM 上独立演进。

### 装进 Obsidian

把 `out/obsidian/` 整个目录拷进 vault 的 `.obsidian/plugins/winhost-console/`,在 Obsidian 设置里启用。插件设置里填 `win-host 地址`(默认 `http://127.0.0.1:8799`)。

## 加一个新插件(Capability)

1. 在 `src/host/capabilities/` 写一个模块,导出 `Capability`:可选 `tools`(给 agent)、`routes`(给 UI)、`configSchema`(给控制台,自动生成表单)、`init/dispose`、`emit` 事件。
2. 在 `src/host/capabilities/index.ts` 的 `builtinCapabilities` 里 import 一行。
3. 想要 UI:在 `src/panels/panels/<id>/` 写一个 SolidJS 面板,`registerPanel({ id, ... })`,并在各前端 entry import 一行;`hasPanel: true` 让控制台知道它有面板。

参考 `capabilities/mailflow.ts`——它一个文件里同时演示了 route + tool + configSchema + 事件轮询。

## 外部插件平台(运行时注册,不重编宿主)

上面是**内建**能力(编译进 daemon)。还有一条**外部插件**路径:任意进程(尤其是 opencode 插件)`POST /capabilities/register` 自报 manifest,就能在控制台出现 —— 管理页配置表单、侧栏 iframe 面板、agent 的 `/mcp` 工具(代理到插件),**daemon 一行不改**;插件停掉自动消失。

- 协议 + 安全模型 + **如何把真实的 `opencode-plugin-serial` 接进来**:见 **[docs/plugin-platform.md](docs/plugin-platform.md)**。
- 可直接 `node plugin.mjs` 跑的串口样板(也是写真实插件的模板):见 **[examples/serial-plugin/](examples/serial-plugin/)**。

## 无 GPU / 公司内网工位

exe 在没有独显的机器(工位 / RDP / VDI)上,Electron 默认开硬件加速会**白屏**(而 `curl 8799` 正常)。本 daemon **默认关闭硬件加速 + 绕过本机回环代理**,无 GPU 也走软件渲染。开关:`WINHOST_GPU=1` 恢复硬件加速;`WINHOST_DEVTOOLS=1` 自动开 DevTools;渲染异常会写 `%APPDATA%\opencode Win Host\winhost-renderer.log`,且空白窗口会把错误画到页面上自曝。

## 热键策略(已选)

daemon 独占全局热键(默认 `Ctrl+Space`):
- **Obsidian 在跑** → 用 `WScript.Shell.AppActivate` 前置它 + 发 `summon:chat` 事件(插件打开对话面板)。
- **没跑** → 弹无边框 spotlight 浮窗(失焦自动消失,Esc 关闭)。

## 验证状态

| 项 | 状态 |
|---|---|
| daemon 全部 HTTP/SSE/MCP 接缝(smoke,5 能力) | ✅ 本机实跑通过 |
| exp 面板 + client 与官方 opencode-exp-console | ✅ 逐字节一致;playbookUrl 走 daemon 配置 |
| 三套 typecheck(host/web/obsidian) | ✅ 通过 |
| 四个构建产物(host/console/spotlight/obsidian) | ✅ 通过;obsidian main.js 为标准 CJS `module.exports=Plugin` |
| Electron 窗口 / 托盘 / 全局热键 / spotlight | ⏳ 需带屏幕的机器 `npm start` 验收 |
| Outlook COM / 原生 toast | ⏳ 需经典版 Outlook + Windows |
| 对话真实往返 | ⏳ 需 `opencode serve` 在跑 |
| Obsidian 加载插件 + 热键前置 | ⏳ 需 Obsidian |

## 相比原 win-console 的变化

- IPC preload bridge → **HTTP/SSE 的 `WinHostClient`**(`panels/bridge.ts`),面板代码几乎不动。
- `mcp.ts` 的 `TOOLS` + `toolserver.ts` 路由 + `native/*` → 合并为 **Capability**,server 不再硬编码任何业务路由。
- 一个 Electron App(日常 chat)→ **一个 daemon + 三个前端**;控制台职责从“日常”翻转为“管理”。
- `win-bridge.ts`(HTTP 插件那条)→ 废弃,统一走 MCP。
