/**
 * 会话监控 — a wall of opencode session cards. Each card shows, at a glance,
 * what a session is doing: status (运行中 / 重试中 / ⏸等待确认 / 空闲), its task
 * (last user query), todo-list progress (the agent's own todowrite), and its
 * latest step. Click a card → a modal with the full timeline AND a compose box
 * (send a message, paste an image/file) — so you can nudge a stuck or finished
 * session without leaving the panel.
 *
 * Ordering: attention first — waiting-on-you, then running/retrying, then by
 * most-recent activity.
 *
 * Polling discipline (audit-informed): self-rescheduling timeouts (never
 * setInterval), paused while the document is hidden except the first load; the
 * modal runs its own busy-aware history poll only while open.
 */
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { registerPanel } from "../../registry"
import { api } from "../../bridge"
import { Icon } from "../../icons"
import { buildAttachmentPayload, readFiles, type Attachment } from "../../attach"
import { MsgBody } from "./parts"
import type { ChatAskReply, ChatMonitorEntry, ChatMsg, ChatPendingAsk } from "../../global"
import "./sessions.css"

const MONITOR_MS = 3000
const DETAIL_BUSY_MS = 1500
const DETAIL_IDLE_MS = 6000
const LS_REASONING = "winhost-sess-reasoning"

type Group = { key: string; label: string; items: ChatMonitorEntry[] }

/** Which day-bucket a timestamp falls in (今天 / 昨天 / 本周 / 更早). */
function dateBucket(ms: number): { key: string; label: string; order: number } {
  const now = new Date()
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= today0) return { key: "today", label: "今天", order: 0 }
  if (ms >= today0 - 86400000) return { key: "yesterday", label: "昨天", order: 1 }
  if (ms >= today0 - 6 * 86400000) return { key: "week", label: "本周", order: 2 }
  return { key: "older", label: "更早", order: 3 }
}

/** Bucket + label sessions into ordered groups. Active sessions (running /
 *  retrying / waiting on you) are always pinned to a top group so nothing
 *  urgent hides inside a date section; the rest fall into day buckets. */
function buildGroups(entries: ChatMonitorEntry[]): Group[] {
  const active: ChatMonitorEntry[] = []
  const rest: ChatMonitorEntry[] = []
  for (const e of entries) {
    if (e.busy || e.state === "retry" || e.ask) active.push(e)
    else rest.push(e)
  }
  active.sort((a, b) => statusOf(a).rank - statusOf(b).rank || b.updatedAt - a.updatedAt)

  const groups: Group[] = []
  if (active.length) groups.push({ key: "active", label: "进行中 · 待处理", items: active })

  const byBucket = new Map<string, { label: string; order: number; items: ChatMonitorEntry[] }>()
  for (const e of rest) {
    const b = dateBucket(e.updatedAt)
    const g = byBucket.get(b.key) ?? { label: b.label, order: b.order, items: [] }
    g.items.push(e)
    byBucket.set(b.key, g)
  }
  for (const [key, g] of [...byBucket.entries()].sort((a, b) => a[1].order - b[1].order)) {
    g.items.sort((a, b) => b.updatedAt - a.updatedAt)
    groups.push({ key, label: g.label, items: g.items })
  }
  return groups
}

function timeAgo(ms: number): string {
  if (!ms) return ""
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s 前`
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`
  return `${Math.floor(s / 86400)}天前`
}

/** The single status a card leads with — attention-ordered. */
type Status = { key: string; label: string; icon: string; rank: number }
function statusOf(e: ChatMonitorEntry): Status {
  if (e.ask) return { key: "waiting", label: e.ask.kind === "permission" ? "等待授权" : "等待回答", icon: "pause-circle", rank: 0 }
  if (e.state === "retry") return { key: "retry", label: "重试中", icon: "alert-triangle", rank: 1 }
  if (e.busy) return { key: "running", label: "运行中", icon: "activity", rank: 1 }
  return { key: "idle", label: "空闲", icon: "circle", rank: 4 }
}

