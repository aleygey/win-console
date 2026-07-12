/**
 * opencode chat backend (the brain behind the chat panel), held host-side via
 * the official SDK. Implements the full ChatBackend: prompt with per-message
 * model override, list real opencode sessions, load a session's history, list
 * available models (provider.list), revert (undo), and delete sessions.
 *
 * Sessions ARE opencode session ids (no separate keying) — the panel creates one
 * on first send and continues it by id, and the sidebar mirrors session.list.
 *
 * SDK is 1.3.13 against serve 1.16.2; a few endpoints drifted, so SDK calls are
 * loosely typed (as any) and defensively read — runtime shape is what matters.
 */
import { createOpencodeClient } from "@opencode-ai/sdk"
import type {
  ChatAskReply,
  ChatBackend,
  ChatMonitorEntry,
  ChatMsg,
  ChatPart,
  ChatPendingAsk,
  ChatSendReq,
  ChatSendRes,
  ChatSession,
  GlobalConfig,
  ModelInfo,
} from "../contracts"

type Client = ReturnType<typeof createOpencodeClient>

export function createChat(getConfig: () => GlobalConfig): ChatBackend {
  let client: Client | undefined
  let clientUrl: string | undefined

  function c(): any {
    const url = getConfig().opencodeUrl
    if (!client || clientUrl !== url) {
      client = createOpencodeClient({ baseUrl: url })
      clientUrl = url
    }
    return client
  }
  // A Windows path (D:\foo\bar) is mapped to the WSL mount (/mnt/d/foo/bar) so
  // the opencode agent running in WSL can actually read/write it. Posix paths
  // pass through unchanged. (Assumes the opencode side is WSL; for a VM, mount
  // the share at a matching path.)
  const dir = (override?: string) => {
    const d = (override && override.trim()) || getConfig().directory
    return d ? { directory: winToLinux(d) } : undefined
  }

  async function send(req: ChatSendReq): Promise<ChatSendRes> {
    const url = getConfig().opencodeUrl
    try {
      const client = c()
      const q = dir(req.directory)
      let sessionId = req.sessionId
      if (!sessionId) {
        const created = await client.session.create({ body: {}, query: q })
        if (created.error || !created.data) return { ok: false, error: describe(created.error) ?? "创建 session 失败(opencode serve 在跑吗?)" }
        sessionId = created.data.id as string
      }
      const parts: Array<Record<string, unknown>> = []
      if (req.text) parts.push({ type: "text", text: req.text })
      if (req.imageDataUrl) parts.push({ type: "file", mime: mimeOf(req.imageDataUrl), filename: "clipboard.png", url: req.imageDataUrl })
      for (const f of req.files ?? []) parts.push({ type: "file", mime: f.mime, filename: f.name, url: f.dataUrl })
      if (parts.length === 0) return { ok: false, error: "空消息" }

      const body: Record<string, unknown> = { parts }
      // Per-message override wins; else the global default (mailflow + anything
      // that doesn't pick a model); else opencode's own default.
      const chosen = req.model ?? getConfig().model
      if (chosen) body.model = { providerID: chosen.providerID, modelID: chosen.modelID }

      const res = await client.session.prompt({ path: { id: sessionId }, body, query: q })
      if (res.error || !res.data) return { ok: false, error: describe(res.error) ?? "prompt 失败" }
      return { ok: true, reply: textOf(res.data.parts) || "(模型没有返回文本)", sessionId }
    } catch (e) {
      return { ok: false, error: connectHint(e, url) }
    }
  }

  async function createSession(directory?: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    const url = getConfig().opencodeUrl
    try {
      const created = await c().session.create({ body: {}, query: dir(directory) })
      if (created.error || !created.data) return { ok: false, error: describe(created.error) ?? "创建 session 失败" }
      return { ok: true, sessionId: created.data.id as string }
    } catch (e) {
      return { ok: false, error: connectHint(e, url) }
    }
  }

  async function sessions(): Promise<ChatSession[]> {
    try {
      const res = await c().session.list({ query: dir() })
      const list = (res.data ?? []) as any[]
      return list
        // Task 工具派生的 subagent 会话带 parentID —— 监控/侧栏只看主会话
        .filter((s) => !s.parentID)
        .map((s) => ({
          id: s.id as string,
          title: (s.title as string) || "(未命名会话)",
          createdAt: numAt(s.time?.created ?? s.created),
          updatedAt: numAt(s.time?.updated ?? s.updated ?? s.time?.created),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  /** Pending permission/question requests, keyed by session. Live serve ≥1.16
   *  exposes GLOBAL lists (GET /permission, GET /question — verified on 1.16.2);
   *  the bundled SDK predates them, so plain fetch. Failure → empty (老版本). */
  async function pendingAsks(): Promise<Map<string, ChatPendingAsk>> {
    const base = getConfig().opencodeUrl.replace(/\/+$/, "")
    const bySession = new Map<string, ChatPendingAsk>()
    const grab = async (path: string): Promise<any[]> => {
      try {
        const r = await fetch(base + path, { signal: AbortSignal.timeout(4000) })
        if (!r.ok) return []
        const j = await r.json()
        return Array.isArray(j) ? j : []
      } catch {
        return []
      }
    }
    const [perms, questions] = await Promise.all([grab("/permission"), grab("/question")])
    // questions first — they're the commoner stuck-session case; a permission for
    // the same session would overwrite otherwise (one card per session is enough).
    for (const p of perms) {
      if (!p?.id || !p?.sessionID) continue
      bySession.set(String(p.sessionID), {
        kind: "permission",
        requestId: String(p.id),
        sessionID: String(p.sessionID),
        permission: typeof p.permission === "string" ? p.permission : undefined,
        patterns: Array.isArray(p.patterns) ? p.patterns.map(String) : undefined,
      })
    }
    for (const q of questions) {
      if (!q?.id || !q?.sessionID) continue
      bySession.set(String(q.sessionID), {
        kind: "question",
        requestId: String(q.id),
        sessionID: String(q.sessionID),
        questions: Array.isArray(q.questions)
          ? q.questions.map((x: any) => ({
              question: String(x?.question ?? ""),
              header: typeof x?.header === "string" ? x.header : undefined,
              options: Array.isArray(x?.options)
                ? x.options.map((o: any) => ({
                    label: String(o?.label ?? ""),
                    description: typeof o?.description === "string" ? o.description : undefined,
                  }))
                : [],
              multiple: x?.multiple === true,
              custom: x?.custom === true,
            }))
          : [],
      })
    }
    return bySession
  }

  /** Answer a pending permission/question. 404 = already answered elsewhere
   *  (e.g. in the TUI) — treated as success so the UI just clears. */
  async function replyAsk(req: ChatAskReply): Promise<{ ok: boolean; error?: string }> {
    const base = getConfig().opencodeUrl.replace(/\/+$/, "")
    const post = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(8000),
      })
      if (r.ok || r.status === 404) return { ok: true }
      return { ok: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }
    }
    try {
      if (req.kind === "permission") {
        return await post(`/permission/${encodeURIComponent(req.requestId)}/reply`, { reply: req.reply })
      }
      if (req.reject) return await post(`/question/${encodeURIComponent(req.requestId)}/reject`)
      return await post(`/question/${encodeURIComponent(req.requestId)}/reply`, { answers: req.answers ?? [] })
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  /** Live status of the most recent sessions — the 会话监控 backend. Summaries
   *  come from each session's message tail: opencode persists parts incrementally
   *  during a turn, so "latest parts" ≡ "live progress" with plain reads. */
  async function monitor(limit = 12): Promise<ChatMonitorEntry[]> {
    const list = await sessions()
    const top = list.slice(0, Math.max(1, Math.min(limit, 24)))
    const now = Date.now()
    // First-class busy signal: GET /session/status returns ONLY the non-idle
    // sessions ({id:{type:"busy"|"retry"}}; verified empirically on serve 1.16.2
    // — {} when everything is idle). So when the call succeeds, absence from the
    // map means idle, authoritatively. Only fall back to the tool-part heuristic
    // when the endpoint itself is unavailable (a stuck "running" tool part from a
    // crashed old turn would otherwise show busy forever).
    let statusMap: Record<string, { type?: string; attempt?: number; message?: string }> = {}
    let statusOk = false
    const [statusRes, asks] = await Promise.all([
      c()
        .session.status({ query: dir() })
        .catch(() => undefined),
      pendingAsks(),
    ])
    if (statusRes !== undefined) {
      statusMap = ((statusRes?.data ?? statusRes) as typeof statusMap) ?? {}
      statusOk = true
    }
    const entries = await Promise.all(
      top.map(async (s): Promise<ChatMonitorEntry> => {
        const base: ChatMonitorEntry = { id: s.id, title: s.title, updatedAt: s.updatedAt, busy: false }
        try {
          const msgs = await history(s.id)
          if (msgs.length === 0) return base
          // last user text → “当前任务”
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "user" && msgs[i].text) {
              base.task = clip(msgs[i].text, 180)
              break
            }
          }
          // latest assistant message → progress + tool counts + busy
          const lastA = [...msgs].reverse().find((m) => m.role === "assistant")
          const parts = lastA?.parts ?? []
          const tools = { running: 0, completed: 0, error: 0 }
          for (const p of parts) {
            if (p.kind !== "tool") continue
            if (p.status === "running" || p.status === "pending") tools.running++
            else if (p.status === "error") tools.error++
            else tools.completed++
          }
          if (parts.length > 0) base.tools = tools
          const lastPart = parts[parts.length - 1]
          if (lastPart) {
            if (lastPart.kind === "tool") {
              const sum = summaryOfInput(lastPart.input)
              base.progress = { kind: "tool", text: sum ? `${lastPart.tool} · ${sum}` : lastPart.tool, status: lastPart.status }
            } else if (lastPart.kind === "text" || lastPart.kind === "reasoning") {
              base.progress = { kind: lastPart.kind, text: clip(lastPart.text, 160) }
            }
          }
          const stEntry = statusMap[s.id]
          const st = stEntry?.type
          base.busy = statusOk ? st != null && st !== "idle" : tools.running > 0 || now - s.updatedAt < 90_000
          if (st === "retry") {
            // Provider error being retried (refusal / gateway failure / rate
            // limit) — surface it, otherwise the card shows an endless 运行中.
            base.state = "retry"
            base.stateDetail = [stEntry?.attempt ? `第 ${stEntry.attempt} 次重试` : undefined, stEntry?.message]
              .filter(Boolean)
              .join(":")
          } else if (base.busy) {
            base.state = "busy"
          }
          // Busy but the model hasn't produced anything yet → say so explicitly
          // instead of leaving the progress line empty ("怎么没反应").
          if (base.busy && !lastA) {
            base.progress = { kind: "text", text: "已发送,等待模型响应…" }
          }
          // A pending permission/question parks the session until answered —
          // attach it so the panel can render reply buttons.
          const ask = asks.get(s.id)
          if (ask) base.ask = ask
          // Todo progress: the agent's own task list = the LAST todowrite call's
          // input, anywhere in the session (walk backwards across messages).
          outer: for (let i = msgs.length - 1; i >= 0; i--) {
            const ps = msgs[i].parts ?? []
            for (let j = ps.length - 1; j >= 0; j--) {
              const p = ps[j]
              if (p.kind === "tool" && p.tool === "todowrite") {
                base.todos = todoProgress(p.input)
                break outer
              }
            }
          }
        } catch {
          /* session unreadable — show the bare card */
        }
        return base
      }),
    )
    return entries
  }

  async function history(sessionId: string): Promise<ChatMsg[]> {
    try {
      const res = await c().session.messages({ path: { id: sessionId }, query: dir() })
      const list = (res.data ?? []) as any[]
      return list
        .map((m) => {
          const parts = mapParts(m.parts)
          const errText = describe(m.info?.error)
          if (errText) parts.push({ kind: "error", text: errText })
          return {
            id: m.info?.id as string | undefined,
            role: (m.info?.role ?? "assistant") as ChatMsg["role"],
            text: textOf(m.parts),
            parts,
            at: numAt(m.info?.time?.created),
          }
        })
        // keep any message that has SOMETHING to show (text, a tool call, an error…)
        .filter((m) => (m.parts?.length ?? 0) > 0 || m.text)
    } catch {
      return []
    }
  }

  async function models(directory?: string): Promise<ModelInfo[]> {
    try {
      const res = await c().provider.list({ query: dir(directory) })
      const data = (res?.data ?? res) as any
      const all = (data?.all ?? []) as any[]
      const connected: string[] = data?.connected ?? []
      const out: ModelInfo[] = []
      for (const p of all) {
        const conn = connected.includes(p.id)
        for (const mid of Object.keys(p.models ?? {})) {
          const m = p.models[mid]
          out.push({
            providerID: p.id,
            modelID: (m?.id as string) ?? mid,
            label: `${p.name ?? p.id} / ${m?.name ?? mid}`,
            connected: conn,
          })
        }
      }
      return out.sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label))
    } catch {
      return []
    }
  }

  async function undo(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const msgs = await c().session.messages({ path: { id: sessionId }, query: dir() })
      const list = (msgs.data ?? []) as any[]
      const messageID = list[list.length - 1]?.info?.id
      if (!messageID) return { ok: false, error: "没有可撤销的消息" }
      const res = await c().session.revert({ path: { id: sessionId }, body: { messageID }, query: dir() })
      if (res?.error) return { ok: false, error: describe(res.error) }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  async function deleteSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const del = c().session.delete
      if (typeof del !== "function") return { ok: false, error: "当前 SDK 不支持删除会话" }
      const res = await del({ path: { id: sessionId }, query: dir() })
      if (res?.error) return { ok: false, error: describe(res.error) }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  return { send, createSession, monitor, replyAsk, reset: () => {}, sessions, history, models, undo, deleteSession }
}

/** Truncate for card display. */
function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n) + "…" : t
}

