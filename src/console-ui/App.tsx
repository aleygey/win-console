/**
 * Console shell — the management app. Same rail-of-panels pattern as the
 * original win-console, but its headline role is administration: the "管理"
 * panel sits alongside the feature panels so you can drive a capability AND
 * configure it from one window.
 *
 * Two sources feed the rail:
 *   - BUILT-IN panels  — registered by side-effect import (registerPanel).
 *   - EXTERNAL plugins — runtime-registered via the daemon; any that advertise a
 *     `panel.url` get a generic <IframePanel> rail item, live. They appear the
 *     moment a plugin registers and vanish when it stops — no rebuild, no code.
 */
import { createMemo, createSignal, For, Show, onMount, onCleanup, type JSX } from "solid-js"
import { listPanels, type Panel } from "../panels/registry"
import { api } from "../panels/bridge"
import { Icon } from "../panels/icons"
import { IframePanel } from "../panels/panels/external/iframe-panel"
import { ExpClientProvider, createClient, resolveBaseUrl, type ExpClient } from "../panels/api/client"
import type { CapabilityInfo, GlobalConfig, HostEvent } from "../panels/global"

/** Map panel id → Lucide icon name (replaces the emoji each panel registered). */
const RAIL_ICON: Record<string, string> = {
  sessions: "activity",
  taskflow: "list-checks",
  mailflow: "mail",
  exp: "share-2",
  manage: "settings",
}

const LS_RAIL_COLLAPSED = "winhost-rail-collapsed"

/** Rail glyph for a panel: known built-ins first, then a plugin's own Lucide
 *  name (if it looks like one), else a generic plug. */
function railIcon(panel: Panel): string {
  if (RAIL_ICON[panel.id]) return RAIL_ICON[panel.id]
  if (panel.icon && /^[a-z][a-z0-9-]*$/.test(panel.icon)) return panel.icon
  return "plug"
}

/** Visual tone for a rail count badge — cobalt (default) or amber/warn. */
type BadgeTone = "info" | "warn"

/** Minimal shape of the experience records we need to count pending reviews. */
type ExpReviewItem = { review_status?: string }
type RefinerOverview = { experiences?: ExpReviewItem[] }