/**
 * A pending permission / question parked on the session — answer it here so the
 * session doesn't hang. Permission → 3 buttons; question → options per question
 * (multi via checkboxes, custom via free text).
 */
function AskCard(props: { ask: ChatPendingAsk; onDone: () => void | Promise<void> }): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | undefined>()
  const [sel, setSel] = createSignal<Record<number, string[]>>({})
  const [free, setFree] = createSignal<Record<number, string>>({})

  async function send(reply: ChatAskReply) {
    setBusy(true)
    setErr(undefined)
    try {
      const r = await api.chat.replyAsk(reply)
      if (!r.ok) setErr(r.error ?? "提交失败")
      else await props.onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const questions = () => props.ask.questions ?? []
  const assembled = (): string[][] =>
    questions().map((_, i) => {
      const f = (free()[i] ?? "").trim()
      if (f) return [f]
      return sel()[i] ?? []
    })
  const complete = () => assembled().every((a) => a.length > 0)

  function toggleOption(qi: number, label: string, multiple: boolean | undefined) {
    setSel((s) => {
      const cur = s[qi] ?? []
      const next = multiple ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label]
      return { ...s, [qi]: next }
    })
    if (!multiple && questions().length === 1) {
      void send({ kind: "question", requestId: props.ask.requestId, answers: [[label]] })
    }
  }

  return (
    <div class="sess-ask">
      <div class="sess-ask-head">
        <Icon name="alert-triangle" size={14} />
        <b>{props.ask.kind === "permission" ? "权限申请 — 会话已暂停等待确认" : "agent 提问 — 会话已暂停等待回答"}</b>
      </div>

      <Show when={props.ask.kind === "permission"}>
        <div class="sess-ask-body">
          <div class="sess-ask-perm">
            请求权限:<code>{props.ask.permission ?? "unknown"}</code>
            <Show when={props.ask.patterns && props.ask.patterns.length > 0}>
              <span class="sess-ask-patterns">{props.ask.patterns!.join("  ")}</span>
            </Show>
          </div>
          <div class="sess-ask-actions">
            <button class="sess-ask-btn ok" disabled={busy()} onClick={() => void send({ kind: "permission", requestId: props.ask.requestId, reply: "once" })}>
              允许一次
            </button>
            <button class="sess-ask-btn" disabled={busy()} onClick={() => void send({ kind: "permission", requestId: props.ask.requestId, reply: "always" })}>
              总是允许
            </button>
            <button class="sess-ask-btn bad" disabled={busy()} onClick={() => void send({ kind: "permission", requestId: props.ask.requestId, reply: "reject" })}>
              拒绝
            </button>
          </div>
        </div>
      </Show>

      <Show when={props.ask.kind === "question"}>
        <div class="sess-ask-body">
          <Index each={questions()}>
            {(q, qi) => (
              <div class="sess-ask-q">
                <div class="sess-ask-qtext">{q().question}</div>
                <div class="sess-ask-opts">
                  <Index each={q().options}>
                    {(o) => (
                      <button
                        class="sess-ask-opt"
                        data-on={(sel()[qi] ?? []).includes(o().label)}
                        disabled={busy()}
                        title={o().description}
                        onClick={() => toggleOption(qi, o().label, q().multiple)}
                      >
                        {o().label}
                      </button>
                    )}
                  </Index>
                </div>
                <Show when={q().custom}>
                  <input
                    class="sess-ask-free"
                    placeholder="或输入自定义回答…"
                    value={free()[qi] ?? ""}
                    onInput={(e) => setFree((f) => ({ ...f, [qi]: e.currentTarget.value }))}
                  />
                </Show>
              </div>
            )}
          </Index>
          <div class="sess-ask-actions">
            <Show when={questions().length > 1 || questions().some((q) => q.multiple || q.custom)}>
              <button
                class="sess-ask-btn ok"
                disabled={busy() || !complete()}
                onClick={() => void send({ kind: "question", requestId: props.ask.requestId, answers: assembled() })}
              >
                提交回答
              </button>
            </Show>
            <button class="sess-ask-btn bad" disabled={busy()} onClick={() => void send({ kind: "question", requestId: props.ask.requestId, reject: true })}>
              拒绝作答
            </button>
          </div>
        </div>
      </Show>

      <Show when={err()}>
        <div class="sess-ask-err">{err()}</div>
      </Show>
    </div>
  )
}

