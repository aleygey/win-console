/**
 * Cold-start panel — bootstrap an empty experience library by hand-picking real
 * queries from past sessions and distilling them one by one.
 *
 * Why this lives in the front-end: the playbook can't enumerate opencode
 * sessions (its vendored client only fetches a session BY id). We do have the
 * win-host chat bridge (`api.chat.sessions/history`), which mirrors opencode's
 * session.list / session.messages — so the picking happens here and we POST the
 * chosen {session_id, message_id, user_text} triples to the playbook's
 * `/cold-start`, which distills each individually and reports a per-item outcome.
 *
 *   mode "route"  — run the normal route judgment (a query may be dropped as noise)
 *   mode "force"  — force one experience per query (createFromText), for "just sediment this"
 */
import { createSignal, For, Show, onMount, type JSX } from "solid-js"
import { api } from "../../bridge"
import { useExpClient } from "../../api/client"
import type { ChatSession } from "../../global"

type Picked = { session_id: string; message_id: string; user_text: string; preview: string; session_title: string }
type ColdItem = { session_id: string; message_id: string; user_text: string }
type ColdResult = {
  session_id: string
  message_id: string
  outcome: "new_exp" | "noise" | "edge_only" | "dropped" | "error"
  experience_ids: string[]
  reason?: string
  error?: string
}
type ColdResponse = {
  ok: true
  results: ColdResult[]
  stats: { processed: number; new_exp: number; noise: number; edge_only: number; dropped: number; error: number }
}

const OUTCOME_LABEL: Record<ColdResult["outcome"], string> = {
  new_exp: "新经验",
  edge_only: "仅建关系",
  noise: "判为噪声",
  dropped: "未沉淀",
  error: "出错",
}

