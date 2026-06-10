/**
 * Headless stand-in for the real Electron daemon, for previewing the console and
 * the Obsidian iframe without a display. Runs the REAL win-host server on 8799
 * with a non-electron native host, and serves the built console from the same
 * origin via the server's own static serving (consoleDir) — exactly how the real
 * daemon serves it for the Obsidian iframe.
 *
 *   outlook  -> mock fixtures (no Outlook COM)
 *   notify   -> logged
 *   chat     -> REAL opencode SDK at 127.0.0.1:4096
 *   exp      -> console hits the REAL playbook backend at localhost:53550
 *
 * Bundled by esbuild to D:\wsl-tmp\preview-server.mjs (ASCII path, no tsx/cwd dep).
 */
import { homedir } from "node:os"
import { join } from "node:path"
import type { NativeHost } from "../src/contracts"
import { createConfigStore } from "../src/host/config"
import { createEventBus } from "../src/host/events"
import { createRegistry } from "../src/host/registry"
import { startServer } from "../src/host/server"
import { builtinCapabilities } from "../src/host/capabilities"
import { createChat } from "../src/host/chat"
import { outlookSearch, outlookList, outlookReply, outlookFolders } from "../src/host/native/outlook"
import { showToastPowerShell } from "../src/host/native/notify-ps"

const API_PORT = 8799
const CONSOLE_DIR = "D:\\wsl-tmp\\console"
// Stable, persistent data dir (was tmpdir()/…-<pid>.json, which threw away the
// config — and now the mail-workflow rules + queue — on every restart).
const DATA_DIR = join(homedir(), ".super-work-host")

async function main(): Promise<void> {
  const config = createConfigStore(join(DATA_DIR, "config.json"))
  // Seed connection defaults only if not already persisted (don't clobber the
  // user's saved capability config / rules on restart).
  const cur = config.get()
  config.set({
    opencodeUrl: cur.opencodeUrl || "http://127.0.0.1:4096",
    capabilities: {
      ...cur.capabilities,
      exp: { playbookUrl: "http://localhost:53550", ...(cur.capabilities?.exp ?? {}) },
    },
  })

  const events = createEventBus()
  const chat = createChat(() => config.get())
  const native: NativeHost = {
    platform: process.platform,
    // REAL toast (PowerShell WinRT) + REAL Outlook (PowerShell COM) — neither
    // needs electron, so the lite daemon is fully functional on the Windows host.
    showToast: (r) => showToastPowerShell(r),
    outlookSearch: (r) => outlookSearch(r),
    outlookList: (r) => outlookList(r),
    outlookReply: (r) => outlookReply(r),
    outlookFolders: () => outlookFolders(),
    clipboardImage: async () => null,
    chat,
  }

  const registry = createRegistry(builtinCapabilities, { native, config, events, dataDir: DATA_DIR })
  await registry.init()
  startServer(API_PORT, { registry, config, events, consoleDir: CONSOLE_DIR })
  console.log(`[preview] daemon stand-in on http://localhost:${API_PORT}  (console at /, data ${DATA_DIR})`)
}

void main()