/** One session card in the wall. */
function SessionCard(props: {
  e: ChatMonitorEntry
  /** taskflow 任务归属（会话由任务看板发起时显示角标，点击跳任务看板） */
  task?: { id: string; title: string }
  /** 卡片可拖走关联：（跨 iframe）拖到 Obsidian 看板卡片上 */
  draggable?: boolean
  dragMime?: string
  onOpen: () => void
}): JSX.Element {
  const st = () => statusOf(props.e)
  return (
    <button
      type="button"
      class="sess-card"
      data-status={st().key}
      draggable={props.draggable}
      onDragStart={(ev) => props.dragMime && ev.dataTransfer?.setData(props.dragMime, props.e.id)}
      onClick={props.onOpen}
    >
      <div class="sess-card-top">
        <span class="sess-status" data-status={st().key}>
          <Icon name={st().icon} size={12} />
          {st().label}
        </span>
        <Show when={props.task}>
          {(t) => (
            <span
              role="button"
              tabIndex={0}
              class="sess-task-chip"
              title={`任务 ${t().id} · ${t().title}（点击在 Obsidian 打开任务文档）`}
              onClick={(ev) => {
                ev.stopPropagation()
                // 任务看板面板已下线：请宿主（Obsidian 里的 winhost-console 插件）打开任务文档
                window.parent?.postMessage({ type: "winhost-open-task", id: t().id }, "*")
              }}
            >
              {t().id}
            </span>
          )}
        </Show>
        <span class="sess-spacer" />
        <span class="sess-card-time">{timeAgo(props.e.updatedAt)}</span>
      </div>

      <div class="sess-card-title">{props.e.title}</div>

      <Show when={props.e.task}>
        <div class="sess-task" title={props.e.task}>
          {props.e.task}
        </div>
      </Show>

      <Show when={props.e.todos}>
        {(t) => (
          <div class="sess-todo">
            <div class="sess-todo-row">
              <Icon name="list-checks" size={12} />
              <span class="sess-todo-count">
                {t().done}/{t().total}
              </span>
              <div class="sess-todo-bar">
                <div class="sess-todo-fill" style={{ width: `${t().total ? Math.round((t().done / t().total) * 100) : 0}%` }} />
              </div>
            </div>
            <Show when={t().current}>
              <div class="sess-todo-current" title={t().current}>
                ▸ {t().current}
              </div>
            </Show>
          </div>
        )}
      </Show>

      {/* latest step */}
      <Show when={props.e.progress}>
        {(p) => (
          <div class="sess-progress" title="最近一步动作">
            <span class="sess-progress-text">{p().text}</span>
          </div>
        )}
      </Show>

      <Show when={props.e.tools && (props.e.tools.running > 0 || props.e.tools.error > 0)}>
        <div class="sess-tools">
          <Show when={props.e.tools!.running > 0}>
            <span class="sess-tool-chip run">{props.e.tools!.running} 个工具运行中</span>
          </Show>
          <Show when={props.e.tools!.error > 0}>
            <span class="sess-tool-chip bad">{props.e.tools!.error} 个工具出错</span>
          </Show>
        </div>
      </Show>
    </button>
  )
}

