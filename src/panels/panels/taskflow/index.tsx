/**
 * taskflow panel — 任务·会话 关联台。
 *
 * 看板视图在 Obsidian（官方 Kanban 插件）里，本面板不重复画看板，专注三件事：
 *   1) 左栏「最近会话」（复用会话监控数据），可拖拽；
 *   2) 右栏任务按看板列分组，每行是拖放目标——把会话拖到任务行 = 关联；
 *   3) 每个任务一键「启动/继续」session、点 session 徽章跳回会话续聊。
 *
 * 数据来自 GET /cap/taskflow/tasks（轮询 5s）+ api.chat.monitor（最近会话）。
 * 关联写进任务 frontmatter.sessions[]（daemon /associate）。
 */
import { createMemo, createSignal, For, Show, onCleanup, onMount, type JSX } from "solid-js"
import { registerPanel } from "../../registry"
import { api } from "../../bridge"
import { Icon } from "../../icons"
import type { ChatMonitorEntry } from "../../../contracts"
import "./taskflow.css"

type Task = {
  id: string
  title: string
  project: string
  type: string
  status: string
  board: string
  sessions: string[]
  pha_issue: string
  todos: { done: number; total: number }
  path: string
  mtimeMs: number
}

function timeAgo(ms: number): string {
  if (!ms) return "—"
  const d = Date.now() - ms
  const m = Math.floor(d / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

const DRAG_MIME = "application/x-taskflow-session"

function TaskflowPanel(): JSX.Element {
  const [tasks, setTasks] = createSignal<Task[]>([])
  const [sessions, setSessions] = createSignal<ChatMonitorEntry[]>([])
  const [boards, setBoards] = createSignal<Array<{ path: string; columns: string[] }>>([])
  const [doneColumns, setDoneColumns] = createSignal<string[]>([])
  const [err, setErr] = createSignal<string | undefined>()
  const [loaded, setLoaded] = createSignal(false)
  const [project, setProject] = createSignal("")
  const [dropId, setDropId] = createSignal<string | undefined>() // task row hovered while dragging
  const [busyId, setBusyId] = createSignal<string | undefined>()

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refreshTasks(): Promise<void> {
    try {
      const r = await api.read<{ ok: boolean; tasks: Task[]; boards: any[]; doneColumns: string[]; error?: string }>(
        "taskflow",
        "/tasks",
      )
      setTasks(r.tasks ?? [])
      setBoards(r.boards ?? [])
      setDoneColumns(r.doneColumns ?? [])
      setErr(r.ok ? undefined : (r.error ?? "未知错误"))
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    } finally {
      setLoaded(true)
    }
  }
  async function tick(): Promise<void> {
    if (stopped) return
    if (!document.hidden || !loaded()) {
      await refreshTasks()
      try {
        setSessions(await api.chat.monitor(24))
      } catch {
        /* opencode down — left column just empty */
      }
    }
    timer = setTimeout(() => void tick(), 5000)
  }
  onMount(() => void tick())
  onCleanup(() => {
    stopped = true
    if (timer) clearTimeout(timer)
  })

  const projects = createMemo(() => [...new Set(tasks().map((t) => t.project))].sort())
  const filtered = createMemo(() => (project() ? tasks().filter((t) => t.project === project()) : tasks()))

  // Column order per the discovered boards (falls back to observed statuses).
  const columns = createMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const b of boards()) for (const c of b.columns) if (!seen.has(c)) (seen.add(c), out.push(c))
    for (const t of filtered()) if (!seen.has(t.status)) (seen.add(t.status), out.push(t.status))
    return out
  })
  const tasksInColumn = (col: string) => filtered().filter((t) => t.status === col).sort((a, b) => b.mtimeMs - a.mtimeMs)

  async function associate(taskId: string, sessionId: string): Promise<void> {
    try {
      await api.call("taskflow", "/associate", { id: taskId, sessionId })
      await refreshTasks()
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    }
  }
  async function dissociate(taskId: string, sessionId: string): Promise<void> {
    try {
      await api.call("taskflow", "/dissociate", { id: taskId, sessionId })
      await refreshTasks()
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    }
  }
  async function launch(taskId: string, mode: "continue" | "new"): Promise<void> {
    if (busyId()) return
    setBusyId(taskId)
    try {
      const r = await api.call<{ ok: boolean; sessionId?: string; error?: string }>("taskflow", "/launch", { id: taskId, mode })
      await refreshTasks()
      if (r.ok && r.sessionId) location.hash = `#panel=sessions&session=${r.sessionId}`
      else if (!r.ok) setErr(r.error ?? "启动失败")
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    } finally {
      setBusyId(undefined)
    }
  }

  const openSession = (sid: string) => {
    location.hash = `#panel=sessions&session=${sid}`
  }
  const statusOf = (e: ChatMonitorEntry) =>
    e.ask ? "待处理" : e.busy ? "运行中" : e.state === "retry" ? "重试中" : "空闲"

  return (
    <section class="tf-panel">
      <header class="tf-header">
        <h1 class="tf-title">任务看板</h1>
        <select class="tf-project" value={project()} onChange={(e) => setProject(e.currentTarget.value)}>
          <option value="">全部项目</option>
          <For each={projects()}>{(p) => <option value={p}>{p}</option>}</For>
        </select>
        <span class="tf-hint">看板本体在 Obsidian（Kanban 插件）里；这里做任务↔会话关联与启动</span>
        <span class="tf-spacer" />
        <button type="button" class="tf-btn" onClick={() => void api.call("taskflow", "/scan", {}).then(refreshTasks)}>
          <Icon name="refresh-cw" size={13} />
          扫描
        </button>
      </header>

      <Show when={err()}>
        <div class="tf-err">
          {err()}
          <span class="tf-err-hint"> —— 在「管理 → 任务看板」配置扫描根目录（含 Obsidian Kanban 看板的 vault 目录）</span>
        </div>
      </Show>

      <Show when={loaded() && !err() && tasks().length === 0}>
        <div class="tf-empty">
          <p>还没有识别到任务。taskflow 会扫描配置目录下所有 Obsidian Kanban 看板，看板上 <code>[[链接]]</code> 到的文档即任务。</p>
          <p>做法：① 用 Kanban 插件建一个项目看板 → ② 新建任务文档（模板见下）→ ③ 把 <code>[[任务名]]</code> 拖到看板列。</p>
          <pre>{`---
project: 机型X
type: bug修复
sessions: []
pha_issue: ""
---
# 低温启动 bug

## 待办
- [ ] 复现
- [ ] 修复

## 进展

## 问题与解决

## 备注
`}</pre>
        </div>
      </Show>

      <div class="tf-body">
        {/* 左：最近会话，可拖 */}
        <aside class="tf-sessions">
          <div class="tf-sessions-hd">最近会话 · 拖到右侧任务关联</div>
          <div class="tf-sessions-list">
            <Show when={sessions().length > 0} fallback={<div class="tf-sess-empty">暂无会话</div>}>
              <For each={sessions()}>
                {(s) => (
                  <div
                    class="tf-sess-card"
                    draggable={true}
                    onDragStart={(ev) => ev.dataTransfer?.setData(DRAG_MIME, s.id)}
                  >
                    <div class="tf-sess-top">
                      <span class="tf-sess-state" data-busy={s.busy}>
                        {statusOf(s)}
                      </span>
                      <span class="tf-spacer" />
                      <span class="tf-sess-time">{timeAgo(s.updatedAt)}</span>
                    </div>
                    <div class="tf-sess-title" title={s.title}>
                      {s.title}
                    </div>
                    <Show when={s.task}>
                      <div class="tf-sess-task" title={s.task}>
                        {s.task}
                      </div>
                    </Show>
                    <button class="tf-sess-open" onClick={() => openSession(s.id)}>
                      打开会话 ↗
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </aside>

        {/* 右：任务按看板列分组，行是拖放目标 */}
        <div class="tf-columns">
          <For each={columns()}>
            {(col) => (
              <Show when={tasksInColumn(col).length > 0}>
                <div class="tf-colgroup">
                  <div class="tf-colgroup-hd" data-done={doneColumns().includes(col.toLowerCase())}>
                    {col}
                    <span class="tf-colgroup-n">{tasksInColumn(col).length}</span>
                  </div>
                  <For each={tasksInColumn(col)}>
                    {(t) => (
                      <div
                        class="tf-task"
                        data-drop={dropId() === t.id}
                        onDragOver={(ev) => {
                          if (ev.dataTransfer?.types.includes(DRAG_MIME)) {
                            ev.preventDefault()
                            setDropId(t.id)
                          }
                        }}
                        onDragLeave={() => dropId() === t.id && setDropId(undefined)}
                        onDrop={(ev) => {
                          ev.preventDefault()
                          const sid = ev.dataTransfer?.getData(DRAG_MIME)
                          setDropId(undefined)
                          if (sid) void associate(t.id, sid)
                        }}
                      >
                        <div class="tf-task-main">
                          <div class="tf-task-title" title={t.path}>
                            {t.title}
                          </div>
                          <div class="tf-task-meta">
                            <Show when={t.type}>
                              <span class="tf-tag">{t.type}</span>
                            </Show>
                            <Show when={t.todos.total > 0}>
                              <span class="tf-todos" title="待办完成度">
                                {t.todos.done}/{t.todos.total}
                              </span>
                            </Show>
                            <Show when={t.pha_issue}>
                              <a class="tf-pha" href={t.pha_issue} target="_blank" rel="noopener">
                                PHA
                              </a>
                            </Show>
                          </div>
                          <Show when={t.sessions.length > 0}>
                            <div class="tf-task-sessions">
                              <For each={t.sessions}>
                                {(sid) => (
                                  <span class="tf-badge">
                                    <button class="tf-badge-open" title="打开会话续聊" onClick={() => openSession(sid)}>
                                      <Icon name="message-square" size={10} />…{sid.slice(-6)}
                                    </button>
                                    <button class="tf-badge-x" title="取消关联" onClick={() => void dissociate(t.id, sid)}>
                                      ×
                                    </button>
                                  </span>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                        <div class="tf-task-actions">
                          <button
                            type="button"
                            class="tf-btn tf-btn-primary"
                            disabled={busyId() === t.id}
                            title={t.sessions.length ? "继续最近的关联会话" : "新建会话开始任务"}
                            onClick={() => void launch(t.id, "continue")}
                          >
                            {busyId() === t.id ? "…" : t.sessions.length ? "继续" : "启动"}
                          </button>
                          <Show when={t.sessions.length > 0}>
                            <button
                              type="button"
                              class="tf-btn"
                              disabled={busyId() === t.id}
                              title="另开一个新会话"
                              onClick={() => void launch(t.id, "new")}
                            >
                              新会话
                            </button>
                          </Show>
                          <a
                            class="tf-open"
                            href={`obsidian://open?path=${encodeURIComponent(t.path)}`}
                            title="在 Obsidian 打开任务文档"
                          >
                            <Icon name="file-text" size={12} />
                          </a>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            )}
          </For>
        </div>
      </div>
    </section>
  )
}

registerPanel({ id: "taskflow", title: "任务看板", icon: "list-checks", render: () => <TaskflowPanel /> })
