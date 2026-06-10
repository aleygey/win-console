/**
 * WinHostClient over HTTP/SSE — the front-end half of the seam. Every front-end
 * (Obsidian, console, spotlight) talks to the daemon through one of these, built
 * from a base URL. It implements the same conveniences (chat/outlook/notify/
 * clipboard) the old preload exposed, so the carried-over panels are a drop-in,
 * plus generic call/read/events any future capability uses with no client edit.
 */
import type {
  CapabilityInfo,
  ChatMsg,
  ChatSendRes,
  ChatSession,
  GlobalConfig,
  HostEvent,
  ModelInfo,
  NotifyRes,
  OutlookSearchRes,
  WinHostClient,
} from "../contracts"

export function createWinHostClient(baseUrl: string, platform = "web"): WinHostClient {
  const base = baseUrl.replace(/\/+$/, "")

  async function jget<T>(path: string): Promise<T> {
    const r = await fetch(base + path)
    return (await r.json()) as T
  }
  async function jpost<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
    return (await r.json()) as T
  }

  return {
    baseUrl: base,
    platform,

    health: () => jget("/health"),
    capabilities: async () => (await jget<{ capabilities: CapabilityInfo[] }>("/capabilities")).capabilities,
    getConfig: () => jget<GlobalConfig>("/config"),
    setConfig: (patch) => jpost<GlobalConfig>("/config", patch),

    call: <T,>(capId: string, path: string, body?: unknown) => jpost<T>(`/cap/${capId}${path}`, body),
    read: <T,>(capId: string, path: string) => jget<T>(`/cap/${capId}${path}`),

    events: (onEvent: (e: HostEvent) => void) => subscribeSSE(base, onEvent),

    chat: {
      send: (req) => jpost<ChatSendRes>("/cap/chat/send", req),
      reset: (sessionId) => jpost<{ ok: boolean }>("/cap/chat/reset", { sessionId }),
      sessions: async () => (await jget<{ sessions: ChatSession[] }>("/cap/chat/sessions")).sessions ?? [],
      history: async (id) => (await jget<{ messages: ChatMsg[] }>(`/cap/chat/history?id=${encodeURIComponent(id)}`)).messages ?? [],
      models: async (dir) =>
        (await jget<{ models: ModelInfo[] }>("/cap/chat/models" + (dir ? `?dir=${encodeURIComponent(dir)}` : ""))).models ?? [],
      undo: (id) => jpost<{ ok: boolean; error?: string }>("/cap/chat/undo", { sessionId: id }),
      deleteSession: (id) => jpost<{ ok: boolean; error?: string }>("/cap/chat/delete", { sessionId: id }),
    },
    outlook: { search: (req) => jpost<OutlookSearchRes>("/cap/outlook/search", req) },
    notify: { test: (req) => jpost<NotifyRes>("/cap/notify/test", req) },
    clipboard: {
      image: async () => (await jget<{ dataUrl: string | null }>("/cap/clipboard/image")).dataUrl,
    },
  }
}

/** SSE subscription. Returns an unsubscribe fn. Uses the browser EventSource,
 *  available in every front-end (renderers + Obsidian's electron renderer). */
function subscribeSSE(base: string, onEvent: (e: HostEvent) => void): () => void {
  let es: EventSource | undefined
  try {
    es = new EventSource(base + "/events")
    es.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data) as HostEvent)
      } catch {
        /* ignore malformed frame */
      }
    }
  } catch {
    /* EventSource unavailable — caller just gets no events */
  }
  return () => es?.close()
}
