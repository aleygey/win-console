/**
 * exp panel · Retrieve view — recall inspector.
 *
 * A two-column audit surface for the retrieve engine, ported (clean, no shared
 * imports) from the opencode `retrieve-page` + `TraceRecall` module:
 *
 *   ┌──────────────┬────────────────────────────────────────────────┐
 *   │  Timeline    │  Detail                                          │
 *   │  (newest →   │   · trigger badge + query excerpt + meta         │
 *   │   oldest     │   · picked experiences (kind / title / abstract  │
 *   │   log rows)  │     / source / reason), expandable               │
 *   │              │   · diff vs previous round (added/removed/kept)  │
 *   │              │   · llm_trace folds (system / user / response)   │
 *   └──────────────┴────────────────────────────────────────────────┘
 *
 * Plus a "dry-run preview" box: POST /retrieve/preview to see what *would* be
 * injected right now for a given agent + user text, without mutating any state.
 *
 * Data: GET /retrieve/log (RetrieveLogEntry[], newest-first per the server, but
 * we re-sort client-side to be safe), POST /retrieve/preview. Types mirror the
 * exp plugin's `src/retrieve/types.ts`. The HTTP client comes from the ambient
 * `useExpClient()` so this file stays free of base-URL / fetch wiring.
 */

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  For,
  Show,
  Switch,
  Match,
  type JSX,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useExpClient } from "../../api/client"
import "./retrieve.css"

/* ──────────────────────────────────────────────────────
   Types — mirror opencode-plugin / src/retrieve/types.ts
   ────────────────────────────────────────────────────── */

type PickSource =
  | "seed"
  | "expand:requires"
  | "expand:refines"
  | "expand:contradicts"
  | "expand:supports"
  | "heuristic"
  | "baseline"
  | "cache"

type Layer = "master" | "slave" | "both"

type PickedExperience = {
  experience_id: string
  kind: string
  title: string
  abstract: string
  statement?: string
  trigger_condition?: string
  task_type?: string
  target_layer?: Layer
  source: PickSource
  reason?: string
}

type RetrieveTrigger =
  | "user_message"
  | "new_user_mid_loop"
  | "tool"
  | "baseline"
  | "dry_run"
  | "unknown"

type RetrieveDiff = { added: string[]; removed: string[]; kept: string[] }

type LlmTrace = {
  provider_id?: string
  model_id?: string
  system_prompt?: string
  user_prompt: string
  response_text?: string
  reasoning_text?: string
  structured_output?: unknown
  error?: string
}

type RetrieveLogEntry = {
  id: string
  session_id: string
  turn_index: number
  agent_name: string
  layer: Layer
  workflow_id?: string
  user_text_excerpt?: string
  trigger?: RetrieveTrigger
  candidate_count: number
  seed_ids: string[]
  expand_ids: string[]
  picked: PickedExperience[]
  diff: RetrieveDiff
  model?: { providerID: string; modelID: string; source: string }
  llm_used: boolean
  error?: string
  duration_ms: number
  created_at: number
  llm_trace?: LlmTrace
  /** 列表接口默认剥离 llm_trace（体积大头），置此标记；详情开调试时按需拉单条全量 */
  has_trace?: boolean
}

type LogResponse = { entries: RetrieveLogEntry[]; total?: number }

/** GET /retrieve/session-state —— 会话当前已注入集合（内存态，只增不减） */
type SessionStateRes =
  | { active: false; session_id: string }
  | {
      active: true
      session_id: string
      turn_index: number
      baseline: PickedExperience[]
      topical: PickedExperience[]
      last_injected: string[]
    }

/** POST /retrieve/preview response = RetrieveResult + a couple of echoed fields. */
type RetrievePreview = {
  system_text?: string
  picked: PickedExperience[]
  diff: RetrieveDiff
  turn_index: number
  agent_layer: "master" | "slave"
}

/* ──────────────────────────────────────────────────────
   Formatting + small label maps
   ────────────────────────────────────────────────────── */

const fmtClock = (ts: number) => {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

const fmtDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

/** Bucket a timestamp into 今天 / 昨天 / ISO date for timeline grouping. */
function dayBucket(ts: number): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yest = new Date(today)
  yest.setDate(today.getDate() - 1)
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  if (d.getTime() === today.getTime()) return "今天"
  if (d.getTime() === yest.getTime()) return "昨天"
  return d.toISOString().slice(0, 10)
}

/** Short Chinese label per trigger kind — used as the timeline-row chip. */
function triggerLabel(t: RetrieveTrigger | undefined): string {
  switch (t) {
    case "user_message":
      return "用户消息"
    case "new_user_mid_loop":
      return "中途新消息"
    case "tool":
      return "工具调用"
    case "baseline":
      return "baseline"
    case "dry_run":
      return "preview"
    default:
      return "未知"
  }
}

