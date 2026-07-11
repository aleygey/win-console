/**
 * taskflow capability v4 — 看板中心 · 人驱动 · 系统只做记录/连接/标准化。
 *
 * 定位（与 v1「自动状态机」相反）：**你驱动一切**，taskflow 负责三件事——
 *   1) 记录：用固定模板 + 格式化工具，让 agent 结构化地写文档（不再随意发挥）；
 *   2) 连接：任务 ⇄ session ⇄ PHA 的关联（存在任务 frontmatter.sessions[]）；
 *   3) 省事：从任务文档一键启动/继续 session；Obsidian 切文档→会话面板联动。
 *
 * 状态的唯一来源 = Obsidian 官方 Kanban 看板文件里卡片所在的「列」。taskflow
 * 读写同一个 md（拖卡=改状态），绝不把 status 存进任务 frontmatter（消灭双源）。
 *
 * 「什么是任务」= 它的 `[[链接]]` 出现在某个看板上。任务文档放哪都行、目录不限。
 * 没有自动派发、没有轮询状态机——poll 仅用于刷新注册表缓存（供焦点联动/面板）。
 *
 * 与 opencode 的接口：MCP 工具（task_*）。若工具不可用，agent 直接编辑同名区域，
 * 文件本身就是接口。
 */
import type { Capability, HostContext, McpToolDef, ModelRef, RouteDef } from "../../contracts"
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname, basename } from "node:path"

// ═════════════════════════════════════════════════════════════════════════════
// Frontmatter — restricted flat YAML (scalars + string lists), round-trip safe.
// ═════════════════════════════════════════════════════════════════════════════

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
  if (i >= lines.length) return null // unterminated (mid-save) — caller skips
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
    } else lines.push(`${k}: ${quoteIfNeeded(String(v))}`)
  }
  lines.push("---")
  return lines.join("\n") + "\n" + body
}

// ═════════════════════════════════════════════════════════════════════════════
// Body sections — the fixed template's regions. Agents only touch these via
// the format-enforcing tools below; humans own 备注.
// ═════════════════════════════════════════════════════════════════════════════

// 文档布局 v5（用户定稿）：
//   frontmatter（tag/pha/sessions）
//   # 标题
//   ## 待办            ← 状态区：任务唯一的 todo list（人机都可勾）
//   ---                ← 分隔线：上面扫一眼状态，下面是任务正文
//   ## 1 章节标题       ← 正文区：编号章节（1/1.1/1.1.1），结构由工具控制
//   ### 1.1 …
//   ## 日志            ← 置底：表格式阶段性日志（时间|会话|记录），不是重点
const LOG_HEADING = "## 日志"
const LOG_TABLE_HEADER = ["| 时间 | 会话 | 记录 |", "| --- | --- | --- |"]

/** Return [start,end) line indices of the `## <heading>` block body (exclusive
 *  of the heading line), or null if the heading is absent. */
function sectionRange(lines: string[], heading: string): { headIdx: number; start: number; end: number } | null {
  const headIdx = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (headIdx < 0) return null
  let end = lines.length
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i]) || lines[i].trim() === "---") {
      end = i
      break
    }
  }
  return { headIdx, start: headIdx + 1, end }
}

/** 非破坏性补齐 v5 布局：待办、`---` 分隔线、置底的日志表。已有内容不动。 */
export function ensureLayout(body: string): string {
  let out = body
  let lines = out.split(/\r?\n/)
  if (!sectionRange(lines, "待办")) {
    // 插在 H1 标题之后，否则文档最前
    const h1 = lines.findIndex((l) => /^# /.test(l))
    const at = h1 >= 0 ? h1 + 1 : 0
    lines = [...lines.slice(0, at), "", "## 待办", "", ...lines.slice(at)]
    out = lines.join("\n")
  }
  if (!out.split(/\r?\n/).some((l) => l.trim() === "---")) {
    out = out.replace(/\s*$/, "") + "\n\n---\n"
  }
  if (!out.split(/\r?\n/).some((l) => l.trim() === LOG_HEADING)) {
    out = out.replace(/\s*$/, "") + `\n\n${LOG_HEADING}\n\n${LOG_TABLE_HEADER.join("\n")}\n`
  }
  return out
}

/** 正文区（章节区）的行范围：第一条 `---` 之后，`## 日志` 之前。 */
function chapterZone(lines: string[]): { start: number; end: number } {
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      start = i + 1
      break
    }
  }
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === LOG_HEADING) {
      end = i
      break
    }
  }
  return { start, end }
}

/** 向置底的「日志」表追加一行（阶段性记录；表头缺失自动补）。 */
export function appendLogRow(body: string, time: string, session: string, text: string): string {
  const withLayout = ensureLayout(body)
  const lines = withLayout.split(/\r?\n/)
  const r = sectionRange(lines, "日志")!
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
  const row = `| ${cell(time)} | ${cell(session) || "—"} | ${cell(text)} |`
  const hasHeader = lines.slice(r.start, r.end).some((l) => /^\|.*\|/.test(l.trim()))
  let end = r.end
  while (end > r.start && lines[end - 1].trim() === "") end--
  const insert = hasHeader ? [row] : [...LOG_TABLE_HEADER, row]
  return [...lines.slice(0, end), ...insert, ...lines.slice(end)].join("\n")
}

/** Parse the 待办 checkbox list → {done,total,items}. */
export function parseTodos(body: string): { done: number; total: number; items: Array<{ checked: boolean; text: string }> } {
  const lines = body.split(/\r?\n/)
  const r = sectionRange(lines, "待办")
  const items: Array<{ checked: boolean; text: string }> = []
  if (r) {
    for (let i = r.start; i < r.end; i++) {
      const m = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.exec(lines[i])
      if (m) items.push({ checked: m[1].toLowerCase() === "x", text: m[2].trim() })
    }
  }
  return { done: items.filter((t) => t.checked).length, total: items.length, items }
}

/** Toggle / add a todo. Returns new body (unchanged if action can't apply). */
function editTodo(body: string, action: "check" | "uncheck" | "add", text: string): string {
  const withSecs = ensureLayout(body)
  const lines = withSecs.split(/\r?\n/)
  const r = sectionRange(lines, "待办")!
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase()
  if (action === "add") {
    let end = r.end
    while (end > r.start && lines[end - 1].trim() === "") end--
    return [...lines.slice(0, end), `- [ ] ${text.trim()}`, ...lines.slice(end)].join("\n")
  }
  const want = action === "check"
  for (let i = r.start; i < r.end; i++) {
    const m = /^(\s*[-*]\s*)\[([ xX])\](\s*)(.*)$/.exec(lines[i])
    if (m && norm(m[4]).includes(norm(text)) && norm(text).length > 0) {
      lines[i] = `${m[1]}[${want ? "x" : " "}]${m[3]}${m[4]}`
      return lines.join("\n")
    }
  }
  return withSecs // no match — leave as-is (caller reports)
}

