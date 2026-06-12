/**
 * QuickAsk — the spotlight's single-line-to-chat surface.
 *
 *   collapsed:  one bar at the cursor — ✦ icon · input · 📎 attach · model
 *   on send:    the bar stays put; a compact conversation springs open BELOW it
 *               (CSS height animation), and the frameless window grows to fit
 *               (window.winhost.resize). Multi-turn reuses the same top input.
 *
 * It talks to the daemon through the same `api.chat` the console chat uses, so
 * there's one chat backend behind three surfaces. Attachments: images go via
 * imageDataUrl; other files contribute their (Electron-exposed) path to the
 * prompt so the agent can open them.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { marked } from "marked"
import { api } from "../panels/bridge"
import { Icon } from "../panels/icons"
import { buildAttachmentPayload, readFiles, type Attachment } from "../panels/attach"
import type { ChatMsg, ModelInfo, ModelRef } from "../panels/global"

marked.setOptions({ gfm: true, breaks: true })
const md = (t: string) => marked.parse(t, { async: false }) as string

const LS_MODEL = "winhost-spotlight-model"

function loadModel(): ModelRef | undefined {
  try {
    const s = localStorage.getItem(LS_MODEL)
    return s ? (JSON.parse(s) as ModelRef) : undefined
  } catch {
    return undefined
  }
}

export function QuickAsk() {
  const [input, setInput] = createSignal("")
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [msgs, setMsgs] = createSignal<ChatMsg[]>([])
  const [busy, setBusy] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [dragOver, setDragOver] = createSignal(false)
  const [sessionId, setSessionId] = createSignal<string | undefined>()
  const [models, setModels] = createSignal<ModelInfo[]>([])
  const [model, setModel] = createSignal<ModelRef | undefined>(loadModel())

  let inputEl: HTMLTextAreaElement | undefined
  let threadEl: HTMLDivElement | undefined
  let fileEl: HTMLInputElement | undefined
  let cardEl: HTMLDivElement | undefined

  /** Resize the (opaque) frameless window to exactly hug the card's content. */
  const fitWindow = () =>
    queueMicrotask(() => {
      const h = cardEl?.getBoundingClientRect().height
      if (h) window.winhost?.resize?.(Math.ceil(h))
    })
  const scrollDown = () => queueMicrotask(() => threadEl?.scrollTo({ top: threadEl.scrollHeight, behavior: "smooth" }))

  // Re-fit whenever anything that changes the card's height changes.
  createEffect(() => {
    input()
    attachments()
    msgs()
    expanded()
    busy()
    fitWindow()
  })

  const modelOptions = createMemo(() => {
    const connected = models().filter((m) => m.connected)
    return connected.length ? connected : models().slice(0, 150)
  })
  // -1 = follow opencode's configured default (no model override on send).
  const modelIndex = createMemo(() => {
    const m = model()
    if (!m) return -1
    return modelOptions().findIndex((o) => o.providerID === m.providerID && o.modelID === m.modelID)
  })
  const shortLabel = (m: ModelInfo) => m.label.split("/").pop()?.trim() || m.modelID

  function pickModel(i: number) {
    const m = modelOptions()[i]
    if (!m) {
      setModel(undefined)
      try {
        localStorage.removeItem(LS_MODEL)
      } catch {
        /* ignore */
      }
      return
    }
    const ref = { providerID: m.providerID, modelID: m.modelID }
    setModel(ref)
    try {
      localStorage.setItem(LS_MODEL, JSON.stringify(ref))
    } catch {
      /* ignore */
    }
  }

  onMount(async () => {
    try {
      setModels(await api.chat.models())
    } catch {
      /* no models yet */
    }
    // Refocus the input every time the hotkey re-shows the window.
    window.winhost?.onShown?.(() => queueMicrotask(() => inputEl?.focus()))
    inputEl?.focus()
    autoGrow()
    fitWindow()
    // Catch paste anywhere in the popup (not just the textarea) so a copied
    // screenshot drops in even if focus drifted.
    document.addEventListener("paste", onPaste)
    onCleanup(() => document.removeEventListener("paste", onPaste))
  })

  function autoGrow() {
    if (!inputEl) return
    inputEl.style.height = "auto"
    inputEl.style.height = Math.min(inputEl.scrollHeight, 84) + "px"
  }

  async function addFiles(files: FileList | File[]) {
    const atts = await readFiles(files)
    setAttachments((a) => [...a, ...atts])
  }

  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile()
        if (f) {
          e.preventDefault()
          addFiles([f])
          return
        }
      }
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const fs = e.dataTransfer?.files
    if (fs && fs.length) addFiles(fs)
  }

  function newAsk() {
    setMsgs([])
    setSessionId(undefined)
    setAttachments([])
    setInput("")
    setExpanded(false)
    autoGrow()
    inputEl?.focus()
  }

  async function send() {
    const text = input().trim()
    const atts = attachments()
    if ((!text && !atts.length) || busy()) return

    if (!expanded()) setExpanded(true) // fitWindow (effect) grows the window to fit

    // Attachments travel inline: text/code files inlined into the prompt, images
    // + binaries as file parts. No working dir / path mapping needed.
    const { textSuffix, files } = buildAttachmentPayload(atts)
    const fullText = text + textSuffix

    setMsgs((m) => [...m, { role: "user", text: text || "（附件）" }])
    setInput("")
    setAttachments([])
    autoGrow()
    setBusy(true)
    scrollDown()

    // try/finally so a thrown/hung send NEVER leaves busy stuck (which blocked
    // all later sends); a timeout unblocks the UI if the agent run is very long.
    try {
      const res = await Promise.race([
        api.chat.send({ text: fullText, files, sessionId: sessionId(), model: model() }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("超时 —— 任务可能还在跑,去控制台「对话」面板继续看")), 180_000),
        ),
      ])
      if (!res.ok) setMsgs((m) => [...m, { role: "system", text: `⚠ ${res.error ?? "发送失败"}` }])
      else {
        if (!sessionId() && res.sessionId) setSessionId(res.sessionId)
        setMsgs((m) => [...m, { role: "assistant", text: res.reply ?? "（空回复）" }])
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: "system", text: `⚠ ${e instanceof Error ? e.message : String(e)}` }])
    } finally {
      setBusy(false)
      scrollDown()
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      window.winhost?.hide?.()
      return
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div
      class="qa"
      data-expanded={expanded()}
      data-drag={dragOver()}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div class="qa-card" ref={cardEl}>
        <div class="qa-bar">
          <span class="qa-mark" aria-hidden="true">
            <Icon name="cpu" size={16} />
          </span>
          <textarea
            class="qa-input"
            ref={inputEl}
            rows={1}
            placeholder="问点什么 / 提个任务…  (Enter 发送)"
            value={input()}
            onInput={(e) => {
              setInput(e.currentTarget.value)
              autoGrow()
            }}
            onKeyDown={onKey}
          />
          <button class="qa-icon" title="附加文件 / 图片" onClick={() => fileEl?.click()}>
            <Icon name="paperclip" size={17} />
          </button>
          <input
            type="file"
            multiple
            ref={fileEl}
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.currentTarget.files) addFiles(e.currentTarget.files)
              e.currentTarget.value = ""
            }}
          />
          <Show when={expanded()}>
            <button class="qa-icon" title="新问题" onClick={newAsk}>
              <Icon name="plus" size={17} />
            </button>
          </Show>
          <select
            class="qa-model"
            title="模型"
            value={String(modelIndex())}
            onChange={(e) => pickModel(Number(e.currentTarget.value))}
          >
            <option value="-1">默认</option>
            <For each={modelOptions()}>{(m, i) => <option value={String(i())}>{shortLabel(m)}</option>}</For>
          </select>
          <button class="qa-icon" title="关闭 (Esc)" onClick={() => window.winhost?.hide?.()} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>

        <Show when={attachments().length > 0}>
          <div class="qa-chips">
            <For each={attachments()}>
              {(a, i) => (
                <span class="qa-chip" title={a.name}>
                  <Show when={a.isImage && a.dataUrl} fallback={<Icon name="file-text" size={13} />}>
                    <img src={a.dataUrl} alt="" />
                  </Show>
                  <span class="qa-chip-name">{a.name}</span>
                  <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i()))} aria-label="移除">
                    <Icon name="x" size={12} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>

        <div class="qa-thread-wrap">
          <div class="qa-thread" ref={threadEl}>
            <For each={msgs()}>
              {(m) => (
                <div class={`qa-msg ${m.role}`}>
                  <Show when={m.role === "assistant"} fallback={<div class="qa-bubble plain">{m.text}</div>}>
                    {/* eslint-disable-next-line solid/no-innerhtml */}
                    <div class="qa-bubble markdown" innerHTML={md(m.text)} />
                  </Show>
                </div>
              )}
            </For>
            <Show when={busy()}>
              <div class="qa-msg assistant">
                <div class="qa-bubble">
                  <span class="qa-typing" role="status" aria-label="思考中">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