/** The modal that opens on card click: live timeline + a compose box. */
function SessionModal(props: { id: string; entry: () => ChatMonitorEntry | undefined; onClose: () => void }): JSX.Element {
  const [msgs, setMsgs] = createSignal<ChatMsg[]>([])
  const [input, setInput] = createSignal("")
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [busy, setBusy] = createSignal(false)
  const [dragOver, setDragOver] = createSignal(false)
  const [showReasoning, setShowReasoning] = createSignal(localStorage.getItem(LS_REASONING) === "1")
  let logEl: HTMLDivElement | undefined
  let fileEl: HTMLInputElement | undefined
  let inputEl: HTMLTextAreaElement | undefined

  const nearBottom = () => !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 140
  const jumpToEnd = () => requestAnimationFrame(() => requestAnimationFrame(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight }))
  const scrollDown = () => queueMicrotask(() => logEl?.scrollTo({ top: logEl.scrollHeight, behavior: "smooth" }))

  // own busy-aware history poll while open
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  async function tick(): Promise<void> {
    if (stopped) return
    if (!inFlight && !document.hidden) {
      inFlight = true
      try {
        const h = await api.chat.history(props.id)
        const follow = nearBottom()
        setMsgs(h)
        if (follow) jumpToEnd()
      } catch {
        /* transient */
      } finally {
        inFlight = false
      }
    }
    timer = setTimeout(() => void tick(), props.entry()?.busy ? DETAIL_BUSY_MS : DETAIL_IDLE_MS)
  }

  onMount(() => {
    void tick()
    jumpToEnd()
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !busy()) props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("keydown", onKey)
    })
  })

  async function addFiles(files: FileList | File[]) {
    try {
      const atts = await readFiles(files)
      setAttachments((a) => [...a, ...atts])
    } catch {
      /* ignore unreadable */
    }
  }
  function onPaste(e: ClipboardEvent) {
    const fs = e.clipboardData?.files
    if (fs && fs.length) {
      e.preventDefault()
      void addFiles(fs)
    }
  }
  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const fs = e.dataTransfer?.files
    if (fs && fs.length) void addFiles(fs)
  }

  async function send() {
    const text = input().trim()
    const atts = attachments()
    if ((!text && atts.length === 0) || busy()) return
    const { textSuffix, files } = buildAttachmentPayload(atts)
    setMsgs((m) => [...m, { role: "user", text: text || "（附件）" }])
    setInput("")
    if (inputEl) inputEl.style.height = "auto"
    setAttachments([])
    setBusy(true)
    scrollDown()
    try {
      const res = await api.chat.send({ text: text + textSuffix, files, sessionId: props.id })
      if (!res.ok) setMsgs((m) => [...m, { role: "system", text: `⚠ ${res.error ?? "发送失败"}` }])
      else await api.chat.history(props.id).then(setMsgs).catch(() => {})
    } catch (e) {
      setMsgs((m) => [...m, { role: "system", text: `⚠ ${e instanceof Error ? e.message : String(e)}` }])
    } finally {
      setBusy(false)
      scrollDown()
    }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const st = () => (props.entry() ? statusOf(props.entry()!) : undefined)

  return (
    <Portal>
      <div class="sess-modal-scrim" onClick={props.onClose}>
        <div class="sess-modal" data-drag={dragOver()} onClick={(e) => e.stopPropagation()} onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
          <div class="sess-modal-head">
            <Show when={st()}>
              {(s) => (
                <span class="sess-status" data-status={s().key}>
                  <Icon name={s().icon} size={12} />
                  {s().label}
                </span>
              )}
            </Show>
            <span class="sess-modal-title">{props.entry()?.title ?? props.id}</span>
            <label class="sess-toggle" title="显示模型思考过程">
              <input type="checkbox" checked={showReasoning()} onChange={(e) => { setShowReasoning(e.currentTarget.checked); try { localStorage.setItem(LS_REASONING, e.currentTarget.checked ? "1" : "0") } catch {} }} />
              思考
            </label>
            <button class="sess-modal-close" title="关闭 (Esc)" onClick={props.onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>

          <Show when={props.entry()?.state === "retry" && props.entry()?.stateDetail}>
            <div class="sess-retry-banner">
              <Icon name="alert-triangle" size={14} />
              <span>模型调用失败,opencode 正在重试:{props.entry()!.stateDetail}</span>
            </div>
          </Show>
          <div class="sess-log" ref={logEl}>
            <Show when={msgs().length > 0} fallback={<div class="sess-empty">加载会话历史…</div>}>
              <For each={msgs()}>
                {(m) => (
                  <div class={`row-msg ${m.role}`}>
                    <div class="avatar" aria-hidden="true">
                      <Show when={m.role !== "user"} fallback={<span>你</span>}>
                        <Icon name={m.role === "assistant" ? "cpu" : "bell"} size={14} />
                      </Show>
                    </div>
                    <div class="bubble">
                      <MsgBody m={m} showReasoning={showReasoning()} />
                    </div>
                  </div>
                )}
              </For>
              <Show when={props.entry()?.busy}>
                <div class="row-msg assistant thinking">
                  <div class="avatar" aria-hidden="true"><Icon name="cpu" size={14} /></div>
                  <div class="bubble">
                    <span class="typing" role="status" aria-label="运行中"><i /><i /><i /></span>
                    <span class="typing-label">运行中…</span>
                  </div>
                </div>
              </Show>
            </Show>
          </div>

          {/* pending ask/question — TUI 式：紧贴输入框上方，会话暂停时在这里作答 */}
          <Show when={props.entry()?.ask} keyed>
            {(a) => <AskCard ask={a} onDone={async () => { try { setMsgs(await api.chat.history(props.id)) } catch {} }} />}
          </Show>

          {/* compose */}
          <div class="sess-compose">
            <Show when={attachments().length > 0}>
              <div class="sess-chips">
                <For each={attachments()}>
                  {(a, i) => (
                    <span class="sess-chip" title={a.name}>
                      <Show when={a.isImage && a.dataUrl} fallback={<Icon name="file-text" size={13} />}>
                        <img src={a.dataUrl} alt="" />
                      </Show>
                      <span class="sess-chip-name">{a.name}</span>
                      <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i()))} aria-label="移除">
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <div class="sess-compose-row">
              <textarea
                class="sess-input"
                rows={1}
                ref={inputEl}
                placeholder="给这个会话发消息(Enter 发送 · Shift+Enter 换行)· 可粘贴/拖拽图片、文件"
                value={input()}
                onInput={(e) => {
                  setInput(e.currentTarget.value)
                  // auto-grow with content up to the CSS max-height, then scroll
                  const el = e.currentTarget
                  el.style.height = "auto"
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
                }}
                onKeyDown={onKey}
                onPaste={onPaste}
              />
              <input type="file" multiple ref={fileEl} style={{ display: "none" }} onChange={(e) => { if (e.currentTarget.files) void addFiles(e.currentTarget.files); e.currentTarget.value = "" }} />
              <button class="sess-icon-btn" title="附加文件/图片" onClick={() => fileEl?.click()}>
                <Icon name="paperclip" size={17} />
              </button>
              <button class="sess-send" disabled={busy()} onClick={() => void send()}>
                <Icon name="send" size={15} />
                {busy() ? "发送中…" : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}

function SessionsPanel(): JSX.Element {
  const [entries, setEntries] = createSignal<ChatMonitorEntry[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [openId, setOpenId] = createSignal<string | undefined>()
  const [err, setErr] = createSignal<string | undefined>()
  const groups = createMemo(() => buildGroups(entries()))
  const openEntry = () => entries().find((e) => e.id === openId())
  const busyCount = () => entries().filter((e) => e.busy).length

  // taskflow 归属：sessionId → 任务。daemon 无 taskflow（旧版）时静默为空。
  const [taskBySession, setTaskBySession] = createSignal<Record<string, { id: string; title: string }>>({})
  async function loadTaskMap(): Promise<void> {
    try {
      const r = await api.read<{ ok: boolean; tasks?: Array<{ id: string; title: string; sessions?: string[] }> }>(
        "taskflow",
        "/tasks",
      )
      const map: Record<string, { id: string; title: string }> = {}
      for (const t of r.tasks ?? []) for (const sid of t.sessions ?? []) map[sid] = { id: t.id, title: t.title }
      setTaskBySession(map)
    } catch {
      /* capability 不存在 — 不显示角标 */
    }
  }

  // 会话卡拖出去的 MIME —— 拖到 Obsidian 看板卡片（fork 插件的整卡落点）即关联。
  // 焦点上下文条已下线：关联信息直接显示在看板卡片脚注上（v0.1.14 用户定稿）。
  const DRAG_MIME = "application/x-taskflow-session"

  // 深链：#panel=sessions&session=<id> 直接弹出对应会话（任务看板跳转用）。
  const sessionFromHash = () => /[#&]session=([\w-]+)/.exec(location.hash)?.[1]
  const [wantSession, setWantSession] = createSignal<string | undefined>(sessionFromHash())
  createEffect(() => {
    const want = wantSession()
    if (!want) return
    if (entries().some((e) => e.id === want)) {
      setOpenId(want)
      setWantSession(undefined)
    }
  })

  let stopped = false
  let monitorTimer: ReturnType<typeof setTimeout> | undefined
  async function monitorTick(): Promise<void> {
    if (stopped) return
    if (!document.hidden || !loaded()) {
      try {
        setEntries(await api.chat.monitor(24))
        setErr(undefined)
      } catch (e) {
        setErr(`连不上 host:${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setLoaded(true)
      }
    }
    monitorTimer = setTimeout(() => void monitorTick(), MONITOR_MS)
  }

  onMount(() => {
    void monitorTick()
    void loadTaskMap()
    const taskTimer = setInterval(() => void loadTaskMap(), 60_000)
    const onVis = () => {
      if (!document.hidden) {
        clearTimeout(monitorTimer)
        void monitorTick()
      }
    }
    const onHash = () => setWantSession(sessionFromHash())
    window.addEventListener("hashchange", onHash)
    document.addEventListener("visibilitychange", onVis)
    // taskflow:changed over SSE —— 关联变化时刷新会话卡上的任务角标
    const offEvents = api.events((ev) => {
      if (ev.type === "taskflow:changed") void loadTaskMap()
    })
    onCleanup(() => {
      stopped = true
      clearTimeout(monitorTimer)
      clearInterval(taskTimer)
      window.removeEventListener("hashchange", onHash)
      document.removeEventListener("visibilitychange", onVis)
      offEvents()
    })
  })

  const visibleGroups = groups

  // If the open session vanished (deleted), close the modal.
  createEffect(() => {
    if (openId() && loaded() && !entries().some((e) => e.id === openId())) setOpenId(undefined)
  })

  return (
    <section class="panel sess">
      <header class="panel-head">
        <h2 class="ph-name">会话监控</h2>
        <div class="ph-tools">
          <Show when={busyCount() > 0}>
            <span class="sess-running-chip" title="正在执行任务的 opencode 会话数">{busyCount()} 运行中</span>
          </Show>
          <button class="sess-refresh" title="立即刷新" onClick={() => { clearTimeout(monitorTimer); void monitorTick() }}>
            <Icon name="refresh-cw" size={15} />
          </button>
        </div>
      </header>

      <div class="panel-body sess-body">
        <Show when={err()}>
          <div class="sess-err">{err()}</div>
        </Show>
        <div class="sess-wall">
          <Show
            when={visibleGroups().length > 0}
            fallback={
              <div class="sess-empty">
                {!loaded() ? "加载中…" : "没有会话 —— 用 Ctrl+Space 发起一个任务"}
              </div>
            }
          >
            <For each={visibleGroups()}>
              {(g) => (
                <section class="sess-group">
                  <div class="sess-group-head" data-key={g.key}>
                    <span class="sess-group-label">{g.label}</span>
                    <span class="sess-group-count">{g.items.length}</span>
                    <span class="sess-group-rule" aria-hidden="true" />
                  </div>
                  <div class="sess-grid">
                    <For each={g.items}>
                      {(e) => (
                        <SessionCard
                          e={e}
                          task={taskBySession()[e.id]}
                          draggable
                          dragMime={DRAG_MIME}
                          onOpen={() => setOpenId(e.id)}
                        />
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </Show>
        </div>
      </div>

      <Show when={openId()} keyed>
        {(id) => <SessionModal id={id} entry={openEntry} onClose={() => setOpenId(undefined)} />}
      </Show>
    </section>
  )
}

registerPanel({ id: "sessions", title: "会话监控", icon: "activity", render: () => <SessionsPanel /> })
