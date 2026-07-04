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
  /** Inline file attachments (images + binaries) sent as file parts. Content
   *  travels WITH the message, so the agent gets the file without any working
   *  directory / Windows↔Linux path mapping. (Text files are inlined into `text`
   *  by the front-end instead.) */
  files?: Array<{ name: string; mime: string; dataUrl: string }>
  /** opencode session id to continue; omitted = create a fresh session. */
  sessionId?: string
  /** Model override for this prompt (provider+model). */
  model?: ModelRef
  /** Working directory for the session — a Windows path (D:\…) is auto-mapped to
   *  the WSL mount (/mnt/d/…). Set only from the 管理 global setting now. */
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

/** Status of a tool invocation, mirrored from opencode's part state. */
export type ChatToolStatus = "pending" | "running" | "completed" | "error"

/** One structured slice of an assistant/user message — the building block that
 *  lets the panel render a TUI-grade view (thinking, tool calls, errors), not
 *  just the joined text. `kind` is ours (opencode calls it `type`). */
export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; tool: string; status: ChatToolStatus; input?: unknown; output?: string; error?: string; title?: string }
  | { kind: "file"; mime: string; filename?: string }
  | { kind: "error"; text: string }

/** A rendered message in a session's history. `text` is the joined text (kept for
 *  the spotlight + as a fallback); `parts` carries the full structured view. */
export type ChatMsg = {
  /** opencode message id (so callers like cold-start distill can reference the
   *  exact source message). Absent for locally-synthesized rows. */
  id?: string
  role: "user" | "assistant" | "system"
  text: string
  parts?: ChatPart[]
  at?: number
}

/** One session's live status for the 会话监控 panel: what it is doing right now.
 *  Built host-side from the tail of the session's messages — opencode persists
 *  message parts incrementally while a turn runs, so the latest parts ARE the
 *  live progress (running tools, streaming text) without any extra protocol. */
/** A pending interactive request parked on a session — opencode's permission
 *  ask or question tool. Until answered the session hangs, so the monitor
 *  surfaces these with reply buttons. Read via opencode's global GET
 *  /permission + /question lists (serve ≥1.16). */
export type ChatQuestionOption = { label: string; description?: string }
export type ChatQuestionInfo = {
  question: string
  header?: string
  options: ChatQuestionOption[]
  multiple?: boolean
  custom?: boolean
}
export type ChatPendingAsk = {
  kind: "permission" | "question"
  requestId: string
  sessionID: string
  /** permission kind (e.g. "bash", "edit") + the patterns it wants. */
  permission?: string
  patterns?: string[]
  /** question tool payload. */
  questions?: ChatQuestionInfo[]
}
export type ChatAskReply =
  | { kind: "permission"; requestId: string; reply: "once" | "always" | "reject" }
  | { kind: "question"; requestId: string; answers?: string[][]; reject?: boolean }

export type ChatMonitorEntry = {
  id: string
  title: string
  updatedAt: number
  /** Mid-turn: from opencode /session/status when available, else the tool-part
   *  heuristic (latest assistant message has a pending/running tool part). */
  busy: boolean
  /** Refined state when known: "retry" = opencode is retrying a failed model
   *  call — surfaces provider errors (refusals, gateway failures) that would
   *  otherwise look like an endless "运行中". */
  state?: "busy" | "retry"
  /** Human-readable detail for `state` (e.g. the retry error message). */
  stateDetail?: string
  /** Last user query — the "current task" line. */
  task?: string
  /** Latest activity from the assistant side (last part of the last message). */
  progress?: { kind: "tool" | "text" | "reasoning"; text: string; status?: ChatToolStatus }
  /** Tool-part counts in the latest assistant message. */
  tools?: { running: number; completed: number; error: number }
  /** Pending permission/question parked on this session (blocks it until answered). */
  ask?: ChatPendingAsk
  /** Todo progress from the session's latest todowrite call (the agent's own
   *  task list): completed/total + the item currently in progress. */
  todos?: { done: number; total: number; current?: string }
}

