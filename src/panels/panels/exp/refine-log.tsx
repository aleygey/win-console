/**
 * exp panel · Logs view + global review ("整理日志").
 *
 * Two stacked sections, both driven by the exp HTTP API via {@link useExpClient}:
 *
 *   1. Activity log — `GET /refiner/log` → `{ entries: RefinerLogEntry[] }`.
 *      Rendered as a newest-first feed (one card per refiner run, including the
 *      ones the refiner classed as noise / dropped / error so the user can audit
 *      what was decided). Each card expands to reveal its per-stage LLM call
 *      traces (prompt / response / reasoning / structured output / error), each
 *      of which is itself collapsible.
 *
 *   2. Global review — a button POSTs `/refiner/global-rerefine/llm/plan` to ask
 *      the curator LLM for a library-wide cleanup PLAN (merges / deletions /
 *      conflicts / keeps_as_is / relations / remove_relations / overall_summary).
 *      Nothing mutates yet. An Apply button then POSTs that exact plan object to
 *      `/refiner/global-rerefine/llm/apply`, which routes through merge/delete +
 *      graph edits and returns the applied counts
 *      ({ merges, deletions, relations, relations_removed }) plus a `skipped`
 *      list. We surface both.
 *
 * Types mirror the exp plugin source:
 *   - RefinerLogEntry / RefinerLlmCall — `src/store/types.ts`
 *   - GlobalLLMPlan                    — `src/curate/index.ts`
 *
 * This view is self-contained: it imports nothing from the opencode app; it only
 * uses solid-js primitives, the shared exp client, and semantic CSS tokens.
 */

import {
  createResource,
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  For,
  Show,
  Switch,
  Match,
  type JSX,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useExpClient } from "../../api/client"
import "./refine-log.css"

/** Experience id whose detail "peek" modal is open (clicked from any id chip). */
const [gPeekId, setGPeekId] = createSignal<string | undefined>()

// -----------------------------------------------------------------------------
// Types — mirrored from the exp plugin (read-only source of truth).
// -----------------------------------------------------------------------------

/** One LLM call inside a refiner run. (`src/store/types.ts` RefinerLlmCall) */
type RefinerLlmCall = {
  stage: "route" | "refine" | "synthesis" | "edge"
  provider_id?: string
  model_id?: string
  system_prompt?: string
  user_prompt: string
  response_text?: string
  reasoning_text?: string
  structured_output?: unknown
  error?: string
  duration_ms: number
}

/** One refiner run. (`src/store/types.ts` RefinerLogEntry) */
type RefinerLogEntry = {
  id: string
  created_at: number
  duration_ms: number
  trigger: "auto" | "manual" | "history" | "import" | "re_refine"
  session_id?: string
  message_id?: string
  observation_id?: string
  user_text: string
  outcome: "new_exp" | "update_exp" | "edge_only" | "noise" | "dropped" | "error"
  experience_ids: string[]
  reason?: string
  llm_calls: RefinerLlmCall[]
}

/** `GET /refiner/log` envelope. */
type RefinerLogResponse = { entries: RefinerLogEntry[] }

type EdgeRelKind = "requires" | "refines" | "contradicts" | "supports" | "see_also"

/** The library-wide cleanup plan. (`src/curate/index.ts` GlobalLLMPlan) */
type GlobalLLMPlan = {
  merges: Array<{ ids: string[]; keep: string; reason: string }>
  deletions: Array<{ id: string; reason: string }>
  conflicts: Array<{
    a_id: string
    b_id: string
    resolution: "keep_a" | "keep_b" | "merge" | "leave"
    reason: string
  }>
  keeps_as_is: string[]
  relations: Array<{ from: string; to: string; kind: EdgeRelKind; reason: string }>
  remove_relations: Array<{ from: string; to: string; kind: EdgeRelKind; reason: string }>
  overall_summary: string
}

/** `POST /refiner/global-rerefine/llm/plan` response. */
type GlobalPlanResponse =
  | { ok: false; reason: string }
  | { ok: true; generated_at: number; experience_count: number; plan: GlobalLLMPlan }

/** `POST /refiner/global-rerefine/llm/apply` response. */
type GlobalApplyResponse = {
  applied: { merges: number; deletions: number; relations: number; relations_removed: number }
  skipped: Array<{ kind: "merge" | "delete"; ids: string[]; reason: string }>
}

// -----------------------------------------------------------------------------
// Module-level global-review store
// -----------------------------------------------------------------------------
//
// The generated plan must SURVIVE tab/panel switches. <GlobalReview> unmounts
// when the user navigates away, so component-local signals would lose the plan
// and force a costly regenerate on return. We therefore hoist the plan, its
// loading/error state, the last apply result, AND the per-item selection out to
// module scope. Re-mounting <GlobalReview> simply re-reads these and re-shows
// the last plan (no auto-refetch — the user still drives generation/apply).
//
// Selection identity: plan items carry no stable id, but a regenerate replaces
// the whole plan atomically, so a "<category>:<index>" key is stable for the
// life of one generated plan. We default every item to selected (checked) and
// only persist the keys the user has UNCHECKED — that way a freshly generated
// plan starts fully selected without us having to enumerate it up front.

