/**
 * Single access point to the daemon (replaces win-console's IPC preload bridge).
 * Panels import `api` and call `api.chat.send(...)` exactly as before — the only
 * change is that under the hood it's HTTP/SSE to the win-host daemon instead of
 * ipcRenderer.
 *
 * The base URL is resolved once, but a host (notably the Obsidian plugin, whose
 * URL is a user setting) can re-point it via `configureHost(url)` before the
 * panels mount. `api` delegates to the *current* client, so reconfiguring is
 * transparent to every panel.
 */
import type { HostEvent, WinHostClient } from "../contracts"
import { createWinHostClient } from "./host-client"

function resolveUrl(): string {
  if (typeof window !== "undefined" && window.winhost?.url) return window.winhost.url
  // Explicit override for plain-browser use (debugging, or pointing the console
  // at a remote/attached daemon): http://host/?winhost=http://127.0.0.1:8801
  if (typeof window !== "undefined" && window.location?.search) {
    const q = new URLSearchParams(window.location.search).get("winhost")
    if (q && q.trim()) return q.trim()
  }
  const env = (import.meta as any)?.env?.VITE_WINHOST_URL as string | undefined
  if (env && env.trim()) return env.trim()
  return "http://127.0.0.1:8799"
}

function resolvePlatform(): string {
  if (typeof window !== "undefined" && window.winhost?.platform) return window.winhost.platform
  return "web"
}

let client: WinHostClient = createWinHostClient(resolveUrl(), resolvePlatform())

/** Re-point every panel at a different daemon URL (used by the Obsidian host). */
export function configureHost(url: string, platform?: string): void {
  client = createWinHostClient(url, platform ?? client.platform)
}

/** The current client, for code that wants a direct handle (e.g. SSE setup). */
export function host(): WinHostClient {
  return client
}

export const api: WinHostClient = {
  get baseUrl() {
    return client.baseUrl
  },
  get platform() {
    return client.platform
  },
  health: () => client.health(),
  capabilities: () => client.capabilities(),
  getConfig: () => client.getConfig(),
  setConfig: (p) => client.setConfig(p),
  call: <T,>(id: string, p: string, b?: unknown) => client.call<T>(id, p, b),
  read: <T,>(id: string, p: string) => client.read<T>(id, p),
  events: (cb: (e: HostEvent) => void) => client.events(cb),
  chat: {
    send: (r) => client.chat.send(r),
    createSession: (dir) => client.chat.createSession(dir),
    reset: (k) => client.chat.reset(k),
    sessions: () => client.chat.sessions(),
    history: (id) => client.chat.history(id),
    models: (dir) => client.chat.models(dir),
    undo: (id) => client.chat.undo(id),
    deleteSession: (id) => client.chat.deleteSession(id),
  },
  outlook: { search: (r) => client.outlook.search(r) },
  notify: { test: (r) => client.notify.test(r) },
  clipboard: { image: () => client.clipboard.image() },
}

export const isElectron = resolvePlatform() !== "web"
