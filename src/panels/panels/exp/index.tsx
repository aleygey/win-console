/**
 * exp plugin panel — "经验库".
 *
 * Registers a single {@link Panel} (id "exp") whose UI is {@link ExpPanel}: a
 * container with four sub-tabs that merge the old refiner + retrieve consoles:
 *   - List     → 经验列表   (RefineList)
 *   - Graph    → 关系图谱   (RefineGraph)
 *   - Logs     → 整理日志   (RefineLog)
 *   - Retrieve → 召回       (Retrieve)
 *
 * The four view components live in sibling files and are owned by other workers;
 * we import them by relative path. Tab state is local to the panel. The shared
 * exp HTTP client is reached inside each view via `useExpClient()` (the App
 * shell wraps the tree in <ExpClientProvider>), so this container stays free of
 * data concerns — it only switches views.
 */

import { createSignal, Switch, Match, For, type JSX } from "solid-js"
import { registerPanel } from "../../registry"
import { RefineList } from "./refine-list"
import { RefineGraph } from "./refine-graph"
import { RefineLog } from "./refine-log"
import { Retrieve } from "./retrieve"
import { ColdStart } from "./cold-start"
import "./exp.css"

type TabId = "list" | "graph" | "logs" | "retrieve" | "coldstart"

type TabDef = { id: TabId; label: string }

const TABS: TabDef[] = [
  { id: "list", label: "经验列表" },
  { id: "graph", label: "关系图谱" },
  { id: "logs", label: "整理日志" },
  { id: "retrieve", label: "召回" },
  { id: "coldstart", label: "冷启动" },
]

export function ExpPanel(): JSX.Element {
  const [tab, setTab] = createSignal<TabId>("list")

  return (
    <section class="exp-panel">
      <header class="exp-panel-header">
        <div class="exp-panel-titles">
          <h1 class="exp-panel-title">经验库</h1>
        </div>
        <div class="exp-panel-tools">
          <nav class="exp-tabs" aria-label="经验库视图">
            <For each={TABS}>
              {(t) => (
                <button
                  type="button"
                  class="exp-tab"
                  data-active={tab() === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              )}
            </For>
          </nav>
        </div>
      </header>

      <div class="exp-panel-body">
        <Switch>
          <Match when={tab() === "list"}>
            <RefineList />
          </Match>
          <Match when={tab() === "graph"}>
            <RefineGraph />
          </Match>
          <Match when={tab() === "logs"}>
            <RefineLog />
          </Match>
          <Match when={tab() === "retrieve"}>
            <Retrieve />
          </Match>
          <Match when={tab() === "coldstart"}>
            <ColdStart />
          </Match>
        </Switch>
      </div>
    </section>
  )
}

// Self-register on import. App.tsx does `import "./panels/exp"` to trigger this.
registerPanel({
  id: "exp",
  title: "经验库",
  icon: "📚",
  render: () => <ExpPanel />,
})