/** Todo progress from a todowrite input ({todos: [{content, status}]}). */
function todoProgress(input: unknown): { done: number; total: number; current?: string } | undefined {
  const todos = (input as { todos?: unknown })?.todos
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  let done = 0
  let current: string | undefined
  for (const t of todos as Array<{ content?: string; status?: string }>) {
    if (t?.status === "completed") done++
    else if (!current && t?.status === "in_progress" && typeof t.content === "string") current = clip(t.content, 60)
  }
  return { done, total: todos.length, current }
}

/** One-line summary of a tool call's input (path / command / pattern / url…). */
function summaryOfInput(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const i = input as Record<string, unknown>
  const pick = i.filePath ?? i.path ?? i.command ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.title
  return typeof pick === "string" ? clip(pick, 80) : ""
}

/** Flatten an opencode message's parts into our display parts. Drops pure-noise
 *  parts (step-start/step-finish/snapshot) and keeps text, reasoning (thinking),
 *  tool calls (with their live state), and file attachments. File data URLs are
 *  intentionally NOT carried — only a chip's worth of metadata — so polling the
 *  history during a turn stays cheap. */
function mapParts(parts: unknown): ChatPart[] {
  const out: ChatPart[] = []
  for (const p of (parts ?? []) as any[]) {
    switch (p?.type) {
      case "text":
        if (typeof p.text === "string" && p.text.trim()) out.push({ kind: "text", text: p.text })
        break
      case "reasoning":
        if (typeof p.text === "string" && p.text.trim()) out.push({ kind: "reasoning", text: p.text })
        break
      case "file":
        out.push({ kind: "file", mime: String(p.mime ?? ""), filename: p.filename })
        break
      case "tool": {
        const st = p.state ?? {}
        const status = ["pending", "running", "completed", "error"].includes(st.status) ? st.status : "pending"
        out.push({
          kind: "tool",
          tool: String(p.tool ?? "tool"),
          status,
          input: st.input,
          output: typeof st.output === "string" ? st.output : st.output != null ? safeJson(st.output) : undefined,
          error: typeof st.error === "string" ? st.error : st.error != null ? describe(st.error) : undefined,
          title: typeof st.title === "string" && st.title ? st.title : undefined,
        })
        break
      }
      // step-start / step-finish / snapshot / patch / agent: skipped (noise / not displayed)
    }
  }
  return out
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function textOf(parts: unknown): string {
  return ((parts ?? []) as Array<{ type?: string; text?: string }>)
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim()
}
function numAt(v: unknown): number {
  return typeof v === "number" ? v : 0
}
function mimeOf(dataUrl: string): string {
  return /^data:([^;]+);/.exec(dataUrl)?.[1] ?? "image/png"
}
/** Map a Windows path to the Linux side opencode runs on: the WSL convention
 *  (D:\ → /mnt/d/); posix paths pass through unchanged. (The configurable
 *  prefix-map feature was removed — everything runs in the VM now.) */
function winToLinux(p: string): string {
  const s = p.trim()
  if (!s) return s
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(s)
  return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}` : s
}
function describe(err: unknown): string | undefined {
  if (!err) return undefined
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
function connectHint(e: unknown, url: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  return `连不上 opencode(${url}):${msg}。确认 opencode serve 在跑。`
}
