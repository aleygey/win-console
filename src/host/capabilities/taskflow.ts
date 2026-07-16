/**
 * taskflow capability v5.3 — 看板中心 · 人驱动 · 系统只做记录/连接/标准化。
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
 * 没有自动派发、没有轮询状态机——poll 仅用于刷新注册表缓存（供看板脚注/面板）。
 *
 * 与 opencode 的接口：MCP 工具（task_*）。任务文档和看板是受管资产；agent
 * 不得绕过工具直接编辑，工具不可用或调用失败时应停下并向用户报告。
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

/** 行扫描：找第一个「围栏外」满足条件的行号；无 → -1。 */
function findLineOutsideFence(lines: string[], pred: (trimmed: string) => boolean): number {
  const fence = fenceTracker()
  for (let i = 0; i < lines.length; i++) {
    if (fence.feed(lines[i]) || fence.inFence()) continue
    if (pred(lines[i].trim())) return i
  }
  return -1
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
  lines = out.split(/\r?\n/)
  if (findLineOutsideFence(lines, (t) => t === "---") < 0) {
    // 缺状态区分隔线：日志已存在时插到日志之前（正文区必须在日志上方），否则贴文末
    const logAt = findLineOutsideFence(lines, (t) => t === LOG_HEADING)
    if (logAt >= 0) {
      let p = logAt
      while (p > 0 && lines[p - 1].trim() === "") p--
      out = [...lines.slice(0, p), "", "---", "", ...lines.slice(logAt)].join("\n")
    } else {
      out = out.replace(/\s*$/, "") + "\n\n---\n"
    }
  }
  lines = out.split(/\r?\n/)
  if (findLineOutsideFence(lines, (t) => t === LOG_HEADING) < 0) {
    out = out.replace(/\s*$/, "") + `\n\n${LOG_HEADING}\n\n${LOG_TABLE_HEADER.join("\n")}\n`
  }
  return out
}

/** 正文区（章节区）的行范围：第一条 `---` 之后，`## 日志` 之前。
 *  两个边界都只认代码围栏之外的行——章内代码块里的 `---`/`## 日志` 是字面量。 */
