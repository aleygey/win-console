/**
 * exp panel — List view ("经验列表").
 *
 * Layout: a toolbar (search / group toggle / refresh) over a two-pane body —
 * a left category tree (two-level tags with counts, plus 全部/待审核 shortcuts)
 * and the card area. Pending-review experiences are pulled OUT of the normal
 * flow into a pinned "待审核" queue at the top so they can be approved fast;
 * once approved they drop into their category section below.
 *
 * Cards show the full title and the full abstract (markdown-rendered — inline
 * code and lists survive). Clicking a card opens a detail modal: statement,
 * abstract, full `detail` body (markdown, the multi-step payload), a slim meta
 * grid, and collapsible folds for usage/judge stats, observations, and the
 * refinement history.
 *
 * Data: `GET /refiner/overview` for experiences, `GET /usage` for the judge /
 * injection counters, joined by id (see {@link ExpUsage}). Styling lives in the
 * co-located refine-list.css under the `el-` namespace — deliberately NOT the
 * `rl-` namespace, which refine-log.css also populates (a past collision let
 * the log view's `max-width: 880px` cap this grid at two columns).
 */

import {
  createResource,
  createSignal,
  createMemo,
  For,
  Show,
  Switch,
  Match,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useExpClient } from "../../api/client"
import { Icon } from "../../icons"
import { md } from "../../md"
import "./refine-list.css"

/* ──────────────────────────────────────────────────────
   Types — mirror the exp plugin store schema (v2). Kept
   local so this view owns its wire contract independently.
   ────────────────────────────────────────────────────── */

const CORE_KINDS = [
  "rule_must",
  "rule_must_not",
  "pattern",
  "recipe",
  "fact",
  "preference",
] as const
type CoreKind = (typeof CORE_KINDS)[number]

const LEGACY_KINDS = [
  "workflow_rule",
  "workflow_gap",
  "workflow_pattern",
  "know_how",
  "constraint_or_policy",
  "domain_knowledge",
  "preference_style",
  "pitfall_or_caveat",
] as const
type LegacyKind = (typeof LEGACY_KINDS)[number]

type Kind = CoreKind | LegacyKind | `custom:${string}`
type Scope = "workspace" | "project" | "repo" | "user"
type ReviewStatus = "pending" | "approved" | "rejected"

type HistoryEntry = {
  role: "user" | "assistant"
  text: string
  message_id: string
}

type WorkflowSnapshot = {
  workflow_id: string
  node_id?: string
  phase?: string
  recent_events: Array<{ kind: string; at: number; summary: string }>
}

type Observation = {
  id: string
  observed_at: number
  session_id: string
  message_id: string
  user_text: string
  agent_context: {
    session_history_excerpt: HistoryEntry[]
    workflow_snapshot?: WorkflowSnapshot
  }
}

type RefinementEntry = {
  at: number
  trigger_observation_id: string
  prev_abstract_digest: string
  model: string
  kind?: "refine" | "manual_edit" | "merge" | "re_refine" | "augment"
  source_ids?: string[]
}

type Experience = {
  id: string
  kind: Kind
  title: string
  abstract: string
  /** Full long-form body (markdown, multi-step) — abstract stays the short gist. */
  detail?: string
  statement?: string
  trigger_condition?: string
  task_type?: string
  scope: Scope
  categories?: string[]
  conflicts_with?: string[]
  review_status?: ReviewStatus
  reviewed_at?: number
  observations: Observation[]
  related_experience_ids: string[]
  refinement_history: RefinementEntry[]
  created_at: number
  last_refined_at: number
  path: string
}

/** Schema-v2 overview payload returned by `GET /refiner/overview`. */
type RefinerOverview = {
  schema_version?: number
  status?: {
    total_experiences: number
    total_observations: number
    latest_refined_at?: number
  }
  model?: { providerID: string; modelID: string }
  experiences: Experience[]
  graph?: unknown
}

/** Per-experience usage counters from `GET /usage` (= /refiner/stats):
 *  how often each exp was injected (by tier), cited by the judge, or recalled
 *  by the recall_experience tool. Keyed by experience id. */
type ExpUsage = {
  injected?: { total?: number; by_tier?: { baseline?: number; topical?: number; recall?: number }; last_at?: number }
  used?: { cited?: number; recalled?: number; last_at?: number }
  // Phase-1 judge observation (recorded only)
  ignored?: number
  not_relevant?: number
  bad?: number
  last_applied_at?: number
  last_bad_at?: number
  workflow?: Record<string, { applied?: number; ignored?: number }>
  co_injected?: Record<string, number>
}
type UsageMap = Record<string, ExpUsage>

/* ──────────────────────────────────────────────────────
   Kind palette + labels. Hues come from the shared design
   tokens (--kind-*). Legacy kinds fold into the nearest
   core token; custom kinds get the neutral token.
   ────────────────────────────────────────────────────── */

const KIND_COLOR: Record<CoreKind, string> = {
  rule_must: "var(--kind-rule_must)",
  rule_must_not: "var(--kind-rule_must_not)",
  pattern: "var(--kind-pattern)",
  recipe: "var(--kind-recipe)",
  fact: "var(--kind-fact)",
  preference: "var(--kind-preference)",
}

const LEGACY_KIND_COLOR: Record<LegacyKind, string> = {
  workflow_rule: "var(--kind-pattern)",
  workflow_gap: "var(--kind-rule_must_not)",
  workflow_pattern: "var(--kind-pattern)",
  know_how: "var(--kind-recipe)",
  constraint_or_policy: "var(--kind-rule_must)",
  domain_knowledge: "var(--kind-fact)",
  preference_style: "var(--kind-preference)",
  pitfall_or_caveat: "var(--kind-rule_must_not)",
}

const NEUTRAL_KIND_COLOR = "var(--kind-neutral)"

const KIND_LABEL: Record<CoreKind, string> = {
  rule_must: "必须",
  rule_must_not: "禁止",
  pattern: "模板",
  recipe: "操作",
  fact: "事实",
  preference: "偏好",
}

const LEGACY_KIND_LABEL: Record<LegacyKind, string> = {
  workflow_rule: "[旧] 流程规则",
  workflow_gap: "[旧] 流程缺口",
  workflow_pattern: "[旧] 工作流套路",
  know_how: "[旧] 操作指导",
  constraint_or_policy: "[旧] 硬约束",
  domain_knowledge: "[旧] 领域知识",
  preference_style: "[旧] 风格偏好",
  pitfall_or_caveat: "[旧] 注意事项",
}

function kindColor(kind?: Kind): string {
  if (!kind) return NEUTRAL_KIND_COLOR
  if (kind.startsWith("custom:")) return NEUTRAL_KIND_COLOR
  return (
    KIND_COLOR[kind as CoreKind] ??
    LEGACY_KIND_COLOR[kind as LegacyKind] ??
    NEUTRAL_KIND_COLOR
  )
}

function kindLabel(kind?: Kind): string {
  if (!kind) return "—"
  if (kind.startsWith("custom:")) return kind.slice("custom:".length)
  return (
    KIND_LABEL[kind as CoreKind] ??
    LEGACY_KIND_LABEL[kind as LegacyKind] ??
    kind
  )
}

const SCOPE_LABEL: Record<Scope, string> = {
  workspace: "工作区",
  project: "项目",
  repo: "仓库",
  user: "用户",
}

/* ── Formatting helpers ── */

const fmtDateTime = (value?: number): string =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—"

/** Compact "time ago" — keeps cards scannable vs. a full timestamp. */
function timeAgo(value?: number): string {
  if (!value) return "—"
  const diff = Date.now() - value
  if (diff < 0) return fmtDateTime(value)
  const s = Math.floor(diff / 1000)
  if (s < 60) return "刚刚"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}天前`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}个月前`
  return `${Math.floor(mo / 12)}年前`
}

/** Markdown bodies are innerHTML'd inside clickable cards — intercept anchor
 *  clicks so a link neither opens the modal nor navigates the SPA away. */