/** Terse Chinese label per experience kind (new 6-kind + legacy fallback). */
const KIND_NAME: Record<string, string> = {
  rule_must: "必须",
  rule_must_not: "禁止",
  pattern: "模板",
  recipe: "操作",
  fact: "事实",
  preference: "偏好",
  // legacy — prefixed so the user can tell which need migrating
  workflow_rule: "[旧]流程",
  workflow_gap: "[旧]缺口",
  workflow_pattern: "[旧]套路",
  know_how: "[旧]操作",
  constraint_or_policy: "[旧]约束",
  domain_knowledge: "[旧]领域",
  preference_style: "[旧]风格",
  pitfall_or_caveat: "[旧]注意",
}

function kindLabel(kind: string): string {
  if (kind.startsWith("custom:")) return kind.replace("custom:", "")
  return KIND_NAME[kind] ?? kind
}

/** Map kind → a stable hue so the category dot is consistent across views. */
const KIND_HUE: Record<string, number> = {
  rule_must: 295,
  rule_must_not: 85,
  pattern: 250,
  recipe: 155,
  fact: 200,
  preference: 340,
  workflow_rule: 295,
  workflow_gap: 250,
  workflow_pattern: 250,
  know_how: 155,
  constraint_or_policy: 295,
  domain_knowledge: 200,
  preference_style: 340,
  pitfall_or_caveat: 85,
}
const kindHue = (kind: string) => KIND_HUE[kind] ?? 235

/** Outcome chip tone for a log row. */
function outcome(e: RetrieveLogEntry): { label: string; tone: "ok" | "warn" | "err" } {
  if (e.error) return { label: "failed", tone: "err" }
  if (e.picked.length === 0) return { label: "skipped", tone: "warn" }
  return { label: "recalled", tone: "ok" }
}

const diffTotal = (d: RetrieveDiff | undefined) =>
  d ? d.added.length + d.removed.length + d.kept.length : 0

/* Relation label for an `expand:<kind>` pick source. */
const SOURCE_REL: Record<string, string> = {
  "expand:requires": "先决条件",
  "expand:refines": "细化",
  "expand:supports": "支持",
  "expand:contradicts": "冲突",
}

/* How an experience got recalled, derived from its pick source. Relation-
   expanded picks are "深度召回"; always-on are "基线"; everything else
   (direct hits / heuristic / cache) reads as "LLM 召回" — the recall model
   judged it relevant. Drives the small method tag on each pick row. */
function recallMethod(source: string): { tag: string; deep: boolean; detail: string } {
  if (source.startsWith("expand:")) {
    return {
      tag: "深度召回",
      deep: true,
      detail: `深度召回 · 沿「${SOURCE_REL[source] ?? source}」关系从命中经验展开`,
    }
  }
  if (source === "baseline") {
    return { tag: "基线", deep: false, detail: "基线常驻 · 每轮固定注入" }
  }
  if (source === "heuristic" || source === "cache") {
    return { tag: "启发式", deep: false, detail: "启发式 · 规则 / 缓存补充" }
  }
  return { tag: "LLM 召回", deep: false, detail: "LLM 召回 · 召回模型判定与 query 相关" }
}

/* ──────────────────────────────────────────────────────
   Retrieve — top-level view
   ────────────────────────────────────────────────────── */

