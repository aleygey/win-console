/**
 * exp capability — the 经验库 (playbook). Its backend runs on the VM
 * (opencode-plugin-playbook serving a Hono API, default :53550, permissive
 * CORS), so unlike the other capabilities the daemon does NOT proxy its traffic:
 * the exp panel talks to the VM directly. What lives here is just the ONE thing
 * that needs central management — the backend URL — expressed as this
 * capability's config.
 *
 * Flow: console edits exp.playbookUrl → persisted in daemon config → every
 * front-end reads it from /capabilities at open time and points its ExpClient at
 * the VM. That keeps the single management point (the console) without dragging
 * the exp backend's PUT/PATCH/DELETE/204 semantics through a proxy.
 */
import type { Capability } from "../../contracts"

export const expCapability: Capability = {
  id: "exp",
  title: "经验库",
  icon: "📚",
  description: "playbook 经验库前端;后端在 VM 上(独立 Hono 服务,前端直连)。",
  hasPanel: true,
  configSchema: {
    fields: [
      {
        key: "playbookUrl",
        label: "playbook 后端地址",
        type: "string",
        default: process.env.EXP_API || "http://localhost:53550",
        placeholder: "http://192.168.56.10:53550",
        help: "VM 上 `bun scripts/serve.ts` 的地址(EXP_PORT 默认 53550)。前端直连,需 VM 可达。",
      },
    ],
  },
}
