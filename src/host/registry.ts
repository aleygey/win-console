/**
 * Capability registry — the heart of the "register once, appear three places"
 * model. It owns the capability instances, builds each one a HostContext, and
 * exposes three aggregated views:
 *
 *   - list()   → CapabilityInfo[] for /capabilities (drives console + which
 *                panels the front-ends show)
 *   - tools()  → the flattened MCP tool set from every *enabled* capability
 *   - route()  → dispatch an HTTP call to /cap/<id><path>
 *
 * Two kinds of capability flow through here:
 *   - BUILT-IN  — compiled-in Capability objects (chat/mailflow/notify/…).
 *   - EXTERNAL  — runtime-registered plugins (a serial-port plugin, a Gerrit
 *                 helper, …) that POST an ExternalManifest to the daemon. They
 *                 need NO host rebuild: their config becomes a 管理 form, their
 *                 panel an iframe, their tools land in /mcp (each call proxied to
 *                 the plugin's own HTTP), and /cap/<id>/* is reverse-proxied to
 *                 the plugin. A heartbeat keeps them alive; a plugin that stops
 *                 is swept out automatically and disappears from the console.
 *
 * SECURITY (the daemon binds all interfaces so a WSL agent can reach /mcp, so
 * the external surface is hardened here):
 *   - apiBaseUrl / panel.url must be http(s) on loopback (127.0.0.1/localhost) —
 *     blocks the daemon being turned into an SSRF proxy to the LAN / metadata.
 *   - re-registering a live id requires the SAME apiBaseUrl (idempotent refresh,
 *     same token) — a different origin is rejected, so an id can't be hijacked.
 *   - tokens are compared in constant time; unregister requires the token.
 *   - tool names can't collide with a built-in or another plugin's tool.
 *   - proxy fetches have a timeout + response-size cap + no redirect-following.
 *   - secret config fields are masked in the public /capabilities list.
 * An optional shared token (enforced at the server layer) gates registration
 * entirely when configured.
 */
import { randomUUID, timingSafeEqual } from "node:crypto"
import type {
  Capability,
  CapabilityConfig,
  CapabilityInfo,
  ConfigSchema,
  ExternalManifest,
  ExternalToolDef,
  HostContext,
  McpToolDef,
  NativeHost,
  RegisterResult,
  RouteRequest,
  RouteResult,
} from "../contracts"
import type { ConfigStore } from "./config"
import type { EventBus } from "./events"

export interface Registry {
  init(): Promise<void>
  list(): CapabilityInfo[]
  tools(): McpToolDef[]
  ctxFor(id: string): HostContext | undefined
  route(capId: string, req: RouteRequest): Promise<RouteResult>
  /** Runtime-register an external plugin from its manifest. */
  registerExternal(m: ExternalManifest): RegisterResult
  /** Refresh an external plugin's TTL; false if id/token don't match. */
  heartbeatExternal(id: string, token: string): boolean
  /** Drop an external plugin; requires the matching token (no force-remove). */
  unregisterExternal(id: string, token: string): boolean
  /** A token-holding plugin pushes a structured event onto the bus. */
  emitExternalEvent(id: string, token: string, type: string, payload?: unknown): boolean
  /** Unmasked config + enabled for the token-holding owner (heartbeat reply). */
  ownerView(id: string): { config: CapabilityConfig; enabled: boolean } | undefined
  dispose(): Promise<void>
}

export interface RegistryDeps {
  native: NativeHost
  config: ConfigStore
  events: EventBus
  /** A writable dir capabilities may persist state into (passed into HostContext). */
  dataDir: string
}

/** A live external plugin registration. */
interface ExternalEntry {
  manifest: ExternalManifest
  token: string
  /** Epoch ms after which the plugin is considered dead and swept out. */
  expiresAt: number
}

const DEFAULT_TTL_SECONDS = 60
/** How often the sweep checks for expired external plugins. */
const SWEEP_MS = 15_000
/** Proxy fetch timeout + max response size (caps memory / hang DoS). */
const PROXY_TIMEOUT_MS = 15_000
const PROXY_MAX_BYTES = 5 * 1024 * 1024
/** Max live external plugins (registration-flood backstop). */
const MAX_EXTERNAL = 64