/** The full chat backend (opencode SDK), injected via NativeHost.chat. */
export interface ChatBackend {
  send(req: ChatSendReq): Promise<ChatSendRes>
  /** Create an empty session up front (so the panel can stream the very first
   *  turn by polling its history while send() is in flight). */
  createSession(directory?: string): Promise<{ ok: boolean; sessionId?: string; error?: string }>
  /** Live status of the most recent sessions, for the 会话监控 panel. */
  monitor(limit?: number): Promise<ChatMonitorEntry[]>
  /** Answer a pending permission/question so the parked session can continue. */
  replyAsk(req: ChatAskReply): Promise<{ ok: boolean; error?: string }>
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
  /** MAPI EntryID — the handle for follow-up reads (outlook_read / attachments). */
  entryId?: string
}
export type OutlookSearchRes = { ok: boolean; mails?: OutlookMail[]; error?: string; mock?: boolean }

/** Read ONE mail in full: by entryId, or by folder+subject keyword (first match). */
export type OutlookReadReq = {
  entryId?: string
  folder?: string
  subjectContains?: string
  /** Also list other mails in the same conversation (same thread topic). */
  thread?: boolean
}
export type OutlookReadRes = {
  ok: boolean
  error?: string
  mock?: boolean
  mail?: {
    entryId: string
    subject: string
    from: string
    to: string
    received: string
    /** FULL body (capped at ~50k chars). */
    body: string
    attachments: Array<{ name: string; size: number }>
    conversationTopic?: string
  }
  /** Same-conversation mails (newest first, ≤10) when thread=true. */
  thread?: Array<{ entryId: string; subject: string; from: string; received: string }>
}

/** Save a mail's attachments to disk so the (WSL) agent can read them directly. */
export type OutlookSaveAttachmentsRes = {
  ok: boolean
  error?: string
  files?: Array<{ name: string; size: number; winPath: string }>
}

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

/** Which parts of the matched email get appended (as a structured block / file
 *  parts) to the rule's instruction. Replaces the old {subject}/{body} template
 *  placeholders — the user writes a plain instruction and ticks what to attach.
 *  Undefined field = its default (subject/from/received/body ON, attachments OFF). */
export type MailInclude = {
  subject?: boolean
  from?: boolean
  received?: boolean
  body?: boolean
  /** Extract the mail's attachments via Outlook COM and send them as inline
   *  file parts (size-capped). */
  attachments?: boolean
}

export type MailRule = {
  id: string
  name: string
  enabled: boolean
  /** Outlook folder path; "" = default Inbox; "收件箱\\Bugzilla" = a subfolder. */
  folder?: string
  match: MailMatch
  action: MailActionKind
  /** Plain task instruction (no placeholders needed — see `include`). Legacy
   *  {subject}-style placeholders are still filled for old rules. */
  prompt?: string
  /** What email content to hand the agent along with the instruction. */
  include?: MailInclude
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
  /** Extract a mail's attachments (by EntryID) as inline data-URL files, size-
   *  capped, so mailflow can hand them to the agent as file parts. */
  outlookAttachments(entryId: string): Promise<{ ok: boolean; files?: Array<{ name: string; mime: string; dataUrl: string }>; error?: string }>
  /** Read one mail in full (body + attachment list + optional thread). */
  outlookRead(req: OutlookReadReq): Promise<OutlookReadRes>
  /** Save a mail's attachments into `dir` (Windows path) for direct agent access. */
  outlookSaveAttachments(entryId: string, dir: string): Promise<OutlookSaveAttachmentsRes>
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
  /** Default model for sessions that don't override it (mailflow, and any send
   *  without an explicit per-message model). Persists, so it keeps applying —
   *  not just the first session. Unset = opencode's own default. */
  model?: ModelRef
  /** Capabilities the user switched off in the console. */
  disabledCapabilities: string[]
  /** Per-capability settings keyed by capability id. */
  capabilities: Record<string, CapabilityConfig>
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
    createSession(directory?: string): Promise<{ ok: boolean; sessionId?: string; error?: string }>
    monitor(limit?: number): Promise<ChatMonitorEntry[]>
    replyAsk(req: ChatAskReply): Promise<{ ok: boolean; error?: string }>
    reset(sessionId?: string): Promise<{ ok: boolean }>
    sessions(): Promise<ChatSession[]>
    history(sessionId: string): Promise<ChatMsg[]>
    models(directory?: string): Promise<ModelInfo[]>
    undo(sessionId: string): Promise<{ ok: boolean; error?: string }>
    deleteSession(sessionId: string): Promise<{ ok: boolean; error?: string }>
  }
  // (the outlook convenience was removed with the standalone outlook capability —
  //  the daemon-side COM access lives on NativeHost; mail automation is mailflow)
  notify: { test(req: NotifyReq): Promise<NotifyRes> }
  clipboard: { image(): Promise<string | null> }
}