const [gPlanning, setGPlanning] = createSignal(false)
const [gPlanError, setGPlanError] = createSignal<string | undefined>()
const [gPlanResult, setGPlanResult] = createSignal<GlobalPlanResponse | undefined>()

const [gApplying, setGApplying] = createSignal(false)
const [gApplyError, setGApplyError] = createSignal<string | undefined>()
const [gApplyResult, setGApplyResult] = createSignal<GlobalApplyResponse | undefined>()

/** Keys the user has explicitly UNCHECKED for the current plan. */
const [gDeselected, setGDeselected] = createSignal<Set<string>>(new Set())

type SelCategory = "merges" | "deletions" | "conflicts" | "relations" | "remove_relations"

/** Stable per-plan selection key for one row. */
function selKey(cat: SelCategory, index: number): string {
  return `${cat}:${index}`
}

// -----------------------------------------------------------------------------
// Small formatting helpers
// -----------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (sameDay) return `今天 ${hm}`
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${hm}`
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

/** Map the backend outcome enum to a coarse status family for styling. */
function outcomeFamily(o: RefinerLogEntry["outcome"]): "sediment" | "noise" | "error" {
  switch (o) {
    case "new_exp":
    case "update_exp":
    case "edge_only":
      return "sediment"
    case "noise":
    case "dropped":
      return "noise"
    case "error":
      return "error"
  }
}

const OUTCOME_LABEL: Record<RefinerLogEntry["outcome"], string> = {
  new_exp: "新建",
  update_exp: "更新",
  edge_only: "仅关系",
  noise: "噪声",
  dropped: "丢弃",
  error: "失败",
}

const REL_KIND_LABEL: Record<EdgeRelKind, string> = {
  requires: "依赖 requires",
  refines: "细化 refines",
  contradicts: "矛盾 contradicts",
  supports: "支持 supports",
  see_also: "相关 see_also",
}

const RESOLUTION_LABEL: Record<GlobalLLMPlan["conflicts"][number]["resolution"], string> = {
  keep_a: "保留 A",
  keep_b: "保留 B",
  merge: "合并",
  leave: "保留双方",
}

/** Render an unknown structured-output value as pretty JSON (fallback to text). */
function stringifyUnknown(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Short id chip text. */
function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function RefineLog(): JSX.Element {
  return (
    <div class="rl-root">
      <ActivityLog />
      <GlobalReview />
      <SkillCandidates />
      <ExpPeek />
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Skill candidates — auto-propose cohesive exp clusters
   worth promoting to a skill (GET /refiner/skill-candidates),
   then promote on confirm (POST /refiner/skill).
   ────────────────────────────────────────────────────── */

type SkillCandidate = {
  ids: string[]
  titles: string[]
  member_count: number
  cited_total: number
  stable: boolean
  kinds: string[]
  suggested_name: string
  score: number
  reason: string
}
type SkillCandidatesResponse = { ok: true; candidates: SkillCandidate[]; stats: { experiences: number; eligible: number; clusters: number } }

function SkillCandidates(): JSX.Element {
  const client = useExpClient()
  const [scanning, setScanning] = createSignal(false)
  const [err, setErr] = createSignal<string | undefined>()
  const [resp, setResp] = createSignal<SkillCandidatesResponse | undefined>()
  const [names, setNames] = createSignal<Record<number, string>>({})
  const [promoting, setPromoting] = createSignal<number | undefined>()
  const [done, setDone] = createSignal<Record<number, string>>({}) // index → skill path

  async function scan() {
    setScanning(true)
    setErr(undefined)
    setDone({})
    try {
      const r = await client.get<SkillCandidatesResponse>("/refiner/skill-candidates?min_cited=0&min_size=2")
      setResp(r)
      const seed: Record<number, string> = {}
      r.candidates.forEach((c, i) => (seed[i] = c.suggested_name))
      setNames(seed)
    } catch (e) {
      setErr(`扫描失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setScanning(false)
    }
  }

  async function promote(i: number, c: SkillCandidate) {
    setPromoting(i)
    setErr(undefined)
    try {
      const r = await client.post<{ ok?: boolean; path?: string; error?: string }>("/refiner/skill", {
        ids: c.ids,
        name: names()[i] || c.suggested_name,
      })
      if (r.error) setErr(`提升失败:${r.error}`)
      else if (r.path) setDone((d) => ({ ...d, [i]: r.path! }))
    } catch (e) {
      setErr(`提升失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPromoting(undefined)
    }
  }

  return (
    <section class="rl-section sk-sec">
      <div class="rl-section-head">
        <h2 class="rl-section-title">Skill 候选</h2>
        <button class="rl-global-btn" disabled={scanning()} onClick={() => void scan()}>
          {scanning() ? "扫描中…" : "扫描 skill 候选"}
        </button>
      </div>
      <p class="sk-hint">
        把<b>反复一起被采用、近期稳定</b>的经验簇提升为 opencode skill(写入 .opencode/skills/)。提升后这些经验不再每轮注入 baseline,改由 skill 按需加载。
      </p>

      <Show when={err()}>
        <div class="sk-err">{err()}</div>
      </Show>

      <Show when={resp()}>
        <Show
          when={resp()!.candidates.length > 0}
          fallback={<div class="sk-empty">没有合适的簇可提升(经验 {resp()!.stats.eligible} 条,需 ≥2 条相关且有采用记录)。</div>}
        >
          <div class="sk-list">
            <For each={resp()!.candidates}>
              {(c, i) => (
                <div class="sk-card">
                  <div class="sk-card-top">
                    <span class="sk-badge">{c.member_count} 条</span>
                    <span class="sk-badge" title="judge 共采用次数">✓ {c.cited_total}</span>
                    <Show when={c.stable}>
                      <span class="sk-badge sk-ok">稳定</span>
                    </Show>
                    <span class="sk-kinds">{c.kinds.join(" · ")}</span>
                  </div>
                  <ul class="sk-titles">
                    <For each={c.titles}>{(t) => <li>{t}</li>}</For>
                  </ul>
                  <div class="sk-reason">{c.reason}</div>
                  <Show
                    when={!done()[i()]}
                    fallback={<div class="sk-done">已生成 → {done()[i()]}(源经验已移出 baseline)</div>}
                  >
                    <div class="sk-actions">
                      <input
                        class="sk-name"
                        placeholder="skill 名(kebab-case)"
                        value={names()[i()] ?? c.suggested_name}
                        onInput={(e) => setNames((n) => ({ ...n, [i()]: e.currentTarget.value }))}
                      />
                      <button class="sk-promote" disabled={promoting() === i()} onClick={() => void promote(i(), c)}>
                        {promoting() === i() ? "生成中…" : "提升为 skill"}
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  )
}

/** A clickable experience-id chip — opens the peek modal with the full content. */
function IdChip(props: { id: string; keep?: boolean }): JSX.Element {
  return (
    <code
      class="rl-idchip rl-idchip-link"
      data-keep={props.keep}
      role="button"
      tabindex="0"
      title={`${props.id} · 点击查看内容`}
      onClick={() => setGPeekId(props.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          setGPeekId(props.id)
        }
      }}
    >
      {shortId(props.id)}
      {props.keep ? " ★" : ""}
    </code>
  )
}

/** Read-only peek at one experience (fetched by id) — so ids in the plan / log
 *  aren't dead-ends. Title + statement + abstract + meta; Esc / scrim closes. */
function ExpPeek(): JSX.Element {
  const client = useExpClient()
  const [exp, setExp] = createSignal<any | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [err, setErr] = createSignal<string | undefined>()

  createEffect(() => {
    const id = gPeekId()
    if (!id) {
      setExp(null)
      return
    }
    setLoading(true)
    setErr(undefined)
    setExp(null)
    client
      .get<any>(`/refiner/experience/${id}`)
      .then((e) => setExp(e?.experience ?? e ?? null))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  })

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gPeekId()) setGPeekId(undefined)
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  const close = () => setGPeekId(undefined)

  return (
    <Show when={gPeekId()}>
      <Portal>
        <div class="rl-scrim" role="presentation" onClick={close}>
          <div class="rl-peek" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div class="rl-peek-hd">
              <code class="rl-idchip" title={gPeekId()}>
                {shortId(gPeekId()!)}
              </code>
              <span class="rl-peek-spacer" />
              <button type="button" class="rl-peek-x" aria-label="关闭" onClick={close}>
                ✕
              </button>
            </div>
            <Switch>
              <Match when={loading()}>
                <div class="rl-empty">加载中…</div>
              </Match>
              <Match when={err()}>
                <div class="rl-error">加载失败：{err()}</div>
              </Match>
              <Match when={exp()}>
                <div class="rl-peek-bd">
                  <h3 class="rl-peek-title">{exp().title || "（无标题）"}</h3>
                  <Show when={exp().statement}>
                    <div class="rl-peek-statement">{exp().statement}</div>
                  </Show>
                  <Show when={exp().abstract}>
                    <p class="rl-peek-abstract">{exp().abstract}</p>
                  </Show>
                  <Show when={exp().categories?.length}>
                    <div class="rl-peek-meta">分类：{exp().categories.join(" · ")}</div>
                  </Show>
                  <Show when={exp().kind}>
                    <div class="rl-peek-meta">
                      类型：{exp().kind} · 范围：{exp().scope ?? "—"} · 观察：
                      {exp().observations?.length ?? 0}
                    </div>
                  </Show>
                </div>
              </Match>
              <Match when={!exp()}>
                <div class="rl-empty">找不到该经验（可能已被合并 / 删除）。</div>
              </Match>
            </Switch>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

// -----------------------------------------------------------------------------
// Section 1 — Activity log
// -----------------------------------------------------------------------------

function ActivityLog(): JSX.Element {
  const client = useExpClient()
  const [filter, setFilter] = createSignal<"all" | "sediment" | "noise" | "error">("all")
  const [openRuns, setOpenRuns] = createSignal<Set<string>>(new Set())

  const [data, { refetch }] = createResource<RefinerLogResponse>(() =>
    client.get<RefinerLogResponse>("/refiner/log"),
  )

  // Newest-first; tolerate a bare-array response just in case.
  const entries = createMemo<RefinerLogEntry[]>(() => {
    const raw = data()
    const list = Array.isArray(raw) ? (raw as RefinerLogEntry[]) : (raw?.entries ?? [])
    return [...list].sort((a, b) => b.created_at - a.created_at)
  })

  const visible = createMemo<RefinerLogEntry[]>(() => {
    const mode = filter()
    if (mode === "all") return entries()
    return entries().filter((e) => outcomeFamily(e.outcome) === mode)
  })

  const counts = createMemo(() => {
    let sediment = 0
    let noise = 0
    let error = 0
    for (const e of entries()) {
      const f = outcomeFamily(e.outcome)
      if (f === "sediment") sediment++
      else if (f === "noise") noise++
      else error++
    }
    return { total: entries().length, sediment, noise, error }
  })

  const toggleRun = (id: string) => {
    const next = new Set(openRuns())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpenRuns(next)
  }

  return (
    <section class="rl-section">
      <header class="rl-section-hd">
        <div class="rl-section-titles">
          <h2 class="rl-section-title">整理日志</h2>
          <p class="rl-section-sub">
            每一次 refiner 运行（含未沉淀的 noise / dropped / error）；展开查看 LLM 调用链路。
          </p>
        </div>
        <button
          type="button"
          class="rl-btn rl-btn-ghost"
          onClick={() => void refetch()}
          disabled={data.loading}
        >
          {data.loading ? "刷新中…" : "↻ 刷新"}
        </button>
      </header>

      <div class="rl-filterbar" role="group" aria-label="按结果筛选">
        <FilterChip active={filter() === "all"} onClick={() => setFilter("all")}>
          全部 {counts().total}
        </FilterChip>
        <FilterChip active={filter() === "sediment"} onClick={() => setFilter("sediment")}>
          已沉淀 {counts().sediment}
        </FilterChip>
        <FilterChip active={filter() === "noise"} onClick={() => setFilter("noise")}>
          未沉淀 {counts().noise}
        </FilterChip>
        <FilterChip active={filter() === "error"} onClick={() => setFilter("error")}>
          失败 {counts().error}
        </FilterChip>
      </div>

      <Switch>
        <Match when={data.loading && !data()}>
          <div class="rl-empty">加载日志中…</div>
        </Match>
        <Match when={data.error}>
          <div class="rl-error">
            加载失败：{data.error instanceof Error ? data.error.message : String(data.error)}
          </div>
        </Match>
        <Match when={visible().length === 0}>
          <div class="rl-empty">
            {entries().length === 0
              ? "暂无 refiner 日志。新的运行会写入这里。"
              : "没有符合当前筛选条件的运行。"}
          </div>
        </Match>
        <Match when={visible().length > 0}>
          <ol class="rl-feed">
            <For each={visible()}>
              {(run) => (
                <RunCard run={run} open={openRuns().has(run.id)} onToggle={() => toggleRun(run.id)} />
              )}
            </For>
          </ol>
        </Match>
      </Switch>
    </section>
  )
}

function FilterChip(props: { active: boolean; onClick: () => void; children: JSX.Element }): JSX.Element {
  return (
    <button type="button" class="rl-chip" data-active={props.active} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

function RunCard(props: { run: RefinerLogEntry; open: boolean; onToggle: () => void }): JSX.Element {
  const family = () => outcomeFamily(props.run.outcome)
  return (
    <li class="rl-run" data-family={family()}>
      <button type="button" class="rl-run-hd" onClick={props.onToggle} aria-expanded={props.open}>
        <span class="rl-run-caret">{props.open ? "▾" : "▸"}</span>
        <span class="rl-badge" data-outcome={props.run.outcome}>
          {OUTCOME_LABEL[props.run.outcome]}
        </span>
        <span class="rl-run-trigger">{props.run.trigger}</span>
        <span class="rl-run-text" title={props.run.user_text}>
          {clip(props.run.user_text, 120)}
        </span>
        <span class="rl-run-spacer" />
        <Show when={props.run.llm_calls.length > 0}>
          <span class="rl-run-llm">{props.run.llm_calls.length} LLM</span>
        </Show>
        <span class="rl-run-time">{fmtTime(props.run.created_at)}</span>
        <span class="rl-run-ms">{fmtMs(props.run.duration_ms)}</span>
      </button>

      <Show when={props.open}>
        <div class="rl-run-body">
          <Show when={props.run.reason}>
            <div class="rl-run-reason">
              <span class="rl-k">原因</span>
              <span>{props.run.reason}</span>
            </div>
          </Show>

          <Show when={props.run.experience_ids.length > 0}>
            <div class="rl-run-touched">
              <span class="rl-k">涉及 experience</span>
              <div class="rl-chips">
                <For each={props.run.experience_ids}>{(id) => <IdChip id={id} />}</For>
              </div>
            </div>
          </Show>

          <div class="rl-run-field">
            <span class="rl-k">用户输入</span>
            <pre class="rl-pre">{props.run.user_text}</pre>
          </div>

          <div class="rl-run-calls">
            <span class="rl-k">LLM 调用 ({props.run.llm_calls.length})</span>
            <Show
              when={props.run.llm_calls.length > 0}
              fallback={<div class="rl-empty-inline">这次运行没有触发 LLM（可能走了 fallback）。</div>}
            >
              <For each={props.run.llm_calls}>{(call) => <CallTrace call={call} />}</For>
            </Show>
          </div>
        </div>
      </Show>
    </li>
  )
}

function CallTrace(props: { call: RefinerLlmCall }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const structured = createMemo(() => stringifyUnknown(props.call.structured_output))
  return (
    <div class="rl-call" data-error={!!props.call.error}>
      <button type="button" class="rl-call-hd" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <span class="rl-call-caret">{open() ? "▾" : "▸"}</span>
        <span class="rl-call-stage" data-stage={props.call.stage}>
          {props.call.stage}
        </span>
        <Show when={props.call.provider_id || props.call.model_id}>
          <span class="rl-call-model">
            {props.call.provider_id}
            {props.call.provider_id && props.call.model_id ? "/" : ""}
            {props.call.model_id}
          </span>
        </Show>
        <span class="rl-run-spacer" />
        <Show when={props.call.error}>
          <span class="rl-call-warn" title="此调用报错">
            ⚠
          </span>
        </Show>
        <span class="rl-call-ms">{fmtMs(props.call.duration_ms)}</span>
      </button>

      <Show when={open()}>
        <div class="rl-call-body">
          <Show when={props.call.error}>
            <Field label="Error" tone="error" text={props.call.error!} />
          </Show>
          <Show when={props.call.system_prompt}>
            <Field label="System prompt" text={props.call.system_prompt!} />
          </Show>
          <Field label="User prompt" text={props.call.user_prompt} />
          <Show when={props.call.reasoning_text}>
            <Field label="Reasoning" tone="muted" text={props.call.reasoning_text!} />
          </Show>
          <Show when={props.call.response_text}>
            <Field label="Response" text={props.call.response_text!} />
          </Show>
          <Show when={props.call.structured_output !== undefined}>
            <Field label="Structured output" tone="mono" text={structured()} />
          </Show>
        </div>
      </Show>
    </div>
  )
}

function Field(props: {
  label: string
  text: string
  tone?: "error" | "muted" | "mono"
}): JSX.Element {
  return (
    <div class="rl-field" data-tone={props.tone}>
      <span class="rl-field-label">{props.label}</span>
      <pre class="rl-pre">{props.text}</pre>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Section 2 — Global review (LLM plan → apply)
// -----------------------------------------------------------------------------

function GlobalReview(): JSX.Element {
  const client = useExpClient()

  // State is module-level so the plan survives unmount/remount (tab switches).
  const planning = gPlanning
  const planError = gPlanError
  const planResult = gPlanResult
  const applying = gApplying
  const applyError = gApplyError
  const applyResult = gApplyResult

  const plan = createMemo<GlobalLLMPlan | undefined>(() => {
    const r = planResult()
    return r && r.ok ? r.plan : undefined
  })

  const planSummary = createMemo(() => {
    const p = plan()
    if (!p) return undefined
    return {
      merges: p.merges?.length ?? 0,
      deletions: p.deletions?.length ?? 0,
      conflicts: p.conflicts?.length ?? 0,
      keeps: p.keeps_as_is?.length ?? 0,
      relations: p.relations?.length ?? 0,
      remove_relations: p.remove_relations?.length ?? 0,
    }
  })

  const isEmptyPlan = createMemo(() => {
    const s = planSummary()
    if (!s) return false
    return (
      s.merges === 0 &&
      s.deletions === 0 &&
      s.conflicts === 0 &&
      s.relations === 0 &&
      s.remove_relations === 0
    )
  })

  // ── Selection ──────────────────────────────────────────────────────────────
  // Default = every actionable item selected; we only persist UNCHECKED keys.
  const isSelected = (cat: SelCategory, index: number): boolean =>
    !gDeselected().has(selKey(cat, index))

  const toggleSelected = (cat: SelCategory, index: number) => {
    const key = selKey(cat, index)
    const next = new Set(gDeselected())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setGDeselected(next)
  }

  /** How many actionable items are currently selected (keeps_as_is excluded). */
  const selectedCount = createMemo(() => {
    const p = plan()
    if (!p) return 0
    const cats: Array<[SelCategory, number]> = [
      ["merges", p.merges?.length ?? 0],
      ["deletions", p.deletions?.length ?? 0],
      ["conflicts", p.conflicts?.length ?? 0],
      ["relations", p.relations?.length ?? 0],
      ["remove_relations", p.remove_relations?.length ?? 0],
    ]
    let n = 0
    for (const [cat, len] of cats) {
      for (let i = 0; i < len; i++) if (isSelected(cat, i)) n++
    }
    return n
  })

  /** Total actionable items (keeps_as_is excluded). */
  const actionableCount = createMemo(() => {
    const s = planSummary()
    if (!s) return 0
    return s.merges + s.deletions + s.conflicts + s.relations + s.remove_relations
  })

  /**
   * Build an apply body that keeps the GlobalLLMPlan shape but contains only the
   * caller-chosen subset. When `all` is true every actionable item is sent
   * regardless of the per-item toggles (the "全部应用" convenience).
   *
   * keeps_as_is is derived, not selected: it passes straight through (the IDs the
   * planner deemed fine to leave alone) so the backend still has the full keep
   * list. overall_summary is passed through unchanged.
   */
  function buildApplyBody(all: boolean): GlobalLLMPlan {
    const p = plan()!
    const take = <T,>(cat: SelCategory, arr: T[] | undefined): T[] =>
      (arr ?? []).filter((_, i) => all || isSelected(cat, i))
    return {
      merges: take("merges", p.merges),
      deletions: take("deletions", p.deletions),
      conflicts: take("conflicts", p.conflicts),
      keeps_as_is: p.keeps_as_is ?? [],
      relations: take("relations", p.relations),
      remove_relations: take("remove_relations", p.remove_relations),
      overall_summary: p.overall_summary ?? "",
    }
  }

  async function runPlan() {
    setGPlanning(true)
    setGPlanError(undefined)
    setGApplyResult(undefined)
    setGApplyError(undefined)
    setGDeselected(new Set<string>()) // fresh plan starts fully selected
    try {
      const res = await client.post<GlobalPlanResponse>("/refiner/global-rerefine/llm/plan", {})
      setGPlanResult(res)
      if (!res.ok) setGPlanError(reasonText(res.reason))
    } catch (err) {
      setGPlanResult(undefined)
      setGPlanError(err instanceof Error ? err.message : String(err))
    } finally {
      setGPlanning(false)
    }
  }

  async function applyPlan(all: boolean) {
    if (!plan()) return
    const body = buildApplyBody(all)
    setGApplying(true)
    setGApplyError(undefined)
    try {
      // The apply route reads merges/deletions/… directly off the request body,
      // so we POST a plan-shaped object (filtered to the chosen subset), not
      // wrapped. Unchecked items are simply omitted from their arrays.
      const res = await client.post<GlobalApplyResponse>("/refiner/global-rerefine/llm/apply", body)
      setGApplyResult(res)
      // Applied items are now stale: drop the plan so the user regenerates a
      // fresh view of what remains, and reset the selection.
      setGPlanResult(undefined)
      setGPlanError(undefined)
      setGDeselected(new Set<string>())
    } catch (err) {
      setGApplyResult(undefined)
      setGApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setGApplying(false)
    }
  }

  const applied = createMemo(() => applyResult()?.applied)

  // ── Stat tiles double as category tabs ────────────────────────────────────
  // Each tab key maps onto one plan category my code already produces. The body
  // below shows ONLY the active tab's rows; zero-count tabs are disabled.
  type PlanTab = "merges" | "deletions" | "conflicts" | "relations" | "remove_relations" | "keeps"
  const TAB_LABEL: Record<PlanTab, string> = {
    merges: "合并",
    deletions: "删除",
    conflicts: "冲突",
    relations: "新增关系",
    remove_relations: "删除关系",
    keeps: "保留原样",
  }
  const TAB_ORDER: PlanTab[] = ["merges", "deletions", "conflicts", "relations", "remove_relations", "keeps"]
  const TAB_TONE: Record<PlanTab, "merge" | "delete" | "conflict" | "relation" | "keep"> = {
    merges: "merge",
    deletions: "delete",
    conflicts: "conflict",
    relations: "relation",
    remove_relations: "relation",
    keeps: "keep",
  }

  const [planTab, setPlanTab] = createSignal<PlanTab | undefined>()

  // The active tab: honor the user's pick if it's non-empty, else fall back to
  // the first category that actually has rows.
  const activeTab = createMemo<PlanTab | undefined>(() => {
    const s = planSummary()
    if (!s) return undefined
    const count = (t: PlanTab) => s[t]
    const picked = planTab()
    if (picked && count(picked) > 0) return picked
    return TAB_ORDER.find((t) => count(t) > 0)
  })

  return (
    <section class="rl-section rl-review">
      <header class="rl-section-hd">
        <div class="rl-section-titles">
          <h2 class="rl-section-title">全局整理（LLM）</h2>
          <p class="rl-section-sub">
            让整理员 LLM 通览整个经验库，给出合并 / 删除 / 冲突 / 关系的方案。点上方分类查看明细，确认后再应用。
          </p>
        </div>
        <div class="rl-review-actions">
          <button type="button" class="rl-btn rl-btn-primary" onClick={() => void runPlan()} disabled={planning()}>
            {planning() ? "生成方案中…" : plan() ? "重新生成方案" : "生成整理方案"}
          </button>
          <Show when={plan() && !isEmptyPlan()}>
            <button
              type="button"
              class="rl-btn"
              onClick={() => void applyPlan(false)}
              disabled={applying() || selectedCount() === 0}
              title={selectedCount() === 0 ? "请至少勾选一项" : "仅执行勾选的合并 / 删除 / 关系变更"}
            >
              {applying() ? "应用中…" : `应用所选（${selectedCount()}/${actionableCount()}）`}
            </button>
            <button
              type="button"
              class="rl-btn rl-btn-danger"
              onClick={() => void applyPlan(true)}
              disabled={applying()}
              title="执行方案中的全部合并 / 删除 / 关系变更"
            >
              {applying() ? "应用中…" : "全部应用"}
            </button>
          </Show>
        </div>
      </header>

      <Show when={planError()}>
        <div class="rl-error">生成方案失败：{planError()}</div>
      </Show>

      <Show when={applyError()}>
        <div class="rl-error">应用失败：{applyError()}</div>
      </Show>

      {/* Applied result banner */}
      <Show when={applied()}>
        {(a) => (
          <div class="rl-applied">
            <span class="rl-applied-title">已应用</span>
            <div class="rl-applied-counts">
              <AppliedStat label="合并" n={a().merges} />
              <AppliedStat label="删除" n={a().deletions} />
              <AppliedStat label="新增关系" n={a().relations} />
              <AppliedStat label="删除关系" n={a().relations_removed} />
            </div>
            <Show when={(applyResult()?.skipped?.length ?? 0) > 0}>
              <details class="rl-skipped">
                <summary>跳过 {applyResult()!.skipped.length} 项</summary>
                <ul>
                  <For each={applyResult()!.skipped}>
                    {(s) => (
                      <li>
                        <span class="rl-badge" data-kind={s.kind}>
                          {s.kind === "merge" ? "合并" : "删除"}
                        </span>
                        <span class="rl-skipped-ids">{s.ids.map(shortId).join(", ")}</span>
                        <span class="rl-skipped-reason">{s.reason}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
          </div>
        )}
      </Show>

      {/* The plan itself */}
      <Show
        when={plan()}
        fallback={
          <Show when={!planning() && !planError()}>
            <div class="rl-empty">尚未生成方案。点击「生成整理方案」开始。</div>
          </Show>
        }
      >
        {(p) => (
          <div class="rl-plan">
            <Show when={p().overall_summary}>
              <div class="rl-plan-summary">{p().overall_summary}</div>
            </Show>

            {/* Stat tiles double as category tabs: click one to focus its rows. */}
            <div class="rl-plan-stats" role="tablist" aria-label="整理分类">
              <For each={TAB_ORDER}>
                {(tab) => {
                  const n = () => planSummary()![tab]
                  return (
                    <PlanStat
                      label={TAB_LABEL[tab]}
                      n={n()}
                      tone={TAB_TONE[tab]}
                      active={activeTab() === tab}
                      onSelect={n() === 0 ? undefined : () => setPlanTab(tab)}
                    />
                  )
                }}
              </For>
            </div>

            <Show when={isEmptyPlan()}>
              <div class="rl-empty-inline">整理员认为当前经验库无需变动。</div>
            </Show>

            {/* Only the active tab's group renders below. */}
            <Show when={activeTab()}>
              <div class="rl-plan-active">
                <Switch>
                  {/* Merges */}
                  <Match when={activeTab() === "merges"}>
                    <PlanGroup title="合并 Merges" count={p().merges.length}>
                      <For each={p().merges}>
                        {(m, i) => (
                          <PlanRow
                            checked={isSelected("merges", i())}
                            onToggle={() => toggleSelected("merges", i())}
                          >
                            <div class="rl-plan-row-hd">
                              <span class="rl-tag" data-tone="merge">
                                合并
                              </span>
                              <div class="rl-chips">
                                <For each={m.ids}>{(id) => <IdChip id={id} keep={id === m.keep} />}</For>
                              </div>
                            </div>
                            <div class="rl-plan-reason">{m.reason}</div>
                          </PlanRow>
                        )}
                      </For>
                    </PlanGroup>
                  </Match>

                  {/* Deletions */}
                  <Match when={activeTab() === "deletions"}>
                    <PlanGroup title="删除 Deletions" count={p().deletions.length}>
                      <For each={p().deletions}>
                        {(d, i) => (
                          <PlanRow
                            checked={isSelected("deletions", i())}
                            onToggle={() => toggleSelected("deletions", i())}
                          >
                            <div class="rl-plan-row-hd">
                              <span class="rl-tag" data-tone="delete">
                                删除
                              </span>
                              <IdChip id={d.id} />
                            </div>
                            <div class="rl-plan-reason">{d.reason}</div>
                          </PlanRow>
                        )}
                      </For>
                    </PlanGroup>
                  </Match>

                  {/* Conflicts */}
                  <Match when={activeTab() === "conflicts"}>
                    <PlanGroup title="冲突 Conflicts" count={p().conflicts.length}>
                      <For each={p().conflicts}>
                        {(c, i) => (
                          <PlanRow
                            checked={isSelected("conflicts", i())}
                            onToggle={() => toggleSelected("conflicts", i())}
                          >
                            <div class="rl-plan-row-hd">
                              <span class="rl-tag" data-tone="conflict">
                                冲突
                              </span>
                              <IdChip id={c.a_id} />
                              <span class="rl-vs">×</span>
                              <IdChip id={c.b_id} />
                              <span class="rl-resolution">{RESOLUTION_LABEL[c.resolution]}</span>
                            </div>
                            <div class="rl-plan-reason">{c.reason}</div>
                          </PlanRow>
                        )}
                      </For>
                    </PlanGroup>
                  </Match>

                  {/* New relations */}
                  <Match when={activeTab() === "relations"}>
                    <PlanGroup title="新增关系 Relations" count={p().relations.length}>
                      <For each={p().relations}>
                        {(r, i) => (
                          <RelationRow
                            rel={r}
                            checked={isSelected("relations", i())}
                            onToggle={() => toggleSelected("relations", i())}
                          />
                        )}
                      </For>
                    </PlanGroup>
                  </Match>

                  {/* Removed relations */}
                  <Match when={activeTab() === "remove_relations"}>
                    <PlanGroup title="删除关系 Remove relations" count={p().remove_relations.length}>
                      <For each={p().remove_relations}>
                        {(r, i) => (
                          <RelationRow
                            rel={r}
                            removed
                            checked={isSelected("remove_relations", i())}
                            onToggle={() => toggleSelected("remove_relations", i())}
                          />
                        )}
                      </For>
                    </PlanGroup>
                  </Match>

                  {/* Keeps */}
                  <Match when={activeTab() === "keeps"}>
                    <PlanGroup title="保留原样 Keeps" count={p().keeps_as_is.length}>
                      <div class="rl-chips rl-chips-wrap">
                        <For each={p().keeps_as_is}>{(id) => <IdChip id={id} />}</For>
                      </div>
                    </PlanGroup>
                  </Match>
                </Switch>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </section>
  )
}

/**
 * A selectable plan row: a leading checkbox (drives the apply selection) plus the
 * row's existing content. Toggling the row anywhere outside an interactive child
 * flips the checkbox, so the whole row is an easy hit target.
 */
function PlanRow(props: {
  checked: boolean
  onToggle: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div class="rl-plan-row" data-selected={props.checked}>
      <label class="rl-plan-pick">
        <input
          type="checkbox"
          class="rl-plan-check"
          checked={props.checked}
          onChange={props.onToggle}
        />
      </label>
      <div class="rl-plan-row-main">{props.children}</div>
    </div>
  )
}

function RelationRow(props: {
  rel: GlobalLLMPlan["relations"][number]
  removed?: boolean
  checked: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <PlanRow checked={props.checked} onToggle={props.onToggle}>
      <div class="rl-plan-row-hd">
        <span class="rl-tag" data-tone={props.removed ? "delete" : "relation"}>
          {props.removed ? "删边" : "加边"}
        </span>
        <IdChip id={props.rel.from} />
        <span class="rl-arrow">→</span>
        <IdChip id={props.rel.to} />
        <span class="rl-relkind" data-kind={props.rel.kind}>
          {REL_KIND_LABEL[props.rel.kind]}
        </span>
      </div>
      <div class="rl-plan-reason">{props.rel.reason}</div>
    </PlanRow>
  )
}

function PlanGroup(props: { title: string; count: number; children: JSX.Element }): JSX.Element {
  return (
    <div class="rl-plan-group">
      <h3 class="rl-plan-group-hd">
        {props.title}
        <span class="rl-plan-group-count">{props.count}</span>
      </h3>
      <div class="rl-plan-group-body">{props.children}</div>
    </div>
  )
}

function PlanStat(props: {
  label: string
  n: number
  tone: "merge" | "delete" | "conflict" | "relation" | "keep"
  active?: boolean
  onSelect?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      class="rl-stat"
      role="tab"
      data-tone={props.tone}
      data-zero={props.n === 0}
      data-on={!!props.active}
      aria-selected={!!props.active}
      disabled={props.n === 0}
      onClick={() => props.onSelect?.()}
    >
      <span class="rl-stat-n">{props.n}</span>
      <span class="rl-stat-l">{props.label}</span>
    </button>
  )
}

function AppliedStat(props: { label: string; n: number }): JSX.Element {
  return (
    <div class="rl-applied-stat">
      <span class="rl-applied-n">{props.n}</span>
      <span class="rl-applied-l">{props.label}</span>
    </div>
  )
}

/** Friendly text for the planner's `reason` failure codes. */
function reasonText(reason: string): string {
  switch (reason) {
    case "no_experiences":
      return "经验库为空，无需整理。"
    case "no_model":
      return "未配置可用的整理模型。"
    case "llm_failed":
      return "整理员 LLM 调用失败，请重试。"
    default:
      return reason
  }
}
