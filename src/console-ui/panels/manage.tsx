/**
 * Management panel — the console's reason to exist. It is itself a registered
 * panel (id "manage"), so it shows up in the same rail as chat/outlook/etc.
 *
 * Everything here is driven by the daemon's /capabilities + /config:
 *   - global settings (opencode URL, directory, hotkey, port)
 *   - per-capability enable/disable  → config.disabledCapabilities
 *   - per-capability config FORMS rendered straight from configSchema, so a new
 *     plugin's settings appear here with ZERO code added to this file.
 *   - the agent's tool inventory (what opencode discovers over /mcp)
 *   - a live health dot.
 */
import { createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { registerPanel } from "../../panels/registry"
import { api } from "../../panels/bridge"
import { Icon } from "../../panels/icons"
import type { CapabilityInfo, ConfigField, GlobalConfig, HostEvent } from "../../panels/global"
import "./manage.css"

/** Parse the path-map textarea ("WIN=>LINUX" per line) into the config shape. */
function parsePathMaps(text: string): Array<{ from: string; to: string }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=>")
      return i < 0 ? null : { from: l.slice(0, i).trim(), to: l.slice(i + 2).trim() }
    })
    .filter((m): m is { from: string; to: string } => !!m && !!m.from && !!m.to)
}

/** Capability id → Lucide icon (replaces the emoji each capability registered). */
const CAP_ICON: Record<string, string> = {
  chat: "message-square",
  outlook: "mail",
  notify: "bell",
  exp: "share-2",
  clipboard: "paperclip",
  manage: "settings",
}

/** Glyph for a capability card: known built-ins, then an external plugin's own
 *  Lucide name (if it looks like one), else a generic plug. */
function capIcon(cap: CapabilityInfo): string {
  if (CAP_ICON[cap.id]) return CAP_ICON[cap.id]
  if (cap.icon && /^[a-z][a-z0-9-]*$/.test(cap.icon)) return cap.icon
  return cap.external ? "plug" : "circle"
}

/**
 * Tiny "?" badge that reveals its help text as a hover/focus tooltip — keeps the
 * descriptive blurbs off the page until they're wanted. Pure CSS tooltip (.mg-hint-pop),
 * with title/aria-label mirrored for accessibility.
 */
function Hint(props: { text: string }) {
  // The tooltip is position:FIXED with JS-computed coords so it escapes the
  // card's `overflow:hidden` (which was clipping the popup near section titles).
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null)
  let ref: HTMLSpanElement | undefined
  const show = () => {
    const r = ref?.getBoundingClientRect()
    if (r) setPos({ x: r.left + r.width / 2, y: r.bottom + 7 })
  }
  const hide = () => setPos(null)
  return (
    <span
      ref={ref}
      class="mg-hint"
      tabindex="0"
      title={props.text}
      aria-label={props.text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      ?
      <Show when={pos()}>
        <span class="mg-hint-pop" role="tooltip" style={{ left: `${pos()!.x}px`, top: `${pos()!.y}px` }}>
          {props.text}
        </span>
      </Show>
    </span>
  )
}

