/**
 * Headless smoke (no electron, no opencode serve). Boots the real server with
 * the real registry + capabilities, injecting a stub NativeHost, then exercises
 * every seam over HTTP: health, capabilities, per-cap routes, config round-trip,
 * MCP (initialize / tools.list / tools.call), and the SSE event stream.
 *
 * Run: npm run smoke
 */
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NativeHost } from "../contracts"
import { createConfigStore } from "./config"
import { createEventBus } from "./events"
import { createRegistry } from "./registry"
import { startServer } from "./server"
import { builtinCapabilities } from "./capabilities"

const stubNative: NativeHost = {
  platform: process.platform,
  showToast: async (r) => {
    console.log(`   [notify] ${r.level ?? "info"} · ${r.title} — ${r.message}`)
    return { ok: true }
  },
  // Pure fixtures — never touch Outlook COM, so the smoke is fast on Windows too.
  outlookSearch: async (req) => ({
    ok: true,
    mock: true,
    mails: [
      { subject: "smoke mail", from: "ci@corp.com", received: new Date(0).toISOString(), unread: true, preview: "x" },
    ].slice(0, req.top ?? 15),
  }),
  outlookList: async (req) => ({
    ok: true,
    mock: true,
    mails: [
      { entryId: "e-bug", subject: "[Bug 1] serial drops bytes", from: "bugzilla@corp.com", received: new Date(0).toISOString(), unread: true, body: "bug body" },
      { entryId: "e-rev", subject: "Change 99: fix overflow", from: "gerrit@corp.com", received: new Date(0).toISOString(), unread: true, body: "diff" },
    ].slice(0, req.top ?? 25),
  }),
  outlookReply: async (req) => ({ ok: true, mock: true, sent: !!req.send }),
  outlookFolders: async () => ({ ok: true, mock: true, folders: ["收件箱", "收件箱\\Bugzilla"] }),
  clipboardImage: async () => null,
  chat: {
    send: async (req) => ({ ok: true, reply: `echo: ${req.text}`, sessionId: "smoke" }),
    reset: () => {},
    sessions: async () => [],
    history: async () => [],
    models: async () => [],
    undo: async () => ({ ok: true }),
    deleteSession: async () => ({ ok: true }),
  },
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init)
  return res.json()
}
const post = (url: string, body: unknown): Promise<any> =>
  getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const port = 8788
  const b = `http://127.0.0.1:${port}`
  let fail = 0
  const ok = (cond: boolean, label: string) => {
    console.log(`${cond ? "✓" : "✗"} ${label}`)
    if (!cond) fail++
  }

  const config = createConfigStore(join(tmpdir(), `winhost-smoke-${process.pid}.json`))
  const events = createEventBus()
  const registry = createRegistry(builtinCapabilities, {
    native: stubNative,
    config,
    events,
    dataDir: join(tmpdir(), `winhost-smoke-mf-${process.pid}`),
  })
  await registry.init()
  const server = startServer(port, { registry, config, events })
  await wait(300)

  // health + capabilities advertisement ───────────────────────────────────────
  ok((await getJson(`${b}/health`))?.ok === true, "GET /health")
  const caps = (await getJson(`${b}/capabilities`))?.capabilities ?? []
  ok(caps.length === 5, `GET /capabilities -> ${caps.length} caps`)
  ok(caps.find((c: any) => c.id === "chat")?.hasPanel === true, "  chat advertises a panel")
  ok(caps.find((c: any) => c.id === "mailflow")?.hasPanel === true, "  mailflow advertises a panel")
  const mailflowCap = caps.find((c: any) => c.id === "mailflow")
  ok(mailflowCap?.tools?.some((t: any) => t.name === "outlook_search"), "  mailflow advertises the outlook_search tool")
  const expCap = caps.find((c: any) => c.id === "exp")
  ok(typeof expCap?.config?.playbookUrl === "string", `  exp advertises playbookUrl (${expCap?.config?.playbookUrl})`)

  // per-capability routes ──────────────────────────────────────────────────────
  const folders = await getJson(`${b}/cap/mailflow/folders`)
  ok(folders?.ok === true && Array.isArray(folders.folders), `GET /cap/mailflow/folders -> ${folders?.folders?.length} folders (mock=${folders?.mock})`)
  ok((await post(`${b}/cap/notify/test`, { title: "smoke", message: "hi", level: "info" }))?.ok === true, "POST /cap/notify/test")
  const chat = await post(`${b}/cap/chat/send`, { text: "hello", sessionKey: "smoke" })
  ok(chat?.ok === true && chat.reply === "echo: hello", `POST /cap/chat/send -> "${chat?.reply}"`)
  const clip = await getJson(`${b}/cap/clipboard/image`)
  ok(clip?.ok === true && clip.dataUrl === null, "GET /cap/clipboard/image -> null (no image)")
  ok((await getJson(`${b}/cap/mailflow/queue`)).ok && (await getJson(`${b}/cap/nope/x`)).ok === false, "unknown cap rejected")

  // config round-trip ──────────────────────────────────────────────────────────
  const cfg = await getJson(`${b}/config`)
  ok(typeof cfg?.opencodeUrl === "string", "GET /config")
  const updated = await post(`${b}/config`, { hotkey: "Alt+Space" })
  ok(updated?.hotkey === "Alt+Space", "POST /config persists hotkey")

  // mail workflow (mailflow) ─────────────────────────────────────────────────────
  // notify rule → fires immediately (done); ai-review-reply rule → drafts and
  // waits for approval, which then "sends" via the stubbed Outlook COM.
  config.setCapConfig("mailflow", {
    rulesJson: JSON.stringify([
      { id: "r-bug", name: "Bug", enabled: true, folder: "", match: { subjectContains: "Bug" }, action: "notify" },
      { id: "r-rev", name: "Review", enabled: true, folder: "", match: { subjectContains: "Change" }, action: "ai-review-reply" },
    ]),
  })
  const scan = await post(`${b}/cap/mailflow/scan`, { force: true })
  ok(scan?.ok === true && scan.queued >= 2, `POST /cap/mailflow/scan -> queued ${scan?.queued}`)
  const q = (await getJson(`${b}/cap/mailflow/queue`))?.queue ?? []
  const pending = q.find((x: any) => x.action === "ai-review-reply" && x.status === "pending")
  ok(!!pending?.draft, `  ai-review-reply drafted a reply, pending approval`)
  const dn = q.find((x: any) => x.action === "notify" && x.status === "done")
  ok(!!dn, "  notify rule resolved to done (no approval)")
  const appr = await post(`${b}/cap/mailflow/approve`, { id: pending?.id })
  ok(appr?.ok === true, "  approve sends the drafted reply (mock COM)")
  const reScan = await post(`${b}/cap/mailflow/scan`, { force: true })
  ok(reScan?.queued === 0, "  re-scan is idempotent (dedup: already processed)")

  // MCP ─────────────────────────────────────────────────────────────────────────
  const init = await post(`${b}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
  ok(init?.result?.serverInfo?.name === "win-host", "MCP initialize")
  const list = await post(`${b}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list" })
  const toolNames = (list?.result?.tools ?? []).map((t: any) => t.name)
  ok(toolNames.includes("outlook_search") && toolNames.includes("notify_desktop"), `MCP tools/list -> ${JSON.stringify(toolNames)}`)
  const call = await post(`${b}/mcp`, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "outlook_search", arguments: { top: 2 } } })
  ok(typeof call?.result?.content?.[0]?.text === "string", "MCP tools/call outlook_search")

  // disabled capability contributes no tools, rejects routes ─────────────────────
  config.set({ disabledCapabilities: ["notify"] })
  const list2 = await post(`${b}/mcp`, { jsonrpc: "2.0", id: 4, method: "tools/list" })
  ok(!(list2?.result?.tools ?? []).some((t: any) => t.name === "notify_desktop"), "disabling notify drops its tool")
  ok((await post(`${b}/cap/notify/test`, { title: "x", message: "y" }))?.ok === false, "disabled cap route rejected")
  config.set({ disabledCapabilities: [] })

  // SSE event stream ────────────────────────────────────────────────────────────
  const got = await sseRoundTrip(b, () => events.emit("test:ping", "smoke", { n: 1 }))
  ok(got, "GET /events delivers an emitted event")

  // External plugin protocol (drop-in capability, no host rebuild) ────────────────
  // Stand up a tiny mock "plugin" HTTP server, register it, and prove it surfaces
  // in /capabilities + /mcp with calls proxied through to it, then unregisters.
  const pluginPort = 8789
  const pluginBase = `http://127.0.0.1:${pluginPort}`
  const plugin = http.createServer((preq, pres) => {
    const u = new URL(preq.url || "/", "http://x")
    let raw = ""
    preq.on("data", (c) => (raw += c))
    preq.on("end", () => {
      const reply = (obj: unknown) => {
        pres.writeHead(200, { "content-type": "application/json" })
        pres.end(JSON.stringify(obj))
      }
      if (preq.method === "POST" && u.pathname === "/tools/echo_tool") {
        let args: any = {}
        try {
          args = JSON.parse(raw || "{}").arguments
        } catch {
          /* ignore */
        }
        return reply({ text: `echo:${args?.msg ?? ""}` })
      }
      if (preq.method === "GET" && u.pathname === "/ping") return reply({ ok: true, pong: "pong" })
      pres.writeHead(404)
      pres.end("{}")
    })
  })
  await new Promise<void>((r) => plugin.listen(pluginPort, () => r()))

  const manifest = {
    id: "demo",
    title: "Demo Plugin",
    icon: "plug",
    apiBaseUrl: pluginBase,
    panel: { url: `${pluginBase}/` },
    configSchema: { fields: [{ key: "host", label: "Host", type: "string", default: "x" }] },
    tools: [{ name: "echo_tool", description: "echo", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }],
    ttlSeconds: 60,
  }
  const reg = await post(`${b}/capabilities/register`, manifest)
  ok(reg?.ok === true && typeof reg.token === "string", "POST /capabilities/register -> token")
  ok(reg?.config?.host === "x", "  register returns the cap's config (schema default)")

  const caps2 = (await getJson(`${b}/capabilities`))?.capabilities ?? []
  const demo = caps2.find((c: any) => c.id === "demo")
  ok(caps2.length === 6 && demo?.external === true, `GET /capabilities -> ${caps2.length} (external 'demo' present)`)
  ok(demo?.panel?.url === `${pluginBase}/` && demo?.hasPanel === true, "  demo advertises an iframe panel")

  const list3 = await post(`${b}/mcp`, { jsonrpc: "2.0", id: 5, method: "tools/list" })
  ok((list3?.result?.tools ?? []).some((t: any) => t.name === "echo_tool"), "  echo_tool appears in MCP tools/list")
  const call2 = await post(`${b}/mcp`, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo_tool", arguments: { msg: "hi" } } })
  ok(call2?.result?.content?.[0]?.text === "echo:hi", "  MCP tools/call proxies through to the plugin")

  const ping = await getJson(`${b}/cap/demo/ping`)
  ok(ping?.ok === true && ping.pong === "pong", "  /cap/demo/ping reverse-proxies to the plugin")

  const hb = await post(`${b}/capabilities/heartbeat`, { id: "demo", token: reg.token })
  ok(hb?.ok === true, "  heartbeat keeps it alive (and returns live config)")
  const badHb = await post(`${b}/capabilities/heartbeat`, { id: "demo", token: "wrong" })
  ok(badHb?.ok === false, "  heartbeat with a wrong token is rejected")
  const conflict = await post(`${b}/capabilities/register`, { id: "notify", title: "x" })
  ok(conflict?.ok === false, "  registering an id that collides with a built-in is rejected")

  // hardening: SSRF guard, re-register ownership, tool collision, token-gated unregister, event-push
  const evil = await post(`${b}/capabilities/register`, { id: "evil", title: "Evil", apiBaseUrl: "http://169.254.169.254/" })
  ok(evil?.ok === false, "  non-loopback apiBaseUrl is rejected (SSRF guard)")
  const reReg = await post(`${b}/capabilities/register`, manifest)
  ok(reReg?.ok === true && reReg.token === reg.token, "  re-register (same apiBaseUrl) is idempotent — same token")
  const hijack = await post(`${b}/capabilities/register`, { ...manifest, apiBaseUrl: "http://127.0.0.1:9" })
  ok(hijack?.ok === false, "  re-register same id with a different apiBaseUrl is rejected (no hijack)")
  const dupTool = await post(`${b}/capabilities/register`, {
    id: "demo2",
    title: "Demo2",
    apiBaseUrl: pluginBase,
    tools: [{ name: "echo_tool", description: "x", inputSchema: { type: "object" } }],
  })
  ok(dupTool?.ok === false, "  a tool name colliding with another plugin is rejected")
  const forceUnreg = await post(`${b}/capabilities/unregister`, { id: "demo" })
  ok(forceUnreg?.ok === false, "  unregister without a token is rejected (no force-remove)")
  const evGot = await sseRoundTrip(
    b,
    () => void post(`${b}/capabilities/event`, { id: "demo", token: reg.token, type: "ping", payload: { n: 1 } }),
    '"type":"demo:ping"',
  )
  ok(evGot, "  plugin event-push is delivered over /events as demo:ping")

  const unreg = await post(`${b}/capabilities/unregister`, { id: "demo", token: reg.token })
  ok(unreg?.ok === true, "  unregister removes it")
  const caps3 = (await getJson(`${b}/capabilities`))?.capabilities ?? []
  const list4 = await post(`${b}/mcp`, { jsonrpc: "2.0", id: 7, method: "tools/list" })
  ok(caps3.length === 5 && !(list4?.result?.tools ?? []).some((t: any) => t.name === "echo_tool"), "  after unregister: gone from caps + tools")
  plugin.close()

  server.close()
  console.log(fail === 0 ? "\n✅ smoke passed" : `\n❌ smoke failed (${fail})`)
  process.exit(fail === 0 ? 0 : 1)
}

/** Open the SSE stream, fire an emit, resolve true if we read the needle. */
function sseRoundTrip(base: string, fire: () => void, needle = '"type":"test:ping"'): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${base}/events`, (res) => {
      let buf = ""
      const timer = setTimeout(() => {
        req.destroy()
        resolve(false)
      }, 1500)
      res.on("data", (c) => {
        buf += c.toString()
        if (buf.includes(needle)) {
          clearTimeout(timer)
          req.destroy()
          resolve(true)
        }
      })
    })
    req.on("error", () => resolve(false))
    setTimeout(fire, 200)
  })
}

void main()
