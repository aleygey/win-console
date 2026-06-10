/**
 * outlook capability — read the classic Outlook inbox. Shows the full capability
 * surface in one module:
 *
 *   route   POST /cap/outlook/search   (the panel)
 *   tool    outlook_search             (the agent, auto-discovered via /mcp)
 *   config  defaultTop + pollSeconds   (a form in the console, no UI code)
 *   event   outlook:new-mail           (emitted by the optional poller → SSE)
 *
 * Adding the next plugin = copy this shape. Nothing else in the daemon changes.
 */
import type { Capability, OutlookMail, OutlookSearchReq } from "../../contracts"

let pollTimer: ReturnType<typeof setInterval> | undefined
let lastSeen: string | undefined

export const outlookCapability: Capability = {
  id: "outlook",
  title: "邮件",
  icon: "📧",
  description: "经典版 Outlook 收件箱(COM 读取)。仅作为 agent 的 MCP 工具(outlook_search),无前端面板。",
  // No front-end panel — the user views mail in Outlook directly; this capability
  // exists only to give the agent the outlook_search MCP tool. Mail automation
  // lives in the mailflow capability.
  hasPanel: false,
  events: ["outlook:new-mail"],

  configSchema: {
    fields: [
      { key: "defaultTop", label: "默认条数", type: "number", default: 15, help: "面板/工具默认返回多少封。" },
      {
        key: "pollSeconds",
        label: "新邮件轮询间隔(秒)",
        type: "number",
        default: 0,
        help: "0 = 不轮询。>0 时后台轮询,有新邮件就推 outlook:new-mail 事件(前端弹角标)。",
      },
    ],
  },

  routes: [
    {
      method: "POST",
      path: "/search",
      handler: async (req, ctx) => {
        const body = (req.body ?? {}) as OutlookSearchReq
        const top = body.top ?? Number(ctx.config().defaultTop ?? 15)
        return { body: await ctx.native.outlookSearch({ query: body.query, top }) }
      },
    },
  ],

  tools: [
    {
      name: "outlook_search",
      description:
        "Read the user's classic Outlook inbox on their Windows host. Returns recent emails " +
        "(subject, sender, time, unread, a short preview), optionally filtered by a keyword matched " +
        "against subject/sender. Use to summarize mail, find a message, or pull context the user " +
        "refers to. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword to match subject/sender. Empty = latest." },
          top: { type: "integer", minimum: 1, maximum: 50, description: "How many emails to return (default 15)." },
        },
      },
      handler: async (args, ctx) => {
        const r = await ctx.native.outlookSearch({ query: args?.query, top: args?.top })
        if (!r.ok) return { text: `读取 Outlook 失败:${r.error}`, isError: true }
        const tag = r.mock ? "(mock 数据,非 Windows 环境)\n" : ""
        const mails = r.mails ?? []
        return { text: tag + (mails.length ? JSON.stringify(mails, null, 2) : "没有匹配的邮件。") }
      },
    },
  ],

  init(ctx) {
    const seconds = Number(ctx.config().pollSeconds ?? 0)
    if (!Number.isFinite(seconds) || seconds <= 0) return
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(async () => {
      const r = await ctx.native.outlookSearch({ top: 1 })
      const newest = (r.mails ?? [])[0] as OutlookMail | undefined
      if (newest && newest.received !== lastSeen) {
        if (lastSeen !== undefined) ctx.emit("outlook:new-mail", newest)
        lastSeen = newest.received
      }
    }, seconds * 1000)
  },

  dispose() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
  },
}
