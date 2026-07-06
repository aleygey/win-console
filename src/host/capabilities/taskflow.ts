/**
 * taskflow capability — 文档驱动的项目/任务 agent 编排（Obsidian vault 上）。
 *
 * 唯一驱动信号是任务文档 frontmatter 的 `status` 字段（受限平铺 YAML，本文件
 * 自带 60 行解析器，零新依赖）。轮询扫描 <vaultDir>/<项目>/tasks/*.md，检测
 * status 迁移并派发：
 *
 *   inbox      → 起澄清 session（autoClarify 时）：agent 补全目标/验收或把问题
 *                写进「待澄清」区（经 task_* 工具）。
 *   ready      → 面板/路由「启动」（或 autoStart）：createSession(项目目录) +
 *                执行指令模板，sessionId 写回 frontmatter.sessions。
 *   doing(人改) → 同上（人直接在 Obsidian 把 status 改成 doing 也能启动）。
 *   done       → 向任务 session 发 PHA 同步指令，agent 推送后置 synced。
 *
 * 人机分界（硬约束）：`done` 只能人置（task_update_status 白名单不含 done）；
 * frontmatter + 「执行日志」区 = 机器写，目标/验收/人工备注 = 人写。taskflow
 * 每次写盘后把新 mtime 记入 lastSeen，自己的写入不会再次触发状态机。
 *
 * 参照 mailflow 的成熟模式：self-rescheduling setTimeout 轮询（读 live 配置）、
 * 状态持久化到 ctx.dataDir/taskflow-state.json、routes 服务面板、tools 暴露给
 * agent（win-host MCP）。
 */
import type { Capability, HostContext, McpToolDef, ModelRef, RouteDef } from "../../contracts"
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname, basename } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter — restricted flat YAML (scalars + string lists), round-trip safe
// for the keys we own. Unknown keys are preserved verbatim as strings/lists.
// ─────────────────────────────────────────────────────────────────────────────

export type Frontmatter = Record<string, string | string[]>