// ═════════════════════════════════════════════════════════════════════════════
// 「记录」章节写入 — 线性分章节的任务过程记录（1 / 1.2 / 1.2.3）。
// 结构（编号+标题+层级）由工具控制，内容是 agent 的自由 Markdown（表格等均可）。
// ═════════════════════════════════════════════════════════════════════════════

/** "1.2.3" → [1,2,3]；非法/超过 3 级 → null。 */
export function parseSecNum(s: string): number[] | null {
  if (!/^\d+(\.\d+){0,2}$/.test(s.trim())) return null
  return s.trim().split(".").map(Number)
}

function cmpSecNum(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1
    const y = b[i] ?? -1
    if (x !== y) return x - y
  }
  return 0
}

/** content 消毒：正文里的 markdown 标题会破坏章节解析边界（`##` 会截断
 *  「记录」区、伪编号标题会污染章节索引）——统一降级为粗体行。代码块内不动。
 *  这就是"结构只能由工具产生"的强制执行点。 */
export function sanitizeSectionContent(content: string): string {
  const out: string[] = []
  let inFence = false
  for (const ln of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(ln)) {
      inFence = !inFence
      out.push(ln)
      continue
    }
    const h = !inFence && /^\s*#{1,6}\s+(.*)$/.exec(ln)
    if (h) out.push(`**${h[1].trim()}**`)
    else out.push(ln)
  }
  return out.join("\n")
}

const CHAPTER_RE = /^(#{2,4})\s+(\d+(?:\.\d+){0,2})\s+(.*)$/

/** 在正文区（`---` 与「## 日志」之间）写一个编号章节。
 *  - mode="replace"（默认）：同号章节整体重写（子章节保留——替换只到下一个编号标题）；
 *  - mode="append"：同号章节存在时在其正文末尾追加（增量记录，不动已有内容）；
 *  - 不存在 → 按编号顺序插入正确位置；
 *  - 标题深度：1→##、1.1→###、1.1.1→####（Obsidian 大纲友好）。 */
export function writeRecordSection(
  body: string,
  section: string,
  title: string,
  content: string,
  mode: "replace" | "append" = "replace",
): string | null {
  const num = parseSecNum(section)
  if (!num) return null
  const withLayout = ensureLayout(body)
  const lines = withLayout.split(/\r?\n/)
  const zone = chapterZone(lines)

  type Found = { line: number; num: number[] }
  const heads: Found[] = []
  for (let i = zone.start; i < zone.end; i++) {
    const m = CHAPTER_RE.exec(lines[i])
    if (m) {
      const n = parseSecNum(m[2])
      if (n) heads.push({ line: i, num: n })
    }
  }

  const clean = sanitizeSectionContent(content).replace(/\s+$/, "")
  const newHeading = `${"#".repeat(1 + num.length)} ${section} ${title.trim()}`
  const existing = heads.find((h) => cmpSecNum(h.num, num) === 0)

  if (existing) {
    const idx = heads.indexOf(existing)
    const end = idx + 1 < heads.length ? heads[idx + 1].line : zone.end
    if (mode === "append") {
      // 追加到该章节自己的正文末尾（下一个编号标题之前），标题保持原样（title 非空则更新）
      let at = end
      while (at > existing.line + 1 && lines[at - 1].trim() === "") at--
      const head = title.trim() ? newHeading : lines[existing.line]
      return [
        ...lines.slice(0, existing.line),
        head,
        ...lines.slice(existing.line + 1, at),
        "",
        clean,
        "",
        ...lines.slice(end),
      ].join("\n")
    }
    // replace：从标题到下一个编号标题之前整体重写（任意层级的下个标题=子章节也保留在后面）
    return [...lines.slice(0, existing.line), newHeading, "", clean, "", ...lines.slice(end)].join("\n")
  }

  // 新章节：插到第一个编号更大的标题之前；否则正文区末尾（日志之前）
  const after = heads.find((h) => cmpSecNum(h.num, num) > 0)
  let at = after ? after.line : zone.end
  while (at > zone.start && lines[at - 1].trim() === "" && !after) at--
  return [...lines.slice(0, at), newHeading, "", clean, "", ...lines.slice(at)].join("\n")
}

/** 列出正文区现有章节（给 task_list/契约用，agent 据此知道下一个编号）。 */
export function listRecordSections(body: string): Array<{ num: string; title: string }> {
  const lines = body.split(/\r?\n/)
  const zone = chapterZone(lines)
  const out: Array<{ num: string; title: string }> = []
  for (let i = zone.start; i < zone.end; i++) {
    const m = CHAPTER_RE.exec(lines[i])
    if (m) out.push({ num: m[2], title: m[3].trim() })
  }
  return out
}

// ═════════════════════════════════════════════════════════════════════════════
// Kanban board — read columns/cards; move a card between columns via line edits
// (NEVER reserialize a board's YAML — it holds the plugin's settings block).
// ═════════════════════════════════════════════════════════════════════════════

const BOARD_MARK = "kanban-plugin: board"

function isBoardFile(raw: string): boolean {
  const p = parseFrontmatter(raw)
  return !!p && String(p.fm["kanban-plugin"] ?? "").trim() === "board"
}

/** Extract the [[target]] (basename, drops alias/heading/#tags) from a card line. */
function cardLink(line: string): string | null {
  const m = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/.exec(line)
  return m ? m[1].trim().replace(/\.md$/i, "").split("/").pop()! : null
}

type BoardColumn = { name: string; cards: Array<{ link: string; checked: boolean; line: number }> }

/** Parse a board's columns and their card links. Ignores the settings block. */
export function parseBoard(raw: string): BoardColumn[] {
  const lines = raw.split(/\r?\n/)
  const cols: BoardColumn[] = []
  let cur: BoardColumn | null = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (/^%%/.test(ln)) break // settings block — stop
    const h = /^##\s+(.*)$/.exec(ln)
    if (h) {
      cur = { name: h[1].trim(), cards: [] }
      cols.push(cur)
      continue
    }
    const c = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.exec(ln)
    if (c && cur) {
      const link = cardLink(c[2])
      if (link) cur.cards.push({ link, checked: c[1].toLowerCase() === "x", line: i })
    }
  }
  return cols
}

/** Move a card (matched by task basename) to `toColumn`, setting checkbox. */
export function moveCard(raw: string, taskBase: string, toColumn: string, checked: boolean): string | null {
  const lines = raw.split(/\r?\n/)
  const norm = (s: string) => s.toLowerCase()
  // find the card line
  let cardIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^%%/.test(lines[i])) break
    const link = /^\s*[-*]\s*\[[ xX]\]/.test(lines[i]) ? cardLink(lines[i]) : null
    if (link && norm(link) === norm(taskBase)) {
      cardIdx = i
      break
    }
  }
  if (cardIdx < 0) return null
  // find the target column heading
  let headIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^%%/.test(lines[i])) break
    const h = /^##\s+(.*)$/.exec(lines[i])
    if (h && norm(h[1].trim()) === norm(toColumn)) {
      headIdx = i
      break
    }
  }
  if (headIdx < 0) return null
  // rewrite the card line's checkbox
  let card = lines[cardIdx].replace(/(\[)[ xX](\])/, `$1${checked ? "x" : " "}$2`)
  // remove from old position
  const without = [...lines.slice(0, cardIdx), ...lines.slice(cardIdx + 1)]
  // recompute target column end (heading may have shifted if card was above it)
  const newHead = cardIdx < headIdx ? headIdx - 1 : headIdx
  let end = without.length
  for (let i = newHead + 1; i < without.length; i++) {
    if (/^##\s+/.test(without[i]) || /^%%/.test(without[i])) {
      end = i
      break
    }
  }
  while (end > newHead + 1 && without[end - 1].trim() === "") end--
  return [...without.slice(0, end), card, ...without.slice(end)].join("\n")
}

