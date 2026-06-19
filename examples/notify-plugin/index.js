/**
 * opencode-plugin-notify — desktop-toast the user when a session goes idle after
 * a LONG turn, via the win-host's notify endpoint.
 *
 * Why: when opencode runs in a VM / on another screen, a long task finishing is
 * easy to miss. This pings the user's Windows desktop so they know to come back.
 * Standalone (no deps, plain ESM) so it doesn't touch the exp playbook.
 *
 * Install — add to ~/.config/opencode/opencode.jsonc `plugin`:
 *   "plugin": [
 *     "/abs/path/opencode-plugin-notify/index.js",                 // env-configured
 *     ["/abs/path/opencode-plugin-notify/index.js", { "url": "http://192.168.56.106:8810" }]  // or inline
 *   ]
 * Config (option | env):
 *   url   | WINHOST_NOTIFY_URL      win-host base, e.g. http://192.168.56.106:8810  (8810 on the 工位)
 *   minMs | WINHOST_NOTIFY_MIN_MS   only notify if the turn took longer than this (default 45000)
 *
 * It POSTs {title,message,level} to <url>/cap/notify/test — the same route the
 * win-host notify capability serves. Requires Node 18+ (global fetch).
 */

export const NotifyPlugin = async (input, options) => {
  const opts = options ?? {}
  const base = String(opts.url || process.env.WINHOST_NOTIFY_URL || "").replace(/\/+$/, "")
  const minMs = Number(opts.minMs ?? process.env.WINHOST_NOTIFY_MIN_MS ?? 45000)
  const client = input?.client

  // turn start time per session — set on each user message, read on idle.
  const turnStart = new Map()

  async function toast(title, message) {
    if (!base) return // not configured → silently do nothing
    try {
      await fetch(base + "/cap/notify/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, message, level: "info" }),
      })
    } catch {
      /* best-effort, never break the session */
    }
  }

  return {
    "chat.message": async (inp) => {
      if (inp?.sessionID) turnStart.set(inp.sessionID, Date.now())
    },
    event: async ({ event }) => {
      const type = event?.type
      const props = event?.properties ?? {}
      const sid = props.sessionID ?? props.sessionId ?? props.id
      if (type !== "session.idle" || !sid) return
      const start = turnStart.get(sid)
      turnStart.delete(sid)
      if (!start) return
      const elapsed = Date.now() - start
      if (elapsed < minMs) return // short reply — don't nag
      let message = `用时 ${Math.round(elapsed / 1000)}s`
      try {
        const s = await client?.session?.get?.({ sessionID: sid })
        const t = s?.data?.title
        if (t) message = `${t} · ${message}`
      } catch {
        /* title is best-effort */
      }
      await toast("✅ opencode 任务完成", message)
    },
  }
}

export default NotifyPlugin
