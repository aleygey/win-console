/**
 * Notify panel — fire a desktop toast (the original notify feature, now native
 * via Electron Notification). The same capability is exposed to the agent over
 * the tool server (notify_desktop), so opencode can ping you from the VM too.
 */
import { createSignal, For, Show } from "solid-js"
import { registerPanel } from "../../registry"
import { api } from "../../bridge"
import { Icon } from "../../icons"
import type { NotifyLevel } from "../../global"
import "./notify.css"

type Sent = { title: string; message: string; level: NotifyLevel; at: string }

const LEVELS: NotifyLevel[] = ["info", "warn", "error"]

function NotifyPanel() {
  const [title, setTitle] = createSignal("构建完成")
  const [message, setMessage] = createSignal("opencode 跑完了你交代的任务 ✅")
  const [level, setLevel] = createSignal<NotifyLevel>("info")
  const [err, setErr] = createSignal<string | undefined>()
  const [hist, setHist] = createSignal<Sent[]>([])

  async function fire() {
    setErr(undefined)
    const res = await api.notify.test({ title: title(), message: message(), level: level() })
    if (!res.ok) {
      setErr(res.error)
      return
    }
    setHist([{ title: title(), message: message(), level: level(), at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) }, ...hist()])
  }

  return (
    <div class="panel">
      <div class="panel-head">
        <div class="ph-title">
          <span class="ph-icon">
            <Icon name="bell" size={17} />
          </span>
          <div>
            <h2>桌面通知</h2>
            <div class="sub">原生 toast · agent 也能通过工具触发</div>
          </div>
        </div>
      </div>

      <div class="panel-body">
        <div class="nt-wrap">
          <div class="nt-card">
            <div class="nt-field">
              <span class="nt-label">标题</span>
              <input class="nt-input" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
            </div>
            <div class="nt-field">
              <span class="nt-label">内容</span>
              <input class="nt-input" value={message()} onInput={(e) => setMessage(e.currentTarget.value)} />
            </div>
            <div class="nt-foot">
              <div class="nt-field">
                <span class="nt-label">级别</span>
                <div class="nt-levels" role="radiogroup">
                  <For each={LEVELS}>
                    {(lv) => (
                      <button
                        type="button"
                        class="nt-pill"
                        data-level={lv}
                        data-active={level() === lv}
                        aria-pressed={level() === lv}
                        onClick={() => setLevel(lv)}
                      >
                        <span class="nt-pill-dot" />
                        {lv}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <button class="nt-send" onClick={fire}>
                <Icon name="send" size={16} />
                发送测试通知
              </button>
            </div>

            <Show when={err()}>
              <div class="nt-error">{err()}</div>
            </Show>
          </div>

          <Show when={hist().length > 0}>
            <div>
              <div class="nt-hist-head">发送记录</div>
              <ul class="nt-timeline">
                <For each={hist()}>
                  {(h) => (
                    <li class="nt-item">
                      <div class="nt-rail">
                        <span class="nt-dot" data-level={h.level} />
                      </div>
                      <div class="nt-body">
                        <div class="nt-meta">
                          <span class="nt-title">{h.title}</span>
                          <span class="nt-time">{h.at}</span>
                        </div>
                        <div class="nt-text">{h.message}</div>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

registerPanel({ id: "notify", title: "通知", icon: "🔔", render: () => <NotifyPanel /> })
