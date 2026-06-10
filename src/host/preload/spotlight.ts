/**
 * Spotlight preload — same minimal bridge as the console, tagged mode:"spotlight"
 * so the renderer can render just the chat panel with launcher chrome (Esc to
 * hide). The window hides itself on blur (see shell/windows.ts).
 */
import { contextBridge, ipcRenderer } from "electron"

function selfUrl(): string {
  const arg = process.argv.find((a) => a.startsWith("--winhost-url="))
  return arg ? arg.slice("--winhost-url=".length) : "http://127.0.0.1:8799"
}

contextBridge.exposeInMainWorld("winhost", {
  url: selfUrl(),
  platform: process.platform,
  mode: "spotlight",
  /** Let the popup dismiss itself (Esc) without owning window state. */
  hide: () => ipcRenderer.send("spotlight:hide"),
})
