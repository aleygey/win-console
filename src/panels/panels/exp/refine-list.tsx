/**
 * exp panel — List view ("经验列表").
 *
 * Loads the refiner overview from the exp plugin HTTP API and renders every
 * stored {@link Experience} as a card in a responsive grid. Each card surfaces
 * the title, a color-coded kind tag, the abstract, the scope, the observation
 * count, and the last-refined time. Clicking a card opens a detail modal that
 * shows the full abstract, the machine-readable statement, the source
 * observations, and the refinement history.
 *
 * Data comes from `GET /refiner/overview` via {@link useExpClient}; the response
 * is the schema-v2 {@link RefinerOverview} `{ experiences, graph, ... }`. We
 * defensively accept a bare `Experience[]` or `{ experiences }` shape too, so a
 * future `GET /experiences` endpoint slots in without a code change. Loading,
 * empty, and error states are all handled.
 *
 * Styling lives in the co-located refine-list.css and references the shared
 * semantic tokens (styles/tokens.css) so the view themes automatically. The
 * per-kind accent hues are the lone hardcoded colors — they mirror the opencode
 * refiner page's kind swatches and are theme-neutral by intent.
 */

import {
  createResource,
  createSignal,
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
}
type UsageMap = Record<string, ExpUsage>

/* ──────────────────────────────────────────────────────
   Kind palette + labels. Hues come from the shared design
   tokens (--kind-*), a desaturated set that themes with the
   rest of the surface. Legacy kinds fold into the nearest
   core token so a migrating store still renders uniformly;
   custom kinds get the neutral token.
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

  // Category filter — two-level tabs. `top` selects a first-level tag (or null =
  // 全部); `sub` selects one full "top/sub" value under it (or null = all of top).
  const [activeTop, setActiveTop] = createSignal<string | null>(null)
  const [activeSub, setActiveSub] = createSignal<string | null>(null)
  const clearCats = () => {
    setActiveTop(null)
    setActiveSub(null)
  }
  // Free-text search over title / abstract / category.
  const [query, setQuery] = createSignal("")
  // Group the grid into sections by first-level tag (vs one flat grid).
  const [grouped, setGrouped] = createSignal(true)

  // first-level tag of a category string: "a/b" → "a"; flat "x" → "x".
  const firstLevel = (c: string) =>
    c.includes("/") ? c.slice(0, c.indexOf("/")) : c

  // Two-level grouping by "/": "a/b" → top "a", sub "b"; flat "x" → top "x".
  // Drives the two-level filter tabs.
  const categoryGroups = () => {
    const groups = new Map<string, Set<string>>() // top → set of full values
    for (const x of data() ?? [])
      for (const c of x.categories ?? []) {
        const top = firstLevel(c)
        if (!groups.has(top)) groups.set(top, new Set())
        groups.get(top)!.add(c)
      }
    return [...groups.entries()]
      .map(([top, fulls]) => ({
        top,
        items: [...fulls].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.top.localeCompare(b.top))
  }

  // Sub-tags (full "top/sub" values) under the active top, for the level-2 row.
  const subTags = () => {
    const top = activeTop()
    if (!top) return []
    const g = categoryGroups().find((x) => x.top === top)
    return (g?.items ?? []).filter((c) => c.includes("/"))
  }

  const rawCount = () => (data() ?? []).length
  const filtering = () =>
    activeTop() != null || activeSub() != null || query().trim().length > 0

  // Stable order (newest refinement first), then category filter, then search.
  const experiences = () => {
    let list = [...(data() ?? [])].sort(
      (a, b) => (b.last_refined_at ?? 0) - (a.last_refined_at ?? 0),
    )
    const sub = activeSub()
    const top = activeTop()
    if (sub) {
      list = list.filter((x) => (x.categories ?? []).includes(sub))
    } else if (top) {
      list = list.filter((x) => (x.categories ?? []).some((c) => firstLevel(c) === top))
    }
    const q = query().trim().toLowerCase()
    if (q) {
      list = list.filter((x) =>
        [x.title, x.abstract, ...(x.categories ?? [])].join(" ").toLowerCase().includes(q),
      )
    }
    return list
  }

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
    <div class="rl-root">
      <Switch>
        {/* error — only when there is no previously-loaded data to show */}
        <Match when={data.error && !data.latest}>
          <div class="rl-state" data-tone="error">
            <div class="rl-state-title">加载经验库失败</div>
            <div class="rl-state-detail">
              {String((data.error as Error)?.message ?? data.error)}
            </div>
            <button type="button" class="rl-state-retry" onClick={() => refetch()}>
              重试
            </button>
          </div>
        </Match>

        {/* loading — skeleton grid on first load */}
        <Match when={data.loading && !data.latest}>
          <div class="rl-grid" aria-busy="true">
            <For each={Array.from({ length: 6 })}>
              {() => <div class="rl-skeleton" />}
            </For>
          </div>
        </Match>

        {/* empty — the library itself is empty (not merely filtered) */}
        <Match when={rawCount() === 0}>
          <div class="rl-state">
            <div class="rl-state-title">暂无经验</div>
            <div class="rl-state-detail">
              当 refiner 从会话中沉淀出经验后，它们会出现在这里。
            </div>
            <button type="button" class="rl-state-retry" onClick={() => refetch()}>
              刷新
            </button>
          </div>
        </Match>

        {/* loaded grid */}
        <Match when={rawCount() > 0}>
          <div class="rl-toolbar">
            <span class="rl-count">
              共 <b>{experiences().length}</b> 条经验
              <Show when={filtering()}>
                <span class="rl-count-sub"> / {rawCount()} 总</span>
              </Show>
            </span>
            <label class="rl-search">
              <Icon name="search" size={15} />
              <input
                class="rl-search-input"
                placeholder="搜索经验(标题 / 摘要 / 标签)"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <Show when={query()}>
                <button class="rl-search-x" title="清除" onClick={() => setQuery("")}>
                  <Icon name="x" size={13} />
                </button>
              </Show>
            </label>
            <span class="rl-spacer" />
            <button
              type="button"
              class="rl-toggle"
              data-on={grouped()}
              title="按一级标签分组"
              onClick={() => setGrouped((v) => !v)}
            >
              <Icon name="share-2" size={14} />
              分组
            </button>
            <button
              type="button"
              class="rl-refresh"
              disabled={data.loading}
              onClick={() => refetch()}
            >
              <RefreshIcon />
              {data.loading ? "刷新中…" : "刷新"}
            </button>
          </div>

          {/* Category filter — two-level tabs: a level-1 underline tab row
              (全部 + top tags) and, when a top is active, a level-2 chip row of
              its sub tags. */}
          <Show when={categoryGroups().length > 0}>
            <div class="rl-cats">
              <div class="rl-tabrow">
                <button
                  type="button"
                  class="rl-tab1"
                  data-on={activeTop() == null}
                  onClick={clearCats}
                >
                  全部
                </button>
                <For each={categoryGroups()}>
                  {(g) => (
                    <button
                      type="button"
                      class="rl-tab1"
                      data-on={activeTop() === g.top}
                      onClick={() => {
                        setActiveTop(g.top)
                        setActiveSub(null)
                      }}
                    >
                      {g.top}
                    </button>
                  )}
                </For>
              </div>
              <div class="rl-tabrow-rule" />
              <Show when={subTags().length > 0}>
                <div class="rl-subrow">
                  <span class="rl-subrow-lead">二级</span>
                  <button
                    type="button"
                    class="rl-tab2"
                    data-on={activeSub() == null}
                    onClick={() => setActiveSub(null)}
                  >
                    全部
                  </button>
                  <For each={subTags()}>
                    {(full) => (
                      <button
                        type="button"
                        class="rl-tab2"
                        data-on={activeSub() === full}
                        onClick={() =>
                          setActiveSub((cur) => (cur === full ? null : full))
                        }
                      >
                        {full.slice(full.indexOf("/") + 1)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          <Show
            when={experiences().length > 0}
            fallback={
              <div class="rl-state rl-state-inline">
                <div class="rl-state-detail">该分类下暂无经验</div>
                <button
                  type="button"
                  class="rl-state-retry"
                  onClick={() => {
                    clearCats()
                    setQuery("")
                  }}
                >
                  清除筛选
                </button>
              </div>
            }
          >
            <Show
              when={grouped()}
              fallback={
                <div class="rl-grid">
                  <For each={experiences()}>
                    {(exp) => <ExperienceCard exp={exp} usage={usageFor(exp.id)} onOpen={() => setSelected(exp)} />}
                  </For>
                </div>
              }
            >
              <div class="rl-sections">
                <For each={sections()}>
                  {(s) => (
                    <section class="rl-section">
                      <div class="rl-section-head">
                        <span class="rl-section-tag">{s.tag}</span>
                        <span class="rl-section-n">{s.items.length}</span>
                        <span class="rl-section-rule" aria-hidden="true" />
                      </div>
                      <div class="rl-grid-inner">
                        <For each={s.items}>
                          {(exp) => <ExperienceCard exp={exp} usage={usageFor(exp.id)} onOpen={() => setSelected(exp)} />}
                        </For>
                      </div>
                    </section>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Match>
      </Switch>

      <Show when={selected()}>
        {(exp) => (
          <DetailModal
            exp={exp()}
            usage={usageFor(exp().id)}
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

function ExperienceCard(props: { exp: Experience; usage?: ExpUsage; onOpen: () => void }): JSX.Element {
  const e = () => props.exp
  const obsCount = () => e().observations?.length ?? 0
  const cited = () => props.usage?.used?.cited ?? 0
  const recalled = () => props.usage?.used?.recalled ?? 0
  const flag = () => {
    const s = e().review_status
    return s === "pending" || s === "rejected" ? s : undefined
  }
  return (
    <button
      type="button"
      class="rl-card"
      data-status={flag()}
      style={{ "--rl-kind-color": kindColor(e().kind) }}
      onClick={props.onOpen}
    >
      {/* kind line — small, leads the card; dot carries the (desaturated) hue */}
      <div class="rl-card-head">
        <span class="rl-kind">
          <span class="rl-kind-dot" aria-hidden="true" />
          {kindLabel(e().kind)}
        </span>
        <span class="rl-spacer" />
        <Show when={flag()}>
          {(f) => (
            <span class="rl-flag" data-status={f()}>
              <span class="rl-flag-dot" aria-hidden="true" />
              {f() === "pending" ? "待审" : "已拒绝"}
            </span>
          )}
        </Show>
      </div>

      {/* title is the hero */}
      <h3 class="rl-card-title">{e().title || "（无标题）"}</h3>

      <Show when={e().abstract?.trim()}>
        <p class="rl-card-abstract">{e().abstract}</p>
      </Show>

      {/* footer — obs · usage · (scope) · time, quiet mono */}
      <div class="rl-card-meta">
        <span class="rl-meta-item">
          <b>{obsCount()}</b> obs
        </span>
        <Show when={cited() > 0}>
          <span class="rl-meta-item rl-use" title="judge 判定被采用的次数">
            ✓<b>{cited()}</b>
          </span>
        </Show>
        <Show when={recalled() > 0}>
          <span class="rl-meta-item rl-use" title="被 recall 工具召回的次数">
            ⤴<b>{recalled()}</b>
          </span>
        </Show>
        <span class="rl-spacer" />
        <Show when={e().scope && e().scope !== "workspace"}>
          <span class="rl-foot-scope">{SCOPE_LABEL[e().scope] ?? e().scope}</span>
        </Show>
        <span class="rl-meta-item">{timeAgo(e().last_refined_at)}</span>
      </div>
    </button>
  )
}

/* ──────────────────────────────────────────────────────
   Detail modal — full abstract / statement / observations
   / refinement history. Portaled so its z-index is free of
   the grid; Escape + scrim click both close.
   ────────────────────────────────────────────────────── */

function DetailModal(props: {
  exp: Experience
  usage?: ExpUsage
  onClose: () => void
  onMutated: () => void | Promise<void>
}): JSX.Element {
  const client = useExpClient()
  const e = () => props.exp
  const u = () => props.usage

  const [busy, setBusy] = createSignal<string | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [editing, setEditing] = createSignal(false)
  const [confirmDel, setConfirmDel] = createSignal(false)
  const [newObs, setNewObs] = createSignal("")

  // Collapsible secondary folds (observations / history) — caret rotates.
  const [obsOpen, setObsOpen] = createSignal(false)
  const [histOpen, setHistOpen] = createSignal(false)

  // Edit-mode draft, seeded from the experience when entering edit mode.
  const [dKind, setDKind] = createSignal<Kind>("fact")
  const [dScope, setDScope] = createSignal<Scope>("workspace")
  const [dTitle, setDTitle] = createSignal("")
  const [dAbstract, setDAbstract] = createSignal("")
  const [dStatement, setDStatement] = createSignal("")
  const [dCategories, setDCategories] = createSignal<string[]>([])
  const [catDraft, setCatDraft] = createSignal("")

  const startEdit = () => {
    const x = e()
    setDKind((x.kind as Kind) ?? "fact")
    setDScope((x.scope as Scope) ?? "workspace")
    setDTitle(x.title ?? "")
    setDAbstract(x.abstract ?? "")
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
        statement: dStatement().trim() || undefined,
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
      <div class="rl-scrim" role="presentation" onClick={props.onClose}>
        <div
          class="rl-modal"
          role="dialog"
          aria-modal="true"
          aria-label={e().title}
          onClick={(ev) => ev.stopPropagation()}
        >
          <header class="rl-modal-hd">
            <div class="rl-modal-hd-main">
              <div class="rl-modal-hd-tags">
                <span
                  class="rl-kind"
                  style={{ "--rl-kind-color": kindColor(editing() ? dKind() : e().kind) }}
                >
                  <span class="rl-kind-dot" aria-hidden="true" />
                  {kindLabel(editing() ? dKind() : e().kind)}
                </span>
                <span class="rl-scope">
                  {SCOPE_LABEL[(editing() ? dScope() : e().scope) as Scope] ?? e().scope ?? "—"}
                </span>
                <Show when={status() && status() !== "approved"}>
                  <span class="rl-flag" data-status={status()}>
                    <span class="rl-flag-dot" aria-hidden="true" />
                    {status() === "pending" ? "待审" : "已拒绝"}
                  </span>
                </Show>
              </div>
              <Show
                when={editing()}
                fallback={<h2 class="rl-modal-title">{e().title || "（无标题）"}</h2>}
              >
                <input
                  class="rl-edit-title"
                  value={dTitle()}
                  placeholder="标题"
                  onInput={(ev) => setDTitle(ev.currentTarget.value)}
                />
              </Show>
            </div>
            <button
              type="button"
              class="rl-modal-close"
              aria-label="关闭"
              onClick={props.onClose}
            >
              <CloseIcon />
            </button>
          </header>

          <Show when={err()}>
            <div class="rl-modal-err" role="alert">
              {err()}
            </div>
          </Show>

          <div class="rl-modal-bd">
            <Show
              when={editing()}
              fallback={
                <>
                  {/* Statement — the focal block: actionable rule, emphasized,
                      with a left border in the kind hue. */}
                  <Show when={e().statement?.trim()}>
                    <div
                      class="rl-statement"
                      style={{ "--rl-kind-color": kindColor(e().kind) }}
                    >
                      <span class="rl-statement-label">规则 · Statement</span>
                      <p class="rl-statement-text">{e().statement}</p>
                    </div>
                  </Show>

                  {/* Abstract */}
                  <section class="rl-sec">
                    <span class="rl-sec-label">摘要 · Abstract</span>
                    <Show
                      when={e().abstract?.trim()}
                      fallback={<p class="rl-empty-inline">（无摘要）</p>}
                    >
                      <p class="rl-prose">{e().abstract}</p>
                    </Show>
                  </section>

                  {/* Meta — quiet dl grid */}
                  <section class="rl-sec">
                    <span class="rl-sec-label">元信息 · Meta</span>
                    <dl class="rl-kv">
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
                      {/* usage — judge-cited / recalled / injected (by tier) */}
                      <Show when={u()}>
                        <dt>被采用 (judge)</dt>
                        <dd>{u()!.used?.cited ?? 0} 次</dd>
                        <dt>被召回</dt>
                        <dd>{u()!.used?.recalled ?? 0} 次</dd>
                        <dt>注入次数</dt>
                        <dd>
                          {u()!.injected?.total ?? 0}
                          <Show when={u()!.injected?.by_tier}>
                            {(t) => (
                              <span class="rl-kv-sub">
                                （baseline {t().baseline ?? 0} · topical {t().topical ?? 0} · recall {t().recall ?? 0}）
                              </span>
                            )}
                          </Show>
                        </dd>
                        <Show when={(u()!.used?.last_at ?? 0) > 0}>
                          <dt>最近使用</dt>
                          <dd>{fmtDateTime(u()!.used!.last_at!)}</dd>
                        </Show>
                      </Show>
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
              <section class="rl-editform">
                <div class="rl-field-row">
                  <label class="rl-field">
                    <span class="rl-sec-label">类型 · Kind</span>
                    <select
                      class="rl-input"
                      value={dKind()}
                      onChange={(ev) => setDKind(ev.currentTarget.value as Kind)}
                    >
                      <For each={CORE_KINDS}>
                        {(k) => <option value={k}>{KIND_LABEL[k]}</option>}
                      </For>
                    </select>
                  </label>
                  <label class="rl-field">
                    <span class="rl-sec-label">范围 · Scope</span>
                    <select
                      class="rl-input"
                      value={dScope()}
                      onChange={(ev) => setDScope(ev.currentTarget.value as Scope)}
                    >
                      <For each={["workspace", "project", "repo", "user"] as Scope[]}>
                        {(s) => <option value={s}>{SCOPE_LABEL[s]}</option>}
                      </For>
                    </select>
                  </label>
                </div>
                <label class="rl-field">
                  <span class="rl-sec-label">摘要 · Abstract</span>
                  <textarea
                    class="rl-input rl-textarea"
                    rows={3}
                    value={dAbstract()}
                    onInput={(ev) => setDAbstract(ev.currentTarget.value)}
                  />
                </label>
                <label class="rl-field">
                  <span class="rl-sec-label">规则 · Statement</span>
                  <textarea
                    class="rl-input rl-textarea"
                    rows={2}
                    placeholder="（可选）"
                    value={dStatement()}
                    onInput={(ev) => setDStatement(ev.currentTarget.value)}
                  />
                </label>
                <div class="rl-field">
                  <span class="rl-sec-label">分类 · Categories</span>
                  <div class="rl-cat-edit">
                    <For each={dCategories()}>
                      {(c) => (
                        <span class="rl-cat-tag">
                          {c}
                          <button
                            type="button"
                            class="rl-cat-tag-x"
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
                      <span class="rl-empty-inline">（无分类）</span>
                    </Show>
                  </div>
                  <input
                    class="rl-input"
                    placeholder="新增分类，支持二级 a/b，回车添加"
                    value={catDraft()}
                    onInput={(ev) => setCatDraft(ev.currentTarget.value)}
                    onKeyDown={(ev) => {
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

            {/* Observations (with add + per-row delete) + history — collapsible
                folds, read-only mode. Caret rotates via data-open. */}
            <Show when={!editing()}>
              <div class="rl-fold" data-open={obsOpen()}>
                <button
                  type="button"
                  class="rl-fold-hd"
                  onClick={() => setObsOpen((v) => !v)}
                >
                  <span class="rl-fold-caret" aria-hidden="true">
                    <CaretIcon />
                  </span>
                  <span class="rl-fold-title">观察 · Observations</span>
                  <span class="rl-fold-n">{observations().length}</span>
                </button>
                <div class="rl-fold-bd">
                  <Show
                    when={observations().length > 0}
                    fallback={<p class="rl-empty-inline">（暂无观察记录）</p>}
                  >
                    <div class="rl-list">
                      <For each={observations()}>
                        {(obs) => (
                          <div class="rl-entry">
                            <div class="rl-entry-head">
                              <span>{fmtDateTime(obs.observed_at)}</span>
                              <Show when={obs.session_id}>
                                <span class="rl-entry-tag" title={obs.session_id}>
                                  …{obs.session_id.slice(-8)}
                                </span>
                              </Show>
                              <span class="rl-spacer" />
                              <button
                                type="button"
                                class="rl-entry-del"
                                title="删除此观察"
                                disabled={!!busy()}
                                onClick={() => deleteObservation(obs.id)}
                              >
                                ✕
                              </button>
                            </div>
                            <p class="rl-entry-text">{obs.user_text || "（无文本）"}</p>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="rl-add-obs">
                    <textarea
                      class="rl-input rl-textarea"
                      rows={2}
                      placeholder="补充一条观察，再点「重新整理」让它生效…"
                      value={newObs()}
                      onInput={(ev) => setNewObs(ev.currentTarget.value)}
                    />
                    <button
                      type="button"
                      class="rl-btn rl-btn-primary"
                      disabled={!newObs().trim() || !!busy()}
                      onClick={addObservation}
                    >
                      {busy() === "augment" ? "添加中…" : "添加观察"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Refinement history */}
              <div class="rl-fold" data-open={histOpen()}>
                <button
                  type="button"
                  class="rl-fold-hd"
                  onClick={() => setHistOpen((v) => !v)}
                >
                  <span class="rl-fold-caret" aria-hidden="true">
                    <CaretIcon />
                  </span>
                  <span class="rl-fold-title">整理历史 · History</span>
                  <span class="rl-fold-n">{history().length}</span>
                </button>
                <div class="rl-fold-bd">
                  <Show
                    when={history().length > 0}
                    fallback={<p class="rl-empty-inline">（暂无整理历史）</p>}
                  >
                    <div class="rl-list">
                      <For each={history()}>
                        {(h) => (
                          <div class="rl-entry">
                            <div class="rl-entry-head">
                              <span>{fmtDateTime(h.at)}</span>
                              <Show when={h.kind}>
                                <span class="rl-entry-tag">{h.kind}</span>
                              </Show>
                              <Show when={h.model}>
                                <b>{h.model}</b>
                              </Show>
                            </div>
                            <Show when={h.source_ids && h.source_ids.length > 0}>
                              <p class="rl-entry-text">
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
          <footer class="rl-modal-ft">
            <Show
              when={editing()}
              fallback={
                <>
                  <button
                    type="button"
                    class="rl-btn"
                    disabled={!!busy()}
                    onClick={startEdit}
                  >
                    编辑
                  </button>
                  <Show when={status() !== "approved"}>
                    <button
                      type="button"
                      class="rl-btn rl-btn-ok"
                      disabled={!!busy()}
                      onClick={() => setReview("approved")}
                    >
                      {busy() === "approved" ? "处理中…" : "批准"}
                    </button>
                  </Show>
                  <Show when={status() !== "rejected"}>
                    <button
                      type="button"
                      class="rl-btn rl-btn-warn"
                      disabled={!!busy()}
                      onClick={() => setReview("rejected")}
                    >
                      {busy() === "rejected" ? "处理中…" : "拒绝"}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="rl-btn"
                    disabled={!!busy()}
                    onClick={reRefine}
                  >
                    {busy() === "refine" ? "整理中…" : "重新整理"}
                  </button>
                  <span class="rl-spacer" />
                  <Show
                    when={confirmDel()}
                    fallback={
                      <button
                        type="button"
                        class="rl-btn rl-btn-danger-ghost"
                        disabled={!!busy()}
                        onClick={() => setConfirmDel(true)}
                      >
                        删除
                      </button>
                    }
                  >
                    <span class="rl-confirm-q">确认删除?</span>
                    <button
                      type="button"
                      class="rl-btn rl-btn-danger"
                      disabled={!!busy()}
                      onClick={remove}
                    >
                      {busy() === "delete" ? "删除中…" : "确认删除"}
                    </button>
                    <button
                      type="button"
                      class="rl-btn"
                      disabled={!!busy()}
                      onClick={() => setConfirmDel(false)}
                    >
                      取消
                    </button>
                  </Show>
                </>
              }
            >
              <span class="rl-spacer" />
              <button
                type="button"
                class="rl-btn"
                disabled={!!busy()}
                onClick={cancelEdit}
              >
                取消
              </button>
              <button
                type="button"
                class="rl-btn rl-btn-primary"
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

/** Chevron-right; the fold rotates it 90° when open (see .rl-fold-caret). */
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
