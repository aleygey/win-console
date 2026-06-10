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
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { marked } from "marked"
import { registerPanel } from "../../registry"
import { api } from "../../bridge"
import { Icon } from "../../icons"
import type { ChatMsg, ChatSession, ModelInfo, ModelRef } from "../../global"
import "./chat.css"

marked.setOptions({ gfm: true, breaks: true })
const md = (t: string) => marked.parse(t, { async: false }) as string

const LS_SESSION = "winhost-chat-session"
const LS_MODEL = "winhost-chat-model"
const LS_DIR = "winhost-chat-dir"

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
  const [img, setImg] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | undefined>()
  const [sessionsOpen, setSessionsOpen] = createSignal(false) // slide-over when narrow
  const [dir, setDir] = createSignal(localStorage.getItem(LS_DIR) || "")
  const [slashIdx, setSlashIdx] = createSignal(0) // highlighted slash-menu row

  // Slash-command menu: shown while typing "/cmd" (before any space).
  const slashMenu = createMemo(() => {
    const v = input()
    if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) return []
    const q = v.slice(1).toLowerCase()
    return COMMANDS.filter((c) => c.name.startsWith(q))
  })

  async function applyDir(v: string) {
    setDir(v)
    try {
      localStorage.setItem(LS_DIR, v)
    } catch {
      /* ignore */
    }
    // Reload models with this directory so a project's own providers surface.
    try {
      setModels(await api.chat.models(v || undefined))
    } catch {
      /* ignore */
    }
  }

  let logEl: HTMLDivElement | undefined
  const scrollDown = () => queueMicrotask(() => logEl?.scrollTo({ top: logEl.scrollHeight, behavior: "smooth" }))

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
    scrollDown()
  }

  onMount(async () => {
    try {
      setModels(await api.chat.models(dir() || undefined))
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

  async function attachImage() {
    setErr(undefined)
    // Reads the OS clipboard via the daemon — only works under the Electron app
    // (the headless lite daemon has no clipboard access). Either way, pasting a
    // screenshot straight into the box (Ctrl+V) works everywhere via pasteImage.
    const d = await api.clipboard.image()
    if (!d) {
      setErr("没读到剪贴板图片 —— 可直接在输入框里 Ctrl+V 粘贴截图(需 OS 剪贴板读取请用 Electron 版)")
      return
    }
    setImg(d)
  }

  /** Capture an image pasted straight into the compose box (browser-level, works
   *  in the iframe / lite daemon too — no Electron/daemon clipboard needed). */
  function pasteImage(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile()
        if (!file) continue
        e.preventDefault()
        const reader = new FileReader()
        reader.onload = () => setImg(typeof reader.result === "string" ? reader.result : null)
        reader.readAsDataURL(file)
        return
      }
    }
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
    const image = img()
    if (!text && !image) return
    if (text.startsWith("/")) {
      setInput("")
      await runCommand(text)
      return
    }
    setErr(undefined)
    setBusy(true)
    setMsgs([...msgs(), { role: "user", text }])
    setInput("")
    setImg(null)
    scrollDown()

    const res = await api.chat.send({
      text,
      imageDataUrl: image,
      sessionId: activeId(),
      model: model(),
      directory: dir() || undefined,
    })
    setBusy(false)
    if (!res.ok) {
      setErr(res.error)
      setMsgs([...msgs(), { role: "system", text: `⚠ ${res.error ?? "发送失败"}` }])
    } else {
      if (!activeId() && res.sessionId) {
        setActiveId(res.sessionId)
        localStorage.setItem(LS_SESSION, res.sessionId)
        void refreshSessions()
      }
      setMsgs([...msgs(), { role: "assistant", text: res.reply ?? "(空回复)" }])
    }
    scrollDown()
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
    <div class="chat">
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
                    <Show when={m.role === "assistant"} fallback={<div class="plain">{m.text}</div>}>
                      {/* eslint-disable-next-line solid/no-innerhtml */}
                      <div class="markdown" innerHTML={md(m.text)} />
                    </Show>
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
          <Show when={img()}>
            <div class="img-chip">
              <img src={img()!} alt="" />
              <span class="muted">已附剪贴板图片</span>
              <button onClick={() => setImg(null)} title="移除">
                <Icon name="x" size={14} />
              </button>
            </div>
          </Show>
          <div class="compose-box">
            <textarea
              placeholder="输入消息(Enter 发送 · Shift+Enter 换行),或 / 命令…"
              value={input()}
              onInput={(e) => {
                setInput(e.currentTarget.value)
                setSlashIdx(0)
              }}
              onKeyDown={onKey}
              onPaste={pasteImage}
            />
            <div class="compose-actions">
              <div class="dir-field" title="工作目录:opencode 将能读写此目录;粘贴 Windows 路径会自动映射到 WSL">
                <Icon name="folder" size={15} />
                <input
                  class="dir-input"
                  placeholder="工作目录(粘贴 D:\路径 → opencode 可访问)"
                  value={dir()}
                  onChange={(e) => void applyDir(e.currentTarget.value)}
                />
                <Show when={dir()}>
                  <button class="icon-btn sm" title="清除目录" onClick={() => void applyDir("")}>
                    <Icon name="x" size={13} />
                  </button>
                </Show>
              </div>
              <button class="icon-btn" title="贴入剪贴板图片" onClick={attachImage}>
                <Icon name="image" size={18} />
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