export function createRegistry(caps: Capability[], deps: RegistryDeps): Registry {
  const ctxById = new Map<string, HostContext>()
  const external = new Map<string, ExternalEntry>()
  let sweepTimer: ReturnType<typeof setInterval> | undefined

  function ctx(cap: Capability): HostContext {
    let c = ctxById.get(cap.id)
    if (!c) {
      c = {
        native: deps.native,
        config: () => deps.config.capConfig(cap.id, cap.configSchema),
        global: () => deps.config.get(),
        emit: (type, payload) => deps.events.emit(type, cap.id, payload),
        log: (...args) => console.log(`[cap:${cap.id}]`, ...args),
        dataDir: deps.dataDir,
      }
      ctxById.set(cap.id, c)
    }
    return c
  }

  const enabled = (cap: Capability) => deps.config.isEnabled(cap.id)
  const ttlMs = (m: ExternalManifest) => (m.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000

  function liveExternal(): ExternalEntry[] {
    const now = Date.now()
    return [...external.values()].filter((e) => e.expiresAt > now)
  }

  function sweep(): void {
    const now = Date.now()
    let changed = false
    for (const [id, e] of external) {
      if (e.expiresAt <= now) {
        external.delete(id)
        changed = true
        console.log(`[registry] external '${id}' expired (no heartbeat) — removed`)
      }
    }
    if (changed) deps.events.emit("capabilities:changed")
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function tokenEq(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b))
    } catch {
      return false
    }
  }

  /** http(s) on loopback only. Empty/undefined is allowed (optional field). */
  function localUrlError(raw: string | undefined, what: string): string | null {
    if (!raw) return null
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return `${what} 不是合法 URL: ${raw}`
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return `${what} 必须是 http/https: ${raw}`
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (h !== "127.0.0.1" && h !== "localhost" && h !== "::1")
      return `${what} 必须指向本机回环(127.0.0.1/localhost),拒绝 ${u.hostname}(防 SSRF)`
    return null
  }

  function redactSecrets(config: CapabilityConfig, schema?: ConfigSchema): CapabilityConfig {
    const secretKeys = (schema?.fields ?? []).filter((f) => f.secret).map((f) => f.key)
    if (!secretKeys.length) return config
    const out: CapabilityConfig = { ...config }
    for (const k of secretKeys) if (out[k] !== undefined && out[k] !== "") out[k] = "••••••"
    return out
  }

  /** All tool names currently in use, excluding a given external id (for re-register). */
  function existingToolNames(exceptExternalId?: string): Set<string> {
    const names = new Set<string>()
    for (const c of caps) for (const t of c.tools ?? []) names.add(t.name)
    for (const e of external.values()) {
      if (e.manifest.id === exceptExternalId) continue
      for (const t of e.manifest.tools ?? []) names.add(t.name)
    }
    return names
  }

  /** fetch with timeout + capped body + no redirect-following. */
  async function cappedFetch(url: string | URL, init: RequestInit): Promise<{ status: number; text: string }> {
    const r = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) })
    const reader = r.body?.getReader()
    if (!reader) return { status: r.status, text: await r.text() }
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > PROXY_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error(`响应过大(> ${PROXY_MAX_BYTES} 字节)`)
      }
      chunks.push(value)
    }
    return { status: r.status, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") }
  }

  function proxyTool(m: ExternalManifest, t: ExternalToolDef): McpToolDef {
    return {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      handler: async (args) => {
        const base = (m.apiBaseUrl ?? "").replace(/\/+$/, "")
        if (!base) return { text: `插件「${m.id}」未提供 apiBaseUrl,无法调用工具 ${t.name}`, isError: true }
        try {
          const { text } = await cappedFetch(`${base}/tools/${encodeURIComponent(t.name)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ arguments: args ?? {} }),
          })
          let j: { text?: string; isError?: boolean } = {}
          try {
            j = JSON.parse(text)
          } catch {
            /* non-JSON reply */
          }
          if (typeof j?.text === "string") return { text: j.text, isError: !!j.isError }
          return { text: text || "(空响应)" }
        } catch (err) {
          return { text: `插件「${m.id}」调用失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
        }
      },
    }
  }

  async function proxyRoute(m: ExternalManifest, req: RouteRequest): Promise<RouteResult> {
    const base = (m.apiBaseUrl ?? "").replace(/\/+$/, "")
    if (!base) return { status: 502, body: { ok: false, error: `插件「${m.id}」未提供 apiBaseUrl` } }
    try {
      const u = new URL(base + req.path)
      req.query.forEach((v, k) => u.searchParams.set(k, v))
      const init: RequestInit = { method: req.method, headers: { "content-type": "application/json" } }
      if (req.method === "POST") init.body = JSON.stringify(req.body ?? {})
      const { status, text } = await cappedFetch(u, init)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status, body }
    } catch (err) {
      return { status: 502, body: { ok: false, error: `插件「${m.id}」不可达:${err instanceof Error ? err.message : String(err)}` } }
    }
  }

  function externalInfo(e: ExternalEntry): CapabilityInfo {
    const m = e.manifest
    return {
      id: m.id,
      title: m.title,
      icon: m.icon,
      description: m.description,
      hasPanel: !!m.panel,
      enabled: deps.config.isEnabled(m.id),
      tools: (m.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      configSchema: m.configSchema,
      config: redactSecrets(deps.config.capConfig(m.id, m.configSchema), m.configSchema),
      events: m.events,
      external: true,
      panel: m.panel,
    }
  }

  return {
    async init() {
      for (const cap of caps) {
        if (!enabled(cap)) continue
        try {
          await cap.init?.(ctx(cap))
        } catch (e) {
          console.warn(`[registry] init failed for ${cap.id}:`, e)
        }
      }
      sweepTimer = setInterval(sweep, SWEEP_MS)
      sweepTimer.unref?.()
    },

    list() {
      const builtin = caps.map<CapabilityInfo>((cap) => ({
        id: cap.id,
        title: cap.title,
        icon: cap.icon,
        description: cap.description,
        hasPanel: cap.hasPanel ?? false,
        enabled: enabled(cap),
        tools: (cap.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
        configSchema: cap.configSchema,
        config: redactSecrets(deps.config.capConfig(cap.id, cap.configSchema), cap.configSchema),
      }))
      return [...builtin, ...liveExternal().map(externalInfo)]
    },

    tools() {
      const out: McpToolDef[] = []
      for (const cap of caps) {
        if (!enabled(cap)) continue
        for (const t of cap.tools ?? []) out.push(bindTool(t, ctx(cap)))
      }
      for (const e of liveExternal()) {
        if (!deps.config.isEnabled(e.manifest.id)) continue
        for (const t of e.manifest.tools ?? []) out.push(proxyTool(e.manifest, t))
      }
      return out
    },

    ctxFor(id) {
      const cap = caps.find((c) => c.id === id)
      return cap ? ctx(cap) : undefined
    },

    async route(capId, req) {
      const cap = caps.find((c) => c.id === capId)
      if (cap) {
        if (!enabled(cap)) return { status: 403, body: { ok: false, error: `capability disabled: ${capId}` } }
        const r = (cap.routes ?? []).find((rt) => rt.method === req.method && rt.path === req.path)
        if (!r) return { status: 404, body: { ok: false, error: `no route ${req.method} ${capId}${req.path}` } }
        return r.handler(req, ctx(cap))
      }
      const e = liveExternal().find((x) => x.manifest.id === capId)
      if (e) {
        if (!deps.config.isEnabled(capId)) return { status: 403, body: { ok: false, error: `capability disabled: ${capId}` } }
        return proxyRoute(e.manifest, req)
      }
      return { status: 404, body: { ok: false, error: `unknown capability: ${capId}` } }
    },

    registerExternal(m) {
      if (!m || typeof m.id !== "string" || !m.id.trim() || typeof m.title !== "string" || !m.title.trim()) {
        return { ok: false, error: "manifest 至少需要 id 与 title" }
      }
      if (caps.some((c) => c.id === m.id)) return { ok: false, error: `id 与内建能力冲突:${m.id}` }
      // SSRF guard: the daemon will fetch apiBaseUrl + render panel.url, so both
      // must point at the local machine.
      const apiErr = localUrlError(m.apiBaseUrl, "apiBaseUrl")
      if (apiErr) return { ok: false, error: apiErr }
      const panelErr = localUrlError(m.panel?.url, "panel.url")
      if (panelErr) return { ok: false, error: panelErr }
      // Tool names must not shadow a built-in or another plugin's tool.
      const taken = existingToolNames(m.id)
      for (const t of m.tools ?? []) {
        if (taken.has(t.name)) return { ok: false, error: `工具名已被占用:${t.name}` }
      }

      const prior = external.get(m.id)
      if (prior) {
        // Ownership: only the SAME origin may refresh a live id (idempotent) —
        // a different apiBaseUrl is a hijack attempt and is rejected.
        if ((prior.manifest.apiBaseUrl ?? "") !== (m.apiBaseUrl ?? "")) {
          return { ok: false, error: `id「${m.id}」已被占用(apiBaseUrl 不同)` }
        }
        const shapeChanged = JSON.stringify(prior.manifest) !== JSON.stringify(m)
        prior.manifest = m
        prior.expiresAt = Date.now() + ttlMs(m)
        if (shapeChanged) deps.events.emit("capabilities:changed")
        return {
          ok: true,
          token: prior.token, // keep the same token — no rotation, no storm
          config: deps.config.capConfig(m.id, m.configSchema),
          enabled: deps.config.isEnabled(m.id),
        }
      }

      if (external.size >= MAX_EXTERNAL) return { ok: false, error: `外部能力数已达上限(${MAX_EXTERNAL})` }
      const token = randomUUID()
      external.set(m.id, { manifest: m, token, expiresAt: Date.now() + ttlMs(m) })
      console.log(`[registry] external '${m.id}' (${m.title}) registered — ${(m.tools ?? []).length} tool(s)${m.panel ? ", panel" : ""}`)
      deps.events.emit("capabilities:changed")
      return { ok: true, token, config: deps.config.capConfig(m.id, m.configSchema), enabled: deps.config.isEnabled(m.id) }
    },

    heartbeatExternal(id, token) {
      const e = external.get(id)
      if (!e || !tokenEq(e.token, token)) return false
      const wasLapsed = e.expiresAt <= Date.now()
      e.expiresAt = Date.now() + ttlMs(e.manifest)
      // If it had already lapsed (but not yet swept), its reappearance is a
      // visible change — tell the consoles to refetch.
      if (wasLapsed) deps.events.emit("capabilities:changed")
      return true
    },

    unregisterExternal(id, token) {
      const e = external.get(id)
      if (!e || !tokenEq(e.token, token)) return false
      external.delete(id)
      console.log(`[registry] external '${id}' unregistered`)
      deps.events.emit("capabilities:changed")
      return true
    },

    emitExternalEvent(id, token, type, payload) {
      const e = external.get(id)
      if (!e || !tokenEq(e.token, token)) return false
      if (typeof type !== "string" || !type.trim()) return false
      // Namespace under the plugin id so a plugin can't forge a host event type.
      deps.events.emit(type.startsWith(`${id}:`) ? type : `${id}:${type}`, id, payload)
      return true
    },

    ownerView(id) {
      const e = external.get(id)
      if (!e) return undefined
      return { config: deps.config.capConfig(id, e.manifest.configSchema), enabled: deps.config.isEnabled(id) }
    },

    async dispose() {
      if (sweepTimer) clearInterval(sweepTimer)
      for (const cap of caps) {
        try {
          await cap.dispose?.()
        } catch (e) {
          console.warn(`[registry] dispose failed for ${cap.id}:`, e)
        }
      }
    },
  }
}

/** Re-bind a tool's handler so the MCP layer can call it with just (args). */
function bindTool(tool: McpToolDef, ctx: HostContext): McpToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: (args) => tool.handler(args, ctx),
  }
}
