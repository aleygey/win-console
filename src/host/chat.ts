/**
 * opencode chat backend (the brain behind the chat panel), held host-side via
 * the official SDK. Implements the full ChatBackend: prompt with per-message
 * model override, list real opencode sessions, load a session's history, list
 * available models (provider.list), revert (undo), and delete sessions.
 *
 * Sessions ARE opencode session ids (no separate keying) — the panel creates one
 * on first send and continues it by id, and the sidebar mirrors session.list.
 *
 * SDK is 1.3.13 against serve 1.16.2; a few endpoints drifted, so SDK calls are
 * loosely typed (as any) and defensively read — runtime shape is what matters.
 */
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { ChatBackend, ChatMsg, ChatSendReq, ChatSendRes, ChatSession, GlobalConfig, ModelInfo } from "../contracts"

type Client = ReturnType<typeof createOpencodeClient>

export function createChat(getConfig: () => GlobalConfig): ChatBackend {
  let client: Client | undefined
  let clientUrl: string | undefined

  function c(): any {
    const url = getConfig().opencodeUrl
    if (!client || clientUrl !== url) {
      client = createOpencodeClient({ baseUrl: url })
      clientUrl = url
    }
    return client
  }
  // A Windows path (D:\foo\bar) is mapped to the WSL mount (/mnt/d/foo/bar) so
  // the opencode agent running in WSL can actually read/write it. Posix paths
  // pass through unchanged. (Assumes the opencode side is WSL; for a VM, mount
  // the share at a matching path.)
  const dir = (override?: string) => {
    const d = (override && override.trim()) || getConfig().directory
    return d ? { directory: winToLinux(d, getConfig().pathMaps) } : undefined
  }

  async function send(req: ChatSendReq): Promise<ChatSendRes> {
    const url = getConfig().opencodeUrl
    try {
      const client = c()
      const q = dir(req.directory)
      let sessionId = req.sessionId
      if (!sessionId) {
        const created = await client.session.create({ body: {}, query: q })
        if (created.error || !created.data) return { ok: false, error: describe(created.error) ?? "创建 session 失败(opencode serve 在跑吗?)" }
        sessionId = created.data.id as string
      }
      const parts: Array<Record<string, unknown>> = []
      if (req.text) parts.push({ type: "text", text: req.text })
      if (req.imageDataUrl) parts.push({ type: "file", mime: mimeOf(req.imageDataUrl), filename: "clipboard.png", url: req.imageDataUrl })
      if (parts.length === 0) return { ok: false, error: "空消息" }

      const body: Record<string, unknown> = { parts }
      if (req.model) body.model = { providerID: req.model.providerID, modelID: req.model.modelID }

      const res = await client.session.prompt({ path: { id: sessionId }, body, query: q })
      if (res.error || !res.data) return { ok: false, error: describe(res.error) ?? "prompt 失败" }
      return { ok: true, reply: textOf(res.data.parts) || "(模型没有返回文本)", sessionId }
    } catch (e) {
      return { ok: false, error: connectHint(e, url) }
    }
  }

  async function sessions(): Promise<ChatSession[]> {
    try {
      const res = await c().session.list({ query: dir() })
      const list = (res.data ?? []) as any[]
      return list
        .map((s) => ({
          id: s.id as string,
          title: (s.title as string) || "(未命名会话)",
          createdAt: numAt(s.time?.created ?? s.created),
          updatedAt: numAt(s.time?.updated ?? s.updated ?? s.time?.created),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  async function history(sessionId: string): Promise<ChatMsg[]> {
    try {
      const res = await c().session.messages({ path: { id: sessionId }, query: dir() })
      const list = (res.data ?? []) as any[]
      return list
        .map((m) => ({
          role: (m.info?.role ?? "assistant") as ChatMsg["role"],
          text: textOf(m.parts),
          at: numAt(m.info?.time?.created),
        }))
        .filter((m) => m.text)
    } catch {
      return []
    }
  }

  async function models(directory?: string): Promise<ModelInfo[]> {
    try {
      const res = await c().provider.list({ query: dir(directory) })
      const data = (res?.data ?? res) as any
      const all = (data?.all ?? []) as any[]
      const connected: string[] = data?.connected ?? []
      const out: ModelInfo[] = []
      for (const p of all) {
        const conn = connected.includes(p.id)
        for (const mid of Object.keys(p.models ?? {})) {
          const m = p.models[mid]
          out.push({
            providerID: p.id,
            modelID: (m?.id as string) ?? mid,
            label: `${p.name ?? p.id} / ${m?.name ?? mid}`,
            connected: conn,
          })
        }
      }
      return out.sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label))
    } catch {
      return []
    }
  }

  async function undo(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const msgs = await c().session.messages({ path: { id: sessionId }, query: dir() })
      const list = (msgs.data ?? []) as any[]
      const messageID = list[list.length - 1]?.info?.id
      if (!messageID) return { ok: false, error: "没有可撤销的消息" }
      const res = await c().session.revert({ path: { id: sessionId }, body: { messageID }, query: dir() })
      if (res?.error) return { ok: false, error: describe(res.error) }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  async function deleteSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const del = c().session.delete
      if (typeof del !== "function") return { ok: false, error: "当前 SDK 不支持删除会话" }
      const res = await del({ path: { id: sessionId }, query: dir() })
      if (res?.error) return { ok: false, error: describe(res.error) }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  return { send, reset: () => {}, sessions, history, models, undo, deleteSession }
}

function textOf(parts: unknown): string {
  return ((parts ?? []) as Array<{ type?: string; text?: string }>)
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim()
}
function numAt(v: unknown): number {
  return typeof v === "number" ? v : 0
}
function mimeOf(dataUrl: string): string {
  return /^data:([^;]+);/.exec(dataUrl)?.[1] ?? "image/png"
}
/** Map a Windows path to the Linux side opencode runs on. Configured prefix maps
 *  win first (for VirtualBox shares), else the WSL convention (D:\ → /mnt/d/),
 *  else pass posix paths through unchanged. */
function winToLinux(p: string, maps?: Array<{ from: string; to: string }>): string {
  const s = p.trim()
  if (!s) return s
  for (const m of maps ?? []) {
    if (m.from && s.toLowerCase().startsWith(m.from.toLowerCase())) {
      return (m.to + s.slice(m.from.length)).replace(/\\/g, "/")
    }
  }
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(s)
  return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}` : s
}
function describe(err: unknown): string | undefined {
  if (!err) return undefined
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
function connectHint(e: unknown, url: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  return `连不上 opencode(${url}):${msg}。确认 opencode serve 在跑。`
}
