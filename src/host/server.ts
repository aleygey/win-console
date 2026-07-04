/**
 * The daemon's HTTP face — plain node http, no electron import, so it runs in
 * the smoke test exactly as in production. It serves three audiences from one
 * port:
 *
 *   agent  →  POST /mcp                (tools auto-discovered from the registry)
 *   UIs    →  POST/GET /cap/<id><path> (per-capability routes)
 *             GET  /capabilities       (what to render)
 *             GET  /config, POST /config
 *             GET  /events             (SSE: new mail, config/capability changes, …)
 *   ops    →  GET  /health
 *
 * Generalised from the original win-console toolserver.ts: the hard-coded
 * /notify and /outlook/search routes are gone — every route now comes from a
 * capability, so the server never changes when you add a plugin.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, join, normalize } from "node:path"
import { timingSafeEqual } from "node:crypto"
import type { ExternalManifest, GlobalConfig } from "../contracts"
import type { ConfigStore } from "./config"
import type { EventBus } from "./events"
import type { Registry } from "./registry"
import { mcpDispatch, newSessionId, type JsonRpcMessage } from "./mcp"

export interface ServerDeps {
  registry: Registry
  config: ConfigStore
  events: EventBus
  /** If set, GET requests that match no API route are served from this dir
   *  (the built console). Lets the Obsidian plugin embed the console via an
   *  iframe at the daemon's own origin — full CSS isolation, zero conflict.
   *  The Electron console window ALSO loads this over HTTP (loadURL), because
   *  the ES-module bundles can't load over file://. */
  consoleDir?: string
  /** If set, GET /spotlight/* is served from here (the Electron spotlight window
   *  loads it over HTTP for the same ES-module reason). */
  spotlightDir?: string
}

