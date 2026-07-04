/**
 * Daemon entry — a tray-only Electron app (no main window). It:
 *
 *   1. boots the config store, event bus, native host, capability registry,
 *      and the HTTP/SSE/MCP server (the same core the smoke test exercises),
 *   2. registers the global hotkey (always toggles the spotlight quick-ask popup
 *      — the ONLY input surface; the console's 会话监控 is read-only),
 *   3. puts a minimal tray up (open console / quick chat / quit),
 *   4. re-registers the hotkey live when the console edits it (config:changed).
 *
 * Everything OS-touching is funnelled through createNativeHost; the server,
 * registry, and capabilities never import electron.
 */
import { app, globalShortcut, ipcMain } from "electron"
import { join } from "node:path"
import type { Server } from "node:http"
import { createConfigStore } from "./config"
import { createEventBus } from "./events"
import { createRegistry } from "./registry"
import { startServer } from "./server"
import { builtinCapabilities } from "./capabilities"
import { createNativeHost } from "./native"
import { ensureWindowsToastIdentity, APP_ID } from "./native/notify"
import { createTray } from "./shell/tray"
import { registerHotkey } from "./shell/hotkey"
import { makeConsoleWindow, makeSpotlightWindow, resizeSpotlight, showWindow, toggleSpotlight } from "./shell/windows"

app.setAppUserModelId(APP_ID)
ensureWindowsToastIdentity()

// ── Corporate-Win10 / 工位 robustness ────────────────────────────────────────
// The recurring "exe opens but the window is blank (curl 8799 works)" report is
// almost always one of two environment differences vs a personal laptop:
//   1. GPU: restricted/old drivers, group policy, or RDP/VDI crash the GPU
//      process → Chromium paints nothing. This admin UI doesn't need the GPU, so
//      software rendering is the safe, robust choice.  (Override: WINHOST_GPU=1)
//   2. Proxy: a corporate auto-proxy (PAC) intercepts the renderer's load of
//      127.0.0.1 and blanks the window — while `curl` still works because it
//      ignores the WinINET proxy. Bypass the proxy for loopback/private targets.
// Both must be set before app "ready"; they are no-ops on a healthy machine.
if (process.env.WINHOST_GPU !== "1") app.disableHardwareAcceleration()
app.commandLine.appendSwitch(
  "proxy-bypass-list",
  "<local>;127.0.0.1;localhost;[::1];10.0.0.0/8;172.16.0.0/12;192.168.0.0/16",
)

// Single instance — a second launch just opens the console of the running one.
if (!app.requestSingleInstanceLock()) app.quit()

let server: Server | undefined

app.on("second-instance", () => {
  void openConsole()
})

// Lazily-created windows so the daemon stays window-less until needed.
let consoleWin: Electron.BrowserWindow | undefined
let spotlightWin: Electron.BrowserWindow | undefined

const config = createConfigStore(join(app.getPath("userData"), "config.json"))
const events = createEventBus()
const native = createNativeHost(() => config.get())
const registry = createRegistry(builtinCapabilities, {
  native,
  config,
  events,
  dataDir: app.getPath("userData"),
})

function port(): number {
  return config.get().serverPort
}

async function openConsole(): Promise<void> {
  if (!consoleWin || consoleWin.isDestroyed()) consoleWin = makeConsoleWindow(port())
  showWindow(consoleWin)
}

function spotlight(): Electron.BrowserWindow {
  if (!spotlightWin || spotlightWin.isDestroyed()) spotlightWin = makeSpotlightWindow(port())
  return spotlightWin
}

/** Hotkey: always raise the quick-ask popup. (It used to prefer raising Obsidian
 *  when running, but the user wants the hotkey to only summon the dialog.) */
function onSummon(): void {
  toggleSpotlight(spotlight())
}

app.whenReady().then(async () => {
  await registry.init()
  // Serve the built console at the daemon's origin so the Obsidian plugin can
  // embed it in an iframe (full CSS isolation). out/host/index.js → ../console.
  server = startServer(port(), {
    registry,
    config,
    events,
    consoleDir: join(__dirname, "../console"),
    spotlightDir: join(__dirname, "../spotlight"),
  })

  ipcMain.on("spotlight:hide", () => spotlightWin?.hide())
  ipcMain.on("spotlight:resize", (_e, height: number) => {
    if (spotlightWin && !spotlightWin.isDestroyed()) resizeSpotlight(spotlightWin, height)
  })

  createTray({
    hotkey: config.get().hotkey,
    openConsole: () => void openConsole(),
    quickChat: () => toggleSpotlight(spotlight()),
  })

  if (!registerHotkey(config.get().hotkey, () => void onSummon())) {
    console.warn(`[hotkey] 注册失败: ${config.get().hotkey}(可能被其它程序占用)`)
  }

  // Live-update the hotkey when the console saves a new one.
  events.subscribe((e) => {
    if (e.type !== "config:changed") return
    registerHotkey(config.get().hotkey, () => void onSummon())
  })
})

// Resident app: tray stays even with no windows open.
app.on("window-all-closed", () => {
  /* intentionally do not quit */
})

app.on("will-quit", () => {
  globalShortcut.unregisterAll()
  server?.close()
  void registry.dispose()
})