/** Add a `- [ ] [[base]]<suffix>` card under a column (default first) of a board. */
function addCard(raw: string, taskBase: string, column?: string, suffix = ""): string {
  const lines = raw.split(/\r?\n/)
  let headIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^%%/.test(lines[i])) break
    const h = /^##\s+(.*)$/.exec(lines[i])
    if (h && (!column || h[1].trim().toLowerCase() === column.toLowerCase())) {
      headIdx = i
      if (!column) break // first column
      if (column) break
    }
  }
  if (headIdx < 0) {
    // no columns yet — create the default one
    return lines.join("\n").replace(/\s*$/, "") + `\n\n## ${column ?? "待办"}\n\n- [ ] [[${taskBase}]]${suffix}\n`
  }
  let end = lines.length
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) || /^%%/.test(lines[i])) {
      end = i
      break
    }
  }
  while (end > headIdx + 1 && lines[end - 1].trim() === "") end--
  return [...lines.slice(0, end), `- [ ] [[${taskBase}]]${suffix}`, ...lines.slice(end)].join("\n")
}

// ═════════════════════════════════════════════════════════════════════════════
// Path normalization — Obsidian sends abs paths with OS seps; node scan too.
// Key everything on a normalized (forward-slash, lowercase) form.
// ═════════════════════════════════════════════════════════════════════════════

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

// ── 路径映射：Windows 路径 → opencode 所在环境（虚拟机/WSL）的路径 ────────────
// 文档在 Windows 盘上，opencode 可能跑在 VirtualBox 虚拟机（共享目录挂载点
// 因人而异，如 /media/sf_vault）或 WSL（/mnt/c/...）。挂载点无法猜测，所以做成
// 显式配置：pathMap = "WIN前缀=对端路径" 多条用 ; 分隔，最长前缀优先。
// 未配置/未命中 → 返回 null，工具输出只给 Windows 路径并提示配置。

export type PathRule = { win: string; vm: string }

export function parsePathMap(raw: string): PathRule[] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf("=")
      if (i <= 0) return null
      return { win: s.slice(0, i).trim(), vm: s.slice(i + 1).trim() }
    })
    .filter((r): r is PathRule => !!r && !!r.win && !!r.vm)
    .sort((a, b) => b.win.length - a.win.length) // 最长前缀优先
}

/** 按映射规则转换一个 Windows 路径；未命中返回 null。 */
export function mapPath(rules: PathRule[], p: string): string | null {
  const np = norm(p)
  for (const r of rules) {
    const nw = norm(r.win)
    if (np === nw || np.startsWith(nw + "/")) {
      const rest = p.replace(/\\/g, "/").slice(r.win.replace(/\\/g, "/").replace(/\/+$/, "").length)
      return (r.vm.replace(/\/+$/, "") + rest).replace(/\/{2,}/g, "/")
    }
  }
  return null
}

/** 工具输出里的对端路径描述：命中给路径，未命中给配置提示。 */
function vmPathNote(rules: PathRule[], p: string): string {
  const m = mapPath(rules, p)
  return m ?? "（未配置路径映射——管理 → 任务看板 → 路径映射）"
}

// ── 看板卡片徽章 —— 卡片尾部维护 ` · n/N` 待办完成度（状态即列，无需重复）──

const BADGE_RE = /\s*·\s*\d+\/\d+\s*$/

/** 清理看板卡片尾部的历史 ` · n/N` 徽章（徽章已改由看板 fork 脚注展示）；无变化返回 null。 */
export function stripCardBadges(raw: string): string | null {
  const lines = raw.split(/\r?\n/)
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    if (/^%%/.test(lines[i])) break
    if (!/^\s*[-*]\s*\[[ xX]\]/.test(lines[i])) continue
    if (!cardLink(lines[i])) continue
    const next = lines[i].replace(BADGE_RE, "")
    if (next !== lines[i]) {
      lines[i] = next
      changed = true
    }
  }
  return changed ? lines.join("\n") : null
}

/** 对一份看板，把每张可解析卡片的待办徽章刷成最新；无变化返回 null。 */
export function applyCardBadges(raw: string, statsByLink: Map<string, { done: number; total: number }>): string | null {
  const lines = raw.split(/\r?\n/)
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    if (/^%%/.test(lines[i])) break
    if (!/^\s*[-*]\s*\[[ xX]\]/.test(lines[i])) continue
    const link = cardLink(lines[i])
    if (!link) continue
    const st = statsByLink.get(link.toLowerCase())
    if (!st) continue
    const base = lines[i].replace(BADGE_RE, "")
    const next = st.total > 0 ? `${base} · ${st.done}/${st.total}` : base
    if (next !== lines[i]) {
      lines[i] = next
      changed = true
    }
  }
  return changed ? lines.join("\n") : null
}

// ═════════════════════════════════════════════════════════════════════════════
// Task model + registry
// ═════════════════════════════════════════════════════════════════════════════

export type TaskMeta = {
  /** basename without extension — the Obsidian [[link]] target, used as id. */
  id: string
  title: string
  project: string
  type: string
  /** kanban column the card sits in = status. */
  status: string
  board: string // board file path
  sessions: string[]
  pha_issue: string
  todos: { done: number; total: number }
  path: string // absolute path of the task file
  mtimeMs: number
}

type Registry = {
  tasks: Map<string, TaskMeta> // normPath → meta
  byId: Map<string, string> // normBasename → normPath (ambiguity: last wins, logged)
  boards: Array<{ path: string; columns: string[] }>
  builtAt: number
}

let reg: Registry = { tasks: new Map(), byId: new Map(), boards: [], builtAt: 0 }
let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollStop = false
/** Obsidian 插件启动时上报的当前 vault 根目录（手动配置留空时的默认值）。 */
let reportedVaultDir = ""