export function ColdStart(): JSX.Element {
  const client = useExpClient()
  const [sessions, setSessions] = createSignal<ChatSession[]>([])
  const [activeSid, setActiveSid] = createSignal<string | null>(null)
  const [msgs, setMsgs] = createSignal<Array<{ id: string; text: string }>>([])
  const [ingested, setIngested] = createSignal<Set<string>>(new Set())
  const [loadingMsgs, setLoadingMsgs] = createSignal(false)
  // basket of picked queries, keyed `${sid}:${mid}`, accumulates across sessions
  const [basket, setBasket] = createSignal<Map<string, Picked>>(new Map())
  const [mode, setMode] = createSignal<"route" | "force">("route")
  const [busy, setBusy] = createSignal(false)
  const [results, setResults] = createSignal<ColdResult[] | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [filter, setFilter] = createSignal("")

  onMount(async () => {
    try {
      setSessions(await api.chat.sessions())
    } catch {
      setErr("连不上 win-host(对话桥):无法列出会话。确认 host 在跑。")
    }
  })

  const shownSessions = () => {
    const q = filter().trim().toLowerCase()
    return q ? sessions().filter((s) => s.title.toLowerCase().includes(q)) : sessions()
  }

  async function openSession(s: ChatSession) {
    setActiveSid(s.id)
    setLoadingMsgs(true)
    setMsgs([])
    try {
      const [hist, ing] = await Promise.all([
        api.chat.history(s.id),
        client
          .get<{ message_ids: string[] }>(`/refiner/ingested-observations/${encodeURIComponent(s.id)}`)
          .catch(() => ({ message_ids: [] as string[] })),
      ])
      setIngested(new Set(ing.message_ids ?? []))
      setMsgs(
        hist
          .filter((m) => m.role === "user" && m.id && m.text.trim())
          .map((m) => ({ id: m.id as string, text: m.text.trim() })),
      )
    } catch {
      setErr("加载会话消息失败。")
    } finally {
      setLoadingMsgs(false)
    }
  }

  const keyOf = (sid: string, mid: string) => `${sid}:${mid}`
  const inBasket = (sid: string, mid: string) => basket().has(keyOf(sid, mid))

  function toggle(sid: string, mid: string, text: string) {
    const title = sessions().find((s) => s.id === sid)?.title ?? sid
    setBasket((b) => {
      const next = new Map(b)
      const k = keyOf(sid, mid)
      if (next.has(k)) next.delete(k)
      else next.set(k, { session_id: sid, message_id: mid, user_text: text, preview: text.slice(0, 80), session_title: title })
      return next
    })
  }
  function removeFromBasket(k: string) {
    setBasket((b) => {
      const next = new Map(b)
      next.delete(k)
      return next
    })
  }
  const clearBasket = () => setBasket(new Map())

  async function distill() {
    const items: ColdItem[] = [...basket().values()].map((p) => ({
      session_id: p.session_id,
      message_id: p.message_id,
      user_text: p.user_text,
    }))
    if (items.length === 0) return
    setBusy(true)
    setErr(null)
    setResults(null)
    try {
      const res = await client.post<ColdResponse>("/cold-start", { items, mode: mode() })
      setResults(res.results ?? [])
      // refresh ingested marks for the active session so newly-distilled rows grey out
      const sid = activeSid()
      if (sid) {
        const ing = await client
          .get<{ message_ids: string[] }>(`/refiner/ingested-observations/${encodeURIComponent(sid)}`)
          .catch(() => ({ message_ids: [] as string[] }))
        setIngested(new Set(ing.message_ids ?? []))
      }
    } catch (e) {
      setErr(`沉淀失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="cs">
      <div class="cs-hint">
        冷启动:从历史会话里挑出值得沉淀的提问,逐条沉淀进经验库。<b>route</b> 走智能判定(可能判噪声),
        <b>force</b> 强制每条产出一条经验。
      </div>

      <div class="cs-cols">
        {/* left: sessions */}
        <aside class="cs-sessions">
          <input class="cs-search" placeholder="过滤会话…" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
          <div class="cs-session-list">
            <For each={shownSessions()} fallback={<div class="cs-empty">没有会话</div>}>
              {(s) => (
                <button class="cs-session" data-active={activeSid() === s.id} onClick={() => void openSession(s)}>
                  <span class="cs-session-title">{s.title}</span>
                </button>
              )}
            </For>
          </div>
        </aside>

        {/* middle: queries of the selected session */}
        <section class="cs-queries">
          <Show when={activeSid()} fallback={<div class="cs-empty">← 选一个会话查看其中的提问</div>}>
            <Show when={!loadingMsgs()} fallback={<div class="cs-empty">加载中…</div>}>
              <For each={msgs()} fallback={<div class="cs-empty">这个会话没有用户提问</div>}>
                {(m) => {
                  const done = () => ingested().has(m.id)
                  return (
                    <label class="cs-q" data-picked={inBasket(activeSid()!, m.id)} data-done={done()}>
                      <input
                        type="checkbox"
                        checked={inBasket(activeSid()!, m.id)}
                        onChange={() => toggle(activeSid()!, m.id, m.text)}
                      />
                      <span class="cs-q-text">{m.text}</span>
                      <Show when={done()}>
                        <span class="cs-q-done" title="该消息已被沉淀过">已沉淀</span>
                      </Show>
                    </label>
                  )
                }}
              </For>
            </Show>
          </Show>
        </section>

        {/* right: basket + run + results */}
        <aside class="cs-basket">
          <div class="cs-basket-head">
            <span>待沉淀篮子 <b>{basket().size}</b></span>
            <Show when={basket().size > 0}>
              <button class="cs-link" onClick={clearBasket}>清空</button>
            </Show>
          </div>
          <div class="cs-basket-list">
            <For each={[...basket().entries()]} fallback={<div class="cs-empty">勾选左侧提问加入</div>}>
              {([k, p]) => (
                <div class="cs-chip">
                  <span class="cs-chip-text" title={`${p.session_title}\n${p.user_text}`}>{p.preview}</span>
                  <button onClick={() => removeFromBasket(k)} title="移除">✕</button>
                </div>
              )}
            </For>
          </div>

          <div class="cs-run">
            <div class="cs-mode" role="radiogroup">
              <button class="cs-mode-btn" data-on={mode() === "route"} onClick={() => setMode("route")}>route 智能判定</button>
              <button class="cs-mode-btn" data-on={mode() === "force"} onClick={() => setMode("force")}>force 强制沉淀</button>
            </div>
            <button class="cs-go" disabled={busy() || basket().size === 0} onClick={() => void distill()}>
              {busy() ? "沉淀中…" : `逐条沉淀 (${basket().size})`}
            </button>
          </div>

          <Show when={err()}>
            <div class="cs-err">{err()}</div>
          </Show>

          <Show when={results()}>
            <div class="cs-results">
              <div class="cs-results-head">结果</div>
              <For each={results()!}>
                {(r) => (
                  <div class="cs-result" data-outcome={r.outcome}>
                    <span class="cs-result-badge">{OUTCOME_LABEL[r.outcome]}</span>
                    <span class="cs-result-reason">{r.error ?? r.reason ?? (r.experience_ids[0] ?? "")}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </aside>
      </div>
    </div>
  )
}