function ManagePanel() {
  const [caps, setCaps] = createSignal<CapabilityInfo[]>([])
  const [cfg, setCfg] = createSignal<GlobalConfig | undefined>()
  const [healthy, setHealthy] = createSignal<boolean | undefined>()
  const [saved, setSaved] = createSignal<string | undefined>()

  async function refresh() {
    try {
      setHealthy((await api.health()).ok)
      setCaps(await api.capabilities())
      setCfg(await api.getConfig())
    } catch {
      setHealthy(false)
    }
  }

  onMount(() => {
    void refresh()
    const off = api.events((e: HostEvent) => {
      if (e.type === "config:changed") void refresh()
    })
    onCleanup(off)
  })

  function flash(msg: string) {
    setSaved(msg)
    setTimeout(() => setSaved(undefined), 1500)
  }

  async function patchGlobal(patch: Partial<GlobalConfig>) {
    setCfg(await api.setConfig(patch))
    flash("已保存")
  }

  async function toggleCap(id: string, enable: boolean) {
    const disabled = new Set(cfg()?.disabledCapabilities ?? [])
    if (enable) disabled.delete(id)
    else disabled.add(id)
    await patchGlobal({ disabledCapabilities: [...disabled] })
    await refresh()
  }

  async function setCapField(id: string, field: ConfigField, value: string) {
    const coerced =
      field.type === "number" ? Number(value) : field.type === "boolean" ? value === "true" : value
    const current = caps().find((c) => c.id === id)?.config ?? {}
    await patchGlobal({ capabilities: { [id]: { ...current, [field.key]: coerced } } })
    await refresh()
  }

  return (
    <div class="panel">
      <div class="panel-head">
        <div class="ph-title">
          <span class="ph-icon">
            <Icon name="settings" size={17} />
          </span>
          <div>
            <h2>管理 · win-host</h2>
            <div class="sub">能力开关 · 配置 · agent 工具清单</div>
          </div>
        </div>
        <span
          class="mg-health"
          data-state={healthy() === undefined ? "unknown" : healthy() ? "online" : "offline"}
        >
          <span class="mg-dot" />
          {healthy() === undefined ? "检测中…" : healthy() ? "在线" : "离线"}
        </span>
      </div>

      <div class="panel-body">
        <div class="mg-body">
          <Show when={saved()}>
            <div class="mg-flash">
              <Icon name="check" size={14} />
              {saved()}
            </div>
          </Show>

          {/* ── global settings ───────────────────────────────────────────── */}
          <Show when={cfg()} keyed>
            {(c) => (
              <section class="mg-card">
                <div class="mg-card-head">
                  <span class="mg-card-icon">
                    <Icon name="settings" size={15} />
                  </span>
                  <div class="mg-card-title">
                    <h3>
                      全局设置
                      <Hint text="连接 opencode、热键与服务端口" />
                    </h3>
                  </div>
                </div>
                <div class="mg-card-body">
                  <label class="mg-field">
                    <span class="mg-field-label">opencode serve 地址</span>
                    <input
                      value={c.opencodeUrl}
                      onChange={(e) => patchGlobal({ opencodeUrl: e.currentTarget.value })}
                    />
                  </label>
                  <label class="mg-field">
                    <span class="mg-field-label">项目目录(可选,限定 session)</span>
                    <input
                      value={c.directory ?? ""}
                      placeholder="留空 = 不限定"
                      onChange={(e) => patchGlobal({ directory: e.currentTarget.value || undefined })}
                    />
                  </label>
                  <div class="mg-row">
                    <label class="mg-field">
                      <span class="mg-field-label">全局热键</span>
                      <input value={c.hotkey} onChange={(e) => patchGlobal({ hotkey: e.currentTarget.value })} />
                    </label>
                    <label class="mg-field mg-narrow">
                      <span class="mg-field-label">端口</span>
                      <input
                        type="number"
                        value={c.serverPort}
                        onChange={(e) => patchGlobal({ serverPort: Number(e.currentTarget.value) || 8799 })}
                      />
                    </label>
                  </div>
                  <label class="mg-field">
                    <span class="mg-field-label">
                      路径映射(每行 Windows前缀=&gt;Linux前缀)
                      <Hint text="改热键即时生效;改端口需重启 host。对话框「工作目录」填 Windows 路径会按此映射转成 Linux 路径供 opencode 访问。" />
                    </span>
                    <textarea
                      class="mg-textarea"
                      rows="2"
                      placeholder={"D:\\proj=>/media/sf_proj   (VirtualBox 共享盘)\n留空 = 盘符自动映射到 WSL 的 /mnt/<盘>"}
                      value={(c.pathMaps ?? []).map((m) => m.from + "=>" + m.to).join("\n")}
                      onChange={(e) => patchGlobal({ pathMaps: parsePathMaps(e.currentTarget.value) })}
                    />
                  </label>
                </div>
              </section>
            )}
          </Show>

          {/* ── capabilities ──────────────────────────────────────────────── */}
          <section class="mg-card">
            <div class="mg-card-head">
              <span class="mg-card-icon">
                <Icon name="share-2" size={15} />
              </span>
              <div class="mg-card-title">
                <h3>
                  能力(插件)
                  <Hint text="启用 / 停用、面板与 agent 工具" />
                </h3>
              </div>
            </div>
            <div class="mg-caps">
              <For each={caps()}>
                {(cap) => (
                  <div class="mg-cap" data-enabled={cap.enabled}>
                    <div class="mg-cap-top">
                      <span class="mg-cap-glyph">
                        <Icon name={capIcon(cap)} size={16} />
                      </span>
                      <div class="mg-cap-meta">
                        <span class="mg-cap-name">
                          {cap.title}
                          <Show when={cap.description}>
                            <Hint text={cap.description!} />
                          </Show>
                          <Show when={cap.hasPanel}>
                            <span class="mg-badge">
                              <Icon name="panel-left" size={11} />
                              面板
                            </span>
                          </Show>
                        </span>
                      </div>
                      <label class="mg-switch">
                        <input
                          type="checkbox"
                          checked={cap.enabled}
                          onChange={(e) => toggleCap(cap.id, e.currentTarget.checked)}
                        />
                        <span class="mg-switch-track">
                          <span class="mg-switch-thumb" />
                        </span>
                        <span class="mg-switch-text" data-on={cap.enabled}>
                          {cap.enabled ? "启用" : "停用"}
                        </span>
                      </label>
                    </div>

                    <Show when={cap.tools.length > 0}>
                      <div class="mg-tools">
                        <span class="mg-tools-label">agent 工具</span>
                        <For each={cap.tools}>{(t) => <span class="mg-tool">{t.name}</span>}</For>
                      </div>
                    </Show>

                    {/* configSchema → form, zero per-capability code */}
                    <Show when={cap.configSchema && cap.configSchema.fields.length > 0}>
                      <div class="mg-cap-config">
                        <For each={cap.configSchema!.fields}>
                          {(f) => (
                            <label class="mg-field">
                              <span class="mg-field-label">
                                {f.label}
                                <Show when={f.help}>
                                  <Hint text={f.help!} />
                                </Show>
                              </span>
                              <Show
                                when={f.type === "select"}
                                fallback={
                                  <Show
                                    when={f.type === "boolean"}
                                    fallback={
                                      <input
                                        type={f.secret ? "password" : f.type === "number" ? "number" : "text"}
                                        placeholder={f.placeholder}
                                        value={String(cap.config[f.key] ?? "")}
                                        onChange={(e) => setCapField(cap.id, f, e.currentTarget.value)}
                                      />
                                    }
                                  >
                                    <select
                                      value={String(cap.config[f.key] ?? "false")}
                                      onChange={(e) => setCapField(cap.id, f, e.currentTarget.value)}
                                    >
                                      <option value="true">开</option>
                                      <option value="false">关</option>
                                    </select>
                                  </Show>
                                }
                              >
                                <select
                                  value={String(cap.config[f.key] ?? "")}
                                  onChange={(e) => setCapField(cap.id, f, e.currentTarget.value)}
                                >
                                  <For each={f.options ?? []}>{(o) => <option value={o}>{o}</option>}</For>
                                </select>
                              </Show>
                            </label>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

registerPanel({ id: "manage", title: "管理", icon: "⚙️", render: () => <ManagePanel /> })