export function Retrieve(): JSX.Element {
  const client = useExpClient()

  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [sessionFilter, setSessionFilter] = createSignal<string>("") // "" = all sessions

  // The 召回配置 / 试运行 surfaces are demoted to small icon buttons in the
  // detail toolbar that open these modals (rather than big inline boxes).
  const [showConfig, setShowConfig] = createSignal(false)
  const [showPreview, setShowPreview] = createSignal(false)

  // The audit log — paged (offset/limit)。日志文件只增不减，一次全量拉会越来越慢，
  // 这里首屏拉一页，底部「加载更多」翻页；列表响应已剥离 llm_trace。
  const PAGE = 60
  const [raw, setRaw] = createSignal<RetrieveLogEntry[]>([])
  const [total, setTotal] = createSignal<number | undefined>()
  const [loading, setLoading] = createSignal(false)
  const [loadErr, setLoadErr] = createSignal<string | undefined>()

  async function load(reset = false): Promise<void> {
    setLoading(true)
    setLoadErr(undefined)
    try {
      const offset = reset ? 0 : raw().length
      const res = await client.get<LogResponse>(`/retrieve/log?limit=${PAGE}&offset=${offset}`)
      const fresh = res?.entries ?? []
      setRaw((cur) => (reset ? fresh : [...cur, ...fresh]))
      if (typeof res?.total === "number") setTotal(res.total)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  onMount(() => void load(true))
  const log = () => raw()
  const hasMore = () => (total() !== undefined ? raw().length < (total() ?? 0) : raw().length > 0 && raw().length % PAGE === 0)
  const refetch = () => void load(true)

  // Distinct sessions (most-recent first) for the picker — each with a recall
  // count and its latest query excerpt as a human-readable hint.
  const sessions = createMemo(() => {
    const map = new Map<string, { count: number; latest: number; lastQuery: string }>()
    for (const e of log() ?? []) {
      const cur = map.get(e.session_id) ?? { count: 0, latest: 0, lastQuery: "" }
      cur.count++
      if (e.created_at >= cur.latest) {
        cur.latest = e.created_at
        cur.lastQuery = e.user_text_excerpt ?? ""
      }
      map.set(e.session_id, cur)
    }
    return [...map.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.latest - a.latest)
  })

  // Newest-first, filtered by the selected session ("" = all sessions).
  const entries = createMemo(() => {
    const sf = sessionFilter()
    return [...(log() ?? [])]
      .filter((e) => !sf || e.session_id === sf)
      .sort((a, b) => b.created_at - a.created_at)
  })

  // Group rows into day buckets for the timeline.
  const groups = createMemo(() => {
    const out: { bucket: string; items: RetrieveLogEntry[] }[] = []
    let last = ""
    for (const e of entries()) {
      const b = dayBucket(e.created_at)
      if (b !== last) {
        out.push({ bucket: b, items: [] })
        last = b
      }
      out[out.length - 1]!.items.push(e)
    }
    return out
  })

  // Auto-select the newest entry once data lands (or after a refetch drops the
  // current selection). Prefer the first entry that actually recalled something.
  createMemo(() => {
    const list = entries()
    if (list.length === 0) {
      setSelectedId(null)
      return
    }
    const cur = selectedId()
    if (cur && list.some((e) => e.id === cur)) return
    const firstHit = list.find((e) => e.picked.length > 0)
    setSelectedId((firstHit ?? list[0]).id)
  })

  const active = createMemo(() => {
    const id = selectedId()
    if (!id) return null
    return entries().find((e) => e.id === id) ?? null
  })

  return (
    <div class="rt">
      {/* ── Left: timeline ─────────────────────────────────────────────── */}
      <aside class="rt-timeline">
        <div class="rt-timeline-head">
          <span class="rt-timeline-title">召回记录</span>
          <span class="rt-timeline-count">{entries().length}</span>
          <button
            type="button"
            class="rt-refresh"
            onClick={() => refetch()}
            disabled={loading()}
            title="刷新召回记录"
          >
            {loading() ? "…" : "↻"}
          </button>
        </div>

        {/* 触发机制一句话 —— 回答「为什么一个 query 会有多条记录」 */}
        <div class="rt-mech">
          每条记录 = 一次召回触发：<b>用户消息</b>（每条都触发，结果下一轮生效）、
          <b>工具活动观察</b>（agent 每累计 ≥5 次工具调用且距上次 ≥15s，按工作内容主动召回）、
          <b>基线</b>（会话首轮注入工作区规则）。会话内已注入集合只增不减。
        </div>

        <Show when={sessions().length > 0}>
          <div class="rt-session-bar">
            <select
              class="rt-session-select"
              value={sessionFilter()}
              onChange={(ev) => setSessionFilter(ev.currentTarget.value)}
            >
              <option value="">全部会话 ({sessions().length})</option>
              <For each={sessions()}>
                {(s) => (
                  <option value={s.id}>
                    …{s.id.slice(-8)} · {s.count}次
                    {s.lastQuery ? ` · ${s.lastQuery.slice(0, 18)}` : ""}
                  </option>
                )}
              </For>
            </select>
            <Show when={sessionFilter()}>
              <button
                type="button"
                class="rt-session-clear"
                title="清除会话过滤"
                onClick={() => setSessionFilter("")}
              >
                ✕
              </button>
            </Show>
          </div>
        </Show>

        <div class="rt-timeline-body">
          <Switch>
            <Match when={loading() && entries().length === 0}>
              <div class="rt-state">加载中…</div>
            </Match>
            <Match when={loadErr() && entries().length === 0}>
              <div class="rt-state rt-state-err">
                <span>加载失败</span>
                <span class="rt-state-detail">{loadErr()}</span>
                <button type="button" class="rt-retry" onClick={() => refetch()}>
                  重试
                </button>
              </div>
            </Match>
            <Match when={entries().length === 0}>
              <div class="rt-state">
                暂无召回记录 — 跑一轮会话后这里会出现条目。
              </div>
            </Match>
            <Match when={entries().length > 0}>
              <For each={groups()}>
                {(g) => (
                  <section class="rt-tl-group">
                    <div class="rt-tl-bucket">
                      <span class="rt-tl-bucket-name">{g.bucket}</span>
                      <span class="rt-tl-bucket-count">{g.items.length} 次</span>
                    </div>
                    <For each={g.items}>
                      {(e) => (
                        <TimelineRow
                          entry={e}
                          active={selectedId() === e.id}
                          onPick={() => setSelectedId(e.id)}
                        />
                      )}
                    </For>
                  </section>
                )}
              </For>
              <Show when={hasMore()}>
                <button type="button" class="rt-more" disabled={loading()} onClick={() => void load()}>
                  {loading() ? "加载中…" : `加载更多${total() !== undefined ? `（${raw().length}/${total()}）` : ""}`}
                </button>
              </Show>
            </Match>
          </Switch>
        </div>
      </aside>

      {/* ── Bottom: detail (config / preview demoted to toolbar buttons) ── */}
      <main class="rt-detail">
        {/* 选中会话时：该会话当前累计已注入的经验（只增不减的全集，区别于下面单次触发的增量） */}
        <Show when={sessionFilter()} keyed>
          {(sid) => <SessionSnapshot sessionId={sid} entries={raw()} />}
        </Show>
        <div class="rt-detail-bar">
          <span class="rt-detail-bar-title">召回详情</span>
          <Show when={active()}>
            <span class="rt-detail-bar-sub">Turn {active()!.turn_index} · {active()!.agent_name}</span>
          </Show>
          <div class="rt-detail-tools">
            <button
              type="button"
              class="rt-detail-tool"
              title="召回配置 (retrieve-config)"
              onClick={() => setShowConfig(true)}
            >
              <IconGear />
              配置
            </button>
            <button
              type="button"
              class="rt-detail-tool"
              title="试运行召回 (dry-run preview)"
              onClick={() => setShowPreview(true)}
            >
              <IconSend />
              试运行
            </button>
          </div>
        </div>

        <Show
          when={active()}
          fallback={<div class="rt-detail-empty">选择左侧一条记录查看详情。</div>}
        >
          {(e) => <Detail entry={e()} />}
        </Show>
      </main>

      <Show when={showConfig()}>
        <ConfigBox client={client} onClose={() => setShowConfig(false)} />
      </Show>
      <Show when={showPreview()}>
        <PreviewBox
          client={client}
          defaultSessionId={active()?.session_id}
          onClose={() => setShowPreview(false)}
        />
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Inline icons (stroke 1.6 to match the design's soft chrome)
   ────────────────────────────────────────────────────── */

function IconGear(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function IconSend(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function IconChevron(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function IconX(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

/* ──────────────────────────────────────────────────────
   TimelineRow — one log entry in the left column
   ────────────────────────────────────────────────────── */

function TimelineRow(props: {
  entry: RetrieveLogEntry
  active: boolean
  onPick: () => void
}): JSX.Element {
  const o = () => outcome(props.entry)
  return (
    <button
      type="button"
      class="rt-tl-row"
      data-active={props.active}
      onClick={props.onPick}
    >
      <div class="rt-tl-row-top">
        <span class="rt-tl-row-time">{fmtClock(props.entry.created_at)}</span>
        <span class="rt-tl-row-outcome" data-tone={o().tone}>
          <span class="rt-tl-row-dot" />
          {o().label}
        </span>
        <span class="rune-grow" />
        <span class="rt-tl-row-turn">#{props.entry.turn_index}</span>
      </div>
      <div class="rt-tl-row-q" title={props.entry.user_text_excerpt ?? ""}>
        {props.entry.user_text_excerpt || <em>（无 query 文本）</em>}
      </div>
      <div class="rt-tl-row-meta">
        <span class="rt-chip" data-trigger={props.entry.trigger ?? "unknown"}>
          {triggerLabel(props.entry.trigger)}
        </span>
        <span class="rt-tl-row-layer">{props.entry.layer}</span>
        <Show when={props.entry.picked.length > 0}>
          <span class="rt-tl-row-hits">{props.entry.picked.length} 命中</span>
        </Show>
        <Show when={props.entry.llm_used}>
          <span class="rt-tl-row-llm">llm</span>
        </Show>
        <span class="rune-grow" />
        <span class="rt-tl-row-dur">{fmtDuration(props.entry.duration_ms)}</span>
      </div>
    </button>
  )
}

/* ──────────────────────────────────────────────────────
   SessionSnapshot — 选中会话时的「当前已注入」全集条
   ────────────────────────────────────────────────────── */

function SessionSnapshot(props: { sessionId: string; entries: RetrieveLogEntry[] }): JSX.Element {
  const client = useExpClient()
  const [snap] = createResource(
    () => props.sessionId,
    async (sid) => {
      try {
        return await client.get<SessionStateRes>(`/retrieve/session-state?session_id=${encodeURIComponent(sid)}`)
      } catch {
        return undefined
      }
    },
  )
  const live = () => {
    const s = snap()
    return s && s.active ? s : undefined
  }
  // 引擎重启后内存态为空 —— 集合只增不减，∪(已加载日志的 picked) 即近似当前集合
  const picks = createMemo<PickedExperience[]>(() => {
    const s = live()
    if (s) return [...s.baseline, ...s.topical]
    const seen = new Map<string, PickedExperience>()
    for (const e of props.entries) {
      if (e.session_id !== props.sessionId) continue
      for (const p of e.picked) if (!seen.has(p.experience_id)) seen.set(p.experience_id, p)
    }
    return [...seen.values()]
  })
  return (
    <section class="rt-snap">
      <div class="rt-snap-hd">
        <span class="rt-snap-title">该会话当前已注入</span>
        <span class="rt-snap-count">{picks().length}</span>
        <Show when={live()}>
          <span class="rt-snap-meta">
            基线 {live()!.baseline.length} + 累计召回 {live()!.topical.length} · turn {live()!.turn_index}
          </span>
        </Show>
        <Show when={!live() && snap() !== undefined}>
          <span class="rt-snap-meta">引擎内存态已清（重启/压缩），由日志重建</span>
        </Show>
      </div>
      <Show when={picks().length > 0} fallback={<div class="rt-sec-empty">该会话还没有注入任何经验。</div>}>
        <div class="rt-snap-chips">
          <For each={picks()}>
            {(p) => (
              <span class="rt-snap-chip" title={`${p.title}\n${p.abstract || p.statement || ""}`}>
                <span class="rt-pick-dot" data-kind={p.kind} />
                {p.title}
              </span>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

/* ──────────────────────────────────────────────────────
   Detail — the selected log entry (bottom pane)
   ────────────────────────────────────────────────────── */

function Detail(props: { entry: RetrieveLogEntry }): JSX.Element {
  const client = useExpClient()
  const e = () => props.entry
  // 调试信息 toggle — OFF by default; trace / diff folds render only when on.
  const [debug, setDebug] = createSignal(false)
  // 列表接口剥离了 llm_trace（has_trace 标记代替）——开调试时按需拉单条全量
  const [fetchedTrace, setFetchedTrace] = createSignal<LlmTrace | undefined>()
  createEffect(() => {
    const cur = e()
    setFetchedTrace(undefined)
    if (!debug() || cur.llm_trace || !cur.has_trace) return
    void client
      .get<{ entry?: RetrieveLogEntry }>(`/retrieve/log-entry?id=${encodeURIComponent(cur.id)}`)
      .then((r) => setFetchedTrace(r?.entry?.llm_trace))
      .catch(() => {})
  })
  const tr = () => e().llm_trace ?? fetchedTrace()
  const hasDiff = () => diffTotal(e().diff) > 0
  const hasDebug = () => Boolean(tr()) || e().has_trace === true || hasDiff()
  return (
    <article class="rt-card">
      {/* Query / trigger header */}
      <header class="rt-card-head">
        <div class="rt-card-head-row">
          <span class="rt-chip" data-trigger={e().trigger ?? "unknown"} data-lg="true">
            {triggerLabel(e().trigger)}
          </span>
          <span class="rt-card-turn">Turn {e().turn_index}</span>
          <span class="rt-card-agent">{e().agent_name}</span>
          <span class="rune-grow" />
          <span class="rt-card-time">{fmtClock(e().created_at)}</span>
        </div>
        <div class="rt-card-q">
          {e().user_text_excerpt || <em>（无 query 文本）</em>}
        </div>
        <div class="rt-card-meta">
          <Meta k="picked" v={String(e().picked.length)} emph />
          <Meta k="候选" v={String(e().candidate_count)} />
          <Meta k="耗时" v={fmtDuration(e().duration_ms)} />
          <Meta k="模型" v={e().llm_used ? e().model?.modelID ?? "llm" : "heuristic"} />
        </div>
        <Show when={e().error}>
          <div class="rt-card-err">⚠ {e().error}</div>
        </Show>
      </header>

      {/* Injected experiences — flat, titles-first. Each pick leads with its
          kind dot + title, a gray abstract line, and a recall-method tag. */}
      <section class="rt-sec">
        <div class="rt-sec-hd">
          <span class="rt-sec-title">本次召回命中</span>
          <span class="rt-sec-count">{e().picked.length}</span>
          <span class="rt-sec-hint">该次触发新增/命中的经验；会话累计全集见上方（选中会话后显示）</span>
        </div>
        <Show
          when={e().picked.length > 0}
          fallback={<div class="rt-sec-empty">该次触发没有命中新的经验（已注入集合保持不变）。</div>}
        >
          <div class="rt-picks rt-picks-flat">
            <For each={e().picked}>
              {(p) => <PickRow pick={p} />}
            </For>
          </div>
        </Show>
      </section>

      {/* Debug info — OFF by default. trace / diff folds render only when on. */}
      <Show when={hasDebug()}>
        <div class="rt-dbg">
          <div class="rt-dbg-head">
            <span class="rt-dbg-label">调试信息</span>
            <button
              type="button"
              class="rt-dbg-switch"
              data-on={debug()}
              aria-pressed={debug()}
              onClick={() => setDebug((v) => !v)}
            >
              <span class="switch" data-on={debug()} />
              {debug() ? "已开启" : "已关闭"}
            </button>
          </div>

          <Show when={debug()}>
            <div class="rt-dbg-folds">
              {/* LLM call, in full — system / user / reasoning / response / output */}
              <Show when={tr()}>
                {(t) => (
                  <TraceFold
                    name="LLM 调用全文"
                    tag="trace"
                    count={`${[
                      t().system_prompt,
                      t().user_prompt,
                      t().reasoning_text,
                      t().response_text,
                      t().structured_output !== undefined,
                    ].filter(Boolean).length} 段`}
                    defaultOpen
                  >
                    <Show when={t().model_id}>
                      <div class="rt-trace-model">
                        {t().provider_id ? `${t().provider_id} · ` : ""}
                        {t().model_id}
                      </div>
                    </Show>
                    <Show when={t().error}>
                      <div class="rt-card-err">⚠ {t().error}</div>
                    </Show>
                    <Show when={t().system_prompt}>
                      <TracePart label="system" text={t().system_prompt!} />
                    </Show>
                    <TracePart label="user" text={t().user_prompt} />
                    <Show when={t().reasoning_text}>
                      <TracePart label="reasoning" text={t().reasoning_text!} />
                    </Show>
                    <Show when={t().response_text}>
                      <TracePart label="response" text={t().response_text!} />
                    </Show>
                    <Show when={t().structured_output !== undefined}>
                      <TracePart label="output" text={safeJson(t().structured_output)} />
                    </Show>
                  </TraceFold>
                )}
              </Show>

              {/* Diff vs previous round — added / removed / kept */}
              <Show when={hasDiff()}>
                <TraceFold
                  name="相对上一轮的增删"
                  tag="diff"
                  count={`+${e().diff.added.length} / =${e().diff.kept.length}`}
                >
                  <div class="rt-diff">
                    <DiffRow tone="add" items={e().diff.added} />
                    <DiffRow tone="rem" items={e().diff.removed} />
                    <DiffRow tone="kept" items={e().diff.kept} />
                  </div>
                </TraceFold>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </article>
  )
}

function Meta(props: { k: string; v: string; emph?: boolean }): JSX.Element {
  return (
    <span class="rt-meta" data-emph={props.emph ? "true" : "false"}>
      <span class="rt-meta-k">{props.k}</span>
      <span class="rt-meta-v">{props.v}</span>
    </span>
  )
}

/* ──────────────────────────────────────────────────────
   PickRow — one picked experience, expand for the full body
   ────────────────────────────────────────────────────── */

function PickRow(props: { pick: PickedExperience }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const p = () => props.pick
  const method = () => recallMethod(p().source)
  // The gray line under the title = the experience content (abstract), falling
  // back to its statement so something always shows.
  const content = () => p().abstract || p().statement || "（无摘要）"

  return (
    <div class="rt-pick" data-open={open()}>
      <button
        type="button"
        class="rt-pick-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
      >
        <span
          class="rt-pick-dot"
          style={{ background: `oklch(0.74 0.08 ${kindHue(p().kind)})` }}
        />
        <span class="rt-pick-main">
          <span class="rt-pick-row1">
            <span class="rt-pick-title">{p().title}</span>
            <span class="rt-pick-kind">{kindLabel(p().kind)}</span>
          </span>
          <span class="rt-pick-content">{content()}</span>
        </span>
        <span class="rt-pick-tag" data-deep={method().deep}>
          {method().tag}
        </span>
        <span class="rt-pick-chev">
          <IconChevron />
        </span>
      </button>

      <Show when={open()}>
        <div class="rt-pick-more">
          <MoreRow k="召回方式">
            <span>{method().detail}</span>
          </MoreRow>
          <Show when={p().reason}>
            <MoreRow k="理由">
              <span>{p().reason}</span>
            </MoreRow>
          </Show>
          <Show when={p().statement}>
            <MoreRow k="规则">
              <code class="rt-stmt-inline">{p().statement}</code>
            </MoreRow>
          </Show>
          <Show when={p().trigger_condition}>
            <MoreRow k="触发条件">
              <span>{p().trigger_condition}</span>
            </MoreRow>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function MoreRow(props: { k: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="rt-more-row">
      <span class="rt-more-k">{props.k}</span>
      <span class="rt-more-v">{props.children}</span>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   DiffRow — added / removed / kept chip row
   ────────────────────────────────────────────────────── */

function DiffRow(props: { tone: "add" | "rem" | "kept"; items: string[] }): JSX.Element {
  const sym = props.tone === "add" ? "+" : props.tone === "rem" ? "−" : "="
  const label = props.tone === "add" ? "added" : props.tone === "rem" ? "removed" : "kept"
  return (
    <Show when={props.items.length > 0}>
      <div class="rt-diff-row" data-tone={props.tone}>
        <span class="rt-diff-label">
          <span class="rt-diff-sym">{sym}</span> {label}
          <span class="rt-diff-n">{props.items.length}</span>
        </span>
        <div class="rt-diff-chips">
          <For each={props.items}>
            {(id) => (
              <span class="rt-diff-chip" title={id}>
                <span class="rt-diff-chip-dot" />
                {id.length > 22 ? `${id.slice(0, 20)}…` : id}
              </span>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

/* ──────────────────────────────────────────────────────
   TraceFold — collapsible prompt/response block
   ────────────────────────────────────────────────────── */

function TraceFold(props: {
  name: string
  tag?: string
  count?: string
  defaultOpen?: boolean
  children: JSX.Element
}): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  return (
    <div class="rt-fold" data-open={open()}>
      <button
        type="button"
        class="rt-fold-hd"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
      >
        <span class="rt-fold-caret">
          <IconChevron />
        </span>
        <span class="rt-fold-name">{props.name}</span>
        <span class="rune-grow" />
        <Show when={props.tag}>
          <span class="rt-fold-tag">{props.tag}</span>
        </Show>
        <Show when={props.count}>
          <span class="rt-fold-count">{props.count}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="rt-fold-body">{props.children}</div>
      </Show>
    </div>
  )
}

/* One labelled segment inside the "LLM 调用全文" fold (system / user / …). */
function TracePart(props: { label: string; text: string }): JSX.Element {
  const count = () => {
    const n = props.text.length
    return n < 1000 ? `${n} 字` : `${(n / 1000).toFixed(1)}K 字`
  }
  return (
    <div class="rt-trace-part">
      <div class="rt-trace-part-hd">
        <span class="rt-trace-part-label">{props.label}</span>
        <span class="rt-trace-part-count">{count()}</span>
      </div>
      <pre class="rt-trace-part-body">{props.text}</pre>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   ConfigBox — view/edit retrieve-config (GET/PUT /retrieve/config)
   ────────────────────────────────────────────────────── */

type RetrieveTunables = {
  max_picks: number
  max_candidates_to_llm: number
  heuristic_top_n: number
  expand_depth: number
  expand_kinds: string[]
}
type RetrieveConfigResponse = {
  resolved?: { providerID: string; modelID: string }
  source: "override" | "default" | "none"
  tunables: RetrieveTunables
  defaults: RetrieveTunables
}

const EXPAND_KIND_OPTIONS: { key: string; label: string }[] = [
  { key: "requires", label: "先决条件" },
  { key: "refines", label: "细化" },
  { key: "supports", label: "支持" },
  { key: "contradicts", label: "冲突" },
  { key: "related", label: "相关" },
]

/* ──────────────────────────────────────────────────────
   RtModal — small portaled modal shell shared by config / preview.
   Scrim click + Escape close; the body scrolls if it overflows.
   ────────────────────────────────────────────────────── */

function RtModal(props: {
  title: string
  sub?: string
  onClose: () => void
  children: JSX.Element
  footer?: JSX.Element
}): JSX.Element {
  onMount(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })
  return (
    <Portal>
      <div class="rt-scrim" role="presentation" onClick={props.onClose}>
        <div
          class="rt-modal"
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          onClick={(ev) => ev.stopPropagation()}
        >
          <header class="rt-modal-hd">
            <div class="rt-modal-hd-main">
              <h2 class="rt-modal-title">{props.title}</h2>
              <Show when={props.sub}>
                <span class="rt-modal-sub">{props.sub}</span>
              </Show>
            </div>
            <button
              type="button"
              class="rt-modal-close"
              title="关闭"
              onClick={props.onClose}
            >
              <IconX />
            </button>
          </header>
          <div class="rt-modal-bd">{props.children}</div>
          <Show when={props.footer}>
            <footer class="rt-modal-ft">{props.footer}</footer>
          </Show>
        </div>
      </div>
    </Portal>
  )
}

function ConfigBox(props: {
  client: ReturnType<typeof useExpClient>
  onClose: () => void
}): JSX.Element {
  const [cfg, { refetch }] = createResource(async () =>
    props.client.get<RetrieveConfigResponse>("/retrieve/config"),
  )

  const [maxPicks, setMaxPicks] = createSignal<number | "">("")
  const [maxCand, setMaxCand] = createSignal<number | "">("")
  const [heurN, setHeurN] = createSignal<number | "">("")
  const [expDepth, setExpDepth] = createSignal<number | "">("")
  const [expKinds, setExpKinds] = createSignal<string[]>([])
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [saved, setSaved] = createSignal(false)

  // Seed the draft from the loaded effective config.
  createEffect(() => {
    const t = cfg()?.tunables
    if (!t) return
    setMaxPicks(t.max_picks)
    setMaxCand(t.max_candidates_to_llm)
    setHeurN(t.heuristic_top_n)
    setExpDepth(t.expand_depth)
    setExpKinds([...t.expand_kinds])
  })

  const toggleKind = (k: string) =>
    setExpKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
  const numOrUndef = (v: number | "") =>
    v === "" || Number.isNaN(Number(v)) ? undefined : Number(v)

  const save = async () => {
    setBusy(true)
    setErr(null)
    setSaved(false)
    try {
      await props.client.put("/retrieve/config", {
        max_picks: numOrUndef(maxPicks()),
        max_candidates_to_llm: numOrUndef(maxCand()),
        heuristic_top_n: numOrUndef(heurN()),
        expand_depth: numOrUndef(expDepth()),
        expand_kinds: expKinds(),
      })
      await refetch()
      setSaved(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const numField = (
    label: string,
    hint: string,
    get: () => number | "",
    set: (v: number | "") => void,
  ) => (
    <label class="rt-field">
      <span class="rt-field-label">{label} · {hint}</span>
      <input
        class="rt-input"
        type="number"
        min="1"
        value={get()}
        onInput={(ev) => {
          const v = ev.currentTarget.value
          set(v === "" ? "" : Number(v))
          setSaved(false)
        }}
      />
    </label>
  )

  return (
    <RtModal
      title="召回配置"
      sub="retrieve-config · 改完即时生效，无需重启"
      onClose={props.onClose}
      footer={
        <>
          <Show when={saved()}>
            <span class="rt-cfg-saved">✓ 已保存</span>
          </Show>
          <span class="rune-grow" />
          <button type="button" class="rt-btn rt-btn-primary" onClick={save} disabled={busy()}>
            {busy() ? "保存中…" : "保存配置"}
          </button>
        </>
      }
    >
      <Show when={cfg()} fallback={<div class="rt-state">加载中…</div>}>
        <div class="rt-cfg-grid">
          {numField("max_picks", "快照上限", maxPicks, setMaxPicks)}
          {numField("max_candidates_to_llm", "送 LLM 候选", maxCand, setMaxCand)}
          {numField("heuristic_top_n", "启发式 top-n", heurN, setHeurN)}
          {numField("expand_depth", "关系展开深度", expDepth, setExpDepth)}
        </div>

        <div class="rt-field">
          <span class="rt-field-label">expand_kinds · 一并召回的关系类型</span>
          <div class="rt-cfg-kinds">
            <For each={EXPAND_KIND_OPTIONS}>
              {(o) => (
                <button
                  type="button"
                  class="rt-cfg-kind"
                  data-on={expKinds().includes(o.key)}
                  onClick={() => {
                    toggleKind(o.key)
                    setSaved(false)
                  }}
                >
                  {o.label}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={cfg()?.resolved}>
          <div class="rt-cfg-model">
            模型: <code>{cfg()!.resolved!.providerID}/{cfg()!.resolved!.modelID}</code>
            <span class="rt-field-hint"> ({cfg()!.source})</span>
          </div>
        </Show>

        <Show when={err()}>
          <div class="rt-card-err">⚠ {err()}</div>
        </Show>
      </Show>
    </RtModal>
  )
}

/* ──────────────────────────────────────────────────────
   PreviewBox — dry-run POST /retrieve/preview

   The server requires `session_id` (400s without it), so we default to the
   currently-selected entry's session and let the user override. `agent_name`
   and `user_text` drive what would be injected *now*. No state is mutated.
   ────────────────────────────────────────────────────── */

function PreviewBox(props: {
  client: ReturnType<typeof useExpClient>
  defaultSessionId?: string
  onClose: () => void
}): JSX.Element {
  const [sessionId, setSessionId] = createSignal("")
  const [agentName, setAgentName] = createSignal("build")
  const [userText, setUserText] = createSignal("")

  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [result, setResult] = createSignal<RetrievePreview | null>(null)

  // The effective session id: explicit input wins, else the active entry's.
  const effSession = () => sessionId().trim() || props.defaultSessionId || ""

  const run = async () => {
    const sid = effSession()
    if (!sid) {
      setError("需要 session_id(留空时取当前选中记录的会话)")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await props.client.post<RetrievePreview>("/retrieve/preview", {
        session_id: sid,
        agent_name: agentName().trim() || "build",
        user_text: userText().trim() || undefined,
      })
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <RtModal
      title="试运行 · dry-run preview"
      sub="不改动任何状态，只看现在会注入哪些经验"
      onClose={props.onClose}
      footer={
        <>
          <Show when={effSession()}>
            <span class="rt-preview-target">→ {effSession()}</span>
          </Show>
          <span class="rune-grow" />
          <button type="button" class="rt-btn rt-btn-primary" onClick={run} disabled={busy()}>
            {busy() ? "运行中…" : "运行 preview"}
          </button>
        </>
      }
    >
      <div class="rt-form-grid">
        <label class="rt-field">
          <span class="rt-field-label">agent_name</span>
          <input
            class="rt-input"
            type="text"
            value={agentName()}
            placeholder="build"
            onInput={(ev) => setAgentName(ev.currentTarget.value)}
          />
        </label>
        <label class="rt-field">
          <span class="rt-field-label">
            session_id
            <Show when={!sessionId().trim() && props.defaultSessionId}>
              <span class="rt-field-note"> · 默认取当前选中记录</span>
            </Show>
          </span>
          <input
            class="rt-input"
            type="text"
            value={sessionId()}
            placeholder={props.defaultSessionId ?? "ses_…"}
            onInput={(ev) => setSessionId(ev.currentTarget.value)}
          />
        </label>
      </div>
      <label class="rt-field">
        <span class="rt-field-label">user_text</span>
        <textarea
          class="rt-input rt-textarea"
          rows={3}
          value={userText()}
          placeholder="输入一句话，看现在会注入哪些经验…"
          onInput={(ev) => setUserText(ev.currentTarget.value)}
        />
      </label>

      <Show when={error()}>
        <div class="rt-card-err">⚠ {error()}</div>
      </Show>

      <Show when={result()}>
        {(r) => (
          <div class="rt-preview-result">
            <div class="rt-preview-result-meta">
              <Meta k="turn" v={String(r().turn_index)} />
              <Meta k="layer" v={r().agent_layer} />
              <Meta k="picked" v={String(r().picked.length)} emph />
            </div>

            <Show
              when={r().picked.length > 0}
              fallback={<div class="rt-sec-empty">此输入不会注入任何经验。</div>}
            >
              <div class="rt-picks rt-picks-flat">
                <For each={r().picked}>
                  {(p) => <PickRow pick={p} />}
                </For>
              </div>
            </Show>

            <Show when={diffTotal(r().diff) > 0}>
              <div class="rt-diff">
                <DiffRow tone="add" items={r().diff.added} />
                <DiffRow tone="rem" items={r().diff.removed} />
                <DiffRow tone="kept" items={r().diff.kept} />
              </div>
            </Show>

            <Show when={r().system_text}>
              <TraceFold name="注入的 system_text" tag="preview">
                <pre class="rt-trace-part-body">{r().system_text}</pre>
              </TraceFold>
            </Show>
          </div>
        )}
      </Show>
    </RtModal>
  )
}

/* ──────────────────────────────────────────────────────
   util
   ────────────────────────────────────────────────────── */

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