function cfg(ctx: HostContext) {
  const c = ctx.config()
  // 扫描根：手动配置支持 ; 分隔多根；Obsidian 插件上报的当前 vault 始终并入
  // （换 vault 测试零配置）。第一根作为 task_create 相对路径的基准。
  const manual = String(c.vaultDir ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
  const roots = [...manual]
  if (reportedVaultDir && !roots.some((r) => norm(r) === norm(reportedVaultDir))) roots.push(reportedVaultDir)
  return {
    vaultDirs: roots,
    vaultDir: roots[0] ?? "",
    doneColumns: String(c.doneColumns ?? "已完成,Done,完成")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    pollSeconds: Number(c.pollSeconds ?? 15),
    sessionModel: parseModelRef(String(c.sessionModel ?? "").trim()),
    pathMap: parsePathMap(String(c.pathMap ?? "")),
  }
}
function parseModelRef(s: string): ModelRef | undefined {
  const i = s.indexOf("/")
  if (i <= 0 || i >= s.length - 1) return undefined
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

/** Recursively list *.md under a dir (skips dot-dirs, node_modules). */
function listMd(dir: string, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue
    const p = join(dir, e.name)
    if (e.isDirectory()) listMd(p, out)
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(p)
  }
  return out
}

/** Rebuild the registry: discover boards, resolve their card links to files. */
function buildRegistry(vaultDirs: string[]): Registry {
  const files: string[] = []
  const seenRoot = new Set<string>()
  for (const root of vaultDirs) {
    const nr = norm(root)
    if (!root || seenRoot.has(nr) || !existsSync(root)) continue
    seenRoot.add(nr)
    listMd(root, files)
  }
  // basename → candidate paths (for [[link]] resolution)
  const byBase = new Map<string, string[]>()
  for (const f of files) {
    const b = basename(f).replace(/\.md$/i, "").toLowerCase()
    const arr = byBase.get(b) ?? []
    arr.push(f)
    byBase.set(b, arr)
  }
  const boards: Array<{ path: string; raw: string; columns: BoardColumn[] }> = []
  for (const f of files) {
    let raw = ""
    try {
      raw = readFileSync(f, "utf8")
    } catch {
      continue
    }
    if (isBoardFile(raw)) boards.push({ path: f, raw, columns: parseBoard(raw) })
  }
  const tasks = new Map<string, TaskMeta>()
  const byId = new Map<string, string>()
  for (const board of boards) {
    const root = vaultDirs.find((r) => norm(board.path).startsWith(norm(r) + "/")) ?? vaultDirs[0] ?? ""
    const boardProject = boardProjectName(board.path, board.raw, root)
    for (const col of board.columns) {
      for (const card of col.cards) {
        const cands = byBase.get(card.link.toLowerCase())
        const file = cands && cands.length ? cands[0] : undefined
        if (!file) continue // dangling link — not a resolvable task
        const np = norm(file)
        if (tasks.has(np)) {
          // same task linked on multiple boards/columns — first wins for status
          continue
        }
        const meta = readTaskMeta(file, board.path, col.name, boardProject)
        if (meta) {
          tasks.set(np, meta)
          byId.set(meta.id.toLowerCase(), np)
        }
      }
    }
  }
  // 卡片标题徽章已下线（待办完成度改由看板 fork 的卡片脚注展示）——
  // 这里只做一次性清理：把历史写入的 ` · n/N` 尾巴剥掉（无徽章时零写入）。
  for (const b of boards) {
    const next = stripCardBadges(b.raw)
    if (next) {
      try {
        writeFileSync(b.path, next, "utf8")
      } catch {
        /* board busy — next refresh */
      }
    }
  }

  return {
    tasks,
    byId,
    boards: boards.map((b) => ({ path: b.path, columns: b.columns.map((c) => c.name) })),
    builtAt: Date.now(),
  }
}

/** Project name for a board: frontmatter.project → containing folder → filename. */
function boardProjectName(path: string, raw: string, vaultDir: string): string {
  const p = parseFrontmatter(raw)
  const fmProj = p && typeof p.fm.project === "string" ? p.fm.project : ""
  if (fmProj) return fmProj
  const rel = norm(path).startsWith(norm(vaultDir) + "/") ? path.slice(vaultDir.length + 1) : path
  const parts = rel.split(/[\\/]/)
  return parts.length > 1 ? parts[0] : basename(path).replace(/\.md$/i, "")
}

function readTaskMeta(file: string, board: string, column: string, boardProject: string): TaskMeta | null {
  let raw = ""
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return null
  }
  const parsed = parseFrontmatter(raw)
  const fm = parsed?.fm ?? {}
  const body = parsed?.body ?? raw
  const id = basename(file).replace(/\.md$/i, "")
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    /* ignore */
  }
  return {
    id,
    title: h1 || (typeof fm.title === "string" ? fm.title : "") || id,
    project: (typeof fm.project === "string" && fm.project) || boardProject,
    type: (typeof fm.type === "string" && fm.type) || "",
    status: column,
    board,
    sessions: Array.isArray(fm.sessions) ? fm.sessions : [],
    pha_issue: typeof fm.pha_issue === "string" ? fm.pha_issue : "",
    todos: (() => {
      const t = parseTodos(body)
      return { done: t.done, total: t.total }
    })(),
    path: file,
    mtimeMs,
  }
}

function refreshRegistry(ctx: HostContext): Registry {
  reg = buildRegistry(cfg(ctx).vaultDirs)
  return reg
}

/** Resolve an id-or-path to a task file + fresh parse. Rebuilds if stale/miss. */
function resolveTask(ctx: HostContext, idOrPath: string): { meta: TaskMeta; fm: Frontmatter; body: string; raw: string } | null {
  let np = norm(idOrPath)
  let path = reg.tasks.has(np) ? reg.tasks.get(np)!.path : reg.byId.get(idOrPath.toLowerCase())
  if (!path) {
    refreshRegistry(ctx)
    np = norm(idOrPath)
    path = reg.tasks.has(np) ? reg.tasks.get(np)!.path : reg.byId.get(idOrPath.toLowerCase())
  }
  if (!path) return null
  const meta = reg.tasks.get(norm(path))
  if (!meta) return null
  let raw = ""
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return null
  }
  const parsed = parseFrontmatter(raw)
  return { meta, fm: parsed?.fm ?? {}, body: parsed?.body ?? raw, raw }
}

/** Write a task file back (frontmatter + body); refresh that meta in the registry. */
function writeTask(t: { meta: TaskMeta }, fm: Frontmatter, body: string): void {
  writeFileSync(t.meta.path, serializeFrontmatter(fm, body), "utf8")
  const fresh = readTaskMeta(t.meta.path, t.meta.board, t.meta.status, t.meta.project)
  if (fresh) reg.tasks.set(norm(t.meta.path), fresh)
}

// ═════════════════════════════════════════════════════════════════════════════
// Template + launch contract
// ═════════════════════════════════════════════════════════════════════════════

function taskTemplate(input: { title: string; project: string; type: string; todos: string[]; date: string }): string {
  const fm: Frontmatter = {
    project: input.project,
    type: input.type,
    sessions: [],
    pha_issue: "",
    created: input.date,
  }
  const todos = (input.todos.length ? input.todos : ["（待补充）"]).map((t) => `- [ ] ${t}`).join("\n")
  const body = [
    `# ${input.title}`,
    "",
    "## 待办",
    todos,
    "",
    "---",
    "",
    LOG_HEADING,
    "",
    ...LOG_TABLE_HEADER,
    "",
  ].join("\n")
  return serializeFrontmatter(fm, body)
}

