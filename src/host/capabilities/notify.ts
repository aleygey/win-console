/**
 * notify capability — pop a native desktop toast. Used two ways from one
 * definition: the panel calls the route, the agent calls the tool.
 *
 *   route   POST /cap/notify/test   (the panel)
 *   tool    notify_desktop          (the agent pings you from the VM)
 */
import type { Capability, NotifyLevel, NotifyReq } from "../../contracts"

export const notifyCapability: Capability = {
  id: "notify",
  title: "通知",
  icon: "🔔",
  description: "原生桌面 toast。agent 也能通过工具触发。",
  hasPanel: true,

  routes: [
    {
      method: "POST",
      path: "/test",
      handler: async (req, ctx) => ({ body: await ctx.native.showToast((req.body ?? {}) as NotifyReq) }),
    },
  ],

  tools: [
    {
      name: "notify_desktop",
      description:
        "Pop a native desktop toast on the user's Windows host. PROACTIVELY call this WHENEVER you " +
        "finish a long-running task (a build, a multi-step change, anything that took more than ~30s) " +
        "OR hit a point that needs the human (a decision, a blocker, a permission). The user often runs " +
        "opencode in a VM / on another screen and is NOT watching this terminal, so they only learn a " +
        "task is done if you toast them. Default to notifying on completion of substantial work. " +
        "Best-effort, non-blocking.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short bold headline, scannable at a glance." },
          message: { type: "string", description: "One-line body with the actionable detail." },
          level: { type: "string", enum: ["info", "warn", "error"], description: 'Severity, default "info".' },
        },
        required: ["title", "message"],
      },
      handler: async (args, ctx) => {
        const r = await ctx.native.showToast({
          title: String(args?.title ?? ""),
          message: String(args?.message ?? ""),
          level: args?.level as NotifyLevel | undefined,
        })
        return r.ok ? { text: `已通知:「${args?.title}」` } : { text: `通知失败:${r.error}`, isError: true }
      },
    },
  ],
}
