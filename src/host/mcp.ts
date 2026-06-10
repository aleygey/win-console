/**
 * Minimal MCP server over Streamable HTTP — dependency-free, carried over from
 * the original win-console mcp.ts. The only change: the tool list is no longer a
 * hard-coded array but pulled live from the registry, so adding a capability
 * with `tools` makes the agent discover them with zero edits here.
 *
 * Implements the request/response subset of the Streamable HTTP transport: a
 * POST /mcp carries one JSON-RPC message (or a batch); we answer application/json.
 */
import { randomUUID } from "node:crypto"
import type { McpToolDef } from "../contracts"

const SERVER_INFO = { name: "win-host", version: "0.1.0" }
const FALLBACK_PROTOCOL = "2025-06-18"

type JsonRpcId = string | number | null
export type JsonRpcMessage = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: any }
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } }

/** Dispatch one JSON-RPC message against a live tool set. Returns the response,
 *  or null for a notification (no reply expected). */
export async function mcpDispatch(msg: JsonRpcMessage, tools: McpToolDef[]): Promise<JsonRpcResponse | null> {
  const id = (msg?.id ?? null) as JsonRpcId
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result })
  const err = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } })

  switch (msg?.method) {
    case "initialize": {
      const clientProto = msg.params?.protocolVersion
      return ok({
        protocolVersion: typeof clientProto === "string" ? clientProto : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null
    case "ping":
      return ok({})
    case "tools/list":
      return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name)
      if (!tool) return err(-32602, `unknown tool: ${msg.params?.name}`)
      try {
        const out = await tool.handler(msg.params?.arguments ?? {}, undefined as never)
        return ok({ content: [{ type: "text", text: out.text }], isError: out.isError ?? false })
      } catch (e) {
        return ok({
          content: [{ type: "text", text: `工具执行失败:${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        })
      }
    }
    default:
      if (typeof msg?.id === "undefined") return null
      return err(-32601, `method not found: ${msg?.method}`)
  }
}

export function newSessionId(): string {
  return randomUUID()
}