function onMdClick(ev: MouseEvent): void {
  const a = (ev.target as HTMLElement).closest("a")
  if (!a) return
  ev.preventDefault()
  ev.stopPropagation()
  const href = a.getAttribute("href")
  if (href && /^https?:/i.test(href)) window.open(href, "_blank", "noopener")
}

/** Sidebar sentinel for experiences with no categories at all. */
const UNCAT_TOP = "__uncat__"

/** Normalize whatever the endpoint returns into an Experience[]. */
function readExperiences(payload: unknown): Experience[] {
  if (Array.isArray(payload)) return payload as Experience[]
  if (payload && typeof payload === "object") {
    const exps = (payload as RefinerOverview).experiences
    if (Array.isArray(exps)) return exps
  }
  return []
}

/* ──────────────────────────────────────────────────────
   Component
   ────────────────────────────────────────────────────── */

export function RefineList(): JSX.Element {
  const client = useExpClient()
  const [selected, setSelected] = createSignal<Experience | null>(null)

  // createResource drives loading/error; refetch() re-runs the GET. The
  // fetcher tolerates the overview shape as well as a bare list, so the same
  // code path serves /refiner/overview today and /experiences later.
  // The playbook's /refiner/overview defaults to limit=40 (and even reports
  // total_experiences as the truncated count), so pass a high limit to get the
  // whole library — otherwise the list silently stops at 40.
  const [data, { refetch }] = createResource<Experience[]>(async () => {
    const overview = await client.get<RefinerOverview>("/refiner/overview?limit=5000")
    return readExperiences(overview)
  })

  // Per-experience usage counters (judge-cited / recalled / injected-by-tier).
  // Served at /usage; the overview payload itself carries no usage fields, so we
  // fetch it separately and join by id. Empty object on failure = no chips shown.
  const [usage] = createResource<UsageMap>(async () => {
    try {
      return await client.get<UsageMap>("/usage")
    } catch {
      return {}
    }
  })
  const usageFor = (id: string): ExpUsage | undefined => usage()?.[id]
  // id → title lookup (for co-injection display in the detail modal).
  const titleIndex = createMemo(() => {
    const m = new Map<string, string>()
    for (const e of data() ?? []) m.set(e.id, e.title)
    return m
  })
  const titleById = (id: string): string | undefined => titleIndex().get(id)

  // Filters. `top`/`sub` select a category (sub is a full "top/sub" value);
  // `queueOnly` is the 待审核 sidebar shortcut (queue fills the whole view).
  const [activeTop, setActiveTop] = createSignal<string | null>(null)
  const [activeSub, setActiveSub] = createSignal<string | null>(null)
  const [queueOnly, setQueueOnly] = createSignal(false)
  // Free-text search over title / abstract / detail / category.
  const [query, setQuery] = createSignal("")
  // Group the grid into sections by first-level tag (vs one flat grid).
  const [grouped, setGrouped] = createSignal(true)
  // Sidebar tree: which top-level tags are expanded.
  const [expandedTops, setExpandedTops] = createSignal<Set<string>>(new Set())

  const showAll = () => {
    setQueueOnly(false)
    setActiveTop(null)
    setActiveSub(null)
  }
  const selectTop = (top: string) => {
    setQueueOnly(false)
    setActiveTop(top)
    setActiveSub(null)
    setExpandedTops((prev) => new Set(prev).add(top))
  }
  const selectSub = (full: string) => {
    setQueueOnly(false)
    setActiveTop(firstLevel(full))
    setActiveSub((cur) => (cur === full ? null : full))
  }
  const toggleExpand = (top: string) =>
    setExpandedTops((prev) => {
      const next = new Set(prev)
      if (next.has(top)) next.delete(top)
      else next.add(top)
      return next
    })

  // first-level tag of a category string: "a/b" → "a"; flat "x" → "x".
  const firstLevel = (c: string) =>
    c.includes("/") ? c.slice(0, c.indexOf("/")) : c

  const matchesQuery = (x: Experience, q: string) =>
    [x.title, x.abstract, x.detail ?? "", ...(x.categories ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(q)

  const sortByRefined = (list: Experience[]) =>
    [...list].sort((a, b) => (b.last_refined_at ?? 0) - (a.last_refined_at ?? 0))

  // The review queue: pending experiences, newest first, search-filtered but
  // NOT category-filtered — it is a global inbox, pinned above everything.
  const pendingQueue = createMemo(() => {
    const q = query().trim().toLowerCase()
    let list = (data() ?? []).filter((x) => x.review_status === "pending")
    if (q) list = list.filter((x) => matchesQuery(x, q))
    return sortByRefined(list)
  })
  // Unfiltered pending count — so the queue-empty state can distinguish
  // "nothing pending" from "nothing pending matches the search".
  const pendingRaw = () =>
    (data() ?? []).filter((x) => x.review_status === "pending").length

  // Everything not pending flows through the category filter + search.
  const mainFlow = createMemo(() =>
    (data() ?? []).filter((x) => x.review_status !== "pending"),
  )

  // Two-level grouping by "/", with counts, over the main flow — drives the
  // sidebar tree. count(top) = experiences carrying any category under top.
  const categoryGroups = createMemo(() => {
    const tops = new Map<string, { count: number; subs: Map<string, number> }>()
    for (const x of mainFlow()) {
      const seenTops = new Set<string>()
      for (const c of x.categories ?? []) {
        const top = firstLevel(c)
        let g = tops.get(top)
        if (!g) {
          g = { count: 0, subs: new Map() }
          tops.set(top, g)
        }
        if (!seenTops.has(top)) {
          g.count += 1
          seenTops.add(top)
        }
        if (c.includes("/")) g.subs.set(c, (g.subs.get(c) ?? 0) + 1)
      }
    }
    return [...tops.entries()]
      .map(([top, g]) => ({
        top,
        count: g.count,
        subs: [...g.subs.entries()]
          .map(([full, count]) => ({ full, count }))
          .sort((a, b) => a.full.localeCompare(b.full)),
      }))
      .sort((a, b) => a.top.localeCompare(b.top))
  })

  const rawCount = () => (data() ?? []).length
  const uncatCount = () => mainFlow().filter((x) => (x.categories ?? []).length === 0).length
  const filtering = () =>
    activeTop() != null || activeSub() != null || query().trim().length > 0

  // Stable order (newest refinement first), then category filter, then search.
  const experiences = createMemo(() => {
    let list = sortByRefined(mainFlow())
    const sub = activeSub()
    const top = activeTop()
    if (sub) {
      list = list.filter((x) => (x.categories ?? []).includes(sub))
    } else if (top === UNCAT_TOP) {
      list = list.filter((x) => (x.categories ?? []).length === 0)
    } else if (top) {
      list = list.filter((x) => (x.categories ?? []).some((c) => firstLevel(c) === top))
    }
    const q = query().trim().toLowerCase()
    if (q) list = list.filter((x) => matchesQuery(x, q))
    return list
  })

  // first-level tag of an experience (top before "/", or 其他 if none).
  const topTag = (x: Experience) => {
    const c = (x.categories ?? [])[0]
    return c ? firstLevel(c) : "其他"
  }
  // Sections by first-level tag, for the grouped view.
  const sections = () => {
    const groups = new Map<string, Experience[]>()
    for (const x of experiences()) {
      const t = topTag(x)
      if (!groups.has(t)) groups.set(t, [])
      groups.get(t)!.push(x)
    }
    return [...groups.entries()]
      .map(([tag, items]) => ({ tag, items }))
      .sort((a, b) => (a.tag === "其他" ? 1 : b.tag === "其他" ? -1 : a.tag.localeCompare(b.tag)))
  }

  // Multi-select (ctrl/cmd + click on cards) → manual merge.
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set())
  const [mergeBusy, setMergeBusy] = createSignal(false)
  const [mergeConfirm, setMergeConfirm] = createSignal(false)
  const [mergeErr, setMergeErr] = createSignal<string | null>(null)
  const toggleSelect = (id: string) => {
    setMergeConfirm(false)
    setMergeErr(null)
    setSelectedIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const clearSelect = () => {
    setSelectedIds(new Set<string>())
    setMergeConfirm(false)
    setMergeErr(null)
  }
  const doMerge = async () => {
    if (mergeBusy() || selectedIds().size < 2) return
    setMergeBusy(true)
    setMergeErr(null)
    try {
      await client.post("/refiner/experience/merge", {
        ids: [...selectedIds()],
        reason: "manual_multi_select",
      })
      clearSelect()
      await refetch()
    } catch (ex: any) {
      setMergeErr(String(ex?.message ?? ex))
    } finally {
      setMergeBusy(false)
    }
  }

  // After a mutation in the detail modal, re-pull the list and re-sync the
  // open experience to its fresh copy — or close the modal if it was deleted.
  const reloadAndSync = async () => {
    const fresh = await refetch()
    const cur = selected()
    if (!cur) return
    const next = Array.isArray(fresh)
      ? fresh.find((x) => x.id === cur.id)
      : undefined
    setSelected(next ?? null)
  }

  return (
    <div class="el-root">
      <Switch>
        {/* error — only when there is no previously-loaded data to show */}
        <Match when={data.error && !data.latest}>
          <div class="el-state" data-tone="error">
            <div class="el-state-title">加载经验库失败</div>
            <div class="el-state-detail">
              {String((data.error as Error)?.message ?? data.error)}
            </div>
            <button type="button" class="el-state-retry" onClick={() => refetch()}>
              重试
            </button>
          </div>
        </Match>

        {/* loading — skeleton grid on first load */}
        <Match when={data.loading && !data.latest}>
          <div class="el-grid" aria-busy="true">
            <For each={Array.from({ length: 6 })}>
              {() => <div class="el-skeleton" />}
            </For>
          </div>
        </Match>

        {/* empty — the library itself is empty (not merely filtered) */}
        <Match when={rawCount() === 0}>
          <div class="el-state">
            <div class="el-state-title">暂无经验</div>
            <div class="el-state-detail">
              当 refiner 从会话中沉淀出经验后，它们会出现在这里。
            </div>
            <button type="button" class="el-state-retry" onClick={() => refetch()}>
              刷新
            </button>
          </div>
        </Match>

        {/* loaded */}
        <Match when={rawCount() > 0}>
          <div class="el-toolbar">
            <label class="el-search">
              <Icon name="search" size={15} />
              <input
                class="el-search-input"
                placeholder="搜索标题、摘要、标签…"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <Show when={query()}>
                <button class="el-search-x" title="清除" onClick={() => setQuery("")}>
                  <Icon name="x" size={13} />
                </button>
              </Show>
            </label>
            <span class="el-count">
              {/* count what is actually on screen: queue cards + list cards */}
              <b>
                {queueOnly()
                  ? pendingQueue().length
                  : experiences().length + pendingQueue().length}
              </b>{" "}
              条
              <Show when={filtering() || queueOnly()}>
                <span class="el-count-sub"> / 共 {rawCount()}</span>
              </Show>
            </span>
            <span class="el-spacer" />
            <button
              type="button"
              class="el-toggle"
              data-on={grouped()}
              title="按一级标签分组显示"
              onClick={() => setGrouped((v) => !v)}
            >
              <Icon name="share-2" size={14} />
              分组
            </button>
            <button
              type="button"
              class="el-refresh"
              disabled={data.loading}
              onClick={() => refetch()}
            >
              <RefreshIcon />
              {data.loading ? "刷新中…" : "刷新"}
            </button>
          </div>

          <div class="el-body">
            {/* Sidebar — 全部 / 待审核 shortcuts + two-level category tree. */}
            <aside class="el-side" aria-label="分类筛选">
              <button
                type="button"
                class="el-nav"
                data-on={!queueOnly() && activeTop() == null}
                onClick={showAll}
              >
                <Icon name="layers" size={14} />
                <span class="el-nav-label">全部经验</span>
                <span class="el-nav-n">{mainFlow().length}</span>
              </button>
              <button
                type="button"
                class="el-nav el-nav-queue"
                data-on={queueOnly()}
                onClick={() => setQueueOnly(true)}
              >
                <span class="el-nav-pending-dot" aria-hidden="true" />
                <span class="el-nav-label">待审核</span>
                <span class="el-nav-n" data-tone={pendingQueue().length > 0 ? "warn" : undefined}>
                  {pendingQueue().length}
                </span>
              </button>

              <Show when={categoryGroups().length > 0 || uncatCount() > 0}>
                <div class="el-side-label">分类</div>
                <div class="el-tree">
                  <For each={categoryGroups()}>
                    {(g) => (
                      <div class="el-tree-group">
                        <div class="el-tree-row">
                          <button
                            type="button"
                            class="el-tree-caret"
                            data-open={expandedTops().has(g.top)}
                            data-empty={g.subs.length === 0}
                            aria-label={expandedTops().has(g.top) ? "收起" : "展开"}
                            tabIndex={g.subs.length === 0 ? -1 : 0}
                            onClick={() => g.subs.length > 0 && toggleExpand(g.top)}
                          >
                            <CaretIcon />
                          </button>
                          <button
                            type="button"
                            class="el-tree-name"
                            data-on={!queueOnly() && activeTop() === g.top && activeSub() == null}
                            onClick={() => selectTop(g.top)}
                          >
                            <span class="el-tree-text">{g.top}</span>
                            <span class="el-nav-n">{g.count}</span>
                          </button>
                        </div>
                        <Show when={g.subs.length > 0 && expandedTops().has(g.top)}>
                          <div class="el-tree-subs">
                            <For each={g.subs}>
                              {(s) => (
                                <button
                                  type="button"
                                  class="el-tree-sub"
                                  data-on={!queueOnly() && activeSub() === s.full}
                                  onClick={() => selectSub(s.full)}
                                >
                                  <span class="el-tree-text">
                                    {s.full.slice(s.full.indexOf("/") + 1)}
                                  </span>
                                  <span class="el-nav-n">{s.count}</span>
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                  {/* Experiences with no tags are otherwise unreachable from
                      the tree — give them an explicit entry. */}
                  <Show when={uncatCount() > 0}>
                    <div class="el-tree-row">
                      <button type="button" class="el-tree-caret" data-empty="true" tabIndex={-1}>
                        <CaretIcon />
                      </button>
                      <button
                        type="button"
                        class="el-tree-name"
                        data-on={!queueOnly() && activeTop() === UNCAT_TOP}
                        onClick={() => selectTop(UNCAT_TOP)}
                      >
                        <span class="el-tree-text">未分类</span>
                        <span class="el-nav-n">{uncatCount()}</span>
                      </button>
                    </div>
                  </Show>
                </div>
              </Show>
            </aside>

            {/* Card area — pinned review queue, then the filtered sections. */}
            <div class="el-main">
              {/* 待审核 queue — global inbox, always pinned on top. */}
              <Show when={pendingQueue().length > 0}>
                <section class="el-queue">
                  <div class="el-queue-head">
                    <span class="el-queue-dot" aria-hidden="true" />
                    <span class="el-queue-title">待审核</span>
                    <span class="el-queue-n">{pendingQueue().length}</span>
                    <span class="el-queue-hint">批准后自动归入下方分类</span>
                  </div>
                  <div class="el-grid-inner">
                    <For each={pendingQueue()}>
                      {(exp) => (
                        <ExperienceCard
                          exp={exp}
                          usage={usageFor(exp.id)}
                          inQueue
                          selected={selectedIds().has(exp.id)}
                          onToggleSelect={() => toggleSelect(exp.id)}
                          onOpen={() => setSelected(exp)}
                        />
                      )}
                    </For>
                  </div>
                </section>
              </Show>
              <Show when={queueOnly() && pendingQueue().length === 0}>
                <div class="el-state el-state-inline">
                  <div class="el-state-detail">
                    {pendingRaw() > 0
                      ? "没有匹配当前搜索的待审核经验"
                      : "没有待审核的经验"}
                  </div>
                  <Show
                    when={pendingRaw() > 0}
                    fallback={
                      <button type="button" class="el-state-retry" onClick={showAll}>
                        查看全部
                      </button>
                    }
                  >
                    <button type="button" class="el-state-retry" onClick={() => setQuery("")}>
                      清除搜索
                    </button>
                  </Show>
                </div>
              </Show>

              <Show when={!queueOnly()}>
                <Show
                  when={experiences().length > 0}
                  fallback={
                    <div class="el-state el-state-inline">
                      <div class="el-state-detail">该分类下暂无经验</div>
                      <button
                        type="button"
                        class="el-state-retry"
                        onClick={() => {
                          showAll()
                          setQuery("")
                        }}
                      >
                        清除筛选
                      </button>
                    </div>
                  }
                >
                  {/* With a category filter active the sections would bucket by
                      each item's FIRST tag (not the selected one) — confusing,
                      so filtered views always render the flat grid. */}
                  <Show
                    when={grouped() && activeTop() == null}
                    fallback={
                      <div class="el-grid">
                        <For each={experiences()}>
                          {(exp) => (
                            <ExperienceCard
                              exp={exp}
                              usage={usageFor(exp.id)}
                              selected={selectedIds().has(exp.id)}
                              onToggleSelect={() => toggleSelect(exp.id)}
                              onOpen={() => setSelected(exp)}
                            />
                          )}
                        </For>
                      </div>
                    }
                  >
                    <div class="el-sections">
                      <For each={sections()}>
                        {(s) => (
                          <section class="el-section">
                            <div class="el-section-head">
                              <span class="el-section-tag">{s.tag}</span>
                              <span class="el-section-n">{s.items.length}</span>
                              <span class="el-section-rule" aria-hidden="true" />
                            </div>
                            <div class="el-grid-inner">
                              <For each={s.items}>
                                {(exp) => (
                                  <ExperienceCard
                                    exp={exp}
                                    usage={usageFor(exp.id)}
                                    selected={selectedIds().has(exp.id)}
                                    onToggleSelect={() => toggleSelect(exp.id)}
                                    onOpen={() => setSelected(exp)}
                                  />
                                )}
                              </For>
                            </div>
                          </section>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>

              {/* multi-select action bar — sticks to the bottom of the scroll */}
              <Show when={selectedIds().size > 0}>
                <div class="el-selbar">
                  <span class="el-selbar-n">
                    已选 <b>{selectedIds().size}</b> 条
                  </span>
                  <span class="el-selbar-hint">Ctrl+点击卡片可增减</span>
                  <Show when={mergeErr()}>
                    <span class="el-selbar-err">{mergeErr()}</span>
                  </Show>
                  <span class="el-spacer" />
                  <Show
                    when={mergeConfirm()}
                    fallback={
                      <button
                        type="button"
                        class="el-btn el-btn-primary"
                        disabled={selectedIds().size < 2 || mergeBusy()}
                        title={selectedIds().size < 2 ? "至少选择 2 条才能合并" : undefined}
                        onClick={() => setMergeConfirm(true)}
                      >
                        合并 {selectedIds().size} 条
                      </button>
                    }
                  >
                    <span class="el-selbar-q">合并会删除源经验并生成一条新经验，确认？</span>
                    <button
                      type="button"
                      class="el-btn el-btn-primary"
                      disabled={mergeBusy()}
                      onClick={doMerge}
                    >
                      {mergeBusy() ? "合并中…" : "确认合并"}
                    </button>
                    <button
                      type="button"
                      class="el-btn"
                      disabled={mergeBusy()}
                      onClick={() => setMergeConfirm(false)}
                    >
                      取消
                    </button>
                  </Show>
                  <button type="button" class="el-btn" disabled={mergeBusy()} onClick={clearSelect}>
                    清除
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </Match>
      </Switch>

      <Show when={selected()}>
        {(exp) => (
          <DetailModal
            exp={exp()}
            usage={usageFor(exp().id)}
            titleById={titleById}
            onNavigate={(id) => {
              const next = (data() ?? []).find((x) => x.id === id)
              if (next) setSelected(next)
            }}
            onClose={() => setSelected(null)}
            onMutated={reloadAndSync}
          />
        )}
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Card
   ────────────────────────────────────────────────────── */

function ExperienceCard(props: {
  exp: Experience
  usage?: ExpUsage
  /** Rendered inside the 待审核 queue — the section carries the tint, so the
   *  card itself stays neutral and drops the redundant 待审 chip. */
  inQueue?: boolean
  /** ctrl/cmd+click multi-select for manual merge. */
  selected?: boolean
  onToggleSelect?: () => void
  onOpen: () => void
}): JSX.Element {
  const e = () => props.exp
  const obsCount = () => e().observations?.length ?? 0
  const cited = () => props.usage?.used?.cited ?? 0
  const recalled = () => props.usage?.used?.recalled ?? 0
  const flag = () => {
    if (props.inQueue) return undefined
    const s = e().review_status
    return s === "pending" || s === "rejected" ? s : undefined
  }
  return (
    <div
      role="button"
      tabIndex={0}
      class="el-card"
      data-status={props.inQueue ? undefined : e().review_status}
      data-selected={props.selected || undefined}
      style={{ "--el-kind-color": kindColor(e().kind) }}
      onClick={(ev) => {
        // ctrl/cmd+click toggles multi-select (for merge) instead of opening
        if ((ev.ctrlKey || ev.metaKey) && props.onToggleSelect) {
          props.onToggleSelect()
          return
        }
        props.onOpen()
      }}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault()
          if ((ev.ctrlKey || ev.metaKey) && props.onToggleSelect) props.onToggleSelect()
          else props.onOpen()
        }
      }}
    >
      {/* kind line — small, leads the card; dot carries the (desaturated) hue */}
      <div class="el-card-head">
        <span class="el-kind">
          <span class="el-kind-dot" aria-hidden="true" />
          {kindLabel(e().kind)}
        </span>
        <span class="el-spacer" />
        <Show when={flag()}>
          {(f) => (
            <span class="el-flag" data-status={f()}>
              <span class="el-flag-dot" aria-hidden="true" />
              {f() === "pending" ? "待审" : "已拒绝"}
            </span>
          )}
        </Show>
      </div>

      {/* title is the hero — full, no clamping */}
      <h3 class="el-card-title">{e().title || "（无标题）"}</h3>

      {/* body: the experience content (detail under the new contract; legacy
          items fall back to abstract). Full markdown, no clamping. */}
      <Show when={(e().detail?.trim() || e().abstract)?.trim()}>
        <div
          class="el-card-abstract el-md"
          innerHTML={md(e().detail?.trim() || e().abstract)}
          onClick={onMdClick}
        />
      </Show>

      {/* footer — obs · usage · (scope) · time, quiet mono */}
      <div class="el-card-meta">
        <span class="el-meta-item">
          <b>{obsCount()}</b> obs
        </span>
        <Show when={cited() > 0}>
          <span class="el-meta-item el-use" title="judge 判定被采用的次数">
            ✓<b>{cited()}</b>
          </span>
        </Show>
        <Show when={recalled() > 0}>
          <span class="el-meta-item el-use" title="被 recall 工具召回的次数">
            ⤴<b>{recalled()}</b>
          </span>
        </Show>
        <span class="el-spacer" />
        <Show when={e().scope && e().scope !== "workspace"}>
          <span class="el-foot-scope">{SCOPE_LABEL[e().scope] ?? e().scope}</span>
        </Show>
        <span class="el-meta-item">{timeAgo(e().last_refined_at)}</span>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Detail modal — statement / abstract / detail body /
   slim meta, plus collapsible folds for usage stats,
   observations and refinement history. Portaled; Escape +
   scrim click both close.
   ────────────────────────────────────────────────────── */

function DetailModal(props: {
  exp: Experience
  usage?: ExpUsage
  titleById?: (id: string) => string | undefined
  onNavigate?: (id: string) => void
  onClose: () => void
  onMutated: () => void | Promise<void>
}): JSX.Element {
  const client = useExpClient()
  const e = () => props.exp
  const u = () => props.usage
  // Top co-injected experiences (recalled together for the same queries) — a
  // manual merge hint. Sorted by count, capped.
  const coInjected = () => {
    const co = u()?.co_injected
    if (!co) return [] as Array<{ id: string; title: string; count: number }>
    return Object.entries(co)
      .filter(([, n]) => (n ?? 0) > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id, count]) => ({ id, title: props.titleById?.(id) ?? id, count }))
  }
  // Per-workflow judge affinity, sorted by applied desc then ignored desc.
  const workflowStats = () =>
    Object.entries(u()?.workflow ?? {})
      .map(([wf, c]) => ({ wf, applied: c.applied ?? 0, ignored: c.ignored ?? 0 }))
      .filter((x) => x.applied > 0 || x.ignored > 0)
      .sort((a, b) => b.applied - a.applied || b.ignored - a.ignored)

  const hasUsage = () => {
    const x = u()
    if (!x) return false
    return (
      (x.injected?.total ?? 0) > 0 ||
      (x.used?.cited ?? 0) > 0 ||
      (x.used?.recalled ?? 0) > 0 ||
      (x.ignored ?? 0) > 0 ||
      (x.not_relevant ?? 0) > 0 ||
      (x.bad ?? 0) > 0
    )
  }

  const [busy, setBusy] = createSignal<string | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [editing, setEditing] = createSignal(false)
  const [confirmDel, setConfirmDel] = createSignal(false)
  const [newObs, setNewObs] = createSignal("")

  // Collapsible secondary folds — caret rotates via data-open.
  const [relOpen, setRelOpen] = createSignal(true)
  const [usageOpen, setUsageOpen] = createSignal(false)
  const [obsOpen, setObsOpen] = createSignal(false)
  const [histOpen, setHistOpen] = createSignal(false)

  // Edit-mode draft, seeded from the experience when entering edit mode.
  const [dKind, setDKind] = createSignal<Kind>("fact")
  const [dScope, setDScope] = createSignal<Scope>("workspace")
  const [dTitle, setDTitle] = createSignal("")
  const [dAbstract, setDAbstract] = createSignal("")
  const [dDetail, setDDetail] = createSignal("")
  const [dStatement, setDStatement] = createSignal("")
  const [dCategories, setDCategories] = createSignal<string[]>([])
  const [catDraft, setCatDraft] = createSignal("")

  const startEdit = () => {
    const x = e()
    setDKind((x.kind as Kind) ?? "fact")
    setDScope((x.scope as Scope) ?? "workspace")
    setDTitle(x.title ?? "")
    setDAbstract(x.abstract ?? "")
    setDDetail(x.detail ?? "")
    setDStatement(x.statement ?? "")
    setDCategories([...(x.categories ?? [])])
    setCatDraft("")
    setErr(null)
    setEditing(true)
  }
  const cancelEdit = () => {
    setEditing(false)
    setErr(null)
  }

  // While editing, an outside click must not silently destroy the draft —
  // only the explicit 取消/保存 buttons (or Escape) end edit mode.
  const requestClose = () => {
    if (editing()) return
    props.onClose()
  }

  onMount(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return
      if (editing()) cancelEdit()
      else if (confirmDel()) setConfirmDel(false)
      else props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  // Run a mutation: flag busy, surface errors, refresh the list on success.
  const run = async (
    label: string,
    fn: () => Promise<unknown>,
    opts?: { closeAfter?: boolean },
  ) => {
    if (busy()) return
    setBusy(label)
    setErr(null)
    try {
      await fn()
      await props.onMutated()
      if (opts?.closeAfter) props.onClose()
    } catch (ex: any) {
      setErr(String(ex?.message ?? ex))
    } finally {
      setBusy(null)
    }
  }

  const saveEdit = () =>
    run("save", async () => {
      await client.patch(`/refiner/experience/${e().id}`, {
        kind: dKind(),
        scope: dScope(),
        title: dTitle().trim(),
        abstract: dAbstract().trim(),
        // null (not undefined) so clearing the field actually clears it —
        // undefined means "no change" to the PATCH endpoint.
        detail: dDetail().trim() || null,
        statement: dStatement().trim() || null,
        categories: dCategories(),
      })
      setEditing(false)
    })

  const setReview = (status: "approved" | "rejected" | "pending") =>
    run(status, () => client.post(`/refiner/experience/${e().id}/review`, { status }))

  const reRefine = () =>
    run("refine", () => client.post(`/refiner/experience/${e().id}/refine`, {}))

  const remove = () =>
    run("delete", () => client.del(`/refiner/experience/${e().id}`), { closeAfter: true })

  const addObservation = () => {
    const user_text = newObs().trim()
    if (!user_text) return
    return run("augment", async () => {
      await client.post(`/refiner/experience/${e().id}/observation`, { user_text })
      setNewObs("")
    })
  }

  const deleteObservation = (obsId: string) =>
    run(`delobs:${obsId}`, () =>
      client.del(`/refiner/experience/${e().id}/observation/${obsId}`),
    )

  const status = () => e().review_status

  // Observations newest-first; refinement history newest-first too.
  const observations = () =>
    [...(e().observations ?? [])].sort((a, b) => (b.observed_at ?? 0) - (a.observed_at ?? 0))
  const history = () =>
    [...(e().refinement_history ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))

  return (
    <Portal>
      <div class="el-scrim" role="presentation" onClick={requestClose}>
        <div
          class="el-modal"
          role="dialog"
          aria-modal="true"
          aria-label={e().title}
          onClick={(ev) => ev.stopPropagation()}
        >
          <header class="el-modal-hd">
            <div class="el-modal-hd-main">
              <div class="el-modal-hd-tags">
                <span
                  class="el-kind"
                  style={{ "--el-kind-color": kindColor(editing() ? dKind() : e().kind) }}
                >
                  <span class="el-kind-dot" aria-hidden="true" />
                  {kindLabel(editing() ? dKind() : e().kind)}
                </span>
                <span class="el-scope">
                  {SCOPE_LABEL[(editing() ? dScope() : e().scope) as Scope] ?? e().scope ?? "—"}
                </span>
                <Show when={status() && status() !== "approved"}>
                  <span class="el-flag" data-status={status()}>
                    <span class="el-flag-dot" aria-hidden="true" />
                    {status() === "pending" ? "待审" : "已拒绝"}
                  </span>
                </Show>
              </div>
              <Show
                when={editing()}
                fallback={<h2 class="el-modal-title">{e().title || "（无标题）"}</h2>}
              >
                <input
                  class="el-edit-title"
                  value={dTitle()}
                  placeholder="标题"
                  onInput={(ev) => setDTitle(ev.currentTarget.value)}
                />
              </Show>
            </div>
            <button
              type="button"
              class="el-modal-close"
              aria-label="关闭"
              onClick={() => (editing() ? cancelEdit() : props.onClose())}
            >
              <CloseIcon />
            </button>
          </header>

          <Show when={err()}>
            <div class="el-modal-err" role="alert">
              {err()}
            </div>
          </Show>

          <div class="el-modal-bd">
            <Show
              when={editing()}
              fallback={
                <>
                  {/* Statement — the focal block: actionable rule, emphasized,
                      with a left border in the kind hue. */}
                  <Show when={e().statement?.trim()}>
                    <div
                      class="el-statement"
                      style={{ "--el-kind-color": kindColor(e().kind) }}
                    >
                      <span class="el-statement-label">规则 · Statement</span>
                      <p class="el-statement-text">{e().statement}</p>
                    </div>
                  </Show>

                  {/* Body — detail is the content under the new contract;
                      legacy items without one show their abstract instead. */}
                  <Show
                    when={e().detail?.trim()}
                    fallback={
                      <section class="el-sec">
                        <span class="el-sec-label">摘要 · Abstract</span>
                        <Show
                          when={e().abstract?.trim()}
                          fallback={<p class="el-empty-inline">（无内容）</p>}
                        >
                          <div class="el-prose el-md" innerHTML={md(e().abstract)} onClick={onMdClick} />
                        </Show>
                      </section>
                    }
                  >
                    <section class="el-sec">
                      <span class="el-sec-label">正文 · Content</span>
                      <div class="el-detail-body el-md" innerHTML={md(e().detail!)} onClick={onMdClick} />
                    </section>
                  </Show>

                  {/* Meta — slim: only descriptive fields; stats live in the
                      usage fold below. */}
                  <section class="el-sec">
                    <span class="el-sec-label">元信息 · Meta</span>
                    <dl class="el-kv">
                      {/* with a body present, the abstract is just the one-line
                          recall index — show it here instead of as a section */}
                      <Show when={e().detail?.trim() && e().abstract?.trim()}>
                        <dt>一句话索引</dt>
                        <dd>{e().abstract}</dd>
                      </Show>
                      <Show when={e().trigger_condition?.trim()}>
                        <dt>触发条件</dt>
                        <dd>{e().trigger_condition}</dd>
                      </Show>
                      <Show when={e().task_type?.trim()}>
                        <dt>任务类型</dt>
                        <dd>{e().task_type}</dd>
                      </Show>
                      <Show when={e().categories && e().categories!.length > 0}>
                        <dt>分类</dt>
                        <dd>{e().categories!.join(" · ")}</dd>
                      </Show>
                      <dt>创建于</dt>
                      <dd>{fmtDateTime(e().created_at)}</dd>
                      <dt>最近整理</dt>
                      <dd>{fmtDateTime(e().last_refined_at)}</dd>
                      <Show
                        when={
                          e().related_experience_ids && e().related_experience_ids.length > 0
                        }
                      >
                        <dt>关联经验</dt>
                        <dd>{e().related_experience_ids.length} 条</dd>
                      </Show>
                    </dl>
                  </section>
                </>
              }
            >
              {/* Edit form — title is edited in the header above */}
              <section class="el-editform">
                <div class="el-field-row">
                  <label class="el-field">
                    <span class="el-sec-label">类型 · Kind</span>
                    <select
                      class="el-input"
                      value={dKind()}
                      onChange={(ev) => setDKind(ev.currentTarget.value as Kind)}
                    >
                      <For each={CORE_KINDS}>
                        {(k) => <option value={k}>{KIND_LABEL[k]}</option>}
                      </For>
                    </select>
                  </label>
                  <label class="el-field">
                    <span class="el-sec-label">范围 · Scope</span>
                    <select
                      class="el-input"
                      value={dScope()}
                      onChange={(ev) => setDScope(ev.currentTarget.value as Scope)}
                    >
                      <For each={["workspace", "project", "repo", "user"] as Scope[]}>
                        {(s) => <option value={s}>{SCOPE_LABEL[s]}</option>}
                      </For>
                    </select>
                  </label>
                </div>
                <label class="el-field">
                  <span class="el-sec-label">一句话索引 · Abstract</span>
                  <textarea
                    class="el-input el-textarea"
                    rows={2}
                    placeholder="做什么 + 什么时候用（用于召回候选/列表扫读）"
                    value={dAbstract()}
                    onInput={(ev) => setDAbstract(ev.currentTarget.value)}
                  />
                </label>
                <label class="el-field">
                  <span class="el-sec-label">正文 · Detail（Markdown，不限长度）</span>
                  <textarea
                    class="el-input el-textarea el-textarea-detail"
                    rows={10}
                    placeholder="经验正文：规则类一两行；多步骤用有序列表分步；命令用行内代码"
                    value={dDetail()}
                    onInput={(ev) => setDDetail(ev.currentTarget.value)}
                  />
                </label>
                <label class="el-field">
                  <span class="el-sec-label">规则 · Statement</span>
                  <textarea
                    class="el-input el-textarea"
                    rows={2}
                    placeholder="（可选）"
                    value={dStatement()}
                    onInput={(ev) => setDStatement(ev.currentTarget.value)}
                  />
                </label>
                <div class="el-field">
                  <span class="el-sec-label">分类 · Categories</span>
                  <div class="el-cat-edit">
                    <For each={dCategories()}>
                      {(c) => (
                        <span class="el-cat-tag">
                          {c}
                          <button
                            type="button"
                            class="el-cat-tag-x"
                            title="移除"
                            onClick={() =>
                              setDCategories((prev) => prev.filter((x) => x !== c))
                            }
                          >
                            ✕
                          </button>
                        </span>
                      )}
                    </For>
                    <Show when={dCategories().length === 0}>
                      <span class="el-empty-inline">（无分类）</span>
                    </Show>
                  </div>
                  <input
                    class="el-input"
                    placeholder="新增分类，支持二级 a/b，回车添加"
                    value={catDraft()}
                    onInput={(ev) => setCatDraft(ev.currentTarget.value)}
                    onKeyDown={(ev) => {
                      // IME composition commit also fires Enter — don't turn a
                      // half-composed draft into a tag.
                      if (ev.isComposing || ev.keyCode === 229) return
                      if (ev.key !== "Enter") return
                      ev.preventDefault()
                      const v = catDraft().trim()
                      if (v && !dCategories().includes(v))
                        setDCategories((prev) => [...prev, v])
                      setCatDraft("")
                    }}
                  />
                </div>
              </section>
            </Show>

            {/* Folds: relations / usage stats / observations / history. */}
            <Show when={!editing()}>
              {/* Relation star — replaces the retired 关系图谱 tab. */}
              <div class="el-fold" data-open={relOpen()}>
                <button
                  type="button"
                  class="el-fold-hd"
                  onClick={() => setRelOpen((v) => !v)}
                >
                  <span class="el-fold-caret" aria-hidden="true">
                    <CaretIcon />
                  </span>
                  <span class="el-fold-title">关系 · Relations</span>
                </button>
                <div class="el-fold-bd">
                  <Show when={relOpen()}>
                    <RelationStar exp={e()} onNavigate={props.onNavigate} />
                  </Show>
                </div>
              </div>

              {/* Usage & judge stats — collapsed by default; the header line
                  carries a compact summary so you rarely need to open it. */}
              <Show when={hasUsage()}>
                <div class="el-fold" data-open={usageOpen()}>
                  <button
                    type="button"
                    class="el-fold-hd"
                    onClick={() => setUsageOpen((v) => !v)}
                  >
                    <span class="el-fold-caret" aria-hidden="true">
                      <CaretIcon />
                    </span>
                    <span class="el-fold-title">使用统计 · Usage</span>
                    <span class="el-fold-summary">
                      注入 {u()?.injected?.total ?? 0}
                      <Show when={(u()?.used?.cited ?? 0) > 0}> · 采用 {u()!.used!.cited}</Show>
                      <Show when={(u()?.used?.recalled ?? 0) > 0}> · 召回 {u()!.used!.recalled}</Show>
                      <Show when={(u()?.ignored ?? 0) > 0}> · 忽略 {u()!.ignored}</Show>
                      <Show when={(u()?.not_relevant ?? 0) > 0}> · 无关 {u()!.not_relevant}</Show>
                      <Show when={(u()?.bad ?? 0) > 0}>
                        <span class="el-fold-summary-bad"> · 出问题 {u()!.bad}</span>
                      </Show>
                    </span>
                  </button>
                  <div class="el-fold-bd">
                    <div class="el-stats">
                      <div class="el-stat" title="被注入进 agent 上下文的次数（baseline=会话基线 / topical=话题相关 / recall=工具召回）">
                        <span class="el-stat-n">{u()?.injected?.total ?? 0}</span>
                        <span class="el-stat-label">注入</span>
                        <Show when={u()?.injected?.by_tier}>
                          {(t) => (
                            <span class="el-stat-sub">
                              基线 {t().baseline ?? 0} · 话题 {t().topical ?? 0} · 召回 {t().recall ?? 0}
                            </span>
                          )}
                        </Show>
                      </div>
                      <div class="el-stat" data-tone="good" title="judge 判定 agent 这轮确实遵循了该经验">
                        <span class="el-stat-n">{u()?.used?.cited ?? 0}</span>
                        <span class="el-stat-label">被采用</span>
                        <Show when={(u()?.last_applied_at ?? 0) > 0}>
                          <span class="el-stat-sub">最近 {fmtDateTime(u()!.last_applied_at!)}</span>
                        </Show>
                      </div>
                      <div class="el-stat" title="agent 主动调用 recall 工具召回它的次数">
                        <span class="el-stat-n">{u()?.used?.recalled ?? 0}</span>
                        <span class="el-stat-label">被召回</span>
                      </div>
                      <Show when={(u()?.ignored ?? 0) > 0}>
                        <div class="el-stat" data-tone="warn" title="这轮的工作与它同主题，但 agent 没有遵循">
                          <span class="el-stat-n">{u()!.ignored}</span>
                          <span class="el-stat-label">被忽略</span>
                        </div>
                      </Show>
                      <Show when={(u()?.not_relevant ?? 0) > 0}>
                        <div class="el-stat" data-tone="warn" title="注入了但这轮工作没碰它的主题 — 召回偏宽的信号">
                          <span class="el-stat-n">{u()!.not_relevant}</span>
                          <span class="el-stat-label">判为无关</span>
                        </div>
                      </Show>
                      <Show when={(u()?.bad ?? 0) > 0}>
                        <div class="el-stat" data-tone="bad" title="应用它（或它在上下文里）反而出了问题">
                          <span class="el-stat-n">{u()!.bad}</span>
                          <span class="el-stat-label">出问题</span>
                          <Show when={(u()?.last_bad_at ?? 0) > 0}>
                            <span class="el-stat-sub">最近 {fmtDateTime(u()!.last_bad_at!)}</span>
                          </Show>
                        </div>
                      </Show>
                    </div>

                    <Show when={workflowStats().length > 0}>
                      <div class="el-usage-sub">
                        <span
                          class="el-sec-label"
                          title="judge 每轮会记下当时的 workflow 标签：该经验在各工作流下被判「遵循 ✓ / 忽略 ✗」的次数，反映它对哪些工作流真正有用"
                        >
                          各工作流采纳
                        </span>
                        <ul class="el-wf-list">
                          <For each={workflowStats()}>
                            {(w) => (
                              <li class="el-wf-item">
                                <span class="el-wf-name">{w.wf}</span>
                                <span class="el-wf-counts">
                                  <b>{w.applied}</b>✓
                                  <Show when={w.ignored > 0}>
                                    <span class="el-wf-ignored"> {w.ignored}✗</span>
                                  </Show>
                                </span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    </Show>

                    <Show when={coInjected().length > 0}>
                      <div class="el-usage-sub">
                        <span
                          class="el-sec-label"
                          title="经常和它同一轮被注入的经验 — 若长期成对出现，可考虑手动合并"
                        >
                          常一起召回 · 合并候选
                        </span>
                        <ul class="el-coinj">
                          <For each={coInjected()}>
                            {(c) => (
                              <li class="el-coinj-item">
                                <span class="el-coinj-title">{c.title}</span>
                                <span class="el-coinj-n">×{c.count}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>

              <div class="el-fold" data-open={obsOpen()}>
                <button
                  type="button"
                  class="el-fold-hd"
                  onClick={() => setObsOpen((v) => !v)}
                >
                  <span class="el-fold-caret" aria-hidden="true">
                    <CaretIcon />
                  </span>
                  <span class="el-fold-title">观察 · Observations</span>
                  <span class="el-fold-n">{observations().length}</span>
                </button>
                <div class="el-fold-bd">
                  <Show
                    when={observations().length > 0}
                    fallback={<p class="el-empty-inline">（暂无观察记录）</p>}
                  >
                    <div class="el-list">
                      <For each={observations()}>
                        {(obs) => (
                          <div class="el-entry">
                            <div class="el-entry-head">
                              <span>{fmtDateTime(obs.observed_at)}</span>
                              <Show when={obs.session_id}>
                                <span class="el-entry-tag" title={obs.session_id}>
                                  …{obs.session_id.slice(-8)}
                                </span>
                              </Show>
                              <span class="el-spacer" />
                              <button
                                type="button"
                                class="el-entry-del"
                                title="删除此观察"
                                disabled={!!busy()}
                                onClick={() => deleteObservation(obs.id)}
                              >
                                ✕
                              </button>
                            </div>
                            <p class="el-entry-text">{obs.user_text || "（无文本）"}</p>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="el-add-obs">
                    <textarea
                      class="el-input el-textarea"
                      rows={2}
                      placeholder="补充一条观察，再点「重新整理」让它生效…"
                      value={newObs()}
                      onInput={(ev) => setNewObs(ev.currentTarget.value)}
                    />
                    <button
                      type="button"
                      class="el-btn el-btn-primary"
                      disabled={!newObs().trim() || !!busy()}
                      onClick={addObservation}
                    >
                      {busy() === "augment" ? "添加中…" : "添加观察"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Refinement history */}
              <div class="el-fold" data-open={histOpen()}>
                <button
                  type="button"
                  class="el-fold-hd"
                  onClick={() => setHistOpen((v) => !v)}
                >
                  <span class="el-fold-caret" aria-hidden="true">
                    <CaretIcon />
                  </span>
                  <span class="el-fold-title">整理历史 · History</span>
                  <span class="el-fold-n">{history().length}</span>
                </button>
                <div class="el-fold-bd">
                  <Show
                    when={history().length > 0}
                    fallback={<p class="el-empty-inline">（暂无整理历史）</p>}
                  >
                    <div class="el-list">
                      <For each={history()}>
                        {(h) => (
                          <div class="el-entry">
                            <div class="el-entry-head">
                              <span>{fmtDateTime(h.at)}</span>
                              <Show when={h.kind}>
                                <span class="el-entry-tag">{h.kind}</span>
                              </Show>
                              <Show when={h.model}>
                                <b>{h.model}</b>
                              </Show>
                            </div>
                            <Show when={h.source_ids && h.source_ids.length > 0}>
                              <p class="el-entry-text">
                                来源：{h.source_ids!.length} 条经验合并
                              </p>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>
          </div>

          {/* Action bar */}
          <footer class="el-modal-ft">
            <Show
              when={editing()}
              fallback={
                <>
                  <button
                    type="button"
                    class="el-btn"
                    disabled={!!busy()}
                    onClick={startEdit}
                  >
                    编辑
                  </button>
                  <Show when={status() !== "approved"}>
                    <button
                      type="button"
                      class="el-btn el-btn-ok"
                      disabled={!!busy()}
                      onClick={() => setReview("approved")}
                    >
                      {busy() === "approved" ? "处理中…" : "批准"}
                    </button>
                  </Show>
                  <Show when={status() !== "rejected"}>
                    <button
                      type="button"
                      class="el-btn el-btn-warn"
                      disabled={!!busy()}
                      onClick={() => setReview("rejected")}
                    >
                      {busy() === "rejected" ? "处理中…" : "拒绝"}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="el-btn"
                    disabled={!!busy()}
                    onClick={reRefine}
                  >
                    {busy() === "refine" ? "整理中…" : "重新整理"}
                  </button>
                  <span class="el-spacer" />
                  <Show
                    when={confirmDel()}
                    fallback={
                      <button
                        type="button"
                        class="el-btn el-btn-danger-ghost"
                        disabled={!!busy()}
                        onClick={() => setConfirmDel(true)}
                      >
                        删除
                      </button>
                    }
                  >
                    <span class="el-confirm-q">确认删除?</span>
                    <button
                      type="button"
                      class="el-btn el-btn-danger"
                      disabled={!!busy()}
                      onClick={remove}
                    >
                      {busy() === "delete" ? "删除中…" : "确认删除"}
                    </button>
                    <button
                      type="button"
                      class="el-btn"
                      disabled={!!busy()}
                      onClick={() => setConfirmDel(false)}
                    >
                      取消
                    </button>
                  </Show>
                </>
              }
            >
              <span class="el-spacer" />
              <button
                type="button"
                class="el-btn"
                disabled={!!busy()}
                onClick={cancelEdit}
              >
                取消
              </button>
              <button
                type="button"
                class="el-btn el-btn-primary"
                disabled={!!busy() || !dTitle().trim()}
                onClick={saveEdit}
              >
                {busy() === "save" ? "保存中…" : "保存"}
              </button>
            </Show>
          </footer>
        </div>
      </div>
    </Portal>
  )
}

/* ──────────────────────────────────────────────────────
   RelationStar — per-experience relation graph, replaces
   the retired standalone 关系图谱 tab. Star layout: the
   current exp sits in the center, neighbors ring outward
   by graph depth (1–3, user-selectable). Backed by
   GET /refiner/experience/:id/neighbors.
   ────────────────────────────────────────────────────── */

type NeighborNode = {
  id: string
  kind: Kind | null
  title: string
  abstract: string
  archived?: boolean
  depth: number
}
type NeighborEdge = { from: string; to: string; kind: string; reason?: string }
type Neighbors = { seed: string; nodes: NeighborNode[]; edges: NeighborEdge[] }

const EDGE_LABEL: Record<string, string> = {
  requires: "依赖",
  refines: "细化",
  supports: "佐证",
  contradicts: "冲突",
  see_also: "相关",
}
const EDGE_COLOR: Record<string, string> = {
  requires: "var(--cobalt-9)",
  refines: "var(--kind-pattern)",
  supports: "var(--text-on-success-base)",
  contradicts: "var(--text-on-critical-base)",
  see_also: "var(--border-hover)",
}
const ALL_EDGE_KINDS = "requires,refines,supports,contradicts,see_also"

function RelationStar(props: {
  exp: Experience
  onNavigate?: (id: string) => void
}): JSX.Element {
  const client = useExpClient()
  const [depth, setDepth] = createSignal(1)

  const [data] = createResource(
    () => ({ id: props.exp.id, depth: depth() }),
    async (k) => {
      try {
        return await client.get<Neighbors>(
          `/refiner/experience/${k.id}/neighbors?max_depth=${k.depth}&direction=both&edge_kinds=${ALL_EDGE_KINDS}`,
        )
      } catch {
        return { seed: k.id, nodes: [], edges: [] } as Neighbors
      }
    },
  )

  const W = 640
  const H = 380

  // Star layout: seed centered, each depth on an elliptic ring (wider than
  // tall — the modal is wide, labels need horizontal room).
  const layout = createMemo(() => {
    const d = data()
    if (!d) return undefined
    const nodes = d.nodes.filter((n) => !n.archived)
    const others = nodes.filter((n) => n.id !== d.seed)
    const cx = W / 2
    const cy = H / 2
    const ringR = [0, 82, 136, 176]
    const byDepth = new Map<number, NeighborNode[]>()
    for (const n of others) {
      const dep = Math.min(Math.max(n.depth, 1), 3)
      if (!byDepth.has(dep)) byDepth.set(dep, [])
      byDepth.get(dep)!.push(n)
    }
    const pos = new Map<string, { x: number; y: number }>()
    pos.set(d.seed, { x: cx, y: cy })
    for (const [dep, list] of byDepth) {
      const r = ringR[dep] ?? 176
      list.forEach((n, i) => {
        const a = (2 * Math.PI * i) / list.length - Math.PI / 2 + (dep - 1) * 0.4
        pos.set(n.id, { x: cx + r * 1.4 * Math.cos(a), y: cy + r * 0.82 * Math.sin(a) })
      })
    }
    const edges = d.edges.filter((e) => pos.has(e.from) && pos.has(e.to))
    const kindsPresent = [...new Set(edges.map((e) => e.kind))]
    return { seed: d.seed, others, edges, pos, kindsPresent }
  })

  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

  // Depth-1 relation rows for the quick-confirm list below the star.
  const rows = createMemo(() => {
    const d = data()
    if (!d) return []
    const byId = new Map(d.nodes.map((n) => [n.id, n]))
    return d.edges
      .filter((e) => e.from === d.seed || e.to === d.seed)
      .map((e) => {
        const outward = e.from === d.seed
        const other = byId.get(outward ? e.to : e.from)
        return other ? { edge: e, other, outward } : undefined
      })
      .filter((x): x is { edge: NeighborEdge; other: NeighborNode; outward: boolean } => !!x)
  })

  return (
    <div class="el-rel">
      <div class="el-rel-bar">
        <span class="el-rel-depth-label">深度</span>
        <For each={[1, 2, 3]}>
          {(n) => (
            <button
              type="button"
              class="el-rel-depth"
              data-on={depth() === n}
              onClick={() => setDepth(n)}
            >
              {n}
            </button>
          )}
        </For>
        <span class="el-spacer" />
        <For each={layout()?.kindsPresent ?? []}>
          {(k) => (
            <span class="el-rel-legend">
              <span class="el-rel-legend-line" style={{ background: EDGE_COLOR[k] ?? "var(--border-hover)" }} />
              {EDGE_LABEL[k] ?? k}
            </span>
          )}
        </For>
      </div>

      <Show
        when={(layout()?.others.length ?? 0) > 0}
        fallback={
          <p class="el-empty-inline">
            {data.loading ? "加载关系中…" : "暂无关联经验（还没有与其他经验建立边）"}
          </p>
        }
      >
        <svg class="el-star" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="经验关系图">
          <For each={layout()!.edges}>
            {(e) => {
              const p1 = () => layout()!.pos.get(e.from)!
              const p2 = () => layout()!.pos.get(e.to)!
              return (
                <line
                  x1={p1().x}
                  y1={p1().y}
                  x2={p2().x}
                  y2={p2().y}
                  stroke={EDGE_COLOR[e.kind] ?? "var(--border-hover)"}
                  stroke-width="1.4"
                  stroke-dasharray={e.kind === "see_also" ? "4 4" : undefined}
                  opacity="0.65"
                >
                  <Show when={e.reason}>
                    <title>{`${EDGE_LABEL[e.kind] ?? e.kind}: ${e.reason}`}</title>
                  </Show>
                </line>
              )
            }}
          </For>
          {/* seed */}
          <g transform={`translate(${W / 2}, ${H / 2})`} class="el-star-seed">
            <circle r="11" fill={kindColor(props.exp.kind)} stroke="var(--background-strong)" stroke-width="2" />
            <text y="26" text-anchor="middle" class="el-star-label el-star-label-seed">
              {clip(props.exp.title, 14)}
            </text>
            <title>{props.exp.title}</title>
          </g>
          <For each={layout()!.others}>
            {(n) => {
              const p = () => layout()!.pos.get(n.id)!
              return (
                <g
                  transform={`translate(${p().x}, ${p().y})`}
                  class="el-star-node"
                  onClick={() => props.onNavigate?.(n.id)}
                >
                  <circle
                    r={n.depth === 1 ? 8 : 6}
                    fill={kindColor((n.kind ?? undefined) as Kind | undefined)}
                    opacity={n.depth === 1 ? 1 : 0.75}
                  />
                  <text y={n.depth === 1 ? 22 : 19} text-anchor="middle" class="el-star-label">
                    {clip(n.title, 12)}
                  </text>
                  <title>{`${n.title}\n${n.abstract}`}</title>
                </g>
              )
            }}
          </For>
        </svg>

        {/* one-hop quick-confirm list: kind chip + title + reason */}
        <ul class="el-rel-list">
          <For each={rows()}>
            {(r) => (
              <li>
                <button type="button" class="el-rel-row" onClick={() => props.onNavigate?.(r.other.id)}>
                  <span
                    class="el-rel-chip"
                    style={{ color: EDGE_COLOR[r.edge.kind] ?? "var(--text-weak)" }}
                  >
                    {r.outward ? "" : "← "}
                    {EDGE_LABEL[r.edge.kind] ?? r.edge.kind}
                    {r.outward ? " →" : ""}
                  </span>
                  <span class="el-rel-title">{r.other.title}</span>
                  <Show when={r.edge.reason}>
                    <span class="el-rel-reason">{r.edge.reason}</span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Inline icons (no icon package per project rules)
   ────────────────────────────────────────────────────── */

function RefreshIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5V5H11" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/** Chevron-right; folds/tree rotate it 90° when open (see .el-fold-caret). */
function CaretIcon(): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}
