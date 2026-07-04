/**
 * TUI-grade message rendering for the 会话监控 timeline: tool calls, errors,
 * file chips, and (optionally) thinking blocks.
 *
 * Display rules shaped by real use:
 *   - reasoning is HIDDEN unless the panel's 显示思考 toggle is on — thinking is
 *     noise when you just want to see what a session is doing;
 *   - consecutive tool calls collapse into ONE compact group row ("N 个工具调用")
 *     — agent loops fire dozens of tools and the raw cards drowned the reply.
 */
import { createMemo, For, Match, Show, Switch, type JSX } from "solid-js"
import { Icon } from "../../icons"
import { md } from "../../md"
import type { ChatMsg, ChatPart, ChatToolStatus } from "../../global"

export const TOOL_STATUS: Record<ChatToolStatus, { label: string; icon: string }> = {
  pending: { label: "待运行", icon: "circle" },
  running: { label: "运行中", icon: "activity" },
  completed: { label: "完成", icon: "check" },
  error: { label: "出错", icon: "alert-triangle" },
}

type ToolPart = Extract<ChatPart, { kind: "tool" }>

/** One-line summary of a tool call from whichever common input field exists. */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const i = input as Record<string, unknown>
  const pick = i.filePath ?? i.path ?? i.command ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt ?? i.title
  return typeof pick === "string" ? pick : ""
}
function prettyInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} 字符)` : s
}

function ToolCard(props: { p: ToolPart }): JSX.Element {
  const st = () => TOOL_STATUS[props.p.status]
  const summary = createMemo(() => toolSummary(props.p.input))
  const body = createMemo(() => props.p.error ?? props.p.output ?? "")
  return (
    <details class="tool-card" data-status={props.p.status}>
      <summary>
        <Icon name="terminal" size={12} />
        <span class="tool-name">{props.p.tool}</span>
        <Show when={summary()}>
          <span class="tool-sum">{summary()}</span>
        </Show>
        <span class={`tool-badge ${props.p.status}`} title={`工具状态:${st().label}`}>
          <Icon name={st().icon} size={10} />
          {st().label}
        </span>
      </summary>
      <Show when={props.p.input != null}>
        <pre class="tool-io">{clip(prettyInput(props.p.input), 2000)}</pre>
      </Show>
      <Show when={body()}>
        <pre class={`tool-io ${props.p.error ? "err" : "out"}`}>{clip(body(), 4000)}</pre>
      </Show>
    </details>
  )
}

/** Several consecutive tool calls folded into one quiet row. */
function ToolGroup(props: { tools: ToolPart[] }): JSX.Element {
  const counts = createMemo(() => {
    const c = { running: 0, completed: 0, error: 0 }
    for (const t of props.tools) {
      if (t.status === "running" || t.status === "pending") c.running++
      else if (t.status === "error") c.error++
      else c.completed++
    }
    return c
  })
  return (
    <details class="tools-group" data-active={counts().running > 0}>
      <summary title="点击展开每个工具调用的详情">
        <Icon name="terminal" size={12} />
        <span class="tools-group-label">{props.tools.length} 个工具调用</span>
        <span class="tools-group-counts">
          <Show when={counts().running > 0}>
            <em class="run">{counts().running} 运行中</em>
          </Show>
          <Show when={counts().completed > 0}>
            <em class="ok">{counts().completed} 完成</em>
          </Show>
          <Show when={counts().error > 0}>
            <em class="bad">{counts().error} 出错</em>
          </Show>
        </span>
      </summary>
      <div class="tools-group-body">
        <For each={props.tools}>{(t) => <ToolCard p={t} />}</For>
      </div>
    </details>
  )
}

function ReasoningCard(props: { text: string }): JSX.Element {
  const preview = createMemo(() => props.text.replace(/\s+/g, " ").trim().slice(0, 72))
  return (
    <details class="reason-card">
      <summary>
        <Icon name="lightbulb" size={13} />
        <span class="reason-label">思考</span>
        <span class="reason-preview">{preview()}…</span>
      </summary>
      <div class="reason-body">{props.text}</div>
    </details>
  )
}

/** Pre-group a message's parts for display: fold runs of ≥2 consecutive tool
 *  parts into one ToolGroup item; optionally drop reasoning. */
type RenderItem = { kind: "part"; part: ChatPart } | { kind: "tools"; tools: ToolPart[] }
function groupParts(parts: ChatPart[], showReasoning: boolean): RenderItem[] {
  const out: RenderItem[] = []
  for (const p of parts) {
    if (p.kind === "reasoning" && !showReasoning) continue
    if (p.kind === "tool") {
      const last = out[out.length - 1]
      if (last?.kind === "tools") {
        last.tools.push(p)
        continue
      }
      out.push({ kind: "tools", tools: [p] })
      continue
    }
    out.push({ kind: "part", part: p })
  }
  return out
}

/** One message body — structured parts when present, else joined text. */
export function MsgBody(props: { m: ChatMsg; showReasoning?: boolean }): JSX.Element {
  const text = (t: string) =>
    props.m.role === "assistant" ? (
      // eslint-disable-next-line solid/no-innerhtml
      <div class="markdown" innerHTML={md(t)} />
    ) : (
      <div class="plain">{t}</div>
    )
  const items = createMemo(() => groupParts(props.m.parts ?? [], props.showReasoning ?? false))
  return (
    <Show when={(props.m.parts?.length ?? 0) > 0} fallback={text(props.m.text)}>
      <div class="parts">
        <For each={items()}>
          {(it) => (
            <Switch>
              <Match when={it.kind === "tools" && (it as { tools: ToolPart[] }).tools.length > 1}>
                <ToolGroup tools={(it as { tools: ToolPart[] }).tools} />
              </Match>
              <Match when={it.kind === "tools"}>
                <ToolCard p={(it as { tools: ToolPart[] }).tools[0]} />
              </Match>
              <Match when={(it as { part: ChatPart }).part.kind === "reasoning"}>
                <ReasoningCard text={((it as { part: ChatPart }).part as Extract<ChatPart, { kind: "reasoning" }>).text} />
              </Match>
              <Match when={(it as { part: ChatPart }).part.kind === "error"}>
                <div class="part-error">
                  <Icon name="alert-triangle" size={14} />
                  <span>{((it as { part: ChatPart }).part as Extract<ChatPart, { kind: "error" }>).text}</span>
                </div>
              </Match>
              <Match when={(it as { part: ChatPart }).part.kind === "file"}>
                <span class="part-file">
                  <Icon name="file-text" size={13} />
                  {((it as { part: ChatPart }).part as Extract<ChatPart, { kind: "file" }>).filename ?? "附件"}
                </span>
              </Match>
              <Match when={(it as { part: ChatPart }).part.kind === "text"}>
                {text(((it as { part: ChatPart }).part as Extract<ChatPart, { kind: "text" }>).text)}
              </Match>
            </Switch>
          )}
        </For>
      </div>
    </Show>
  )
}
