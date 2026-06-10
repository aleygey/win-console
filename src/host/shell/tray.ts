/**
 * Minimal tray — the daemon's only persistent surface. Per the chosen design it
 * exists just to signal "I'm alive", open the management console, fire the
 * quick-chat, and quit. No main window.
 */
import { app, Menu, nativeImage, Tray } from "electron"
import { trayPng } from "../native/icon"

export interface TrayActions {
  hotkey: string
  openConsole: () => void
  quickChat: () => void
}

export function createTray(actions: TrayActions): Tray {
  const tray = new Tray(nativeImage.createFromBuffer(trayPng()))
  tray.setToolTip("opencode · Win Host(后台常驻)")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开控制台(管理)", click: actions.openConsole },
      { label: `快速对话  (${actions.hotkey})`, click: actions.quickChat },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          ;(globalThis as { __quitting?: boolean }).__quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on("click", actions.openConsole)
  return tray
}
