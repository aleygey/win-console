/**
 * contracts — the one seam every layer depends on, and the only file with zero
 * runtime dependencies. It defines:
 *
 *   1. domain types        (chat / outlook / notify — carried over verbatim)
 *   2. NativeHost          the OS-touching surface the daemon injects into caps
 *   3. Capability          a pluggable module = tools(MCP)+routes(HTTP)+config(+panel)
 *   4. HostContext         what a capability gets at init / per call
 *   5. GlobalConfig        the daemon's single source of truth
 *   6. CapabilityInfo      what `/capabilities` advertises to front-ends
 *   7. WinHostClient       the typed HTTP/SSE client every front-end (Obsidian /
 *                          console / spotlight) talks through — same *shape* the
 *                          old preload `window.winconsole` had, so panels port
 *                          with a one-line import change.
 *
 * Adding a plugin = author one Capability. It then surfaces in three places at
 * once: the agent (its tools land in /mcp), the UIs (its routes + optional
 * panel), and the management console (its configSchema becomes a form). That
 * "register once, appear three places" is the whole point of this file.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Domain types (unchanged from the original win-console global.d.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type ModelRef = { providerID: string; modelID: string }

export type ChatSendReq = {
  text: string
  imageDataUrl?: string | null
  /** opencode session id to continue; omitted = create a fresh session. */
  sessionId?: string
  /** Model override for this prompt (provider+model). */
  model?: ModelRef
  /** Working directory for the session — a Windows path (D:\…) is auto-mapped to
   *  the WSL mount (/mnt/d/…) so the opencode agent (in WSL) can read/write it. */
  directory?: string
}
export type ChatSendRes = { ok: boolean; reply?: string; error?: string; sessionId?: string }

/** A model the user can pick, flattened from opencode's provider list. */
export type ModelInfo = {
  providerID: string
  modelID: string
  /** Display label, e.g. "Anthropic / Claude Opus 4.8". */
  label: string
  /** True if the provider is authenticated/connected. */
  connected: boolean
}

/** One opencode session, for the sessions sidebar. */
export type ChatSession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** A rendered message in a session's history. */
export type ChatMsg = {
  role: "user" | "assistant" | "system"
  text: string
  at?: number
}

/** The full chat backend (opencode SDK), injected via NativeHost.chat. */
export interface ChatBackend {
  send(req: ChatSendReq): Promise<ChatSendRes>
  /** Forget local state for a session (or all if omitted). */
  reset(sessionId?: string): void
  sessions(): Promise<ChatSession[]>
  history(sessionId: string): Promise<ChatMsg[]>
  /** List models; pass a directory to also surface that project's providers. */
  models(directory?: string): Promise<ModelInfo[]>
  /** Revert the last message in a session. */
  undo(sessionId: string): Promise<{ ok: boolean; error?: string }>
  deleteSession(sessionId: string): Promise<{ ok: boolean; error?: string }>
}

export type NotifyLevel = "info" | "warn" | "error"
export type NotifyReq = { title: string; message: string; level?: NotifyLevel }
export type NotifyRes = { ok: boolean; error?: string }

export type OutlookSearchReq = { query?: string; top?: number }
export type OutlookMail = {
  subject: string
  from: string
  received: string
  unread: boolean
  preview: string
}
export type OutlookSearchRes = { ok: boolean; mails?: OutlookMail[]; error?: string; mock?: boolean }

// ── Mail workflow (mailflow) ─────────────────────────────────────────────────
// Rule-driven email automation: scan an Outlook folder for new mail matching a
// rule, then act — notify, trigger an opencode session (e.g. a Bugzilla bug →
// a session that handles it), or AI-draft a reply (e.g. a Gerrit review) that
// waits for the user's approval before COM actually sends it (human-in-the-loop).

export type MailMatch = {
  /** Sender name/address substring (case-insensitive). */
  fromContains?: string
  /** Subject substring (case-insensitive). */
  subjectContains?: string
  /** Subject regex (JS syntax, case-insensitive). Takes precedence over subjectContains. */
  subjectRegex?: string
  /** Only consider unread mail. */
  unreadOnly?: boolean
}

export type MailActionKind = "notify" | "trigger-session" | "ai-review-reply"

export type MailRule = {
  id: string
  name: string
  enabled: boolean
  /** Outlook folder path; "" = default Inbox; "收件箱\\Bugzilla" = a subfolder. */
  folder?: string
  match: MailMatch
  action: MailActionKind
  /** Prompt/message template. Placeholders {subject} {from} {body} {received} are filled. */
  prompt?: string
  /** trigger-session working dir (a Windows path is auto-mapped to the WSL mount). */
  directory?: string
  /** Model for trigger-session / ai-review-reply (omit = opencode's default). */
  model?: ModelRef
}

/** One email read from Outlook, carrying the EntryID needed to reply later. */
export type MailMessage = {
  entryId: string
  subject: string
  from: string
  received: string
  unread: boolean
  body: string
  folder?: string
}