function chapterZone(lines: string[]): { start: number; end: number } {
  let start = 0
  const f1 = fenceTracker()
  for (let i = 0; i < lines.length; i++) {
    if (f1.feed(lines[i]) || f1.inFence()) continue
    if (lines[i].trim() === "---") {
      start = i + 1
      break
    }
  }
  let end = lines.length
  const f2 = fenceTracker()
  for (let i = start; i < lines.length; i++) {
    if (f2.feed(lines[i]) || f2.inFence()) continue
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
// 「记录」章节写入 — 线性分章节的任务过程记录（1 / 1.2 / 1.2.3 / 1.2.3.4）。
// 结构（编号+标题+层级）由工具控制，内容是 agent 的自由 Markdown（表格等均可）。
// ═════════════════════════════════════════════════════════════════════════════

export const MAX_SECTION_DEPTH = 4

/** "1.2.3.4" → [1,2,3,4]；非法/超过 MAX_SECTION_DEPTH 级 → null。 */
export function parseSecNum(s: string): number[] | null {
  const value = s.trim()
  if (!/^\d+(\.\d+)*$/.test(value)) return null
  const parts = value.split(".").map(Number)
  return parts.length <= MAX_SECTION_DEPTH ? parts : null
}

function cmpSecNum(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1
    const y = b[i] ?? -1
    if (x !== y) return x - y
  }
  return 0
}

/** 代码围栏追踪器：``` 与 ~~~ 分开配对——``` 块内的 ~~~ 行是字面量，不翻转状态。 */
function fenceTracker(): { feed(line: string): boolean; inFence(): boolean; openMark(): string | null } {
  let open: string | null = null
  return {
    /** 喂一行；若该行本身是围栏边界行返回 true。 */
    feed(line: string): boolean {
      const m = /^\s*(```|~~~)/.exec(line)
      if (!m) return false
      if (open === null) open = m[1]
      else if (open === m[1]) open = null
      else return false // 另一种围栏出现在块内 = 字面量
      return true
    },
    inFence: () => open !== null,
    openMark: () => open,
  }
}

/** 一行是否是 Markdown 水平分隔线（---, ***, ___，允许尾随空白）。
 *  章内分隔线归工具管（章节间的 `---` 由 ensureChapterSeparators 统一维护），
 *  agent 在小节里手写的水平线一律剥掉。表格分隔行含 `|`，不会命中。 */
function isHRule(line: string): boolean {
  return /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
}

/** content 消毒：正文里的 markdown 标题会破坏章节解析边界（`##` 会截断
 *  「记录」区、伪编号标题会污染章节索引）——统一降级为粗体行。代码块内不动。
 *  章内手写的水平线（---）剥掉。未闭合的围栏自动补一行闭合——否则落盘后
 *  毒化整篇文档的章节扫描。这就是"结构只能由工具产生"的强制执行点。 */
export function sanitizeSectionContent(content: string): string {
  const out: string[] = []
  const fence = fenceTracker()
  for (const ln of content.split(/\r?\n/)) {
    if (fence.feed(ln)) {
      out.push(ln)
      continue
    }
    if (!fence.inFence() && isHRule(ln)) continue // 章内水平线剥掉
    const h = !fence.inFence() && /^\s*#{1,6}\s+(.*)$/.exec(ln)
    if (h) out.push(`**${h[1].trim()}**`)
    else out.push(ln)
  }
  if (fence.inFence()) out.push(fence.openMark()!)
  return out.join("\n")
}

/** content 结构化（v5.3）：把 content 里的 markdown 标题按相对层级映射成本章的
 *  编号小节——章(## N)内：第一级→### N.i、第二级→#### N.i.j、
 *  第三级→##### N.i.j.k，更深→粗体；对任意父节都按剩余深度做同样映射。
 *  标题原有的纯数字编号（"1."、"2.3"）剥掉换成工具分配的号；名字与内容不动。
 *  第一个一级标题之前出现的更深标题降为粗体（无处挂编号）。代码块内一律不动。
 *  childStart：一级小节起始编号（append 续号用）。 */
export function restructureSectionContent(content: string, parent: number[], childStart = 1): string {
  const depthAvail = MAX_SECTION_DEPTH - parent.length // 章下还能挂几层编号小节
  if (depthAvail <= 0) return sanitizeSectionContent(content)

  type Ln = { raw: string; level?: number; name?: string }
  const parsed: Ln[] = []
  const fence = fenceTracker()
  const levels = new Set<number>()
  for (const raw of content.split(/\r?\n/)) {
    if (fence.feed(raw)) {
      parsed.push({ raw })
      continue
    }
    if (!fence.inFence() && isHRule(raw)) continue // 章内手写水平线剥掉（分隔由工具管）
    const h = !fence.inFence() && /^\s*(#{1,6})\s+(.*)$/.exec(raw)
    if (h) {
      // 剥掉标题自带的编号（"1. 名字"/"2.3 名字"）——编号由工具统一分配。
      // 裸数字+空格（"2 号机测试"）不剥：那可能就是名字本身。
      const name = h[2].trim().replace(/^(\d+(\.\d+)+|\d+[.、．])\s*/, "")
      parsed.push({ raw, level: h[1].length, name })
      levels.add(h[1].length)
    } else parsed.push({ raw })
  }
  const tailClose = fence.inFence() ? [fence.openMark()!] : []
  // 无标题：从 parsed 重建（水平线已剔除），不能回退用原始 content。
  if (levels.size === 0) return [...parsed.map((p) => p.raw), ...tailClose].join("\n").replace(/\s+$/, "")

  // 相对层级：content 里出现的最浅标题=第一级，次浅=第二级，更深=第三级+
  const sorted = [...levels].sort((a, b) => a - b)
  const relOf = (lv: number) => sorted.indexOf(lv) + 1

  const out: string[] = []
  // 相对各级计数。第一级从 childStart 起（append 续号）；进入较浅层时重置其后各级。
  const counters = Array.from({ length: depthAvail }, () => 0)
  counters[0] = childStart - 1
  for (const ln of parsed) {
    if (ln.level === undefined) {
      out.push(ln.raw)
      continue
    }
    const rel = relOf(ln.level)
    const hasParents = rel === 1 || counters.slice(0, rel - 1).every((n, idx) => (idx === 0 ? n >= childStart : n > 0))
    if (rel <= depthAvail && hasParents) {
      counters[rel - 1]++
      for (let k = rel; k < counters.length; k++) counters[k] = 0
      const full = [...parent, ...counters.slice(0, rel)]
      out.push(`${"#".repeat(1 + full.length)} ${full.join(".")} ${ln.name}`)
    } else {
      out.push(`**${ln.name}**`)
    }
  }
  out.push(...tailClose)
  return out.join("\n").replace(/\s+$/, "")
}

const CHAPTER_RE = /^(#{2,5})\s+(\d+(?:\.\d+){0,3})\s+(.*)$/

/** 正文区里扫编号章节标题（fence 内不算——bash 注释「## 2 xxx」不是章节）。 */
function scanChapterHeads(lines: string[], zone: { start: number; end: number }): Array<{ line: number; num: number[] }> {
  const heads: Array<{ line: number; num: number[] }> = []
  const fence = fenceTracker()
  for (let i = zone.start; i < zone.end; i++) {
    if (fence.feed(lines[i]) || fence.inFence()) continue
    const m = CHAPTER_RE.exec(lines[i])
    if (m) {
      const n = parseSecNum(m[2])
      if (n) heads.push({ line: i, num: n })
    }
  }
  return heads
}

/** 顶级章之间补 `---` 分隔线（章更清晰）：每个 ## N（正文区里第一个除外）前面，
 *  隔空行处若没有 `---` 就插一条。只加不删——章内 agent 自己写的水平线不动。幂等。 */
export function ensureChapterSeparators(body: string): string {
  const lines = body.split(/\r?\n/)
  const zone = chapterZone(lines)
  const tops = scanChapterHeads(lines, zone).filter((h) => h.num.length === 1)
  // 从后往前插，行号不失效
  for (let t = tops.length - 1; t >= 1; t--) {
    const at = tops[t].line
    let p = at - 1
    while (p >= zone.start && lines[p].trim() === "") p--
    if (p >= zone.start && lines[p].trim() === "---") continue
    lines.splice(at, 0, "", "---", "")
  }
  return lines.join("\n")
}

/** 在正文区（`---` 与「## 日志」之间）写一个编号章节（v5.1）。
 *  - content 里的 markdown 标题自动编号成本章的小节（### N.i / #### N.i.j，
 *    更深→粗体）——agent 直接按习惯写标题即可，结构由工具规范；
 *  - mode="replace"（默认）：content 不含标题 → 只重写本章导语（已有编号子节保留）；
 *    content 含标题 → 整章连子节一起重写（新小节从 1 重新编号）；
 *  - mode="append"：追加到本章末尾，content 里的标题接着已有小节续号；
 *  - 不存在 → 按编号顺序插入正确位置；
 *  - 标题深度：1→##、1.1→###、1.1.1→####（Obsidian 大纲友好）；
 *  - 写完自动补顶级章之间的 `---` 分隔线。 */
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
  const heads = scanChapterHeads(lines, zone)

  const newHeading = `${"#".repeat(1 + num.length)} ${section} ${title.trim()}`
  const existing = heads.find((h) => cmpSecNum(h.num, num) === 0)
  const isChildOf = (h: { num: number[] }) => h.num.length > num.length && num.every((x, k) => h.num[k] === x)
  // content 里是否有会变成编号小节的标题（fence 外）——决定 replace 的替换范围
  const contentHasHeads = (() => {
    if (MAX_SECTION_DEPTH - num.length <= 0) return false
    const fence = fenceTracker()
    for (const ln of content.split(/\r?\n/)) {
      if (fence.feed(ln) || fence.inFence()) continue
      if (/^\s*#{1,6}\s+/.test(ln)) return true
    }
    return false
  })()
  // 插入点回退：越过空行 + 顶级章之间的 `---` 分隔线（分隔线归章界所有，
  // 内容必须插在它之前——否则分隔线被卷进章内逐次累积）
  const backOff = (at: number, floor: number): number => {
    let p = at
    while (p > floor && lines[p - 1].trim() === "") p--
    if (p > floor && lines[p - 1].trim() === "---") {
      p--
      while (p > floor && lines[p - 1].trim() === "") p--
    }
    return p
  }

  let out: string[] | null = null
  if (existing) {
    const idx = heads.indexOf(existing)
    // 本章已有编号子节的最大一级子号（append 续号的起点）
    const children = heads.filter((h) => h.num.length === num.length + 1 && isChildOf(h))
    const maxChild = children.reduce((m, h) => Math.max(m, h.num[num.length]), 0)
    if (mode === "append") {
      // 追加到整章（含子节）末尾；content 标题续号
      let end = zone.end
      for (let k = idx + 1; k < heads.length; k++) {
        if (!isChildOf(heads[k])) {
          end = heads[k].line
          break
        }
      }
      const clean = restructureSectionContent(content, num, maxChild + 1)
      const at = backOff(end, existing.line + 1)
      const head = title.trim() ? newHeading : lines[existing.line]
      out = [
        ...lines.slice(0, existing.line),
        head,
        ...lines.slice(existing.line + 1, at),
        "",
        clean,
        "",
        ...lines.slice(end),
      ]
    } else if (contentHasHeads) {
      // replace 且 content 自带小节 → 整章（含旧子节）重写，避免新旧小节重号并存
      let end = zone.end
      for (let k = idx + 1; k < heads.length; k++) {
        if (!isChildOf(heads[k])) {
          end = heads[k].line
          break
        }
      }
      const clean = restructureSectionContent(content, num, 1)
      out = [...lines.slice(0, existing.line), newHeading, "", clean, "", ...lines.slice(end)]
    } else {
      // replace 纯文本 → 只重写本章导语（到下一个编号标题为止，子节保留）
      const end = idx + 1 < heads.length ? heads[idx + 1].line : zone.end
      const clean = restructureSectionContent(content, num, maxChild + 1)
      out = [...lines.slice(0, existing.line), newHeading, "", clean, "", ...lines.slice(end)]
    }
  } else {
    // 新章节：插到第一个编号更大的标题之前；否则正文区末尾（日志之前）
    const clean = restructureSectionContent(content, num, 1)
    const after = heads.find((h) => cmpSecNum(h.num, num) > 0)
    let at = after ? after.line : zone.end
    if (!after) {
      while (at > zone.start && lines[at - 1].trim() === "") at--
    }
    // 尾部空行块不带进输出（否则每写一章多攒一行空行）
    const tail = lines.slice(at)
    while (tail.length && tail[0].trim() === "" && !after) tail.shift()
    out = [...lines.slice(0, at), newHeading, "", clean, "", ...tail]
  }
  return ensureChapterSeparators(out.join("\n"))
}

/** 列出正文区现有章节（给 task_list/契约用，agent 据此知道下一个编号）。 */
export function listRecordSections(body: string): Array<{ num: string; title: string }> {
  const lines = body.split(/\r?\n/)
  const zone = chapterZone(lines)
  const out: Array<{ num: string; title: string }> = []
  for (const h of scanChapterHeads(lines, zone)) {
    const m = CHAPTER_RE.exec(lines[h.line])!
    out.push({ num: m[2], title: m[3].trim() })
  }
  return out
}

/** 取正文区里某个编号章节的完整片段（含其编号子节，如取「1」带出 1.1/1.1.1）；
 *  章节不存在 → null。给 task_get 的单章节读取用。 */
export function extractSection(body: string, section: string): string | null {
  const num = parseSecNum(section)
  if (!num) return null
  const lines = body.split(/\r?\n/)
  const zone = chapterZone(lines)
  const heads = scanChapterHeads(lines, zone)
  const idx = heads.findIndex((h) => cmpSecNum(h.num, num) === 0)
  if (idx < 0) return null
  const start = heads[idx].line
  const isChildOf = (h: { num: number[] }) => h.num.length > num.length && num.every((x, k) => h.num[k] === x)
  let end = zone.end
  for (let k = idx + 1; k < heads.length; k++) {
    if (!isChildOf(heads[k])) {
      end = heads[k].line
      break
    }
  }
  // 去掉尾部空行与章间分隔线
  while (end > start && (lines[end - 1].trim() === "" || lines[end - 1].trim() === "---")) end--
  return lines.slice(start, end).join("\n")
}

export type SectionPatchError =
  | "invalid_section"
  | "section_not_found"
  | "empty_match"
  | "match_not_found"
  | "ambiguous_match"
  | "outline_changed"

export type SectionPatchResult =
  | { ok: true; body: string }
  | { ok: false; error: SectionPatchError }

/** 提取一段正文里的 Markdown 结构边界。比较替换前后签名可以识别由上下文拼接产生的
 * 标题/水平线/围栏，且不会把代码围栏内部的 `##`、`---` 当成结构。 */
function markdownStructureSignature(source: string): string {
  const marks: string[] = []
  const fence = fenceTracker()
  for (const line of source.split("\n")) {
    if (fence.feed(line)) {
      marks.push(`fence\t${line}`)
      continue
    }
    if (fence.inFence()) continue
    if (/^\s*#{1,6}\s+/.test(line)) marks.push(`heading\t${line}`)
    else if (isHRule(line)) marks.push(`hrule\t${line}`)
  }
  marks.push(`open\t${fence.openMark() ?? ""}`)
  return marks.join("\n")
}

/** 在一个已存在编号章节的正文范围内做精确、唯一替换。
 *
 * 这是 agent 更正一句结论、一个参数或一小段表格时的受控入口，避免为了小改动
 * 直接 edit 整个任务文件。oldText 必须在目标章节自身正文（不含子节）中恰好出现一次；
 * patch 不允许改变编号章节大纲，改标题/重组章节仍应走 replace。
 */
export function patchRecordSection(body: string, section: string, oldText: string, newText: string): SectionPatchResult {
  const num = parseSecNum(section)
  if (!num) return { ok: false, error: "invalid_section" }
  const needle = oldText.replace(/\r\n/g, "\n")
  if (!needle) return { ok: false, error: "empty_match" }

  // patch 不承担 normalize：目标范围之外的正文必须保持原样。
  const normalizedBody = body.replace(/\r\n/g, "\n")
  const lines = normalizedBody.split("\n")
  const zone = chapterZone(lines)
  const heads = scanChapterHeads(lines, zone)
  const idx = heads.findIndex((h) => cmpSecNum(h.num, num) === 0)
  if (idx < 0) return { ok: false, error: "section_not_found" }

  const current = heads[idx]
  // 只允许改该节自己的导语正文；遇到第一个编号子节/兄弟节就停止。
  // 想改子节必须显式传它的编号，避免父章 patch 误伤深层内容。
  const end = idx + 1 < heads.length ? heads[idx + 1].line : zone.end
  const start = current.line + 1 // 标题本身由 section/title 管，不允许 patch 偷改
  const source = lines.slice(start, end).join("\n")
  const matches = source.split(needle).length - 1
  if (matches === 0) return { ok: false, error: "match_not_found" }
  if (matches > 1) return { ok: false, error: "ambiguous_match" }

  const replacement = newText.replace(/\r\n/g, "\n")
  const patched = source.replace(needle, replacement)
  // 必须在拼回原文上下文后校验；只看 replacement 会漏掉 `##` + ` 标题`
  // 这类跨替换边界生成的结构。围栏内的 Markdown 字面量仍允许修改。
  if (markdownStructureSignature(patched) !== markdownStructureSignature(source)) return { ok: false, error: "outline_changed" }
  const next = [...lines.slice(0, start), ...patched.split("\n"), ...lines.slice(end)].join("\n")
  const outline = (s: string) => listRecordSections(s).map((x) => `${x.num}\t${x.title}`).join("\n")
  if (outline(next) !== outline(normalizedBody)) return { ok: false, error: "outline_changed" }
  return { ok: true, body: next }
}

// ═════════════════════════════════════════════════════════════════════════════
// Kanban board — read columns/cards and insert a new task card without ever
// reserializing the board's YAML settings block.
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

/** 显式配置是权威来源；只有显式配置为空时才回退到 Obsidian 当前 vault。
 *
 * 不能把两者无条件合并：同一共享目录可能同时以映射盘 Z:\ 和 UNC
 * \\server\share 出现，字符串去重无法识别它们是同一目录，最终会重复扫描和展示。
 */
export function resolveVaultDirs(manualRaw: string, reported: string): string[] {
  const manual = manualRaw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const unique = manual.filter((p) => {
    const key = norm(p)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length) return unique
  const fallback = reported.trim()
  return fallback ? [fallback] : []
}

function cfg(ctx: HostContext) {
  const c = ctx.config()
  // 扫描根：手动配置支持 ; 分隔多根并优先；留空时才跟随 Obsidian 当前 vault。
  // 第一根作为 task_create 相对路径的基准。
  const roots = resolveVaultDirs(String(c.vaultDir ?? ""), reportedVaultDir)
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

/** 按任务类型给 agent 一份最小证据清单；不是固定模板，避免为了填表而制造废话。 */
function recordingRubric(type: string): string[] {
  const t = type.toLowerCase()
  if (/bug|缺陷|故障|修复/.test(t)) {
    return [
      "本任务是 bug/故障修复，正文优先保留：现象与影响、环境/版本、最小复现、决定性根因证据、",
      "修复方案及取舍、原场景复测 + 回归/边界测试、残余风险。失败假设只有能防止以后重复踩坑时才浓缩记录。",
    ]
  }
  if (/产测|工装|治具|测试工具|烧录/.test(t)) {
    return [
      "本任务是产测/工装工具，正文优先保留：工位与 DUT 范围、仪器/夹具/固件/工具版本、输入输出与协议、",
      "pass/fail 阈值（单位/公差/超时/重试）、异常恢复与安全互锁、追溯数据、良品/坏品/边界/重复性验证、发布与回滚。",
    ]
  }
  if (/适配|功能|移植|兼容/.test(t)) {
    return [
      "本任务是功能/平台适配，正文优先保留：目标与验收边界、支持/不支持的平台版本矩阵、约束与兼容决策、",
      "接口/依赖/配置变化、实现要点、验证矩阵、发布/升级/回滚方式和已知限制。",
    ]
  }
  return [
    "本任务正文优先保留：目标与验收边界、约束和最终决策、关键实现变化、可复查的验证证据、",
    "风险/限制/未决项和下一步。按实际任务取舍，不要为了凑结构写空话。",
  ]
}

function launchContract(meta: TaskMeta, sessionId: string, docText: string, rules: PathRule[]): string {
  const recs = listRecordSections(docText.split(/\r?\n/).slice(1).join("\n"))
  const nextNum = recs.length ? String(Math.max(...recs.map((r) => Number(r.num.split(".")[0]))) + 1) : "1"
  return [
    `【taskflow】你在处理任务「${meta.title}」（id: ${meta.id}，项目 ${meta.project}）。你本次的 session id 是 ${sessionId}。`,
    `任务文档路径（只读定位）：Windows「${meta.path}」；你的运行环境内「${vmPathNote(rules, meta.path)}」。`,
    "",
    "## 写入协议（必须遵守）",
    "任务文档和 Kanban 看板是 Taskflow 受管资产。路径只用于定位；禁止使用 edit/write/apply_patch、shell、脚本、",
    "重定向或编辑器直接写任务 md/看板。所有变更必须调用工具列表中名称以 `task_…` 结尾的 win-host MCP 工具",
    "（通常显示为 `winhost_task_…`）。工具不可见或调用失败时，报告 `TASKFLOW_TOOL_UNAVAILABLE`，不得降级为直接编辑。",
    "代码仓库里的源文件不受此限制。下方任务文档只是只读快照。",
    "",
    "文档布局：frontmatter（project/type/sessions/pha_issue/created）→「待办」→ `---` →",
    "**正文区**（编号章节最多四级：1 / 1.1 / 1.1.1 / 1.1.1.1）→ 置底「日志」表。",
    "",
    "可用工具（按名称后缀识别，例如 task_write_section 通常显示为 winhost_task_write_section）：",
    `- task_write_section(id="${meta.id}", section, title?, content, mode?, old_text?, complete_todo?)：`,
    "  【正文唯一入口】写一个完整的顶级章节（section 用 1 / 2 / 3…）。一次把该阶段的所有小节",
    "  都写进 content，一步成型——别一个小节一个小节地分开调用。content 里小节直接用 markdown",
    "  标题标记，从几级开始都行（#/##/### 都可以，工具按相对深度排），工具自动编号成 ### N.1、",
    "  #### N.1.1、##### N.1.1.1（再深降为粗体）。**不用自己写 `---` 分隔线**（章间分隔工具管）。",
    "  结构化写：小节标题+列表+表格+代码块，别把一段塞成单行长文本。",
    "  mode=replace（默认）重写目标章 / append 章末追加续号；小范围更正必须先 task_get 目标节，再用",
    "  mode=patch + old_text 做章节自身正文内的唯一精确替换。patch 不得改标题/大纲。修改已有节前先读该节；新建节先读全文确认编号。",
    `  当前已有章节：${recs.length ? recs.map((r) => r.num).join(", ") : "（无）"}；新阶段从 ${nextNum} 开始。`,
    `- task_todo(id="${meta.id}", action, text)：只管理可执行下一步、阻塞和「待确认：…」（action: check/uncheck/add）`,
    `- task_issue(id="${meta.id}", problem, cause?, solution, verification)：仅在问题已定位、已解决并验证后生成「问题」章节`,
    `- task_log(id="${meta.id}", text, session="${sessionId}")：正文索引，只在阶段完成时记一句，不重复正文`,
    `- task_set_field(id="${meta.id}", key, value)：更新 type/pha_issue 字段`,
    `- task_get(id="${meta.id}", section?)：读全文/目标章节；修改已有节前读该节，新建节前读全文；task_list()：看板全览`,
    `- task_normalize(id="${meta.id}")：只在旧文档缺少 v5 布局时补齐结构`,
    "看板状态由用户在 Obsidian 中拖卡决定；不要直接编辑看板文件。",
    "",
    "## 记录标准：文档是可复用结论，不是会话转录",
    "只在稳定里程碑落正文：需求/边界确认、方案定稿、实现切片完成且有验证、根因由证据确认且修复验证、",
    "或重要问答形成最终结论。每个顶级章节应自洽，至少覆盖：结论；范围与关键变更/取舍；验证环境、方法与结果；遗留风险/限制。",
    "应保留版本、环境、关键指标、测试计数和 artifact/log 路径等可复查证据；大段日志只摘决定性行。",
    ...recordingRubric(meta.type),
    "",
    "问答不要复制聊天：未回答且阻塞的问题用 task_todo 新增「待确认：…」并询问用户；回答若改变需求、验收、",
    "设计、兼容或操作，就浓缩为「问题 / 最终结论 / 依据 / 影响」写进相关章节并勾掉待确认项。一次性权限、路径、",
    "是否继续等过程问题不记录；答案变化时保留最新批准结论，只有审计必要才简述替代原因。",
    "",
    "禁止写入：思维链和探索碎碎念、逐条命令、无结论中间状态、完整终端输出/完整 diff/整段聊天、",
    "未经证实的猜测、与任务无关的信息、密钥和不必要的敏感数据。失败尝试只有能排除高概率路径、避免未来重踩时才浓缩记录。",
    "新发现的必要工作不要静默扩范围：先询问用户，或用 task_todo 增加明确可验证的待办。",
    "每完成一个阶段：task_write_section 一次写全 + complete_todo 勾待办 + task_log 写一句索引。不要主动同步 PHA。",
    "",
    "## 当前任务文档（只读快照，禁止直接编辑）",
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
    "任务文档是 Taskflow 受管资产，禁止通过 edit/shell/脚本直接修改；需要回填链接时调用工具列表中名称以",
    "`task_set_field` 结尾的 win-host MCP 工具（通常显示为 `winhost_task_set_field`）。工具不可用就报告错误，不得直接编辑。",
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
// Agent tools (win-host MCP) — format-enforcing; this is where Taskflow applies
// its strongest in-protocol standardization. Filesystem policy is still the
// caller/runtime's responsibility, so every mutating tool also states the rule.
// ═════════════════════════════════════════════════════════════════════════════

const MANAGED_WRITE_RULE =
  "任务文档和看板是 Taskflow 受管资产：禁止用 edit/write/apply_patch、shell、脚本或重定向直接修改；所有变更必须调用 task_* 工具，工具不可用或失败时报告错误，不得绕过。"

const tools: McpToolDef[] = [
  {
    name: "task_list",
    description:
      "看板全览：列出所有看板（路径、列名）和每列下已有的任务（id/标题/类型/待办完成度/文档路径）。" +
      "创建新任务或查找既有任务前先调用它——确认任务是否已存在、应放哪个看板哪一列。" +
      MANAGED_WRITE_RULE,
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
    description:
      "读取一个 taskflow 任务文档（id = 文档文件名，如「低温启动bug」）。" +
      "不带 section = 读全文；带 section（如 1 / 1.2 / 1.2.3.4）= 只读该编号章节（含其子节）。" +
      "修改已有章节前必须先读取目标章节；新建章节前先读全文确认编号，避免覆盖旧结论和证据。" +
      MANAGED_WRITE_RULE,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        section: { type: "string", description: "可选：只读这个编号章节（如 1、1.2、1.2.3.4），含其编号子节" },
      },
      required: ["id"],
    },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const rules = cfg(ctx).pathMap
      const section = String(args.section ?? "").trim()
      if (section) {
        const frag = extractSection(t.body, section)
        if (!frag) {
          const avail = listRecordSections(t.body).map((r) => r.num).join(", ") || "（无）"
          return { text: `任务「${t.meta.id}」没有章节 ${section}。现有章节：${avail}`, isError: true }
        }
        return { text: `任务「${t.meta.id}」· 章节 ${section}：\n\n${frag}` }
      }
      return { text: `路径(Windows): ${t.meta.path}\n路径(你的环境): ${vmPathNote(rules, t.meta.path)}\n\n${t.raw}` }
    },
  },
  {
    name: "task_create",
    description:
      "按统一模板新建任务文档，并在指定看板列插入卡片。" +
      "调用前必须做两件事：① task_list 查看已有任务与看板列，避免重复创建；" +
      "② dir（文档存放目录）和 column（看板列）如果用户没有明说，先在对话里询问用户确认，不要擅自决定。" +
      "初始 todos 应是可验证的交付/验收项，不要填探索步骤或泛泛的『完成开发』。" +
      "创建后若任务还没有 PHA：在有 PHA 工具的会话里建一个 PHA 条目并用 task_set_field 回填 pha_issue，或提醒用户稍后处理。" +
      MANAGED_WRITE_RULE,
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
    description:
      "勾选/取消/新增任务待办。action: check(完成) | uncheck(取消) | add(新增)。text 是待办文本（check 时做包含匹配）。" +
      "待办只放可执行下一步、阻塞或『待确认：…』问题；知识结论应写正文，未解决问题不得伪装成已完成结论。" +
      MANAGED_WRITE_RULE,
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
      "【记录任务正文的唯一方式】向任务正文区（--- 分隔线之后）写章节，或在指定章节自身正文内做受控的局部更正。" +
      "section 用顶级章节号（1 / 2 / 3…）；一次把这个阶段的全部小节都写进 content，一步成型——" +
      "不要一个小节一个小节地分开调用（那样割裂又啰嗦）。" +
      "content 是 Markdown：小节直接用标题标记，从几级标题开始都行（#、##、### 都可以，工具按相对深度排）——" +
      "工具自动编号成本章的编号小节（### N.1、#### N.1.1、##### N.1.1.1，最多四级），小节名和内容随你定；数据用表格、命令用代码块。" +
      "不用自己写 `---` 分隔线（章节之间的分隔线由工具统一维护，写进去会被去掉）。" +
      "结构化写：小节标题+列表+表格+代码块，别把一大段塞成单行长文本。" +
      "mode=replace（默认）：content 含标题=整章连子节一起重写；不含标题=只重写本章导语（已有子节保留）。" +
      "mode=append：在本章末尾追加增量，content 里的小节自动接着已有编号续号（改已有章节别新开重复章节）。" +
      "mode=patch：必须先 task_get 目标节；old_text 必须在该节自身正文（不含子节）恰好出现一次，content 是替换文本。" +
      "patch 不接受 title，也不允许新增标题/水平线或改变大纲；0 次或多次匹配均拒绝且不写文件。" +
      "只在稳定里程碑写正文：结论先行，并保留范围/取舍、验证环境与结果、风险/限制。讨论问答应提炼成最终结论/依据/影响，" +
      "不得粘贴聊天、思维链、试错流水、大段原始输出或完整 diff。传 complete_todo（待办文本包含匹配）可同时勾掉待办。" +
      MANAGED_WRITE_RULE,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        section: {
          type: "string",
          description: "章节号：最多四级。优先用顶级号 1 / 2 / 3（整阶段一次写全，小节放 content 里）；1.2 / 1.2.3 / 1.2.3.4 用于精确补改已有小节",
        },
        title: { type: "string", description: "章节标题（新建/replace 应提供；append 留空=保持原标题；patch 必须留空）" },
        content: {
          type: "string",
          description: "replace/append 时为章节 Markdown；patch 时为 old_text 的替换文本。小节标题由工具编号；用列表/表格/代码块结构化；不用加 --- 分隔线",
        },
        mode: { type: "string", enum: ["replace", "append", "patch"], description: "replace=重写(默认)；append=章末追加；patch=章节自身正文内唯一精确替换" },
        old_text: { type: "string", description: "mode=patch 必填：task_get 后从目标节自身正文复制的精确旧文本，必须恰好匹配一次" },
        complete_todo: { type: "string", description: "可选：同时勾掉的待办（文本包含匹配）" },
      },
      required: ["id", "section", "content"],
    },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const content = String(args.content ?? "")
      const LIMIT = 24000
      if (content.length > LIMIT) {
        return {
          text: `content 过长（${content.length} 字符 > ${LIMIT}）。超大清单/表格拆成多个小节、用 mode=append 分批写；普通内容请精炼——只留结论、关键数据、决策理由。`,
          isError: true,
        }
      }
      const mode = args.mode === "append" ? "append" : args.mode === "patch" ? "patch" : "replace"
      const section = String(args.section ?? "")
      let body: string
      if (mode === "patch") {
        if (String(args.title ?? "").trim()) return { text: "mode=patch 不接受 title；改标题请对精确 section 使用 mode=replace", isError: true }
        const oldText = String(args.old_text ?? "")
        if (oldText.length > LIMIT) return { text: `old_text 过长（${oldText.length} 字符 > ${LIMIT}）`, isError: true }
        const patched = patchRecordSection(t.body, section, oldText, content)
        if (!patched.ok) {
          const messages: Record<SectionPatchError, string> = {
            invalid_section: `非法章节号：${section}（应为 1 / 1.2 / 1.2.3 / 1.2.3.4，最多四级）`,
            section_not_found: `章节不存在：${section}；请先 task_get 确认章节号`,
            empty_match: "mode=patch 必须提供非空 old_text",
            match_not_found: "old_text 在目标章节自身正文中未找到；文档可能已变化，请重新 task_get 后再试",
            ambiguous_match: "old_text 在目标章节自身正文中出现多次；请增加上下文，使其唯一后再试",
            outline_changed: "patch 只能改普通正文，不能新增/修改标题、水平线或未闭合代码块；结构变更请用 mode=replace",
          }
          return { text: messages[patched.error], isError: true }
        }
        body = patched.body
      } else {
        const next = writeRecordSection(t.body, section, String(args.title ?? ""), content, mode)
        if (!next) return { text: `非法章节号：${section}（应为 1 / 1.2 / 1.2.3 / 1.2.3.4，最多四级）`, isError: true }
        body = next
      }
      let todoNote = ""
      const todo = String(args.complete_todo ?? "").trim()
      if (todo) {
        const after = editTodo(body, "check", todo)
        todoNote = after === body ? `；待办未匹配到「${todo}」` : `；已勾掉待办「${todo}」`
        body = after
      }
      writeTask(t, t.fm, body)
      ctx.emit("taskflow:changed", { id: t.meta.id })
      // 结构化提醒（不拦截）：正文里出现超长单行（非代码块/表格/URL）→ 建议拆成小节/列表
      const longLine = (() => {
        const fence = fenceTracker()
        for (const ln of content.split(/\r?\n/)) {
          if (fence.feed(ln) || fence.inFence()) continue
          const s = ln.trim()
          if (s.includes("|") || /^https?:\/\/\S+$/.test(s)) continue
          if (s.length > 500) return s.length
        }
        return 0
      })()
      const structNote = longLine
        ? `；提示：有 ${longLine} 字符的超长单行，建议拆成小节标题/列表/表格，别堆成一行`
        : ""
      const action = mode === "append" ? "追加" : mode === "patch" ? "局部修改" : "写入"
      return { text: `ok: 章节 ${args.section} 已${action}${todoNote}${structNote}` }
    },
  },
  {
    name: "task_log",
    description:
      "向文档底部的「日志」表追加一行阶段性索引（时间|会话|记录）。只在阶段完成或关键结论变化时记一条，不要流水账，" +
      "也不要复制正文。推荐一句话格式：完成 X；验证 Y；结论/遗留 Z。" +
      MANAGED_WRITE_RULE,
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
    description: "更新任务 frontmatter 字段。仅允许 type / pha_issue（PHA 链接回填用这个）。" + MANAGED_WRITE_RULE,
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
      "生成固定结构的「问题」章节（现象/根因/解决/验证）。仅用于已定位、已解决且已验证的问题；" +
      "未解决或仍是猜测时，应 task_todo(add, '待确认：…')，不得写成既成结论。" +
      MANAGED_WRITE_RULE,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        problem: { type: "string", description: "问题现象（一两句）" },
        cause: { type: "string", description: "可选：已由证据确认的根因" },
        solution: { type: "string", description: "解决办法、选择理由及影响" },
        verification: { type: "string", description: "必填：验证环境、方法与结果；不要只写『已测试』" },
      },
      required: ["id", "problem", "solution", "verification"],
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
      const solution = String(args.solution ?? "").trim()
      const verification = String(args.verification ?? "").trim()
      if (!problem || !solution || !verification) {
        return { text: "problem / solution / verification 均不能为空；未解决问题请先加入『待确认』待办", isError: true }
      }
      const content = [
        `**现象**：${problem}`,
        ...(cause ? ["", `**根因**：${cause}`] : []),
        "",
        `**解决**：${solution}`,
        "",
        `**验证**：${verification}`,
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
    name: "task_normalize",
    description:
      "非破坏性规范化一篇任务文档到 v5 布局：补齐缺失的 frontmatter 字段、待办小节、--- 分隔线、顶级章之间的分隔线、置底日志表。不改动任何已有内容。" +
      MANAGED_WRITE_RULE,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async handler(args, ctx) {
      const t = resolveTask(ctx, String(args.id ?? ""))
      if (!t) return { text: `task not found: ${args.id}`, isError: true }
      const fm = { ...t.fm }
      for (const [k, dv] of Object.entries({ project: t.meta.project, type: "", sessions: [], pha_issue: "" })) {
        if (fm[k] === undefined) fm[k] = dv as string | string[]
      }
      writeTask(t, fm, ensureChapterSeparators(ensureLayout(t.body)))
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
        const before = cfg(ctx).vaultDirs.map(norm).join("|")
        const reportedChanged = norm(reportedVaultDir) !== norm(path)
        reportedVaultDir = path
        const effectiveChanged = before !== cfg(ctx).vaultDirs.map(norm).join("|")
        if (reportedChanged) ctx.log(`vault reported by obsidian: ${path}`)
        if (effectiveChanged) {
          refreshRegistry(ctx)
          ctx.emit("taskflow:changed", {})
        }
      }
      return { body: { ok: true, effective: cfg(ctx).vaultDirs } }
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
  events: ["taskflow:changed"],
  configSchema: {
    fields: [
      {
        key: "vaultDir",
        label: "扫描根目录",
        type: "string",
        placeholder: "留空=自动用当前 Obsidian vault；多根用 ; 分隔；支持 UNC 如 \\\\192.168.56.100\\share",
        help: "taskflow 在这些目录下递归查找 Obsidian Kanban 看板（含 kanban-plugin: board 的文件）；看板上 [[链接]] 到的文档即任务。手动配置是权威来源，多根用 ; 分隔；只有留空时才跟随 Obsidian 当前 vault，避免映射盘与 UNC 对同一目录重复扫描。",
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
          "配置后 task_* 工具会给出 agent 可定位的对端路径，session 工作目录也用映射后的形态；任务文档仍必须通过 task_* 工具更新。",
      },
      { key: "pollSeconds", label: "刷新间隔(秒)", type: "number", default: 15, help: "刷新看板/任务缓存的间隔（供看板脚注与面板）。0=不主动刷新。" },
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
