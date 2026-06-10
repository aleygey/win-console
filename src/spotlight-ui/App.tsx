/**
 * Spotlight — the hotkey fallback when Obsidian isn't running. Just the chat
 * panel with launcher chrome: Esc hides the window (the daemon also hides it on
 * blur). It reuses the exact same chat panel the console and Obsidian mount, so
 * there's one chat implementation, three surfaces.
 */
import { onCleanup, onMount, type JSX } from "solid-js"
import { listPanels } from "../panels/registry"
import "../panels/panels/chat"

export default function App(): JSX.Element {
  const chat = listPanels().find((p) => p.id === "chat")

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.winhost?.hide?.()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return <div class="spotlight">{chat ? chat.render() : <div class="empty">chat 面板未注册</div>}</div>
}