function launchContract(meta: TaskMeta, sessionId: string, docText: string, rules: PathRule[]): string {
  const recs = listRecordSections(docText.split(/\r?\n/).slice(1).join("\n"))
  const nextNum = recs.length ? String(Math.max(...recs.map((r) => Number(r.num.split(".")[0]))) + 1) : "1"
  return [
    `【taskflow】你在处理任务「${meta.title}」（id: ${meta.id}，项目 ${meta.project}）。你本次的 session id 是 ${sessionId}。`,
    `任务文档路径：Windows「${meta.path}」；你的运行环境内「${vmPathNote(rules, meta.path)}」。`,
    "",
    "文档布局：frontmatter（tag/pha/sessions）→「待办」（任务 todo list）→ `---` 分隔线 →",
    "**正文区**（编号章节 1 / 1.1 / 1.1.1，任务的方案/实施/验证/问题等实质内容）→ 置底「日志」表。",
    "",
    "可用工具（win-host MCP）——只能通过它们写文档，保证格式统一：",
    `- task_write_section(id="${meta.id}", section, title, content, mode?, complete_todo?)：`,
    "  【正文唯一入口】写编号章节。mode=replace 整章重写（默认）/ append 章节末尾追加增量。",
    "  content 里的 # 标题会被自动降级为粗体——层级只由章节号决定。",
    `  当前已有章节：${recs.length ? recs.map((r) => r.num).join(", ") : "（无）"}；新阶段从 ${nextNum} 开始，子步骤用 ${nextNum}.1、${nextNum}.2…`,
    `- task_todo(id="${meta.id}", action, text)：勾选/新增待办（action: check/uncheck/add）`,
    `- task_issue(id="${meta.id}", problem, cause?, solution)：问题+解决一次性记录（自动生成「问题」章节）`,
    `- task_log(id="${meta.id}", text, session="${sessionId}")：底部日志表追加一行——只在阶段完成时记，不要流水账`,
    `- task_set_status(id="${meta.id}", column)：移动看板卡片（列见看板）`,
    `- task_set_field(id="${meta.id}", key, value)：更新 type/pha_issue 字段`,
    `- task_get(id="${meta.id}")：读文档全文；task_list()：看板全览`,
    "（若这些工具不在你的工具列表里，就按上面的布局直接编辑任务文档，路径用「你的运行环境内」那个形态。）",
    "",
    "写文档的硬规则（这份文档是给人复查的，不是过程日志）：",
    "1. 只做「待办」里列出的事。",
    "2. 每完成一个阶段 → task_write_section 写一个编号章节 + complete_todo 勾掉对应待办",
    "   + task_log 记一行。章节 = 结论先行、关键数据用表格、命令/清单用代码块、决策写理由。",
    "3. **禁止**写入：探索过程的碎碎念、无结论的中间状态、与任务无关的边角信息、",
    "   大段原始输出（截取关键行即可）。写之前自问：这段被删掉会有人惋惜吗？不会就别写。",
    "4. 修改已有章节：同号 replace 整章重写；补充增量用 mode=append，别新开重复章节。",
    "5. 不要主动碰 PHA（同步由用户手动触发）。",
    "",
    "## 当前任务文档",
    "```markdown",
    docText,
    "```",
  ].join("\n")
}

/** PHA 手动同步指令 —— 概览为主，不必全文。 */
function phaSyncPrompt(meta: TaskMeta, docText: string): string {
  return [
    `【taskflow · 同步 PHA】把任务「${meta.title}」的进度同步到内网 PHA。`,
    "",
    "步骤：",
    `1. 若 frontmatter 的 pha_issue 为空 → 用你的 PHA 工具新建条目，然后 task_set_field(id="${meta.id}", key="pha_issue", value=<链接>) 回填。`,
    "2. 已有 pha_issue → 更新该条目。",
    "3. 同步内容以**概览为主，不必全文**：任务标题、当前看板状态、待办完成度（n/N + 各项勾选情况）、",
    "   「问题与解决」条目、以及「记录」里最新一两个章节的小结。",
    "4. 完成后用一句话回复同步结果（不要改动任务文档其它内容）。",
    "",
    "## 当前任务文档",
    "```markdown",
    docText,
    "```",
  ].join("\n")
}

// ═════════════════════════════════════════════════════════════════════════════
// Session orchestration (manual only — no auto dispatch)
// ═════════════════════════════════════════════════════════════════════════════

async function launch(
  ctx: HostContext,
  idOrPath: string,
  mode: "continue" | "new",
  kind: "work" | "pha" = "work",
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const t = resolveTask(ctx, idOrPath)
  if (!t) return { ok: false, error: `task_not_found: ${idOrPath}` }
  const conf = cfg(ctx)
  // session 工作目录：配置了路径映射就用对端（虚拟机/容器）形态，opencode 直接可用；
  // 未配置则原样传 Windows 路径（chat 层对同机场景有自己的兜底）。
  const projectDirWin = dirname(t.meta.path)
  const projectDir = mapPath(conf.pathMap, projectDirWin) ?? projectDirWin

  let sessionId: string | undefined
  let fresh = false
  if (mode === "continue" && t.meta.sessions.length > 0) {
    sessionId = t.meta.sessions[t.meta.sessions.length - 1]
  } else {
    const created = await ctx.native.chat.createSession(projectDir)
    if (!created.ok || !created.sessionId) return { ok: false, error: created.error ?? "createSession failed" }
    sessionId = created.sessionId
    fresh = true
  }

  if (fresh) {
    t.fm.sessions = [...(Array.isArray(t.fm.sessions) ? t.fm.sessions : []), sessionId]
    writeTask(t, t.fm, t.body)
    ctx.emit("taskflow:changed", { id: t.meta.id })
  }

  const doc = readFileSync(t.meta.path, "utf8")
  const text = kind === "pha" ? phaSyncPrompt(t.meta, doc) : launchContract(t.meta, sessionId, doc, conf.pathMap)
  void ctx.native.chat
    .send({ text, sessionId, model: conf.sessionModel, directory: projectDir })
    .catch((e) => ctx.log(`launch send failed (${t.meta.id})`, e))
  return { ok: true, sessionId }
}

function associate(ctx: HostContext, idOrPath: string, sessionId: string, add: boolean): { ok: boolean; error?: string; sessions?: string[] } {
  const t = resolveTask(ctx, idOrPath)
  if (!t) return { ok: false, error: `task_not_found: ${idOrPath}` }
  const cur = Array.isArray(t.fm.sessions) ? t.fm.sessions : []
  const next = add ? [...new Set([...cur, sessionId])] : cur.filter((s) => s !== sessionId)
  t.fm.sessions = next
  writeTask(t, t.fm, t.body)
  ctx.emit("taskflow:changed", { id: t.meta.id, sessions: next })
  return { ok: true, sessions: next }
}

