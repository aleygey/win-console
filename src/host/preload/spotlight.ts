/**
 * Spotlight preload — minimal bridge, tagged mode:"spotlight". The renderer (a
 * Raycast-style quick-ask) needs three things from the window it can't do itself:
 *   - hide()            dismiss (Esc / send-then-stay is the renderer's call)
 *   - resize(height)    grow the frameless window when the answer expands
 *   - onShown(cb)       refocus the input each time the hotkey re-shows it
 * The window also hides itself on blur (see shell/windows.ts).
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
  hide: () => ipcRenderer.send("spotlight:hide"),
  /** Ask the main process to resize the popup to `height` px (keeps it on-screen). */
  resize: (height: number) => ipcRenderer.send("spotlight:resize", Math.round(height)),
  /** Fires every time the window is shown by the hotkey (for refocus/reset). */
  onShown: (cb: () => void) => ipcRenderer.on("spotlight:shown", () => cb()),
})
