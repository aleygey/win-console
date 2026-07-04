/**
 * chat capability — the session client's backend door. User-facing only (no MCP
 * tool: the agent doesn't talk to itself). Routes map 1:1 to NativeHost.chat,
 * which wraps the opencode SDK (host/chat.ts):
 *
 *   POST /cap/chat/send     { text, imageDataUrl?, sessionId?, model? } → ChatSendRes
 *   GET  /cap/chat/sessions                                            → ChatSession[]
 *   GET  /cap/chat/history?id=<sessionId>                              → ChatMsg[]
 *   GET  /cap/chat/models                                             → ModelInfo[]
 *   POST /cap/chat/undo     { sessionId }                             → { ok }
 *   POST /cap/chat/delete   { sessionId }                             → { ok }
 *   POST /cap/chat/reset    { sessionId? }                            → { ok }
 */
import type { Capability, ChatAskReply, ChatSendReq } from "../../contracts"

export const chatCapability: Capability = {
  id: "chat",
  title: "对话",
  icon: "💬",
  description: "opencode 会话后端:发送(Ctrl+Space 快速对话)、会话监控、历史、撤销。",
  hasPanel: true,
  routes: [
    {
      method: "POST",
      path: "/send",
      handler: async (req, ctx) => ({ body: await ctx.native.chat.send((req.body ?? {}) as ChatSendReq) }),
    },
    {
      method: "POST",
      path: "/create",
      handler: async (req, ctx) => ({
        body: await ctx.native.chat.createSession((req.body as { directory?: string })?.directory),
      }),
    },
    {
      method: "GET",
      path: "/monitor",
      handler: async (req, ctx) => {
        const limit = Number(req.query.get("limit") ?? "") || undefined
        return { body: { ok: true, entries: await ctx.native.chat.monitor(limit) } }
      },
    },
    {
      method: "POST",
      path: "/ask-reply",
      handler: async (req, ctx) => ({ body: await ctx.native.chat.replyAsk((req.body ?? {}) as ChatAskReply) }),
    },
    {
      method: "GET",
      path: "/sessions",
      handler: async (_req, ctx) => ({ body: { ok: true, sessions: await ctx.native.chat.sessions() } }),
    },
    {
      method: "GET",
      path: "/history",
      handler: async (req, ctx) => {
        const id = req.query.get("id") ?? ""
        return { body: { ok: true, messages: id ? await ctx.native.chat.history(id) : [] } }
      },
    },
    {
      method: "GET",
      path: "/models",
      handler: async (req, ctx) => ({ body: { ok: true, models: await ctx.native.chat.models(req.query.get("dir") ?? undefined) } }),
    },
    {
      method: "POST",
      path: "/undo",
      handler: async (req, ctx) => ({ body: await ctx.native.chat.undo((req.body as { sessionId?: string })?.sessionId ?? "") }),
    },
    {
      method: "POST",
      path: "/delete",
      handler: async (req, ctx) => ({ body: await ctx.native.chat.deleteSession((req.body as { sessionId?: string })?.sessionId ?? "") }),
    },
    {
      method: "POST",
      path: "/reset",
      handler: async (req, ctx) => {
        ctx.native.chat.reset((req.body as { sessionId?: string })?.sessionId)
        return { body: { ok: true } }
      },
    },
  ],
}