function unquote(s: string): string {
  const m = /^(['"])(.*)\1$/.exec(s)
  return m ? m[2] : s
}

function quoteIfNeeded(s: string): string {
  if (s === "") return '""'
  return /[:#\[\]{}'"|>&*!%@`]|^\s|\s$/.test(s) ? JSON.stringify(s) : s
}

export function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } | null {
  const lines = raw.split(/\r?\n/)
  if ((lines[0] ?? "").trim() !== "---") return null
  let i = 1
  const fmLines: string[] = []
  while (i < lines.length && lines[i].trim() !== "---") {
    fmLines.push(lines[i])
    i++
  }
  if (i >= lines.length) return null // unterminated header (mid-save) — caller skips
  const body = lines.slice(i + 1).join("\n")

  const fm: Frontmatter = {}
  let listKey: string | null = null
  for (const ln of fmLines) {
    const li = /^\s+-\s*(.*)$/.exec(ln)
    if (li && listKey) {
      const cur = fm[listKey]
      const arr = Array.isArray(cur) ? cur : []
      const v = unquote(li[1].trim())
      if (v) arr.push(v)
      fm[listKey] = arr
      continue
    }
    const kv = /^([A-Za-z0-9_\-]+):\s*(.*)$/.exec(ln)
    if (!kv) {
      listKey = null
      continue
    }
    const key = kv[1]
    const val = kv[2].trim()
    if (val === "") {
      // either an empty scalar or the head of a block list — resolved by the
      // following "- item" lines (if none arrive it stays "")
      fm[key] = ""
      listKey = key
      continue
    }
    if (val.startsWith("[")) {
      fm[key] = val
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean)
      listKey = null
      continue
    }
    fm[key] = unquote(val)
    listKey = null
  }
  // "" placeholders that accumulated list items were converted in the li branch;
  // ones that didn't stay as empty strings, which is what Obsidian means by them.
  return { fm, body }
}

export function serializeFrontmatter(fm: Frontmatter, body: string): string {
  const lines: string[] = ["---"]
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`)
      else {
        lines.push(`${k}:`)
        for (const it of v) lines.push(`  - ${quoteIfNeeded(it)}`)
      }
    } else {
      lines.push(`${k}: ${quoteIfNeeded(String(v))}`)
    }
  }
  lines.push("---")
  return lines.join("\n") + "\n" + body
}

/** Append one entry under the「## 执行日志」section (created at EOF if absent). */
export function appendLogSection(body: string, entry: string): string {
  const marker = "## 执行日志"
  const idx = body.indexOf(marker)
  if (idx < 0) {
    return body.replace(/\s*$/, "") + `\n\n${marker}\n\n${entry}\n`
  }
  // insert before the next same-level heading after the section, else at EOF
  const after = body.slice(idx + marker.length)
  const next = after.search(/^## /m)
  if (next < 0) return body.replace(/\s*$/, "") + `\n\n${entry}\n`
  const cut = idx + marker.length + next
  const head = body.slice(0, cut).replace(/\s*$/, "")
  return `${head}\n\n${entry}\n\n${body.slice(cut)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Task model
// ─────────────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "inbox"
  | "clarifying"
  | "ready"
  | "doing"
  | "review"
  | "done"
  | "synced"
  | "blocked"

const ALL_STATUS: TaskStatus[] = ["inbox", "clarifying", "ready", "doing", "review", "done", "synced", "blocked"]
/** Statuses the AGENT may set. `done` is the human-only gate; `inbox` is birth-only. */
const AGENT_STATUS: TaskStatus[] = ["clarifying", "ready", "doing", "review", "blocked", "synced"]

export const STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: "新建",
  clarifying: "澄清中",
  ready: "就绪",
  doing: "进行中",
  review: "待验收",
  done: "已完成",
  synced: "已同步",
  blocked: "阻塞",
}
const STATUS_EMOJI: Record<TaskStatus, string> = {
  inbox: "📥",
  clarifying: "❓",
  ready: "🟡",
  doing: "🔵",
  review: "🟣",
  done: "✅",
  synced: "📤",
  blocked: "⛔",
}
/** Kanban row order — actionable first. */
const STATUS_ORDER: TaskStatus[] = ["doing", "review", "ready", "clarifying", "inbox", "blocked", "done", "synced"]

export type TaskMeta = {
  id: string
  title: string
  project: string
  type: string
  status: TaskStatus
  priority: string
  sessions: string[]
  pha_issue: string
  /** absolute Windows path of the task md */
  path: string
  mtimeMs: number
  updated: string
}

function normStatus(v: unknown): TaskStatus {
  const s = String(v ?? "").trim() as TaskStatus
  return (ALL_STATUS as string[]).includes(s) ? s : "inbox"
}

function taskMetaOf(path: string, project: string, fm: Frontmatter, mtimeMs: number): TaskMeta {
  const base = basename(path).replace(/\.md$/i, "")
  return {
    id: String(fm.id || base),
    title: String(fm.title || base),
    project,
    type: String(fm.type || "未分类"),
    status: normStatus(fm.status),
    priority: String(fm.priority || ""),
    sessions: Array.isArray(fm.sessions) ? fm.sessions : [],
    pha_issue: String(fm.pha_issue || ""),
    path,
    mtimeMs,
    updated: String(fm.updated || ""),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kanban aggregation — rewrite ONLY between the taskflow markers.
// ─────────────────────────────────────────────────────────────────────────────

const KB_BEGIN = "<!-- taskflow:begin 此区块由 taskflow 自动生成,请勿手动编辑 -->"
const KB_END = "<!-- taskflow:end -->"

function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

export function buildKanbanSection(tasks: TaskMeta[]): string {
  const rank = (t: TaskMeta) => STATUS_ORDER.indexOf(t.status)
  const byType = new Map<string, TaskMeta[]>()
  for (const t of tasks) {
    const arr = byType.get(t.type) ?? []
    arr.push(t)
    byType.set(t.type, arr)
  }
  const lines: string[] = [KB_BEGIN, ""]
  const active = tasks.filter((t) => !["done", "synced"].includes(t.status)).length
  lines.push(`> 任务 ${tasks.length} 项 · 进行中/待处理 ${active} 项 · 更新于 ${new Date().toLocaleString()}`)
  lines.push("")
  for (const [type, list] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => rank(a) - rank(b) || a.priority.localeCompare(b.priority))
    lines.push(`### ${type} (${list.length})`)
    lines.push("")
    lines.push("| 状态 | 任务 | P | session | PHA | 更新 |")
    lines.push("| --- | --- | --- | --- | --- | --- |")
    for (const t of list) {
      const file = basename(t.path).replace(/\.md$/i, "")
      const pha = t.pha_issue ? (/^https?:/.test(t.pha_issue) ? `[链接](${t.pha_issue})` : mdCell(t.pha_issue)) : "—"
      lines.push(
        `| ${STATUS_EMOJI[t.status]} ${STATUS_LABEL[t.status]} | [[${mdCell(file)}]] | ${mdCell(t.priority) || "—"} | ${
          t.sessions.length || "—"
        } | ${pha} | ${mdCell(t.updated) || "—"} |`,
      )
    }
    lines.push("")
  }
  lines.push(KB_END)
  return lines.join("\n")
}

export function applyKanban(existing: string | undefined, section: string, projectName: string): string {
  if (!existing || !existing.trim()) {
    return [
      `# ${projectName} · 项目看板`,
      "",
      "## 项目说明",
      "",
      "（人工区：项目描述、里程碑、硬性约束——taskflow 不会改动这里）",
      "",
      "## 任务总表",
      "",
      section,
      "",
    ].join("\n")
  }
  const b = existing.indexOf(KB_BEGIN)
  const e = existing.indexOf(KB_END)
  if (b >= 0 && e > b) {
    return existing.slice(0, b) + section + existing.slice(e + KB_END.length)
  }
  return existing.replace(/\s*$/, "") + "\n\n## 任务总表\n\n" + section + "\n"
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts — the contract injected as the FIRST USER MESSAGE of each session
// (this codebase's convention; sessions have no system-prompt injection).
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_CONTRACT = [
  "你可以使用 win-host 提供的任务工具（MCP）读写任务文档：",
  "- task_get(id) — 读任务文档全文",
  "- task_update_status(id, status, note?) — 更新状态（可用: clarifying/ready/doing/review/blocked/synced；done 只能人工设置）",
  "- task_append_log(id, content) — 向「执行日志」区追加一条记录（带时间戳）",
  "- task_set_field(id, key, value) — 更新 priority/type/pha_issue 字段",
  "若以上 task_* 工具在你的工具列表里不存在（win-host MCP 未接通），改用文件编辑达成同样效果：",
  "直接修改任务文档——改 frontmatter 的 status/priority/type/pha_issue 字段、向「## 执行日志」小节追加条目。",
  "文件本身就是接口，taskflow 会通过扫描感知你的修改；status 取值与上述白名单一致，同样不得设为 done。",
  "文档分区规则：frontmatter 和「执行日志」由你维护；「目标/验收标准/人工备注」属于用户，禁止改写；「待澄清」区你写问题（Q:），用户写答案（A:）。",
].join("\n")

function clarifyPrompt(t: TaskMeta, doc: string, kanbanHuman: string): string {
  return [
    `【taskflow 澄清任务】任务 ${t.id}（项目 ${t.project}）刚被创建，请帮用户把它结构化。`,
    "",
    TOOL_CONTRACT,
    "",
    "你的工作：",
    "1. 阅读下面的任务文档与项目背景，判断信息是否足以开工。",
    "2. 信息足够 → 直接完善文档：补全「目标」「验收标准」（可编辑文件本身），用 task_set_field 修正 type/priority，然后 task_update_status(id, \"ready\")。",
    "3. 信息不足 → 把关键问题写进文档的「## 待澄清」区（每行 `- Q: …` 空一行 `A:` 待用户填写，直接编辑文件），然后 task_update_status(id, \"clarifying\")，并用 notify_desktop 提醒用户回答。",
    "4. 用户答完后会把 status 改回 inbox 触发你再次整理（届时把 Q/A 整合进目标/验收，置 ready）。",
    "",
    `## 任务文档（${t.path}）`,
    "```markdown",
    doc,
    "```",
    "",
    "## 项目背景（看板人工区节选）",
    kanbanHuman || "（无）",
  ].join("\n")
}

function execPrompt(t: TaskMeta, doc: string): string {
  return [
    `【taskflow 执行任务】任务 ${t.id}（项目 ${t.project}）已就绪，本 session 负责完成它。`,
    "",
    TOOL_CONTRACT,
    "",
    "执行契约：",
    "1. 开工前 task_append_log 记录你的计划；关键节点（发现/决策/产出）随时 append。",
    "2. 严格对照「验收标准」工作；全部满足后 task_append_log 写总结，并 task_update_status(id, \"review\") 等用户验收。",
    "3. 遇到无法推进的阻塞：task_update_status(id, \"blocked\", 原因)，并 notify_desktop 告知用户。",
    "4. 永远不要把状态设为 done——那是用户验收后的人工操作。",
    "",
    `## 任务文档（${t.path}）`,
    "```markdown",
    doc,
    "```",
  ].join("\n")
}

function phaPrompt(t: TaskMeta, doc: string): string {
  return [
    `【taskflow 同步 PHA】任务 ${t.id} 已被用户验收（done），请把进度同步到内网 PHA。`,
    "",
    TOOL_CONTRACT,
    "",
    "步骤：",
    "1. 用你已有的 PHA 推送工具，把该任务的标题、结论与关键进度（取自「执行日志」）推送/更新到 PHA。",
    "2. 把返回的 issue 链接 task_set_field(id, \"pha_issue\", <url>)。",
    "3. 完成后 task_update_status(id, \"synced\")；失败则 task_update_status(id, \"blocked\", 原因) 并 notify_desktop。",
    "",
    `## 任务文档（${t.path}）`,
    "```markdown",
    doc,
    "```",
  ].join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// State + scanning
// ─────────────────────────────────────────────────────────────────────────────

type ActiveEntry = { sessionId: string; path: string; startedAt: number; notifiedAt?: number }
type State = {
  lastSeen: Record<string, { mtime: number; status: string }>
  active: Record<string, ActiveEntry>
  /** task id → last PHA dispatch ms (prevents re-firing while status stays done) */
  phaAt: Record<string, number>
}

let state: State | undefined
let statePath: string | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollStop = false
let scanChain: Promise<unknown> = Promise.resolve()
/** id → meta from the latest scan (tool/route lookups) */
let index = new Map<string, TaskMeta>()

function ensureState(ctx: HostContext): State {
  if (!state) {
    statePath = join(ctx.dataDir, "taskflow-state.json")
    try {
      state = JSON.parse(readFileSync(statePath, "utf8")) as State
    } catch {
      state = { lastSeen: {}, active: {}, phaAt: {} }
    }
    state.lastSeen ??= {}
    state.active ??= {}
    state.phaAt ??= {}
  }
  return state
}

function saveState(): void {
  if (!state || !statePath) return
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8")
  } catch (e) {
    console.warn("[cap:taskflow] state write failed:", e)
  }
}

function cfg(ctx: HostContext) {
  const c = ctx.config()
  return {
    vaultDir: String(c.vaultDir ?? "").trim(),
    pollSeconds: Number(c.pollSeconds ?? 10),
    autoClarify: c.autoClarify !== false && c.autoClarify !== "false",
    autoStart: c.autoStart === true || c.autoStart === "true",
    maxConcurrent: Math.max(1, Number(c.maxConcurrent ?? 2) || 2),
    sessionModel: parseModelRef(String(c.sessionModel ?? "").trim()),
  }
}

/** "provider/model" → ModelRef; anything else → undefined (use default model). */
function parseModelRef(s: string): ModelRef | undefined {
  const i = s.indexOf("/")
  if (i <= 0 || i >= s.length - 1) return undefined
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Read + parse one task file; null when unparsable (e.g. Obsidian mid-save). */
function readTask(path: string, project: string): { meta: TaskMeta; fm: Frontmatter; body: string } | null {
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = parseFrontmatter(raw)
    if (!parsed) return null
    const mtimeMs = statSync(path).mtimeMs
    return { meta: taskMetaOf(path, project, parsed.fm, mtimeMs), fm: parsed.fm, body: parsed.body }
  } catch {
    return null
  }
}

/** Write a task back and suppress self-triggering (lastSeen updated to new mtime). */
function writeTask(st: State, path: string, fm: Frontmatter, body: string): void {
  fm.updated = today()
  writeFileSync(path, serializeFrontmatter(fm, body), "utf8")
  st.lastSeen[path] = { mtime: statSync(path).mtimeMs, status: String(fm.status ?? "") }
}

/** Enumerate all tasks under <vaultDir>/<project>/tasks/*.md. */
function scanTasks(vaultDir: string): TaskMeta[] {
  const out: TaskMeta[] = []
  let projects: string[] = []
  try {
    projects = readdirSync(vaultDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
  } catch {
    return out
  }
  for (const project of projects) {
    const dir = join(vaultDir, project, "tasks")
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"))
    } catch {
      continue // project without tasks/ — fine
    }
    for (const f of files) {
      const t = readTask(join(dir, f), project)
      if (t) out.push(t.meta)
    }
  }
  index = new Map(out.map((t) => [t.id, t]))
  return out
}

function kanbanPath(vaultDir: string, project: string): string {
  return join(vaultDir, project, "项目看板.md")
}

/** Human part of the kanban (everything above the taskflow markers). */
function kanbanHumanPart(vaultDir: string, project: string): string {
  try {
    const raw = readFileSync(kanbanPath(vaultDir, project), "utf8")
    const b = raw.indexOf(KB_BEGIN)
    return (b >= 0 ? raw.slice(0, b) : raw).slice(0, 4000)
  } catch {
    return ""
  }
}

function rebuildKanban(st: State, vaultDir: string, project: string, tasks: TaskMeta[]): void {
  const mine = tasks.filter((t) => t.project === project)
  const path = kanbanPath(vaultDir, project)
  let existing: string | undefined
  try {
    existing = readFileSync(path, "utf8")
  } catch {
    existing = undefined
  }
  const next = applyKanban(existing, buildKanbanSection(mine), project)
  if (next !== existing) {
    try {
      writeFileSync(path, next, "utf8")
    } catch (e) {
      console.warn("[cap:taskflow] kanban write failed:", e)
    }
  }
  void st
}

// ─────────────────────────────────────────────────────────────────────────────
// Session orchestration
// ─────────────────────────────────────────────────────────────────────────────

async function startSessionFor(
  ctx: HostContext,
  taskId: string,
  kind: "clarify" | "exec" | "pha",
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const st = ensureState(ctx)
  const conf = cfg(ctx)
  const meta = index.get(taskId)
  if (!meta) return { ok: false, error: `task_not_found: ${taskId}` }
  const t = readTask(meta.path, meta.project)
  if (!t) return { ok: false, error: "task_unreadable" }
  const doc = readFileSync(meta.path, "utf8")

  if (kind === "exec") {
    const running = Object.entries(st.active).filter(([id]) => index.get(id)?.status === "doing").length
    if (running >= conf.maxConcurrent) {
      return { ok: false, error: `并发已达上限(${conf.maxConcurrent})，请先完成进行中的任务` }
    }
  }

  // PHA 同步优先复用任务已有 session（上下文都在），否则新建。
  let sessionId: string | undefined
  const projectDir = join(conf.vaultDir, meta.project)
  if (kind === "pha" && t.meta.sessions.length > 0) {
    sessionId = t.meta.sessions[t.meta.sessions.length - 1]
  } else {
    const created = await ctx.native.chat.createSession(projectDir)
    if (!created.ok || !created.sessionId) return { ok: false, error: created.error ?? "createSession failed" }
    sessionId = created.sessionId
    t.fm.sessions = [...t.meta.sessions, sessionId]
  }

  if (kind === "clarify") t.fm.status = "clarifying"
  if (kind === "exec") {
    t.fm.status = "doing"
    st.active[taskId] = { sessionId, path: meta.path, startedAt: Date.now() }
  }
  if (kind === "pha") st.phaAt[taskId] = Date.now()
  writeTask(st, meta.path, t.fm, t.body)
  saveState()
  ctx.emit("taskflow:changed", { id: taskId, kind })

  const prompt =
    kind === "clarify"
      ? clarifyPrompt(t.meta, doc, kanbanHumanPart(conf.vaultDir, meta.project))
      : kind === "exec"
        ? execPrompt(t.meta, doc)
        : phaPrompt(t.meta, doc)

  // fire-and-forget：session.prompt 直到 agent 回复完成才返回，不能阻塞轮询
  void ctx.native.chat
    .send({ text: prompt, sessionId, model: conf.sessionModel, directory: projectDir })
    .catch((e) => ctx.log(`session send failed (task ${taskId})`, e))

  return { ok: true, sessionId }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan tick — detect status transitions & dispatch
// ─────────────────────────────────────────────────────────────────────────────

async function doScan(ctx: HostContext): Promise<{ tasks: TaskMeta[]; transitions: number }> {
  const st = ensureState(ctx)
  const conf = cfg(ctx)
  if (!conf.vaultDir || !existsSync(conf.vaultDir)) return { tasks: [], transitions: 0 }

  const tasks = scanTasks(conf.vaultDir)
  const touchedProjects = new Set<string>()
  let transitions = 0

  for (const t of tasks) {
    const seen = st.lastSeen[t.path]
    if (seen && seen.mtime === t.mtimeMs) continue // untouched（含自写抑制）
    const prev = seen?.status
    st.lastSeen[t.path] = { mtime: t.mtimeMs, status: t.status }
    touchedProjects.add(t.project)
    if (prev === t.status) continue // 内容改了但状态没变 → 只重建看板
    transitions++
    ctx.log(`task ${t.id}: ${prev ?? "(new)"} → ${t.status}`)
    ctx.emit("taskflow:changed", { id: t.id, status: t.status })

    if (t.status === "inbox") {
      if (conf.autoClarify) {
        void startSessionFor(ctx, t.id, "clarify")
      } else {
        ctx.native.showToast({ title: "新任务待澄清", message: `${t.id} ${t.title}`, level: "info" })
      }
    } else if (t.status === "ready") {
      if (conf.autoStart) {
        void startSessionFor(ctx, t.id, "exec")
      } else {
        ctx.native.showToast({ title: "任务就绪，可启动", message: `${t.id} ${t.title}`, level: "info" })
      }
    } else if (t.status === "doing" && !st.active[t.id]) {
      // 人在 Obsidian 直接把 status 改成 doing = 手动启动信号
      void startSessionFor(ctx, t.id, "exec")
    } else if (t.status === "review") {
      ctx.native.showToast({ title: "任务待验收", message: `${t.id} ${t.title}`, level: "info" })
    } else if (t.status === "done") {
      const last = st.phaAt[t.id] ?? 0
      if (Date.now() - last > 30 * 60_000) void startSessionFor(ctx, t.id, "pha")
    } else if (t.status === "blocked") {
      ctx.native.showToast({ title: "任务阻塞", message: `${t.id} ${t.title}`, level: "warn" })
    }
  }

  // 清理 active（任务不再 doing 或文件消失）；doing 看门狗
  for (const [id, a] of Object.entries(st.active)) {
    const t = index.get(id)
    if (!t || t.status !== "doing") {
      delete st.active[id]
      continue
    }
    if (Date.now() - a.startedAt < 10 * 60_000) continue
    if (a.notifiedAt && Date.now() - a.notifiedAt < 30 * 60_000) continue
    try {
      const entries = await ctx.native.chat.monitor(24)
      const e = entries.find((x) => x.id === a.sessionId)
      if (e && !e.busy) {
        a.notifiedAt = Date.now()
        ctx.native.showToast({
          title: "任务可能悬停",
          message: `${id} 的会话已空闲，但状态仍是「进行中」，请检查`,
          level: "warn",
        })
      }
    } catch {
      /* opencode 不可达 — 下轮再看 */
    }
  }

  for (const p of touchedProjects) rebuildKanban(st, conf.vaultDir, p, tasks)
  if (touchedProjects.size > 0 || transitions > 0) saveState()
  return { tasks, transitions }
}

function scan(ctx: HostContext): Promise<{ tasks: TaskMeta[]; transitions: number }> {
  const run = scanChain.then(() => doScan(ctx))
  scanChain = run.catch(() => undefined)
  return run
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent tools (win-host MCP)
// ─────────────────────────────────────────────────────────────────────────────

function findTask(id: string, ctx: HostContext): { meta: TaskMeta; fm: Frontmatter; body: string } | null {
  let meta = index.get(id)
  if (!meta) {
    scanTasks(cfg(ctx).vaultDir) // lazy refresh（tools 可能先于首轮扫描被调用）
    meta = index.get(id)
  }
  if (!meta) return null
  return readTask(meta.path, meta.project)
}

const tools: McpToolDef[] = [
  {
    name: "task_get",
    description: "读取一个 taskflow 任务文档的全文（frontmatter + 正文）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id，如 T-0013" } },
      required: ["id"],
    },
    async handler(args, ctx) {
      const t = findTask(String(args.id ?? ""), ctx)
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      return { text: readFileSync(t.meta.path, "utf8") }
    },
  },
  {
    name: "task_update_status",
    description:
      "更新任务状态。可用值: clarifying|ready|doing|review|blocked|synced。done 是用户验收专属，工具不可设置。可附 note（会记入执行日志）。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: AGENT_STATUS },
        note: { type: "string", description: "可选，一句话原因/说明" },
      },
      required: ["id", "status"],
    },
    async handler(args, ctx) {
      const st = ensureState(ctx)
      const status = String(args.status ?? "") as TaskStatus
      if (!AGENT_STATUS.includes(status)) return { text: `status not allowed: ${status}`, isError: true }
      const t = findTask(String(args.id ?? ""), ctx)
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      t.fm.status = status
      let body = t.body
      if (args.note && String(args.note).trim()) {
        body = appendLogSection(body, `- ${new Date().toLocaleString()} 状态 → ${status}：${String(args.note).trim()}`)
      }
      writeTask(st, t.meta.path, t.fm, body)
      const conf = cfg(ctx)
      rebuildKanban(st, conf.vaultDir, t.meta.project, scanTasks(conf.vaultDir))
      saveState()
      ctx.emit("taskflow:changed", { id: t.meta.id, status })
      return { text: `ok: ${t.meta.id} → ${status}` }
    },
  },
  {
    name: "task_append_log",
    description: "向任务文档的「执行日志」区追加一条 Markdown 记录（自动带时间戳）。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string", description: "Markdown 内容（发现/决策/产出/总结）" },
      },
      required: ["id", "content"],
    },
    async handler(args, ctx) {
      const st = ensureState(ctx)
      const t = findTask(String(args.id ?? ""), ctx)
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const entry = `### ${new Date().toLocaleString()}\n\n${String(args.content ?? "").trim()}`
      writeTask(st, t.meta.path, t.fm, appendLogSection(t.body, entry))
      return { text: `ok: log appended to ${t.meta.id}` }
    },
  },
  {
    name: "task_set_field",
    description: "更新任务 frontmatter 字段。仅允许 priority / type / pha_issue。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        key: { type: "string", enum: ["priority", "type", "pha_issue"] },
        value: { type: "string" },
      },
      required: ["id", "key", "value"],
    },
    async handler(args, ctx) {
      const st = ensureState(ctx)
      const key = String(args.key ?? "")
      if (!["priority", "type", "pha_issue"].includes(key)) return { text: `field not allowed: ${key}`, isError: true }
      const t = findTask(String(args.id ?? ""), ctx)
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      t.fm[key] = String(args.value ?? "")
      writeTask(st, t.meta.path, t.fm, t.body)
      return { text: `ok: ${t.meta.id}.${key} = ${args.value}` }
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Routes (panel)
// ─────────────────────────────────────────────────────────────────────────────

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/tasks",
    async handler(_req, ctx) {
      const conf = cfg(ctx)
      if (!conf.vaultDir) return { body: { ok: false, error: "vaultDir 未配置（管理页 → 任务看板）", tasks: [] } }
      const tasks = scanTasks(conf.vaultDir)
      return { body: { ok: true, tasks } }
    },
  },
  {
    method: "POST",
    path: "/scan",
    async handler(_req, ctx) {
      const r = await scan(ctx)
      return { body: { ok: true, count: r.tasks.length, transitions: r.transitions } }
    },
  },
  {
    method: "POST",
    path: "/task/start",
    async handler(req, ctx) {
      await scan(ctx) // 确保 index 新鲜
      const r = await startSessionFor(ctx, String(req.body?.id ?? ""), "exec")
      return { body: r, status: r.ok ? 200 : 400 }
    },
  },
  {
    method: "POST",
    path: "/task/sync-pha",
    async handler(req, ctx) {
      await scan(ctx)
      const r = await startSessionFor(ctx, String(req.body?.id ?? ""), "pha")
      return { body: r, status: r.ok ? 200 : 400 }
    },
  },
  {
    method: "POST",
    path: "/task/set-status",
    async handler(req, ctx) {
      const st = ensureState(ctx)
      const id = String(req.body?.id ?? "")
      const status = normStatus(req.body?.status)
      const t = findTask(id, ctx)
      if (!t) return { status: 404, body: { ok: false, error: `task not found: ${id}` } }
      t.fm.status = status
      writeTask(st, t.meta.path, t.fm, t.body)
      const conf = cfg(ctx)
      rebuildKanban(st, conf.vaultDir, t.meta.project, scanTasks(conf.vaultDir))
      saveState()
      ctx.emit("taskflow:changed", { id, status })
      // done 走正常状态机（下一轮扫描会触发 PHA）；这里直接派发省一轮等待
      if (status === "done") {
        const last = st.phaAt[id] ?? 0
        if (Date.now() - last > 30 * 60_000) void startSessionFor(ctx, id, "pha")
      }
      return { body: { ok: true } }
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Capability
// ─────────────────────────────────────────────────────────────────────────────

export const taskflowCapability: Capability = {
  id: "taskflow",
  title: "任务看板",
  icon: "list-checks",
  description: "文档驱动的项目任务编排：扫描 Obsidian vault 的任务文档，按 status 状态机派发澄清/执行/PHA 同步 session。",
  hasPanel: true,
  events: ["taskflow:changed"],
  configSchema: {
    fields: [
      {
        key: "vaultDir",
        label: "项目根目录",
        type: "string",
        placeholder: "如 D:\\vault\\01-项目资料",
        help: "Obsidian vault 里的项目根目录；每个子目录=一个项目，任务在 <项目>/tasks/*.md",
      },
      { key: "pollSeconds", label: "扫描间隔(秒)", type: "number", default: 10, help: "0=停用扫描" },
      {
        key: "autoClarify",
        label: "新任务自动澄清",
        type: "boolean",
        default: true,
        help: "inbox 任务自动起澄清 session（消耗一次 LLM 调用）",
      },
      {
        key: "autoStart",
        label: "就绪自动启动",
        type: "boolean",
        default: false,
        help: "ready 任务自动起执行 session（建议先手动启动建立信任）",
      },
      { key: "maxConcurrent", label: "并发任务上限", type: "number", default: 2 },
      { key: "sessionModel", label: "会话模型(可选)", type: "string", placeholder: "provider/model，留空用默认" },
    ],
  },
  tools,
  routes,

  init(ctx) {
    ensureState(ctx)
    pollStop = false
    if (pollTimer) clearTimeout(pollTimer)
    // mailflow 同款 self-rescheduling tick：live 读配置、慢扫描不叠加。
    const tick = () => {
      if (pollStop) return
      const seconds = cfg(ctx).pollSeconds
      if (!Number.isFinite(seconds) || seconds <= 0 || !cfg(ctx).vaultDir) {
        pollTimer = setTimeout(tick, 30_000)
        return
      }
      void scan(ctx)
        .catch((e) => ctx.log("scan failed", e))
        .finally(() => {
          if (!pollStop) pollTimer = setTimeout(tick, Math.max(5, seconds) * 1000)
        })
    }
    pollTimer = setTimeout(tick, 3_000)
  },

  dispose() {
    pollStop = true
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
  },
}
