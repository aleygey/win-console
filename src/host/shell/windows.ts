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
import { BrowserWindow, screen } from "electron"
import { join } from "node:path"
import { attachWindowDiagnostics } from "./diagnostics"

const selfArg = (port: number) => [`--winhost-url=http://127.0.0.1:${port}`]

/** Spotlight popup geometry. The window is OPAQUE + frameless and resizes to hug
 *  the card's content (transparent windows need the GPU, which we disable for the
 *  no-GPU 工位 fix — so an opaque window that grows is what works everywhere). */
export const SPOTLIGHT_WIDTH = 660
export const SPOTLIGHT_COLLAPSED_H = 58

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
    width: SPOTLIGHT_WIDTH,
    height: SPOTLIGHT_COLLAPSED_H,
    show: false,
    frame: false,
    hasShadow: true, // OS drop shadow (the window is opaque now)
    roundedCorners: true, // Win11 rounds the frameless window; no-op on Win10
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#f6f6f5",
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
  // NOTE: deliberately NO blur→hide. Opening the file picker / taking a screenshot
  // (Win+Shift+S) blurs the window, which used to dismiss the popup mid-task. The
  // user dismisses explicitly: Esc, the ✕ button, or re-pressing the hotkey.
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
    positionSpotlightCentered(win)
    win.show()
    win.focus()
    win.webContents.send("spotlight:shown")
  }
}

/** Center the popup horizontally, upper-third vertically (Spotlight-style), on
 *  the display the cursor is on — a fixed, predictable spot (the user can drag it
 *  from there). Leaves room below for the answer to grow into. */
export function positionSpotlightCentered(win: BrowserWindow): void {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const [w] = win.getSize()
  const x = Math.round(wa.x + (wa.width - w) / 2)
  const y = Math.round(wa.y + wa.height * 0.22)
  win.setPosition(x, y)
}

/** Grow/shrink the popup as the answer expands, keeping the bar anchored where it
 *  is (grows downward; nudges up if it would clip the work-area bottom). */
export function resizeSpotlight(win: BrowserWindow, height: number): void {
  if (win.isDestroyed()) return
  const b = win.getBounds()
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
  const h = Math.max(SPOTLIGHT_COLLAPSED_H, Math.round(height))
  let y = b.y
  if (y + h > wa.y + wa.height) y = Math.max(wa.y, wa.y + wa.height - h)
  win.setBounds({ x: b.x, y, width: SPOTLIGHT_WIDTH, height: h })
}

export function showWindow(win: BrowserWindow): void {
  win.show()
  win.focus()
}

function isQuitting(): boolean {
  return (globalThis as { __quitting?: boolean }).__quitting === true
}
