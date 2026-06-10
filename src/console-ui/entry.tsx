/** Console renderer entry. Registers every panel (side-effect imports), resolves
 *  the exp backend URL from the daemon, then mounts the management shell. */
import { render } from "solid-js/web"
import App from "./App"
import { createClient } from "../panels/api/client"
import { resolveExpUrl } from "../panels/exp-url"
import "../panels/styles/tokens.css"
import "../panels/styles/app.css"
import "./console.css"

// Side-effect imports: each registers one panel on load.
import "../panels/panels/chat"
// 邮件(收件箱列表)前端已下线 — 用户直接用 Outlook 查看;agent 仍可通过 outlook_search
// MCP 工具读邮件,邮件自动化走「邮件工作流」面板。
import "../panels/panels/mailflow"
import "../panels/panels/notify"
import "../panels/panels/exp"
import "./panels/manage"

async function main(): Promise<void> {
  const root = document.getElementById("root")
  if (!root) throw new Error('Root element "#root" not found')
  const expClient = createClient(await resolveExpUrl())
  render(() => <App expClient={expClient} />, root)
}
void main()
