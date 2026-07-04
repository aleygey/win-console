/**
 * 整理模型 selector — the LLM the playbook uses for distill / recall-judge /
 * global-rerefine. Lists opencode's LIVE connected models (so a model the
 * gateway dropped doesn't strand the refiner), and writes the playbook override
 * via GET/PUT /refiner/config. The refiner is OpenAI-compatible only and needs
 * json_schema (kimi/glm honor it); for a different endpoint use 自定义端点.
 *
 * Lives in the 管理 panel's exp card (all exp-related configuration in one
 * place, per user request); needs the ExpClientProvider from the App shell.
 */
import { createMemo, createSignal, onMount, Show, For, type JSX } from "solid-js"
import { useExpClient } from "../../api/client"
import { api } from "../../bridge"
import type { ModelInfo } from "../../global"

export function RefineModel(): JSX.Element {
  const client = useExpClient()
  const [providerID, setProviderID] = createSignal("opencode-go")
  const [modelID, setModelID] = createSignal("")
  const [models, setModels] = createSignal<ModelInfo[]>([])
  const [saved, setSaved] = createSignal(false)
  // custom endpoint (different OpenAI-compatible provider)
  const [custom, setCustom] = createSignal(false)
  const [cModel, setCModel] = createSignal("")
  const [cBase, setCBase] = createSignal("")
  const [cKey, setCKey] = createSignal("")

  onMount(async () => {
    try {
      const r = await client.get<{ override?: { model?: { providerID?: string; modelID?: string }; baseURL?: string } }>(
        "/refiner/config",
      )
      const m = r?.override?.model
      if (m?.providerID) setProviderID(m.providerID)
      if (m?.modelID) setModelID(m.modelID)
      if (r?.override?.baseURL) setCBase(r.override.baseURL)
      setCModel(m?.modelID ?? "")
    } catch {
      /* playbook unreachable */
    }
    try {
      setModels(await api.chat.models())
    } catch {
      /* opencode/win-host down — fall back to just the current model */
    }
  })

  // Models on the SAME provider the refiner is configured with — these work with
  // the existing baseURL/key. Keep the current model selectable even if dropped.
  const providerModels = createMemo(() => {
    const list = models()
      .filter((m) => m.providerID === providerID())
      .map((m) => m.modelID)
    return modelID() && !list.includes(modelID()) ? [modelID(), ...list] : list
  })

  function flash() {
    setSaved(true)
    setTimeout(() => setSaved(false), 1400)
  }
  async function pickModel(id: string, el?: HTMLSelectElement) {
    if (id === "__custom__") {
      setCustom(true)
      // The native <select> would otherwise stay stuck on "自定义端点…"; the
      // signal didn't change, so reset the DOM to keep showing the real model
      // (the popover itself signals we're in custom mode).
      if (el) el.value = modelID()
      return
    }
    setModelID(id)
    await client.put("/refiner/config", { model: { providerID: providerID(), modelID: id } }).catch(() => {})
    flash()
  }
  async function applyCustom() {
    const mid = cModel().trim()
    if (!mid) return
    const body: Record<string, unknown> = { model: { providerID: providerID(), modelID: mid } }
    if (cBase().trim()) body.baseURL = cBase().trim()
    if (cKey().trim()) body.apiKey = cKey().trim()
    await client.put("/refiner/config", body).catch(() => {})
    setModelID(mid)
    setCustom(false)
    setCKey("")
    flash()
  }

  return (
    <div class="exp-model">
      <span class="exp-model-label">整理模型</span>
      <select
        class="exp-model-select"
        value={modelID()}
        title="经验整理 / 召回判断 / 全局整理用的 LLM。列出 opencode 已连接的模型(需 OpenAI 兼容 + 支持结构化输出;kimi/glm 系一般可用)。"
        onChange={(e) => void pickModel(e.currentTarget.value, e.currentTarget)}
      >
        <Show when={providerModels().length === 0}>
          <option value={modelID()}>{modelID() || "（无可用模型）"}</option>
        </Show>
        <For each={providerModels()}>{(m) => <option value={m}>{m}</option>}</For>
        <option value="__custom__">自定义端点…</option>
      </select>
      <Show when={saved()}>
        <span class="exp-model-saved">已保存</span>
      </Show>

      <Show when={custom()}>
        <div class="exp-model-custom">
          <div class="exp-model-custom-hd">自定义 OpenAI 兼容端点</div>
          <input placeholder="modelID(如 glm-5.2)" value={cModel()} onInput={(e) => setCModel(e.currentTarget.value)} />
          <input placeholder="baseURL(留空=沿用当前)" value={cBase()} onInput={(e) => setCBase(e.currentTarget.value)} />
          <input
            type="password"
            placeholder="apiKey(留空=沿用当前)"
            value={cKey()}
            onInput={(e) => setCKey(e.currentTarget.value)}
          />
          <div class="exp-model-custom-row">
            <button class="exp-model-btn" onClick={() => void applyCustom()}>
              保存
            </button>
            <button class="exp-model-btn ghost" onClick={() => setCustom(false)}>
              取消
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
