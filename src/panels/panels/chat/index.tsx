/**
 * Chat panel — a complete opencode session client (TUI/web-grade):
 *   - sessions sidebar (list real opencode sessions, switch, new, delete)
 *   - model switcher (provider.list → per-prompt model override)
 *   - markdown + code-block rendering of assistant replies (marked)
 *   - full history loaded from opencode (session.messages)
 *   - slash commands: /new /clear /undo /models /sessions
 *   - paste-image attach, Ctrl/⌘+Enter to send
 *
 * State source of truth is opencode (sessions persisted in opencode.db); the
 * panel just mirrors it. The selected model + current session id persist in
 * localStorage so a reload restores where you were.
 */
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { marked } from "marked"
import { registerPanel } from "../../registry"
import { api } from "../../bridge"
import { Icon } from "../../icons"
import { buildAttachmentPayload, readFiles, type Attachment } from "../../attach"
import type { ChatMsg, ChatPart, ChatToolStatus, ChatSession, ModelInfo, ModelRef } from "../../global"
import "./chat.css"

marked.setOptions({ gfm: true, breaks: true })
const md = (t: string) => marked.parse(t, { async: false }) as string

// ── TUI-grade message rendering ──────────────────────────────────────────────
const TOOL_STATUS: Record<ChatToolStatus, { label: string; icon: string }> = {
  pending: { label: "待运行", icon: "circle" },
  running: { label: "运行中", icon: "activity" },
  completed: { label: "完成", icon: "check" },
  error: { label: "出错", icon: "alert-triangle" },
}