export function startServer(port: number, deps: ServerDeps): Server {
  const server = createServer((req, res) => {
    void route(req, res, deps).catch((e) => json(res, 500, { ok: false, error: String(e) }))
  })
  server.on("error", (e) => console.error("[server] listen error:", e))
  server.listen(port, () =>
    console.log(`[server] http://127.0.0.1:${port}  (/health /capabilities /config /events /mcp /cap/*)`),
  )
  return server
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  cors(res)
  if (req.method === "OPTIONS") return void res.writeHead(204).end()

  const url = new URL(req.url || "/", "http://localhost")
  const path = url.pathname

  if (path === "/health") return json(res, 200, { ok: true, service: "win-host" })
  if (path === "/capabilities") return json(res, 200, { ok: true, capabilities: deps.registry.list() })

  // ── External plugin lifecycle (drop-in, no host rebuild) ────────────────────
  // A plugin POSTs its manifest → appears in 管理 (config) + the rail (iframe) +
  // /mcp (proxied tools). It must heartbeat to stay alive; stopping the plugin
  // (or letting the TTL lapse) removes it automatically.
  //
  // The daemon binds all interfaces (a WSL agent reaches /mcp over the LAN IP),
  // so when WIN_HOST_PLUGIN_TOKEN is set these registration endpoints require it
  // (x-winhost-token header) — without it any LAN host could register a plugin.
  if (path.startsWith("/capabilities/") && req.method === "POST") {
    if (!pluginAuthOk(req)) return json(res, 401, { ok: false, error: "plugin token required" })

    if (path === "/capabilities/register") {
      const m = await readJson<ExternalManifest>(req)
      const r = deps.registry.registerExternal(m)
      return json(res, r.ok ? 200 : 409, r)
    }
    if (path === "/capabilities/heartbeat") {
      const { id, token } = await readJson<{ id?: string; token?: string }>(req)
      const ok = deps.registry.heartbeatExternal(String(id ?? ""), String(token ?? ""))
      // Unmasked owner view (token-gated by the per-plugin token) so the plugin
      // reacts to 管理 edits — including its own secret fields.
      const owner = ok ? deps.registry.ownerView(String(id ?? "")) : undefined
      return json(res, ok ? 200 : 404, { ok, config: owner?.config, enabled: owner?.enabled })
    }
    if (path === "/capabilities/unregister") {
      const { id, token } = await readJson<{ id?: string; token?: string }>(req)
      const ok = deps.registry.unregisterExternal(String(id ?? ""), String(token ?? ""))
      return json(res, ok ? 200 : 404, { ok })
    }
    if (path === "/capabilities/event") {
      const { id, token, type, payload } = await readJson<{ id?: string; token?: string; type?: string; payload?: unknown }>(req)
      const ok = deps.registry.emitExternalEvent(String(id ?? ""), String(token ?? ""), String(type ?? ""), payload)
      return json(res, ok ? 200 : 404, { ok })
    }
  }

  if (path === "/config") {
    if (req.method === "GET") return json(res, 200, deps.config.get())
    if (req.method === "POST") {
      const patch = await readJson<Partial<GlobalConfig>>(req)
      const next = deps.config.set(patch)
      // Broadcast so the daemon can re-register the hotkey and front-ends can
      // react live (e.g. re-render the rail) without a poll.
      deps.events.emit("config:changed", undefined, next)
      return json(res, 200, next)
    }
    return void res.writeHead(405).end()
  }

  if (path === "/events") return void sse(req, res, deps.events)

  if (path === "/mcp") return void (await handleMcp(req, res, deps))

  // /cap/<id>/<rest...>  →  capability route
  if (path.startsWith("/cap/")) {
    const rest = path.slice("/cap/".length)
    const slash = rest.indexOf("/")
    const capId = slash === -1 ? rest : rest.slice(0, slash)
    const subPath = slash === -1 ? "/" : rest.slice(slash)
    const method = req.method === "GET" ? "GET" : "POST"
    const body = method === "POST" ? await readJson<unknown>(req) : undefined
    const result = await deps.registry.route(capId, { method, path: subPath, query: url.searchParams, body })
    return json(res, result.status ?? 200, result.body)
  }

  // Static spotlight bundle (the Electron spotlight window loads it over HTTP).
  if (req.method === "GET" && deps.spotlightDir && (path === "/spotlight" || path.startsWith("/spotlight/"))) {
    const sub = path.slice("/spotlight".length) || "/"
    if (serveStatic(res, deps.spotlightDir, sub)) return
  }

  // Static console (for the Obsidian iframe + the Electron console window). GET only.
  if (req.method === "GET" && deps.consoleDir && serveStatic(res, deps.consoleDir, path)) return

  return json(res, 404, { ok: false, error: "not_found", path })
}

// ── static file serving (the built console, for the Obsidian iframe) ─────────
const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function serveStatic(res: ServerResponse, dir: string, path: string): boolean {
  // Resolve within dir; SPA fallback to index.html for unknown paths.
  const rel = path === "/" ? "/index.html" : path
  let file = normalize(join(dir, rel))
  if (!file.startsWith(normalize(dir))) return false // path traversal guard
  try {
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html")
    if (!existsSync(file)) return false
    const ext = extname(file)
    let body: Buffer | string = readFileSync(file)
    // For the served console/spotlight HTML, point the front-end at THIS daemon's
    // own origin (unless a host already injected window.winhost, e.g. the Electron
    // preload or the Obsidian plugin). Lets the console "just work" when opened in
    // a plain browser at the daemon's port instead of falling back to :8799.
    if (ext === ".html") {
      // (a) point the front-end at THIS daemon's origin unless a host already
      //     injected window.winhost (Electron preload / Obsidian plugin);
      // (b) a tiny crash overlay so a blank window self-describes: any uncaught
      //     renderer error (or a #root that never mounts) paints onto the page,
      //     making the otherwise-silent 工位/corp-Win10 blank window diagnosable.
      const inject =
        "<script>" +
        'window.winhost=window.winhost||{url:location.origin,platform:"web"};' +
        "(function(){" +
        'function show(m){var e=document.getElementById("__wh_err");' +
        'if(!e){e=document.createElement("pre");e.id="__wh_err";' +
        'e.style.cssText="position:fixed;left:0;top:0;right:0;bottom:0;margin:0;padding:14px;background:#111;color:#f88;font:12px/1.6 monospace;white-space:pre-wrap;overflow:auto;z-index:2147483647";' +
        "(document.body||document.documentElement).appendChild(e);}" +
        'e.textContent+=m+"\\n";}' +
        'window.addEventListener("error",function(ev){show("[JS] "+(ev.message||"")+" @ "+(ev.filename||"")+":"+(ev.lineno||""));});' +
        'window.addEventListener("unhandledrejection",function(ev){show("[Promise] "+((ev.reason&&ev.reason.message)||ev.reason||""));});' +
        'setTimeout(function(){var r=document.getElementById("root");if(r&&r.childElementCount===0){show("[winhost] #root 仍为空(脚本未加载或未挂载)。URL="+location.href+" host="+(window.winhost&&window.winhost.url));}},6000);' +
        "})();" +
        "</script>"
      body = body.toString("utf8").replace(/<head(\s[^>]*)?>/i, (m) => m + inject)
    }
    res.writeHead(200, { "Content-Type": STATIC_MIME[ext] || "application/octet-stream" })
    res.end(body)
    return true
  } catch {
    return false
  }
}

