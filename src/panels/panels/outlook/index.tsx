/**
 * Outlook panel — search the classic Outlook inbox. On Windows the main process
 * drives Outlook over COM (PowerShell); on mac/dev it returns mock fixtures so
 * the panel renders end-to-end without Outlook. Same data either way.
 */
import { createSignal, For, Show } from "solid-js"
import { registerPanel } from "../../registry"
import { api } from "../../bridge"
import { Icon } from "../../icons"
import type { OutlookMail } from "../../global"
import "./outlook.css"

function OutlookPanel() {
  const [query, setQuery] = createSignal("")
  const [top, setTop] = createSignal(15)
  const [mails, setMails] = createSignal<OutlookMail[]>([])
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | undefined>()
  const [mock, setMock] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)

  async function run() {
    setBusy(true)
    setErr(undefined)
    const res = await api.outlook.search({ query: query().trim() || undefined, top: top() })
    setBusy(false)
    setLoaded(true)
    if (!res.ok) {
      setErr(res.error)
      setMails([])
      return
    }
    setMock(!!res.mock)
    setMails(res.mails ?? [])
  }

  function fmt(iso: string) {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false })
  }

  function initial(from: string) {
    const c = (from || "").trim().charAt(0)
    return c || "?"
  }

  return (
    <div class="panel">
      <div class="panel-head">
        <div class="ph-title">
          <span class="ph-icon">
            <Icon name="mail" size={17} />
          </span>
          <div>
            <h2>Outlook 收件箱</h2>
            <div class="sub">经典版 Outlook · COM 读取</div>
          </div>
        </div>
        <Show when={mock()}>
          <span class="badge mock">mock 数据(非 Windows)</span>
        </Show>
      </div>

      <div class="panel-body">
        <div class="ol-search">
          <label class="ol-search-field">
            <Icon name="search" size={16} />
            <input
              class="ol-search-input"
              placeholder="关键词(主题/发件人,可空)"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
          </label>
          <label class="ol-count">
            条数
            <input
              type="number"
              min="1"
              max="50"
              value={top()}
              onInput={(e) => setTop(Number(e.currentTarget.value) || 15)}
            />
          </label>
          <button class="ol-go" disabled={busy()} onClick={run}>
            <Show when={!busy()} fallback={<Icon name="refresh-cw" size={16} />}>
              <Icon name="search" size={16} />
            </Show>
            {busy() ? "读取中…" : "搜索"}
          </button>
        </div>

        <Show when={err()}>
          <div class="ol-error">{err()}</div>
        </Show>

        <Show when={loaded() && !err() && mails().length === 0}>
          <div class="ol-empty">没有匹配的邮件。</div>
        </Show>

        <div class="ol-list">
          <For each={mails()}>
            {(m) => (
              <div class={`ol-mail ${m.unread ? "unread" : ""}`}>
                <span class="ol-avatar" aria-hidden="true">{initial(m.from)}</span>
                <div class="ol-body">
                  <div class="ol-top">
                    <span class="ol-subject">{m.subject || "(无主题)"}</span>
                    <span class="ol-time">{fmt(m.received)}</span>
                  </div>
                  <div class="ol-from">{m.from}</div>
                  <Show when={m.preview}>
                    <div class="ol-preview">{m.preview}</div>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}

registerPanel({ id: "outlook", title: "邮件", icon: "📧", render: () => <OutlookPanel /> })
