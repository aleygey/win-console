/**
 * The daemon's two on-demand windows. By default neither is open — the app
 * lives in the tray. The console is the management UI (opened from the tray
 * menu); the spotlight is the frameless quick-chat popup the hotkey shows when
 * Obsidian isn't running.
 *
 * Both renderers are plain web bundles (out/console, out/spotlight) that talk to
 * the daemon over HTTP; the preload only injects the daemon's self URL via
 * additionalArguments, nothing else (contextIsolation on, nodeIntegration off).
 */
import { BrowserWindow } from "electron"
import { join } from "node:path"
import { attachWindowDiagnostics } from "./diagnostics"

const selfArg = (port: number) => [`--winhost-url=http://127.0.0.1:${port}`]

export function makeConsoleWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 460,
    show: false,
    title: "opencode · Win Host 控制台",
    backgroundColor: "#1a1b1e",
    webPreferences: {
      preload: join(__dirname, "preload/console.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: selfArg(port),
    },
  })
  attachWindowDiagnostics(win, "console")
  // Load over HTTP from the daemon (NOT loadFile/file://): the bundles are ES
  // modules (`<script type="module">`), which the file:// scheme blocks on
  // null-origin CORS → blank window. The daemon already serves the console at /.
  void win.loadURL(`http://127.0.0.1:${port}/`)
  win.on("close", (e) => {
    if (!isQuitting()) {
      e.preventDefault()
      win.hide()
    }
  })
  return win
}

export function makeSpotlightWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 680,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#1a1b1e",
    title: "opencode · 快速对话",
    webPreferences: {
      preload: join(__dirname, "preload/spotlight.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: selfArg(port),
    },
  })
  attachWindowDiagnostics(win, "spotlight")
  // HTTP (not file://) for the same ES-module reason; daemon serves it at /spotlight/.
  void win.loadURL(`http://127.0.0.1:${port}/spotlight/`)
  win.center()
  // Spotlight UX: vanish when it loses focus, like a launcher.
  win.on("blur", () => win.hide())
  win.on("close", (e) => {
    if (!isQuitting()) {
      e.preventDefault()
      win.hide()
    }
  })
  return win
}

export function toggleSpotlight(win: BrowserWindow): void {
  if (win.isVisible()) {
    win.hide()
  } else {
    win.center()
    win.show()
    win.focus()
  }
}

export function showWindow(win: BrowserWindow): void {
  win.show()
  win.focus()
}

function isQuitting(): boolean {
  return (globalThis as { __quitting?: boolean }).__quitting === true
}