// ═════════════════════════════════════════════════════════════════════════════
// Agent tools (win-host MCP) — format-enforcing; this is where standardization
// actually comes from (the agent CANNOT free-form the doc).
// ═════════════════════════════════════════════════════════════════════════════

const tools: McpToolDef[] = [
  {
    name: "task_list",
    description:
      "看板全览：列出所有看板（路径、列名）和每列下已有的任务（id/标题/类型/待办完成度/文档路径）。" +
      "创建新任务或查找既有任务前先调用它——确认任务是否已存在、应放哪个看板哪一列。",
    inputSchema: { type: "object", properties: {} },
    async handler(_args, ctx) {
      const conf = cfg(ctx)
      if (!conf.vaultDirs.length) return { text: "扫描根目录未配置（管理 → 任务看板，或打开 Obsidian 让插件自动上报）", isError: true }
      refreshRegistry(ctx)
      const out: string[] = [
        ...conf.vaultDirs.map((r, i) => `扫描根目录${conf.vaultDirs.length > 1 ? ` ${i + 1}` : ""}: ${r}（你的环境内: ${vmPathNote(conf.pathMap, r)}）`),
        "",
      ]
      for (const b of reg.boards) {
        out.push(`看板: ${b.path}`)
        for (const col of b.columns) {
          const inCol = [...reg.tasks.values()].filter((t) => t.board === b.path && t.status === col)
          out.push(`  列「${col}」(${inCol.length}):`)
          for (const t of inCol) {
            out.push(
              `    - ${t.id}｜${t.title}｜类型:${t.type || "—"}｜待办:${t.todos.done}/${t.todos.total}` +
                `｜PHA:${t.pha_issue ? "已链" : "无"}｜文档: ${mapPath(conf.pathMap, t.path) ?? t.path}`,
            )
          }
        }
        out.push("")
      }
      if (reg.boards.length === 0) out.push("（没有发现任何 Kanban 看板）")
      return { text: out.join("\n") }
    },
  },
  {
    name: "task_get",
    description: "读取一个 taskflow 任务文档的全文（id = 文档文件名，如「低温启动bug」）。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const rules = cfg(ctx).pathMap
      return { text: `路径(Windows): ${t.meta.path}\n路径(你的环境): ${vmPathNote(rules, t.meta.path)}\n\n${t.raw}` }
    },
  },
  {
    name: "task_create",
    description:
      "按统一模板新建任务文档，并在指定看板列插入卡片。" +
      "调用前必须做两件事：① task_list 查看已有任务与看板列，避免重复创建；" +
      "② dir（文档存放目录）和 column（看板列）如果用户没有明说，先在对话里询问用户确认，不要擅自决定。" +
      "创建后若任务还没有 PHA：在有 PHA 工具的会话里建一个 PHA 条目并用 task_set_field 回填 pha_issue，或提醒用户稍后处理。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "任务标题（也是文件名）" },
        dir: {
          type: "string",
          description: "文档存放目录：绝对 Windows 路径，或相对扫描根目录的相对路径（如「机型X/03-bug修复」）。用户没指定时先询问用户。",
        },
        project: { type: "string", description: "所属项目（用于挑看板）" },
        column: { type: "string", description: "看板列名（即任务类型/状态分组）。不确定先 task_list 看有哪些列、再问用户。" },
        board: { type: "string", description: "可选，看板文件名或路径；多看板且 project 无法定位时指定" },
        type: { type: "string", description: "任务类型，如 bug修复/硬件适配/产测" },
        todos: { type: "array", items: { type: "string" }, description: "初始待办清单" },
      },
      required: ["title", "dir"],
    },
    async handler(args, ctx) {
      const conf = cfg(ctx)
      if (!conf.vaultDirs.length) return { text: "扫描根目录未配置（管理 → 任务看板，或打开 Obsidian 让插件自动上报）", isError: true }
      const title = String(args.title ?? "").trim()
      if (!title) return { text: "title required", isError: true }
      const dirArg = String(args.dir ?? "").trim()
      if (!dirArg) {
        return {
          text: "缺少 dir（文档存放目录）。请先 task_list 查看现有结构，然后在对话里询问用户想把任务文档放在哪个目录、归到看板哪一列，再带上 dir/column 重新调用。",
          isError: true,
        }
      }
      // 绝对路径 = 盘符 或 UNC（\\server\share / //server/share）；否则相对第一个扫描根
      const isAbs = /^[A-Za-z]:[\\/]/.test(dirArg) || /^(\\\\|\/\/)/.test(dirArg)
      const dir = isAbs ? dirArg : join(conf.vaultDir, dirArg)
      if (!conf.vaultDirs.some((r) => norm(dir).startsWith(norm(r)))) {
        return { text: `目录必须在扫描根目录内: ${conf.vaultDirs.join(" 或 ")}`, isError: true }
      }
      mkdirSync(dir, { recursive: true })
      const safe = title.replace(/[\\/:*?"<>|]/g, "·")
      let file = join(dir, `${safe}.md`)
      let n = 2
      while (existsSync(file)) file = join(dir, `${safe}-${n++}.md`)
      const todos = Array.isArray(args.todos) ? args.todos.map(String) : []
      writeFileSync(
        file,
        taskTemplate({
          title,
          project: String(args.project ?? ""),
          type: String(args.type ?? ""),
          todos,
          date: new Date().toISOString().slice(0, 10),
        }),
        "utf8",
      )
      // 挑看板：显式 board 参数 → project 匹配 → 第一个
      refreshRegistry(ctx)
      const boardArg = String(args.board ?? "").trim().toLowerCase()
      const board =
        (boardArg &&
          reg.boards.find((b) => norm(b.path) === norm(boardArg) || basename(b.path).toLowerCase().startsWith(boardArg))?.path) ||
        reg.boards.find((b) => {
          const root = conf.vaultDirs.find((r) => norm(b.path).startsWith(norm(r) + "/")) ?? conf.vaultDir
          return boardProjectName(b.path, safeRead(b.path), root) === String(args.project)
        })?.path ||
        reg.boards[0]?.path
      const base = basename(file).replace(/\.md$/i, "")
      let cardNote = "（未找到看板，请手动把 [[链接]] 加到看板）"
      if (board) {
        try {
          writeFileSync(board, addCard(readFileSync(board, "utf8"), base, String(args.column ?? "").trim() || undefined), "utf8")
          cardNote = `（已加入看板${args.column ? `「${args.column}」列` : "第一列"}）`
        } catch (e) {
          ctx.log("task_create: add card failed", e)
          cardNote = "（看板写入失败，请手动加卡片）"
        }
      }
      refreshRegistry(ctx)
      ctx.emit("taskflow:changed", { id: base })
      return { text: `created: ${file}\n你的环境内路径: ${vmPathNote(conf.pathMap, file)}\n${cardNote}` }
    },
  },
  {
    name: "task_todo",
    description: "勾选/取消/新增任务待办。action: check(完成) | uncheck(取消) | add(新增)。text 是待办文本（check 时做包含匹配）。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        action: { type: "string", enum: ["check", "uncheck", "add"] },
        text: { type: "string" },
      },
      required: ["id", "action", "text"],
    },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const action = String(args.action) as "check" | "uncheck" | "add"
      const next = editTodo(t.body, action, String(args.text ?? ""))
      if (next === t.body && action !== "add") return { text: `没找到匹配的待办：${args.text}`, isError: true }
      writeTask(t, t.fm, next)
      ctx.emit("taskflow:changed", { id: t.meta.id })
      return { text: `ok: ${action} ${args.text}` }
    },
  },
  {
    name: "task_write_section",
    description:
      "【记录任务正文的唯一方式】向任务正文区（--- 分隔线之后）写一个编号章节。" +
      "section 是章节号（1 / 1.2 / 1.2.3，最多三级；层级/排序由工具控制）；" +
      "mode=replace（默认）同号章节整体重写（子章节保留），mode=append 在既有章节末尾追加增量内容。" +
      "content 是 Markdown 正文（数据用表格、命令用代码块；里面的 # 标题会被自动降级为粗体——结构只能由工具产生）。" +
      "只写有效信息：结论先行、关键数据、决策理由；过程性碎碎念留在会话里，不要进文档。" +
      "传 complete_todo（待办文本包含匹配）可同时勾掉待办。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        section: { type: "string", description: "章节号，如 1、1.2、1.2.3（最多三级）" },
        title: { type: "string", description: "章节标题（append 模式下留空=保持原标题）" },
        content: { type: "string", description: "章节正文（Markdown）" },
        mode: { type: "string", enum: ["replace", "append"], description: "replace=整章重写(默认)；append=章节末尾追加" },
        complete_todo: { type: "string", description: "可选：同时勾掉的待办（文本包含匹配）" },
      },
      required: ["id", "section", "content"],
    },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const content = String(args.content ?? "")
      if (content.length > 6000) {
        return {
          text: `content 过长（${content.length} 字符 > 6000）。请精炼：只保留结论、关键数据（表格）与决策理由；细节过程不进文档。也可以拆成多个子章节分次写入。`,
          isError: true,
        }
      }
      const mode = args.mode === "append" ? "append" : "replace"
      const next = writeRecordSection(t.body, String(args.section ?? ""), String(args.title ?? ""), content, mode)
      if (!next) return { text: `非法章节号：${args.section}（应为 1 / 1.2 / 1.2.3，最多三级）`, isError: true }
      let body = next
      let todoNote = ""
      const todo = String(args.complete_todo ?? "").trim()
      if (todo) {
        const after = editTodo(body, "check", todo)
        todoNote = after === body ? `；待办未匹配到「${todo}」` : `；已勾掉待办「${todo}」`
        body = after
      }
      writeTask(t, t.fm, body)
      ctx.emit("taskflow:changed", { id: t.meta.id })
      return { text: `ok: 章节 ${args.section} 已${mode === "append" ? "追加" : "写入"}${todoNote}` }
    },
  },
  {
    name: "task_log",
    description:
      "向文档底部的「日志」表追加一行阶段性记录（时间|会话|记录）。只在阶段完成/状态变化时记一条，不要流水账。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" }, session: { type: "string" } },
      required: ["id", "text"],
    },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const stamp = new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      const sess = String(args.session ?? "").trim()
      writeTask(t, t.fm, appendLogRow(t.body, stamp, sess ? `…${sess.slice(-6)}` : "", String(args.text ?? "")))
      ctx.emit("taskflow:changed", { id: t.meta.id })
      return { text: "ok: 日志已记录" }
    },
  },
  {
    name: "task_set_field",
    description: "更新任务 frontmatter 字段。仅允许 type / pha_issue（PHA 链接回填用这个）。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        key: { type: "string", enum: ["type", "pha_issue"] },
        value: { type: "string" },
      },
      required: ["id", "key", "value"],
    },
    async handler(args, ctx) {
      const key = String(args.key ?? "")
      if (!["type", "pha_issue"].includes(key)) return { text: `field not allowed: ${key}`, isError: true }
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      t.fm[key] = String(args.value ?? "")
      writeTask(t, t.fm, t.body)
      ctx.emit("taskflow:changed", { id: t.meta.id })
      return { text: `ok: ${t.meta.id}.${key} = ${args.value}` }
    },
  },
  {
    name: "task_issue",
    description:
      "记录一个问题及其解决（task_write_section 的语法糖）：自动取下一个顶级章节号，" +
      "生成固定结构的「问题」章节（现象/根因/解决）。适合遇到并解决问题后一次性记录。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        problem: { type: "string", description: "问题现象（一两句）" },
        cause: { type: "string", description: "可选：根因" },
        solution: { type: "string", description: "解决办法/结论" },
      },
      required: ["id", "problem", "solution"],
    },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const tops = listRecordSections(t.body)
        .map((s) => Number(s.num.split(".")[0]))
        .filter((n) => Number.isFinite(n))
      const nextNum = String((tops.length ? Math.max(...tops) : 0) + 1)
      const problem = String(args.problem ?? "").trim()
      const cause = String(args.cause ?? "").trim()
      const content = [
        `**现象**：${problem}`,
        ...(cause ? ["", `**根因**：${cause}`] : []),
        "",
        `**解决**：${String(args.solution ?? "").trim()}`,
      ].join("\n")
      const title = `问题：${problem.slice(0, 24)}${problem.length > 24 ? "…" : ""}`
      const next = writeRecordSection(t.body, nextNum, title, content)
      if (!next) return { text: "internal: chapter write failed", isError: true }
      writeTask(t, t.fm, next)
      ctx.emit("taskflow:changed", { id: t.meta.id })
      return { text: `ok: 已记录为章节 ${nextNum}` }
    },
  },
  {
    name: "task_set_status",
    description: "移动任务在看板上的卡片到指定列（= 改状态）。column 必须是该看板已有的列名。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, column: { type: "string" } }, required: ["id", "column"] },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const conf = cfg(ctx)
      const column = String(args.column ?? "").trim()
      let boardRaw = ""
      try {
        boardRaw = readFileSync(t.meta.board, "utf8")
      } catch {
        return { text: "board unreadable", isError: true }
      }
      const checked = conf.doneColumns.includes(column.toLowerCase())
      const next = moveCard(boardRaw, t.meta.id, column, checked)
      if (!next) return { text: `移动失败：看板里没有卡片或列「${column}」`, isError: true }
      writeFileSync(t.meta.board, next, "utf8")
      refreshRegistry(ctx)
      ctx.emit("taskflow:changed", { id: t.meta.id, status: column })
      return { text: `ok: ${t.meta.id} → ${column}` }
    },
  },
  {
    name: "task_normalize",
    description:
      "非破坏性规范化一篇任务文档到 v5 布局：补齐缺失的 frontmatter 字段、待办小节、--- 分隔线、置底日志表。不改动任何已有内容。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const fm = { ...t.fm }
      for (const [k, dv] of Object.entries({ project: t.meta.project, type: "", sessions: [], pha_issue: "" })) {
        if (fm[k] === undefined) fm[k] = dv as string | string[]
      }
      writeTask(t, fm, ensureLayout(t.body))
      ctx.emit("taskflow:changed", { id: t.meta.id })
      return { text: "ok: 已补齐 frontmatter 与 v5 布局（未改动原内容）" }
    },
  },
]

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return ""
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Routes (panels + Obsidian plugin)
// ═════════════════════════════════════════════════════════════════════════════

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/tasks",
    async handler(_req, ctx) {
      const conf = cfg(ctx)
      if (!conf.vaultDirs.length)
        return { body: { ok: false, error: "扫描根目录未配置（管理 → 任务看板，或打开 Obsidian 让插件自动上报）", tasks: [], boards: [] } }
      refreshRegistry(ctx)
      return {
        body: {
          ok: true,
          tasks: [...reg.tasks.values()],
          boards: reg.boards,
          doneColumns: conf.doneColumns,
        },
      }
    },
  },
  {
    method: "POST",
    path: "/scan",
    async handler(_req, ctx) {
      refreshRegistry(ctx)
      return { body: { ok: true, count: reg.tasks.size } }
    },
  },
  {
    // Obsidian 插件启动时上报当前 vault 根目录 —— vaultDir 未手动配置时的默认值。
    method: "POST",
    path: "/vault",
    async handler(req, ctx) {
      const path = String(req.body?.path ?? "").trim()
      if (path && existsSync(path)) {
        const changed = reportedVaultDir !== path
        reportedVaultDir = path
        if (changed) {
          ctx.log(`vault reported by obsidian: ${path}`)
          refreshRegistry(ctx)
          ctx.emit("taskflow:changed", {})
        }
      }
      return { body: { ok: true, effective: cfg(ctx).vaultDirs } }
    },
  },
  {
    // Obsidian plugin posts the active file's ABSOLUTE path; we resolve whether
    // it's a task and broadcast taskflow:focus so the console reacts.
    method: "POST",
    path: "/focus",
    async handler(req, ctx) {
      const path = String(req.body?.path ?? "")
      if (!path) {
        ctx.emit("taskflow:focus", { found: false })
        return { body: { ok: true, found: false } }
      }
      let meta = reg.tasks.get(norm(path))
      if (!meta) {
        refreshRegistry(ctx)
        meta = reg.tasks.get(norm(path))
      }
      if (!meta) {
        ctx.emit("taskflow:focus", { found: false, path })
        return { body: { ok: true, found: false } }
      }
      const payload = {
        found: true,
        id: meta.id,
        title: meta.title,
        project: meta.project,
        status: meta.status,
        sessions: meta.sessions,
        todos: meta.todos,
      }
      ctx.emit("taskflow:focus", payload)
      return { body: { ok: true, ...payload } }
    },
  },
  {
    method: "POST",
    path: "/launch",
    async handler(req, ctx) {
      const id = String(req.body?.id ?? req.body?.path ?? "")
      const mode = req.body?.mode === "new" ? "new" : "continue"
      const r = await launch(ctx, id, mode)
      return { body: r, status: r.ok ? 200 : 400 }
    },
  },
  {
    // 手动同步 PHA：向任务会话（优先复用最近的）发同步指令，概览为主不全文。
    method: "POST",
    path: "/task/sync-pha",
    async handler(req, ctx) {
      const id = String(req.body?.id ?? req.body?.path ?? "")
      const r = await launch(ctx, id, "continue", "pha")
      return { body: r, status: r.ok ? 200 : 400 }
    },
  },
  {
    method: "POST",
    path: "/associate",
    async handler(req, ctx) {
      const r = associate(ctx, String(req.body?.id ?? ""), String(req.body?.sessionId ?? ""), true)
      return { body: r, status: r.ok ? 200 : 400 }
    },
  },
  {
    method: "POST",
    path: "/dissociate",
    async handler(req, ctx) {
      const r = associate(ctx, String(req.body?.id ?? ""), String(req.body?.sessionId ?? ""), false)
      return { body: r, status: r.ok ? 200 : 400 }
    },
  },
]