export default function App(props: { expClient?: ExpClient }): JSX.Element {
  const staticPanels = listPanels()
  const [extCaps, setExtCaps] = createSignal<CapabilityInfo[]>([])

  // External plugins with a UI → one IframePanel each. The Panel objects are
  // CACHED by id+url so an SSE-driven caps refetch (a config edit, another plugin
  // registering) returns the SAME reference for an unchanged plugin — otherwise
  // the keyed <Show> below would tear down and RELOAD the active iframe on every
  // refresh (losing the plugin page's scroll/input/stream state).
  const panelCache = new Map<string, Panel>()
  const externalPanels = createMemo<Panel[]>(() => {
    const live = new Set<string>()
    const out = extCaps()
      .filter((c) => c.external && c.enabled && c.panel?.url)
      .map((c) => {
        const key = `${c.id}|${c.panel!.url}`
        live.add(key)
        let p = panelCache.get(key)
        if (!p) {
          p = { id: c.id, title: c.title, icon: c.icon, render: () => <IframePanel id={c.id} title={c.title} url={c.panel!.url} /> }
          panelCache.set(key, p)
        }
        return p
      })
    // Evict entries for plugins that unregistered or changed URL — otherwise the
    // cache grows forever against churning plugins (fresh port per restart).
    for (const k of panelCache.keys()) if (!live.has(k)) panelCache.delete(k)
    return out
  })

  // When the active panel's capability is toggled off in 管理 it leaves the rail;
  // show an explanation instead of the generic empty state.
  const disabledHint = createMemo<string | undefined>(() => {
    const c = extCaps().find((x) => x.id === activeId())
    return c && !c.enabled ? "该能力已在「管理」里停用 — 重新启用后面板会回来" : undefined
  })

  // Rail order: feature panels, then external plugins, then 管理 last.
  const panels = createMemo<Panel[]>(() => {
    const feature = staticPanels.filter((p) => p.id !== "manage")
    const manage = staticPanels.filter((p) => p.id === "manage")
    return [...feature, ...externalPanels(), ...manage]
  })

  const panelFromHash = () => /[#&]panel=([\w-]+)/.exec(location.hash)?.[1]
  const initial = panelFromHash()
  const [activeId, setActiveId] = createSignal<string | undefined>(
    initial && panels().some((p) => p.id === initial) ? initial : panels()[0]?.id,
  )
  const [cfg, setCfg] = createSignal<GlobalConfig | undefined>()
  // Collapsible rail: icons-only, persisted. Requested because inside Obsidian
  // the screen splits into too many vertical columns (folders → note → console
  // rail → panel) — collapsing the rail buys the content column back.
  const [railCollapsed, setRailCollapsed] = createSignal(localStorage.getItem(LS_RAIL_COLLAPSED) === "1")
  const toggleRail = () => {
    const v = !railCollapsed()
    setRailCollapsed(v)
    try {
      localStorage.setItem(LS_RAIL_COLLAPSED, v ? "1" : "0")
    } catch {
      /* ignore */
    }
  }

  // ── Rail count badge ──────────────────────────────────────────────────────
  // 经验库: pending-review experiences from the exp backend (playbookUrl).
  const [expPending, setExpPending] = createSignal(0)

  /** Count for a given rail panel id, or 0 when none applies. */
  const railCount = (id: string): number => (id === "exp" ? expPending() : 0)
  /** Tone for a given rail panel id's badge (only 经验库 carries one). */
  const railTone = (_id: string): BadgeTone => "warn"

  /** Load the capability list (used at mount + on capabilities/config change). */
  async function loadCaps(): Promise<void> {
    try {
      setExtCaps(await api.capabilities())
    } catch {
      /* daemon not up yet */
    }
  }

  onMount(() => {
    // ALL subscriptions registered synchronously: an onCleanup placed after an
    // `await` in an async onMount silently no-ops (Solid's owner is gone), so
    // the SSE unsubscribe would never actually be registered.
    // Deep-link: #panel=<id> switches the active panel (Obsidian commands use it).
    const onHash = () => {
      const p = panelFromHash()
      if (p && panels().some((x) => x.id === p)) setActiveId(p)
    }
    window.addEventListener("hashchange", onHash)
    onCleanup(() => window.removeEventListener("hashchange", onHash))

    // Live rail: a plugin registering/unregistering (or being toggled in 管理)
    // re-renders the rail with no reload.
    const off = api.events((e: HostEvent) => {
      if (e.type === "capabilities:changed" || e.type === "config:changed") {
        void loadCaps()
        void api.getConfig().then(setCfg).catch(() => {})
      }
    })
    onCleanup(off)

    // Async data loads AFTER the subscriptions are safely owned.
    void (async () => {
      try {
        setCfg(await api.getConfig())
      } catch {
        /* daemon not up yet */
      }
      void loadCaps()

      // Best-effort pending-review count for 经验库.
      try {
        const client = props.expClient ?? createClient(resolveBaseUrl())
        const overview = await client.get<RefinerOverview>("/refiner/overview?limit=5000")
        const pending = (overview.experiences ?? []).filter((e) => e.review_status === "pending").length
        setExpPending(pending)
      } catch {
        /* exp backend unreachable → no badge */
      }
    })()
  })

  const activePanel = createMemo(() => panels().find((p) => p.id === activeId()))

  return (
    <ExpClientProvider client={props.expClient}>
      <div class="shell" data-collapsed={railCollapsed()}>
        <nav class="rail" aria-label="插件列表">
          <div class="rail-head">
            <div class="rail-brand">
              <span class="rail-mark" aria-hidden="true">
                <Icon name="cpu" size={16} />
              </span>
              <div class="rail-brand-text">
                <div class="rail-title">opencode</div>
                <div class="rail-sub">Win Host</div>
              </div>
            </div>
            <button
              type="button"
              class="rail-collapse"
              title={railCollapsed() ? "展开导航栏" : "收起导航栏(只留图标)"}
              onClick={toggleRail}
            >
              <Icon name="panel-left" size={15} />
            </button>
          </div>
          <div class="rail-section">插件</div>
          <For each={panels()}>
            {(panel) => (
              <button
                type="button"
                class="rail-item"
                data-active={panel.id === activeId()}
                title={railCollapsed() ? panel.title : undefined}
                onClick={() => setActiveId(panel.id)}
              >
                <span class="rail-icon" aria-hidden="true">
                  <Icon name={railIcon(panel)} size={17} />
                </span>
                <span class="rail-label">{panel.title}</span>
                <Show when={railCount(panel.id) > 0}>
                  <span class="rail-badge" data-tone={railTone(panel.id)}>
                    {railCount(panel.id)}
                  </span>
                </Show>
              </button>
            )}
          </For>
          <div class="rail-foot">
            <Show when={cfg()} fallback={<span class="muted">连接 host 中…</span>}>
              {(c) => (
                <>
                  <div class="muted" title={c().opencodeUrl}>
                    serve: {c().opencodeUrl.replace(/^https?:\/\//, "")}
                  </div>
                  <div class="muted">host: {api.baseUrl.replace(/^https?:\/\//, "")}</div>
                  <div class="muted">平台: {api.platform}</div>
                </>
              )}
            </Show>
          </div>
        </nav>

        <main class="content">
          <Show when={activePanel()} fallback={<div class="empty">{disabledHint() ?? "请选择一个插件"}</div>} keyed>
            {(panel) => panel.render()}
          </Show>
        </main>
      </div>
    </ExpClientProvider>
  )
}
