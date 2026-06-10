/**
 * The daemon's single source of truth. Persisted to a JSON file (path injected
 * so this module never imports electron — the smoke test passes a temp path).
 * Seeded from env + defaults, same knobs the original win-console had plus the
 * per-capability config blobs and the disabled-capability set the console edits.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { CapabilityConfig, ConfigSchema, GlobalConfig } from "../contracts"

export function defaultConfig(): GlobalConfig {
  return {
    opencodeUrl: process.env.OPENCODE_URL || "http://127.0.0.1:4096",
    directory: process.env.OPENCODE_DIRECTORY || undefined,
    // Ctrl+Space per the original request. Override via WIN_HOST_HOTKEY.
    hotkey: process.env.WIN_HOST_HOTKEY || "Control+Space",
    serverPort: Number(process.env.WIN_HOST_PORT || 8799),
    disabledCapabilities: [],
    capabilities: {},
  }
}

export interface ConfigStore {
  get(): GlobalConfig
  set(patch: Partial<GlobalConfig>): GlobalConfig
  /** This capability's effective config = schema defaults ← persisted blob. */
  capConfig(id: string, schema?: ConfigSchema): CapabilityConfig
  setCapConfig(id: string, patch: CapabilityConfig): GlobalConfig
  isEnabled(id: string): boolean
}

export function createConfigStore(file: string): ConfigStore {
  let cache: GlobalConfig | undefined

  function load(): GlobalConfig {
    if (cache) return cache
    try {
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as Partial<GlobalConfig>
      cache = { ...defaultConfig(), ...onDisk, capabilities: onDisk.capabilities ?? {} }
    } catch {
      cache = defaultConfig()
    }
    return cache
  }

  function persist(next: GlobalConfig): GlobalConfig {
    cache = next
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next, null, 2), "utf8")
    } catch (e) {
      console.warn("[config] write failed:", e)
    }
    return next
  }

  return {
    get: load,
    set: (patch) => {
      const cur = load()
      // Merge the capabilities map at the id level so editing one cap's config
      // (or toggling another) never clobbers a sibling's blob.
      const capabilities = patch.capabilities ? { ...cur.capabilities, ...patch.capabilities } : cur.capabilities
      return persist({ ...cur, ...patch, capabilities })
    },
    capConfig: (id, schema) => {
      const persisted = load().capabilities[id] ?? {}
      const defaults: CapabilityConfig = {}
      for (const f of schema?.fields ?? []) {
        if (f.default !== undefined) defaults[f.key] = f.default
      }
      return { ...defaults, ...persisted }
    },
    setCapConfig: (id, patch) => {
      const cfg = load()
      const next = {
        ...cfg,
        capabilities: { ...cfg.capabilities, [id]: { ...(cfg.capabilities[id] ?? {}), ...patch } },
      }
      return persist(next)
    },
    isEnabled: (id) => !load().disabledCapabilities.includes(id),
  }
}
