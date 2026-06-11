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

import { createMemo, createSignal, onMount, Show, Switch, Match, For, type JSX } from "solid-js"
import { registerPanel } from "../../registry"
import { useExpClient } from "../../api/client"
import { RefineList } from "./refine-list"
import { RefineGraph } from "./refine-graph"
import { RefineLog } from "./refine-log"
import { Retrieve } from "./retrieve"
import "./exp.css"

/** opencode-go (zen) models that honor json_schema structured output — the only
 *  ones the refiner's strict-schema calls (curate / global-rerefine) work with. */
const REFINE_MODELS = ["kimi-k2.5", "kimi-k2.6", "glm-5"]

/**
 * 整理模型 selector — the LLM the playbook uses for distill / recall-judge /
 * global-rerefine. Reads + writes the playbook's persisted override via
 * GET/PUT /refiner/config (so it survives restarts). Restricted to opencode-go
 * models (same gateway baseURL/key); cross-provider changes stay in config.json.
 */
function RefineModel(): JSX.Element {
  const client = useExpClient()
  const [modelID, setModelID] = createSignal("kimi-k2.5")
  const [providerID, setProviderID] = createSignal("opencode-go")
  const [saved, setSaved] = createSignal(false)

  onMount(async () => {
    try {
      const r = await client.get<{ override?: { model?: { providerID?: string; modelID?: string } } }>("/refiner/config")
      const m = r?.override?.model
      if (m?.modelID) setModelID(m.modelID)
      if (m?.providerID) setProviderID(m.providerID)
    } catch {
      /* playbook unreachable — keep the default label */
    }
  })

  const options = createMemo(() => (REFINE_MODELS.includes(modelID()) ? REFINE_MODELS : [modelID(), ...REFINE_MODELS]))

  async function change(id: string) {
    setModelID(id)
    try {
      await client.put("/refiner/config", { model: { providerID: providerID(), modelID: id } })
      setSaved(true)
      setTimeout(() => setSaved(false), 1400)
    } catch {
      /* surfaced by the empty state elsewhere */
    }
  }

  return (
    <label
      class="exp-model"
      title="经验整理 / 召回判断 / 全局整理用的 LLM(opencode-go 网关)。只列支持结构化输出的模型;换其它供应商请改 config.json。"
    >
      <span class="exp-model-label">整理模型</span>
      <select value={modelID()} onChange={(e) => void change(e.currentTarget.value)}>
        <For each={options()}>{(m) => <option value={m}>{m}</option>}</For>
      </select>
      <Show when={saved()}>
        <span class="exp-model-saved">已保存</span>
      </Show>
    </label>
  )
}

type TabId = "list" | "graph" | "logs" | "retrieve"

type TabDef = { id: TabId; label: string }

const TABS: TabDef[] = [
  { id: "list", label: "经验列表" },
  { id: "graph", label: "关系图谱" },
  { id: "logs", label: "整理日志" },
  { id: "retrieve", label: "召回" },
]

export function ExpPanel(): JSX.Element {
  const [tab, setTab] = createSignal<TabId>("list")

  return (
    <section class="exp-panel">
      <header class="exp-panel-header">
        <div class="exp-panel-titles">
          <h1 class="exp-panel-title">经验库</h1>
          <p class="exp-panel-subtitle">沉淀 · 整理 · 召回</p>
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
          <RefineModel />
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