// ── Server-Sent Events ───────────────────────────────────────────────────────
function sse(req: IncomingMessage, res: ServerResponse, events: EventBus): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  })
  res.write(": connected\n\n")
  // Replay recent events so a just-connected client doesn't miss the last ping.
  for (const e of events.recent()) writeEvent(res, e)

  const unsub = events.subscribe((e) => writeEvent(res, e))
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000)

  req.on("close", () => {
    clearInterval(heartbeat)
    unsub()
  })
}

function writeEvent(res: ServerResponse, e: unknown): void {
  res.write(`data: ${JSON.stringify(e)}\n\n`)
}

// ── MCP over Streamable HTTP (request/response subset) ───────────────────────
async function handleMcp(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  if (req.method === "GET") return void res.writeHead(405).end()
  if (req.method === "DELETE") return void res.writeHead(204).end()
  if (req.method !== "POST") return void res.writeHead(405).end()

  const body = await readJson<unknown>(req)
  const batch = Array.isArray(body)
  const msgs = (batch ? body : [body]) as JsonRpcMessage[]
  const tools = deps.registry.tools()
  const out: unknown[] = []
  for (const m of msgs) {
    const r = await mcpDispatch(m, tools)
    if (r) out.push(r)
  }
  const extra: Record<string, string> = {}
  if (!req.headers["mcp-session-id"] && msgs.some((m) => m?.method === "initialize")) {
    extra["Mcp-Session-Id"] = newSessionId()
  }
  if (out.length === 0) return void res.writeHead(202, extra).end()
  jsonH(res, 200, batch ? out : out[0], extra)
}

// ── external-plugin auth ─────────────────────────────────────────────────────
// When WIN_HOST_PLUGIN_TOKEN is set, /capabilities/* requires a matching
// x-winhost-token header. Unset (the demo default) leaves registration open —
// but registry.ts still restricts apiBaseUrl/panel.url to loopback regardless.
function pluginAuthOk(req: IncomingMessage): boolean {
  const want = process.env.WIN_HOST_PLUGIN_TOKEN
  if (!want) return true
  const got = req.headers["x-winhost-token"]
  const tok = Array.isArray(got) ? got[0] : got
  if (typeof tok !== "string" || tok.length !== want.length) return false
  try {
    return timingSafeEqual(Buffer.from(tok), Buffer.from(want))
  } catch {
    return false
  }
}

// ── helpers (carried over from toolserver.ts) ────────────────────────────────
function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, x-winhost-token")
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id")
}

function jsonH(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length, ...headers })
  res.end(buf)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  jsonH(res, status, body, {})
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve) => {
    let raw = ""
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > 8 * 1024 * 1024) {
        req.destroy()
        resolve({} as T)
        return
      }
      raw += c
    })
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T))
      } catch {
        resolve({} as T)
      }
    })
    req.on("error", () => resolve({} as T))
  })
}
