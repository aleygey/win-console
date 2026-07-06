/**
 * taskflow panel — 任务看板（文档驱动的项目任务编排前端）。
 *
 * 数据全部来自 daemon 的 taskflow capability（GET /cap/taskflow/tasks，轮询
 * 5s，文档才是事实源——本面板只是视图 + 少量动作按钮）。列 = 状态机各态；
 * 卡片上的 session 徽章跳转会话监控（#panel=sessions&session=<id>），
 * 「打开」用 obsidian:// 协议直达任务文档。
 */
import { createMemo, createSignal, For, Show, onCleanup, onMount, type JSX } from "solid-js"
import { registerPanel } from "../../registry"
import { api } from "../../bridge"
import { Icon } from "../../icons"
import "./taskflow.css"

type TaskStatus = "inbox" | "clarifying" | "ready" | "doing" | "review" | "done" | "synced" | "blocked"

type Task = {
  id: string
  title: string
  project: string
  type: string
  status: TaskStatus
  priority: string
  sessions: string[]
  pha_issue: string
  path: string
  mtimeMs: number
  updated: string
}

const COLUMNS: Array<{ status: TaskStatus; label: string; tone?: "warn" | "good" | "info" }> = [
  { status: "inbox", label: "新建" },
  { status: "clarifying", label: "澄清中", tone: "warn" },
  { status: "ready", label: "就绪", tone: "warn" },
  { status: "doing", label: "进行中", tone: "info" },
  { status: "review", label: "待验收", tone: "warn" },
  { status: "blocked", label: "阻塞", tone: "warn" },
  { status: "done", label: "已完成", tone: "good" },
  { status: "synced", label: "已同步", tone: "good" },
]

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