// ═════════════════════════════════════════════════════════════════════════════
// Capability
// ═════════════════════════════════════════════════════════════════════════════

export const taskflowCapability: Capability = {
  id: "taskflow",
  title: "任务看板",
  icon: "list-checks",
  description: "看板中心的任务-会话关联台：解析 Obsidian Kanban 看板，连接任务⇄session⇄PHA，标准化文档，从任务一键启动/继续会话。",
  hasPanel: true,
  events: ["taskflow:focus", "taskflow:changed"],
  configSchema: {
    fields: [
      {
        key: "vaultDir",
        label: "扫描根目录",
        type: "string",
        placeholder: "留空=自动用当前 Obsidian vault；多根用 ; 分隔；支持 UNC 如 \\\\192.168.56.100\\share",
        help: "taskflow 在这些目录下递归查找 Obsidian Kanban 看板（含 kanban-plugin: board 的文件）；看板上 [[链接]] 到的文档即任务。多根用 ; 分隔；Obsidian 插件上报的当前 vault 始终自动并入（换 vault 无需改配置）。",
      },
      {
        key: "doneColumns",
        label: "完成列名",
        type: "string",
        default: "已完成,Done,完成",
        help: "逗号分隔；卡片移到这些列时自动打勾，面板里归为已完成。",
      },
      {
        key: "pathMap",
        label: "路径映射",
        type: "string",
        placeholder: "如 C:\\Users\\me\\Documents\\Obsidian Vault=/media/sf_vault",
        help:
          "Windows 路径 → opencode 运行环境（VirtualBox 共享目录/WSL 等）的前缀映射，多条用 ; 分隔，最长前缀优先。" +
          "配置后 task_* 工具会给出 agent 可直接读写的路径，session 工作目录也用映射后的形态。",
      },
      { key: "pollSeconds", label: "刷新间隔(秒)", type: "number", default: 15, help: "刷新看板/任务缓存的间隔（供焦点联动与面板）。0=不主动刷新。" },
      { key: "sessionModel", label: "会话模型(可选)", type: "string", placeholder: "provider/model，留空用默认" },
    ],
  },
  tools,
  routes,

  init(ctx) {
    pollStop = false
    if (pollTimer) clearTimeout(pollTimer)
    const tick = () => {
      if (pollStop) return
      const conf = cfg(ctx)
      if (conf.pollSeconds <= 0 || !conf.vaultDirs.length) {
        pollTimer = setTimeout(tick, 30_000)
        return
      }
      try {
        refreshRegistry(ctx)
      } catch (e) {
        ctx.log("registry refresh failed", e)
      }
      pollTimer = setTimeout(tick, Math.max(5, conf.pollSeconds) * 1000)
    }
    pollTimer = setTimeout(tick, 3_000)
  },

  dispose() {
    pollStop = true
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
  },
}
