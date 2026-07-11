/** Console renderer entry. Registers every panel (side-effect imports), resolves
 *  the exp backend URL from the daemon, then mounts the management shell. */
import { render } from "solid-js/web"
import App from "./App"
import { createClient } from "../panels/api/client"
import { resolveExpUrl } from "../panels/exp-url"
import "../panels/styles/tokens.css"
import "../panels/styles/app.css"
import "./console.css"

// Side-effect imports: each registers one panel on load. IMPORT ORDER = rail
// order, and the FIRST import is the default landing panel.
// 对话面板已下线 — Ctrl+Space 快速对话框是唯一输入面;控制台里换成只读的会话监控。
// 通知测试面板已下线 — notify 能力本身保留(mailflow/桌面通知插件/MCP 工具在用)。
// 任务看板面板已下线(v5) — 任务信息合并到 Obsidian Kanban 看板卡片上(fork 插件),
// 会话监控是唯一的会话面;关联/启动经焦点上下文条与看板卡完成。
import "../panels/panels/sessions"
import "../panels/panels/mailflow"
import "../panels/panels/exp"
import "./panels/manage"

async function main(): Promise<void> {
  const root = document.getElementById("root")
  if (!root) throw new Error('Root element "#root" not found')
  const expClient = createClient(await resolveExpUrl())
  render(() => <App expClient={expClient} />, root)
}
void main()
