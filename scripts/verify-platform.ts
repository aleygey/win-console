/**
 * Headless daemon for verifying the external-plugin platform end to end WITHOUT
 * electron/opencode. Boots the real server + registry + built-in capabilities
 * with a stub NativeHost, and serves the freshly-built console from out/console
 * (so the browser sees the real UI). Stays alive until killed.
 *
 *   npx tsx scripts/verify-platform.ts
 *   node examples/serial-plugin/plugin.mjs        # in another shell
 *   open http://127.0.0.1:8799/
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { NativeHost } from "../src/contracts"
import { createConfigStore } from "../src/host/config"
import { createEventBus } from "../src/host/events"
import { createRegistry } from "../src/host/registry"
import { startServer } from "../src/host/server"
import { builtinCapabilities } from "../src/host/capabilities"

const here = fileURLToPath(new URL(".", import.meta.url))
const consoleDir = join(here, "..", "out", "console")
const spotlightDir = join(here, "..", "out", "spotlight")
const PORT = Number(process.argv[2] || process.env.VERIFY_PORT || 8799)

const native: NativeHost = {
  platform: process.platform,
  showToast: async (r) => {
    console.log(`   [notify] ${r.level ?? "info"} · ${r.title} — ${r.message}`)
    return { ok: true }
  },
  outlookSearch: async () => ({ ok: true, mock: true, mails: [] }),
  outlookList: async () => ({ ok: true, mock: true, mails: [] }),
  outlookReply: async () => ({ ok: true, mock: true, sent: false }),
  outlookFolders: async () => ({ ok: true, mock: true, folders: ["收件箱"] }),
  outlookAttachments: async () => ({ ok: true, files: [] }),
  outlookRead: async () => ({ ok: true, mock: true }),
  outlookSaveAttachments: async () => ({ ok: true, files: [] }),
  clipboardImage: async () => null,
  chat: {
    send: async (req) => ({ ok: true, reply: `echo: ${req.text}`, sessionId: "verify" }),
    createSession: async () => ({ ok: true, sessionId: "verify" }),
    monitor: async () => [],
    replyAsk: async () => ({ ok: true }),
    reset: () => {},
    sessions: async () => [],
    history: async () => [],
    models: async () => [],
    undo: async () => ({ ok: true }),
    deleteSession: async () => ({ ok: true }),
    rename: async () => ({ ok: true }),
  },
}

async function main(): Promise<void> {
  const config = createConfigStore(join(tmpdir(), `winhost-verify-${process.pid}.json`))
  const events = createEventBus()
  const registry = createRegistry(builtinCapabilities, {
    native,
    config,
    events,
    dataDir: join(tmpdir(), `winhost-verify-data-${process.pid}`),
  })
  await registry.init()
  startServer(PORT, { registry, config, events, consoleDir, spotlightDir })
  console.log(`[verify] daemon on http://127.0.0.1:${PORT}  (console + spotlight served)`)
}

void main()