export type OutlookListReq = { folder?: string; top?: number; unreadOnly?: boolean }
export type OutlookListRes = { ok: boolean; mails?: MailMessage[]; error?: string; mock?: boolean }
export type OutlookReplyReq = {
  entryId: string
  body: string
  replyAll?: boolean
  /** true = send now; false = save as a draft in Outlook. */
  send?: boolean
}
export type OutlookReplyRes = { ok: boolean; sent?: boolean; error?: string; mock?: boolean }
/** Outlook folder paths (relative to the mailbox root, e.g. "收件箱\\Bugzilla"). */
export type OutlookFoldersRes = { ok: boolean; folders?: string[]; error?: string; mock?: boolean }

export type MailQueueStatus = "pending" | "sending" | "done" | "rejected" | "error"
/** A workflow outcome recorded for the user; `pending` ones await approval. */
export type MailQueueItem = {
  id: string
  ruleId: string
  ruleName: string
  action: MailActionKind
  mail: { entryId: string; subject: string; from: string; received: string; preview: string }
  /** ai-review-reply: the AI-drafted reply body (editable before sending). */
  draft?: string
  /** trigger-session: the opencode session created to handle it. */
  sessionId?: string
  status: MailQueueStatus
  error?: string
  createdAt: number
  decidedAt?: number
}
export type MailScanRes = {
  ok: boolean
  error?: string
  scanned: number
  matched: number
  queued: number
  items: MailQueueItem[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. NativeHost — the OS surface the daemon provides; capabilities never import
//    electron / child_process directly, they call through here. This is what
//    keeps the server core electron-free and therefore smoke-testable.
// ─────────────────────────────────────────────────────────────────────────────

export interface NativeHost {
  platform: string
  showToast(req: NotifyReq): Promise<NotifyRes>
  outlookSearch(req: OutlookSearchReq): Promise<OutlookSearchRes>
  /** List mail from an Outlook folder (with EntryIDs), for the mail workflow. */
  outlookList(req: OutlookListReq): Promise<OutlookListRes>
  /** Reply to an Outlook mail by EntryID — send now or save as a draft. */
  outlookReply(req: OutlookReplyReq): Promise<OutlookReplyRes>
  /** Enumerate the Outlook folder tree (for the mail-workflow folder picker). */
  outlookFolders(): Promise<OutlookFoldersRes>
  clipboardImage(): Promise<string | null>
  /** opencode SDK round-trip + session/model management, held host-side. */
  chat: ChatBackend
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Config schema — a capability declares its settings; the console renders a
//    form from this with zero per-capability UI code.
// ─────────────────────────────────────────────────────────────────────────────

export type ConfigFieldType = "string" | "number" | "boolean" | "select"
export interface ConfigField {
  key: string
  label: string
  type: ConfigFieldType
  default?: string | number | boolean
  options?: string[]
  placeholder?: string
  secret?: boolean
  help?: string
}
export interface ConfigSchema {
  fields: ConfigField[]
}
export type CapabilityConfig = Record<string, string | number | boolean | undefined>

// ─────────────────────────────────────────────────────────────────────────────
// 4. MCP tool + HTTP route shapes a capability contributes
// ─────────────────────────────────────────────────────────────────────────────

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler(args: any, ctx: HostContext): Promise<{ text: string; isError?: boolean }>
}

export interface RouteRequest {
  method: string
  /** Path *within* the capability, e.g. "/search" for POST /cap/outlook/search. */
  path: string
  query: URLSearchParams
  body: any
}
export interface RouteResult {
  status?: number
  body: unknown
}
export interface RouteDef {
  method: "GET" | "POST"
  path: string
  handler(req: RouteRequest, ctx: HostContext): Promise<RouteResult>
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Events — capabilities push these; the daemon fans them out over SSE so a
//    front-end can react (new mail badge, "summon chat" on hotkey, …).
// ─────────────────────────────────────────────────────────────────────────────

export interface HostEvent {
  type: string
  capability?: string
  payload?: unknown
  at: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. HostContext + Capability
// ─────────────────────────────────────────────────────────────────────────────

export interface HostContext {
  native: NativeHost
  /** This capability's config blob (merged defaults ← persisted ← env). */
  config(): CapabilityConfig
  global(): GlobalConfig
  emit(type: string, payload?: unknown): void
  log(...args: unknown[]): void
  /** A writable directory the capability may persist its own state into
   *  (queues, caches, dedup sets). Provided by the daemon. */
  dataDir: string
}

export interface Capability {
  id: string
  title: string
  icon?: string
  description?: string
  /** True when a matching SolidJS panel is bundled into the front-ends. */
  hasPanel?: boolean
  tools?: McpToolDef[]
  routes?: RouteDef[]
  configSchema?: ConfigSchema
  /** Event types this capability may emit (advertised for documentation). */
  events?: string[]
  init?(ctx: HostContext): Promise<void> | void
  dispose?(): Promise<void> | void
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. GlobalConfig — the daemon's single source of truth
// ─────────────────────────────────────────────────────────────────────────────

export interface GlobalConfig {
  opencodeUrl: string
  directory?: string
  hotkey: string
  serverPort: number
  /** Capabilities the user switched off in the console. */
  disabledCapabilities: string[]
  /** Per-capability settings keyed by capability id. */
  capabilities: Record<string, CapabilityConfig>
  /** Windows→Linux path prefix maps applied to the chat working directory.
   *  e.g. { from: "D:\\proj", to: "/media/sf_proj" } for a VirtualBox share.
   *  Empty = fall back to the WSL convention (D:\ → /mnt/d/). */
  pathMaps?: Array<{ from: string; to: string }>
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. /capabilities advertisement — links daemon-side logic to front-end panels
//    by shared id, and carries everything the console needs to render.
// ─────────────────────────────────────────────────────────────────────────────

export interface CapabilityInfo {
  id: string
  title: string
  icon?: string
  description?: string
  hasPanel: boolean
  enabled: boolean
  tools: { name: string; description: string }[]
  configSchema?: ConfigSchema
  config: CapabilityConfig
  /** True for a runtime-registered external plugin (vs a compiled-in capability). */
  external?: boolean
  /** If set, the console renders this URL as an iframe panel (external plugins). */
  panel?: PanelRef
  /** Event types this capability emits (advertised; front-ends may react). */
  events?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. External plugin protocol — the "drop-in without rebuilding the host" seam.
//
//   A plugin is just a self-contained service (its own HTTP backend, like the exp
//   playbook). It POSTs an ExternalManifest to /capabilities/register and the
//   daemon makes it appear in all three places with ZERO host rebuild:
//     - 管理 form         ← configSchema (reuses the existing renderer)
//     - rail iframe panel ← panel.url
//     - agent /mcp tools  ← tools[] (each call proxied to apiBaseUrl/tools/<name>)
//   /cap/<id>/* is reverse-proxied to apiBaseUrl. A heartbeat keeps it alive; a
//   plugin that stops (no heartbeat within ttlSeconds) is dropped automatically.
// ─────────────────────────────────────────────────────────────────────────────

/** An iframe panel a plugin serves; `url` is absolute (the plugin's own origin). */
export interface PanelRef {
  url: string
  /** Optional fixed height (px); omitted = fill the content area. */
  height?: number
}

/** A tool the plugin exposes; the daemon proxies calls to apiBaseUrl/tools/<name>. */
export interface ExternalToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ExternalManifest {
  id: string
  title: string
  icon?: string
  description?: string
  /** The plugin's own HTTP base, e.g. "http://127.0.0.1:54110". /cap/<id>/* is
   *  reverse-proxied here, and tool calls POST {apiBaseUrl}/tools/<name>. */
  apiBaseUrl?: string
  /** An iframe panel served by the plugin (its own UI, fully CSS-isolated). */
  panel?: PanelRef
  /** Declares settings → the 管理 page renders a form, persisted host-side and
   *  handed back to the plugin via the register/heartbeat response. */
  configSchema?: ConfigSchema
  /** MCP tools the agent should see; each call is proxied to the plugin. */
  tools?: ExternalToolDef[]
  events?: string[]
  /** Drop the capability if no heartbeat arrives within this window (default 60). */
  ttlSeconds?: number
}

/** The daemon's reply to register/heartbeat — carries the token + live config so
 *  the plugin can react to user edits without a second round-trip. */
export interface RegisterResult {
  ok: boolean
  error?: string
  /** Opaque token the plugin must echo on heartbeat / unregister. */
  token?: string
  /** The capability's current (user-edited) config blob. */
  config?: CapabilityConfig
  /** False if the user switched the capability off in 管理. */
  enabled?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. WinHostClient — the front-end seam. Same conveniences the old preload had
//    (chat/outlook/notify/clipboard) so panels are a drop-in, plus the generic
//    call/get/events that any future capability uses with no client changes.
// ─────────────────────────────────────────────────────────────────────────────

export interface WinHostClient {
  baseUrl: string
  platform: string

  health(): Promise<{ ok: boolean }>
  capabilities(): Promise<CapabilityInfo[]>
  getConfig(): Promise<GlobalConfig>
  setConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig>

  /** Generic capability call: POST /cap/<id><path>. */
  call<T>(capId: string, path: string, body?: unknown): Promise<T>
  /** Generic capability read: GET /cap/<id><path>. */
  read<T>(capId: string, path: string): Promise<T>

  /** Subscribe to the SSE event stream; returns an unsubscribe fn. */
  events(onEvent: (e: HostEvent) => void): () => void

  // Typed conveniences over the built-in capabilities ──────────────────────────
  chat: {
    send(req: ChatSendReq): Promise<ChatSendRes>
    reset(sessionId?: string): Promise<{ ok: boolean }>
    sessions(): Promise<ChatSession[]>
    history(sessionId: string): Promise<ChatMsg[]>
    models(directory?: string): Promise<ModelInfo[]>
    undo(sessionId: string): Promise<{ ok: boolean; error?: string }>
    deleteSession(sessionId: string): Promise<{ ok: boolean; error?: string }>
  }
  outlook: { search(req: OutlookSearchReq): Promise<OutlookSearchRes> }
  notify: { test(req: NotifyReq): Promise<NotifyRes> }
  clipboard: { image(): Promise<string | null> }
}