/** A one-line summary of a tool call pulled from whichever common input field is
 *  present (path / command / pattern / url …) — what the TUI shows next to a tool. */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const i = input as Record<string, unknown>
  const pick =
    i.filePath ?? i.path ?? i.command ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt ?? i.title
  return typeof pick === "string" ? pick : ""
}
function prettyInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} 字符)` : s
}

function ToolCard(props: { p: Extract<ChatPart, { kind: "tool" }> }) {
  const st = () => TOOL_STATUS[props.p.status]
  const summary = createMemo(() => toolSummary(props.p.input))
  const body = createMemo(() => props.p.error ?? props.p.output ?? "")
  return (
    <details class="tool-card" data-status={props.p.status}>
      <summary>
        <Icon name="terminal" size={13} />
        <span class="tool-name">{props.p.tool}</span>
        <Show when={summary()}>
          <span class="tool-sum">{summary()}</span>
        </Show>
        <span class={`tool-badge ${props.p.status}`}>
          <Icon name={st().icon} size={11} />
          {st().label}
        </span>
      </summary>
      <Show when={props.p.input != null}>
        <pre class="tool-io">{clip(prettyInput(props.p.input), 2000)}</pre>
      </Show>
      <Show when={body()}>
        <pre class={`tool-io ${props.p.error ? "err" : "out"}`}>{clip(body(), 4000)}</pre>
      </Show>
    </details>
  )
}

function ReasoningCard(props: { text: string }) {
  const preview = createMemo(() => props.text.replace(/\s+/g, " ").trim().slice(0, 72))
  return (
    <details class="reason-card">
      <summary>
        <Icon name="lightbulb" size={13} />
        <span class="reason-label">思考</span>
        <span class="reason-preview">{preview()}…</span>
      </summary>
      <div class="reason-body">{props.text}</div>
    </details>
  )
}

/** Render one message body — the structured parts if we have them (TUI view),
 *  else the joined text as markdown (assistant) / plain (user, system). */
function MsgBody(props: { m: ChatMsg }) {
  const text = (t: string) =>
    props.m.role === "assistant" ? (
      // eslint-disable-next-line solid/no-innerhtml
      <div class="markdown" innerHTML={md(t)} />
    ) : (
      <div class="plain">{t}</div>
    )
  return (
    <Show when={props.m.parts && props.m.parts.length > 0} fallback={text(props.m.text)}>
      <div class="parts">
        <For each={props.m.parts}>
          {(p) => (
            <Switch>
              <Match when={p.kind === "tool"}>
                <ToolCard p={p as Extract<ChatPart, { kind: "tool" }>} />
              </Match>
              <Match when={p.kind === "reasoning"}>
                <ReasoningCard text={(p as Extract<ChatPart, { kind: "reasoning" }>).text} />
              </Match>
              <Match when={p.kind === "error"}>
                <div class="part-error">
                  <Icon name="alert-triangle" size={14} />
                  <span>{(p as Extract<ChatPart, { kind: "error" }>).text}</span>
                </div>
              </Match>
              <Match when={p.kind === "file"}>
                <span class="part-file">
                  <Icon name="file-text" size={13} />
                  {(p as Extract<ChatPart, { kind: "file" }>).filename ?? "附件"}
                </span>
              </Match>
              <Match when={p.kind === "text"}>{text((p as Extract<ChatPart, { kind: "text" }>).text)}</Match>
            </Switch>
          )}
        </For>
      </div>
    </Show>
  )
}

const LS_SESSION = "winhost-chat-session"
const LS_MODEL = "winhost-chat-model"
const LS_RAIL = "winhost-chat-rail-collapsed"

const COMMANDS: Array<{ name: string; desc: string }> = [
  { name: "new", desc: "开始新会话" },
  { name: "clear", desc: "清空(开新会话)" },
  { name: "undo", desc: "撤销上一条消息" },
  { name: "models", desc: "刷新模型列表" },
  { name: "sessions", desc: "刷新会话列表" },
]
const SEP = ""

function loadModel(): ModelRef | undefined {
  try {
    const s = localStorage.getItem(LS_MODEL)
    return s ? (JSON.parse(s) as ModelRef) : undefined
  } catch {
    return undefined
  }
}

function ChatPanel() {
  const [sessions, setSessions] = createSignal<ChatSession[]>([])
  const [models, setModels] = createSignal<ModelInfo[]>([])
  const [activeId, setActiveId] = createSignal<string | undefined>(localStorage.getItem(LS_SESSION) || undefined)
  const [msgs, setMsgs] = createSignal<ChatMsg[]>([])
  const [model, setModelSig] = createSignal<ModelRef | undefined>(loadModel())
  const [input, setInput] = createSignal("")
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [dragOver, setDragOver] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | undefined>()
  const [sessionsOpen, setSessionsOpen] = createSignal(false) // slide-over when narrow
  const [railCollapsed, setRailCollapsed] = createSignal(localStorage.getItem(LS_RAIL) === "1") // hide list (wide)
  const [slashIdx, setSlashIdx] = createSignal(0) // highlighted slash-menu row
  let fileEl: HTMLInputElement | undefined

  const toggleRail = () => {
    const v = !railCollapsed()
    setRailCollapsed(v)
    try {
      localStorage.setItem(LS_RAIL, v ? "1" : "0")
    } catch {
      /* ignore */
    }
  }

  // Slash-command menu: shown while typing "/cmd" (before any space).
  const slashMenu = createMemo(() => {
    const v = input()
    if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) return []
    const q = v.slice(1).toLowerCase()
    return COMMANDS.filter((c) => c.name.startsWith(q))
  })

  /** Add picked/dropped/pasted files as inline attachments (no path/dir needed). */
  async function addFiles(files: FileList | File[]) {
    setErr(undefined)
    try {
      const atts = await readFiles(files)
      setAttachments((a) => [...a, ...atts])
    } catch {
      /* ignore unreadable files */
    }
  }

  let logEl: HTMLDivElement | undefined
  const scrollDown = (smooth = true) =>
    queueMicrotask(() => logEl?.scrollTo({ top: logEl.scrollHeight, behavior: smooth ? "smooth" : "auto" }))
  // Opening a session should land at the END instantly, not animate down through
  // the whole history. rAF so the markdown has laid out before we jump.
  const jumpToEnd = () => requestAnimationFrame(() => requestAnimationFrame(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight }))
  // Only auto-follow the stream if the user is already near the bottom — never
  // yank them upward while they're scrolled up reading earlier output.
  const nearBottom = () => !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 120

  // Live updates: while a turn is in flight, poll the session's history so the
  // panel mirrors the TUI (thinking, tool calls, mid-loop text) as it streams.
  // opencode persists parts incrementally, so a plain poll of session.messages
  // surfaces progress without any SSE relay.
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const stopPoll = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
  }
  const startPoll = (id: string) => {
    stopPoll()
    pollTimer = setInterval(async () => {
      try {
        const h = await api.chat.history(id)
        if (h.length) {
          const follow = nearBottom()
          setMsgs(h)
          if (follow) scrollDown(false)
        }
      } catch {
        /* transient — keep polling */
      }
    }, 900)
  }
  onCleanup(stopPoll)

  const refreshSessions = async () => {
    try {
      setSessions(await api.chat.sessions())
    } catch {
      /* daemon down */
    }
  }
  const loadHistory = async (id?: string) => {
    if (!id) {
      setMsgs([])
      return
    }
    try {
      setMsgs(await api.chat.history(id))
    } catch {
      setMsgs([])
    }
    jumpToEnd()
  }

  onMount(async () => {
    try {
      setModels(await api.chat.models())
    } catch {
      /* no models */
    }
    if (!model()) {
      const m = models().find((x) => x.connected) ?? models()[0]
      if (m) setModelSig({ providerID: m.providerID, modelID: m.modelID })
    }
    await refreshSessions()
    await loadHistory(activeId())
  })

  const modelValue = createMemo(() => {
    const m = model()
    return m ? m.providerID + SEP + m.modelID : ""
  })

  // 5000+ models exist; show the connected (usable) ones. Fall back to a capped
  // slice of all if nothing is connected yet.
  const modelOptions = createMemo(() => {
    const connected = models().filter((m) => m.connected)
    return connected.length ? connected : models().slice(0, 150)
  })

  function setModel(v: string) {
    const [providerID, modelID] = v.split(SEP)
    const ref: ModelRef = { providerID, modelID }
    setModelSig(ref)
    try {
      localStorage.setItem(LS_MODEL, JSON.stringify(ref))
    } catch {
      /* ignore */
    }
  }

  function newChat() {
    setActiveId(undefined)
    localStorage.removeItem(LS_SESSION)
    setMsgs([])
    setErr(undefined)
  }
  async function selectSession(id: string) {
    setActiveId(id)
    localStorage.setItem(LS_SESSION, id)
    setErr(undefined)
    setSessionsOpen(false)
    await loadHistory(id)
  }
  async function delSession(id: string, e: Event) {
    e.stopPropagation()
    await api.chat.deleteSession(id)
    if (activeId() === id) newChat()
    await refreshSessions()
  }

  /** Paste images straight into the compose box (Ctrl+V), e.g. a screenshot. */
  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    const imgs: File[] = []
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile()
        if (f) imgs.push(f)
      }
    }
    if (imgs.length) {
      e.preventDefault()
      void addFiles(imgs)
    }
  }

  /** Drag-drop files onto the compose box. */
  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const fs = e.dataTransfer?.files
    if (fs && fs.length) void addFiles(fs)
  }

  async function runCommand(cmd: string): Promise<void> {
    const name = cmd.slice(1).split(/\s+/)[0]
    switch (name) {
      case "new":
      case "clear":
        newChat()
        return
      case "sessions":
        await refreshSessions()
        return
      case "models":
        setModels(await api.chat.models())
        return
      case "undo": {
        const id = activeId()
        if (!id) {
          setErr("没有会话可撤销")
          return
        }
        const r = await api.chat.undo(id)
        if (!r.ok) setErr(r.error)
        await loadHistory(id)
        return
      }
      default:
        setErr(`未知命令 /${name}(可用:/new /clear /undo /models /sessions)`)
    }
  }

  async function send() {
    const text = input().trim()
    const atts = attachments()
    if (!text && atts.length === 0) return
    if (text.startsWith("/")) {
      setInput("")
      await runCommand(text)
      return
    }
    // Attachments inline: text/code into the prompt, images/binaries as file parts.
    const { textSuffix, files } = buildAttachmentPayload(atts)
    setErr(undefined)
    setBusy(true)
    setMsgs([...msgs(), { role: "user", text: text || "（附件）" }])
    setInput("")
    setAttachments([])
    scrollDown()

    // Get a session id up front (creating one if needed) so we can stream the
    // FIRST turn too — opencode persists parts as they arrive, so polling its
    // history mirrors the TUI live.
    let id = activeId()
    if (!id) {
      const cr = await api.chat.createSession()
      if (cr.ok && cr.sessionId) {
        id = cr.sessionId
        setActiveId(id)
        localStorage.setItem(LS_SESSION, id)
        void refreshSessions()
      }
    }
    if (id) startPoll(id)

    // try/finally so a thrown send never leaves the spinner / poll stuck.
    try {
      const res = await api.chat.send({ text: text + textSuffix, files, sessionId: id, model: model() })
      stopPoll()
      if (!res.ok) {
        setErr(res.error)
        // pull whatever the server got before the failure, but never wipe the
        // optimistic bubble if it has nothing.
        if (id) {
          const h = await api.chat.history(id).catch(() => [] as ChatMsg[])
          if (h.length) setMsgs(h)
        }
        setMsgs([...msgs(), { role: "system", text: `⚠ ${res.error ?? "发送失败"}` }])
      } else {
        const sid = id ?? res.sessionId
        if (sid) {
          if (!activeId()) {
            setActiveId(sid)
            localStorage.setItem(LS_SESSION, sid)
            void refreshSessions()
          }
          await loadHistory(sid) // authoritative rich history (TUI parts)
        } else {
          setMsgs([...msgs(), { role: "assistant", text: res.reply ?? "(空回复)" }])
        }
      }
    } catch (e) {
      stopPoll()
      if (id) {
        const h = await api.chat.history(id).catch(() => [] as ChatMsg[])
        if (h.length) setMsgs(h)
      }
      setMsgs([...msgs(), { role: "system", text: `⚠ ${e instanceof Error ? e.message : String(e)}` }])
    } finally {
      stopPoll()
      setBusy(false)
      scrollDown()
    }
  }

  function onKey(e: KeyboardEvent) {
    const menu = slashMenu()
    // Slash-menu navigation: ↑/↓ move the highlight, Enter runs it, Esc closes.
    if (menu.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSlashIdx((i) => Math.min(menu.length - 1, i + 1))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSlashIdx((i) => Math.max(0, i - 1))
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setInput("")
        return
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        const c = menu[slashIdx()] ?? menu[0]
        setInput("")
        void runCommand("/" + c.name)
        return
      }
    }
    // Enter sends; Shift+Enter inserts a newline. isComposing guards CJK IME so
    // confirming a pinyin candidate with Enter doesn't fire a send.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div class="chat" data-collapsed={railCollapsed()}>
      <aside class="chat-rail" data-open={sessionsOpen()}>
        <button class="chat-new" onClick={newChat}>
          <Icon name="plus" size={16} /> 新会话
        </button>
        <div class="chat-sessions">
          <For each={sessions()} fallback={<div class="chat-empty-sm">还没有会话</div>}>
            {(s) => (
              <div class="chat-sess" data-active={s.id === activeId()} onClick={() => void selectSession(s.id)}>
                <Icon name="message-square" size={14} />
                <span class="chat-sess-title">{s.title}</span>
                <button class="chat-sess-del" title="删除会话" onClick={(e) => void delSession(s.id, e)}>
                  <Icon name="trash-2" size={13} />
                </button>
              </div>
            )}
          </For>
        </div>
      </aside>

      <div class="chat-main">
        <div class="chat-bar">
          <div class="chat-bar-left">
            <button
              class="icon-btn chat-sessions-toggle"
              title="会话列表"
              onClick={() => setSessionsOpen((v) => !v)}
            >
              <Icon name="panel-left" size={17} />
            </button>
            <button
              class="icon-btn chat-rail-collapse"
              title={railCollapsed() ? "显示会话列表" : "隐藏会话列表(腾出宽度)"}
              data-on={railCollapsed()}
              onClick={toggleRail}
            >
              <Icon name="panel-left" size={17} />
            </button>
            <label class="chat-model">
            <Icon name="cpu" size={15} />
            <select value={modelValue()} onChange={(e) => setModel(e.currentTarget.value)}>
              <Show when={models().length === 0}>
                <option value="">默认模型</option>
              </Show>
              <For each={modelOptions()}>
                {(m) => (
                  <option value={m.providerID + SEP + m.modelID}>
                    {m.label}
                    {m.connected ? "" : " (未连接)"}
                  </option>
                )}
              </For>
            </select>
            </label>
          </div>
          <div class="chat-actions">
            <button class="icon-btn" title="撤销上一条" onClick={() => void runCommand("/undo")} disabled={!activeId()}>
              <Icon name="rotate-ccw" size={16} />
            </button>
            <button class="icon-btn" title="刷新会话列表" onClick={() => void refreshSessions()}>
              <Icon name="refresh-cw" size={16} />
            </button>
          </div>
        </div>

        <div class="chat-log" ref={logEl}>
          <Show
            when={msgs().length > 0}
            fallback={
              <div class="chat-hello">
                <div class="chat-hello-mark">
                  <Icon name="message-square" size={26} />
                </div>
                <p>开始一个对话 —— 例如「读我最近的邮件并总结」。</p>
                <p class="muted">支持 /new /undo /models /clear · Enter 发送 · Shift+Enter 换行</p>
              </div>
            }
          >
            <For each={msgs()}>
              {(m) => (
                <div class={`row-msg ${m.role}`}>
                  <div class="avatar" aria-hidden="true">
                    <Show when={m.role !== "user"} fallback={<span>你</span>}>
                      <Show when={m.role === "assistant"} fallback={<Icon name="bell" size={14} />}>
                        <Icon name="cpu" size={15} />
                      </Show>
                    </Show>
                  </div>
                  <div class="bubble">
                    <MsgBody m={m} />
                  </div>
                </div>
              )}
            </For>
            <Show when={busy()}>
              <div class="row-msg assistant thinking">
                <div class="avatar" aria-hidden="true">
                  <Icon name="cpu" size={15} />
                </div>
                <div class="bubble">
                  <span class="typing" role="status" aria-label="思考中">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span class="typing-label">思考中…</span>
                </div>
              </div>
            </Show>
          </Show>
        </div>

        <Show when={err()}>
          <div class="error" style={{ padding: "6px 18px 0" }}>
            {err()}
          </div>
        </Show>

        <div class="chat-compose">
          <Show when={slashMenu().length > 0}>
            <div class="slash-menu">
              <For each={slashMenu()}>
                {(c, i) => (
                  <button
                    class="slash-item"
                    data-active={i() === slashIdx()}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSlashIdx(i())}
                    onClick={() => {
                      setInput("")
                      void runCommand("/" + c.name)
                    }}
                  >
                    <span class="slash-name">/{c.name}</span>
                    <span class="slash-desc">{c.desc}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={attachments().length > 0}>
            <div class="attach-chips">
              <For each={attachments()}>
                {(a, i) => (
                  <span class="attach-chip" title={a.name}>
                    <Show when={a.isImage && a.dataUrl} fallback={<Icon name="file-text" size={14} />}>
                      <img src={a.dataUrl} alt="" />
                    </Show>
                    <span class="attach-chip-name">{a.name}</span>
                    <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i()))} title="移除">
                      <Icon name="x" size={13} />
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div
            class="compose-box"
            data-drag={dragOver()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <textarea
              placeholder="输入消息(Enter 发送 · Shift+Enter 换行),或 / 命令…  可粘贴/拖拽文件"
              value={input()}
              onInput={(e) => {
                setInput(e.currentTarget.value)
                setSlashIdx(0)
              }}
              onKeyDown={onKey}
              onPaste={onPaste}
            />
            <div class="compose-actions">
              <input
                type="file"
                multiple
                ref={fileEl}
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.currentTarget.files) void addFiles(e.currentTarget.files)
                  e.currentTarget.value = ""
                }}
              />
              <button class="icon-btn" title="附加文件 / 图片" onClick={() => fileEl?.click()}>
                <Icon name="paperclip" size={18} />
              </button>
              <button class="btn send" disabled={busy()} onClick={send}>
                <Icon name="send" size={16} />
                {busy() ? "发送中…" : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

registerPanel({ id: "chat", title: "对话", icon: "message-square", render: () => <ChatPanel /> })