function TaskflowPanel(): JSX.Element {
  const [tasks, setTasks] = createSignal<Task[]>([])
  const [err, setErr] = createSignal<string | undefined>()
  const [loaded, setLoaded] = createSignal(false)
  const [project, setProject] = createSignal<string>("")
  const [busyId, setBusyId] = createSignal<string | undefined>()

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  async function tick(): Promise<void> {
    if (stopped) return
    if (!document.hidden || !loaded()) {
      try {
        const r = await api.read<{ ok: boolean; tasks: Task[]; error?: string }>("taskflow", "/tasks")
        setTasks(r.tasks ?? [])
        setErr(r.ok ? undefined : (r.error ?? "未知错误"))
      } catch (e) {
        setErr(String((e as Error)?.message ?? e))
      } finally {
        setLoaded(true)
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
  const byStatus = (s: TaskStatus) =>
    filtered()
      .filter((t) => t.status === s)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

  async function action(path: string, body: Record<string, unknown>, id: string): Promise<void> {
    if (busyId()) return
    setBusyId(id)
    try {
      await api.call("taskflow", path, body)
      const r = await api.read<{ ok: boolean; tasks: Task[] }>("taskflow", "/tasks")
      setTasks(r.tasks ?? [])
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    } finally {
      setBusyId(undefined)
    }
  }

  const openSession = (sid: string) => {
    location.hash = `#panel=sessions&session=${sid}`
  }

  return (
    <section class="tf-panel">
      <header class="tf-header">
        <h1 class="tf-title">任务看板</h1>
        <select class="tf-project" value={project()} onChange={(e) => setProject(e.currentTarget.value)}>
          <option value="">全部项目</option>
          <For each={projects()}>{(p) => <option value={p}>{p}</option>}</For>
        </select>
        <span class="tf-spacer" />
        <button
          type="button"
          class="tf-btn"
          onClick={() => void api.call("taskflow", "/scan", {}).catch(() => {})}
          title="立即扫描 vault（平时每 10s 自动扫）"
        >
          <Icon name="refresh-cw" size={13} />
          扫描
        </button>
      </header>

      <Show when={err()}>
        <div class="tf-err">
          {err()}
          <span class="tf-err-hint">
            —— 需要 win-host ≥ 0.1.10，并在「管理 → 任务看板」配置项目根目录（vault 的 01-项目资料）
          </span>
        </div>
      </Show>

      <Show when={loaded() && !err() && tasks().length === 0}>
        <div class="tf-empty">
          <p>还没有任务。在 vault 的 <code>01-项目资料/&lt;项目&gt;/tasks/</code> 下新建任务文档即可：</p>
          <pre>{`---
id: T-0001
project: 机型X
type: bug修复
status: inbox
priority: P1
sessions: []
pha_issue: ""
---

## 目标
（一句话描述要做什么）

## 验收标准
- [ ] …
`}</pre>
          <p>保存后 taskflow 会自动接管（澄清 → 就绪 → 启动 → 验收 → 同步 PHA）。</p>
        </div>
      </Show>

      <div class="tf-board">
        <For each={COLUMNS}>
          {(col) => (
            <div class="tf-col" data-status={col.status}>
              <div class="tf-col-hd" data-tone={col.tone}>
                <span class="tf-col-title">{col.label}</span>
                <span class="tf-col-n">{byStatus(col.status).length}</span>
              </div>
              <div class="tf-col-bd">
                <For each={byStatus(col.status)}>
                  {(t) => (
                    <div class="tf-card">
                      <div class="tf-card-head">
                        <span class="tf-id">{t.id}</span>
                        <Show when={t.priority}>
                          <span class="tf-pri" data-p={t.priority}>
                            {t.priority}
                          </span>
                        </Show>
                        <span class="tf-spacer" />
                        <span class="tf-time">{timeAgo(t.mtimeMs)}</span>
                      </div>
                      <div class="tf-card-title" title={t.path}>
                        {t.title}
                      </div>
                      <div class="tf-card-tags">
                        <span class="tf-tag">{t.project}</span>
                        <span class="tf-tag">{t.type}</span>
                      </div>
                      <Show when={t.sessions.length > 0 || t.pha_issue}>
                        <div class="tf-card-links">
                          <For each={t.sessions.slice(-3)}>
                            {(sid) => (
                              <button
                                type="button"
                                class="tf-sess"
                                title={`打开会话 ${sid}`}
                                onClick={() => openSession(sid)}
                              >
                                <Icon name="message-square" size={11} />…{sid.slice(-6)}
                              </button>
                            )}
                          </For>
                          <Show when={t.pha_issue}>
                            <a class="tf-pha" href={t.pha_issue} target="_blank" rel="noopener">
                              PHA
                            </a>
                          </Show>
                        </div>
                      </Show>
                      <div class="tf-card-actions">
                        <Show when={t.status === "ready" || t.status === "blocked" || t.status === "inbox"}>
                          <button
                            type="button"
                            class="tf-btn tf-btn-primary"
                            disabled={busyId() === t.id}
                            onClick={() => void action("/task/start", { id: t.id }, t.id)}
                          >
                            {busyId() === t.id ? "启动中…" : "启动"}
                          </button>
                        </Show>
                        <Show when={t.status === "review"}>
                          <button
                            type="button"
                            class="tf-btn tf-btn-primary"
                            disabled={busyId() === t.id}
                            onClick={() => void action("/task/set-status", { id: t.id, status: "done" }, t.id)}
                          >
                            验收通过
                          </button>
                        </Show>
                        <Show when={t.status === "done"}>
                          <button
                            type="button"
                            class="tf-btn"
                            disabled={busyId() === t.id}
                            onClick={() => void action("/task/sync-pha", { id: t.id }, t.id)}
                          >
                            同步PHA
                          </button>
                        </Show>
                        <span class="tf-spacer" />
                        <a
                          class="tf-open"
                          href={`obsidian://open?path=${encodeURIComponent(t.path)}`}
                          title="在 Obsidian 中打开任务文档"
                        >
                          <Icon name="file-text" size={12} />
                          打开
                        </a>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}

registerPanel({ id: "taskflow", title: "任务看板", icon: "list-checks", render: () => <TaskflowPanel /> })
