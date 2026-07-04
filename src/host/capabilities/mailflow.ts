/**
 * mailflow capability — rule-driven email automation, NOT a mail list (the
 * `outlook` capability already browses the inbox). Each rule watches an Outlook
 * folder for new mail matching {from/subject/unread}, then acts:
 *
 *   notify          → a desktop toast (no LLM).
 *   trigger-session → start an opencode session that handles it (e.g. a Bugzilla
 *                     bug mail → "处理这个 bug"). Fires automatically.
 *   ai-review-reply → ask the agent to review + DRAFT a reply (e.g. a Gerrit
 *                     review). The draft lands in an approval queue and is sent
 *                     over Outlook COM ONLY after the user approves it.
 *
 * Rules live in the capability config (rulesJson, edited by the panel). Runtime
 * state — the per-rule dedup set + the approval queue — persists to a JSON file
 * under ctx.dataDir so restarts don't re-fire or lose pending approvals.
 */
import type {
  Capability,
  HostContext,
  MailInclude,
  MailRule,
  MailMessage,
  MailQueueItem,
  MailScanRes,
  MailActionKind,
} from "../../contracts"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"

type State = { processed: Record<string, string[]>; queue: MailQueueItem[] }

let state: State | undefined
let statePath: string | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollStop = false
let scanChain: Promise<unknown> = Promise.resolve()
let seq = 0

function ensureState(ctx: HostContext): State {
  if (!state) {
    statePath = join(ctx.dataDir, "mailflow-state.json")
    try {
      state = JSON.parse(readFileSync(statePath, "utf8")) as State
    } catch {
      state = { processed: {}, queue: [] }
    }
    if (!state.processed) state.processed = {}
    if (!Array.isArray(state.queue)) state.queue = []
  }
  return state
}

function saveState(): void {
  if (!state || !statePath) return
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8")
  } catch (e) {
    console.warn("[cap:mailflow] state write failed:", e)
  }
}

function newId(): string {
  seq += 1
  return `mq_${Date.now().toString(36)}_${seq}`
}

function parseRules(ctx: HostContext): MailRule[] {
  const raw = ctx.config().rulesJson
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr.filter((r) => r && typeof r === "object") as MailRule[]) : []
  } catch {
    return []
  }
}

function matchRule(rule: MailRule, m: MailMessage): boolean {
  const match = rule.match ?? {}
  if (match.unreadOnly && !m.unread) return false
  if (match.fromContains && !m.from.toLowerCase().includes(match.fromContains.toLowerCase())) return false
  if (match.subjectRegex) {
    try {
      if (!new RegExp(match.subjectRegex, "i").test(m.subject)) return false
    } catch {
      /* invalid regex → ignore this criterion rather than throw */
    }
  } else if (match.subjectContains && !m.subject.toLowerCase().includes(match.subjectContains.toLowerCase())) {
    return false
  }
  return true
}

/** Plain task instructions — the email content itself is appended as a
 *  structured block per the rule's `include` checkboxes (no placeholders). */
const DEFAULT_PROMPT: Record<MailActionKind, string> = {
  notify: "新邮件:{subject} — {from}",
  "trigger-session": "下面是一封邮件,请据此开始处理对应任务,完成后简要说明你做了什么。",
  "ai-review-reply":
    "下面是一封需要我回复的邮件(例如 Gerrit 评审、问题咨询)。请先做初步审查/分析," +
    "再用中文起草一封专业、简洁、可直接发送的回复邮件正文。只输出回复正文本身," +
    "不要任何解释、不要主题行。",
}

/** Legacy placeholder fill — old rules may still carry {subject}-style templates
 *  (and the notify toast template legitimately uses them). */
function fill(tpl: string, m: MailMessage): string {
  return tpl
    .replace(/\{subject\}/g, m.subject)
    .replace(/\{from\}/g, m.from)
    .replace(/\{received\}/g, m.received)
    .replace(/\{body\}/g, m.body)
}

/** Effective include flags — every field defaults ON except attachments, so an
 *  untouched rule behaves like the old auto-append. */
function effectiveInclude(rule: MailRule): Required<MailInclude> {
  const inc = rule.include ?? {}
  return {
    subject: inc.subject !== false,
    from: inc.from !== false,
    received: inc.received !== false,
    body: inc.body !== false,
    attachments: inc.attachments === true,
  }
}

/** Instruction + selected email fields as one structured block. If a legacy
 *  prompt still uses placeholders, fill them and skip the block (the template
 *  already placed the fields where it wants them). */
function mailText(rule: MailRule, m: MailMessage): string {
  const tpl = (rule.prompt && rule.prompt.trim()) || DEFAULT_PROMPT[rule.action]
  if (/\{(subject|from|body|received)\}/.test(tpl)) return fill(tpl, m)
  const inc = effectiveInclude(rule)
  const lines: string[] = []
  if (inc.subject) lines.push(`主题:${m.subject}`)
  if (inc.from) lines.push(`发件人:${m.from}`)
  if (inc.received) lines.push(`时间:${m.received}`)
  if (inc.body) lines.push(`\n正文:\n${m.body}`)
  if (lines.length === 0) return tpl
  return `${tpl}\n\n--- 邮件内容 ---\n${lines.join("\n")}`
}

function preview(m: MailMessage): string {
  return (m.body || "").replace(/\s+/g, " ").trim().slice(0, 160)
}

function queueItemFor(rule: MailRule, m: MailMessage): MailQueueItem {
  return {
    id: newId(),
    ruleId: rule.id,
    ruleName: rule.name || rule.id,
    action: rule.action,
    mail: { entryId: m.entryId, subject: m.subject, from: m.from, received: m.received, preview: preview(m) },
    status: "pending",
    createdAt: Date.now(),
  }
}

/** Run a rule's action for one matched mail. ai-review-reply stays `pending`
 *  (awaits approval); notify/trigger-session resolve to `done` immediately. */
/** chat.send with a hard deadline. Every scan is serialized on scanChain, so ONE
 *  wedged/hours-long opencode prompt would otherwise block every later auto-poll
 *  and manual scan until the daemon restarts. On timeout the queue item goes to
 *  "error" and the chain advances; the underlying agent run may still finish
 *  server-side (visible in 会话监控), we just stop waiting for it. */
const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000
async function sendWithDeadline(
  ctx: HostContext,
  req: Parameters<HostContext["native"]["chat"]["send"]>[0],
): Promise<Awaited<ReturnType<HostContext["native"]["chat"]["send"]>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      ctx.native.chat.send(req),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`mailflow 派发超时(>${DISPATCH_TIMEOUT_MS / 60000}min)`)), DISPATCH_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Where outlook_attachments drops files. Prefer D:\wsl-tmp (the established
 *  Windows↔WSL exchange dir — maps to /mnt/d/wsl-tmp for the agent); fall back
 *  to %TEMP% when the machine has no D:\wsl-tmp. Per-mail subdir so repeated
 *  fetches don't collide. */
function attachmentSaveDir(entryId: string): string {
  const tag = (entryId || "mail").replace(/[^A-Za-z0-9]/g, "").slice(-12) || "mail"
  const base = existsSync("D:\\wsl-tmp") ? "D:\\wsl-tmp\\mail-att" : join(tmpdir(), "winhost-mail-att")
  return join(base, tag)
}

/** Windows path → the WSL mount the (VM/WSL) agent reads: D:\x → /mnt/d/x. */
function winPathToWsl(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p
}

/** Pull the mail's attachments as inline file parts when the rule asks for
 *  them. Failures degrade to a note in the prompt, never block the dispatch. */
async function attachmentFiles(
  ctx: HostContext,
  rule: MailRule,
  m: MailMessage,
): Promise<{ files?: Array<{ name: string; mime: string; dataUrl: string }>; note: string }> {
  if (!effectiveInclude(rule).attachments) return { note: "" }
  try {
    const r = await ctx.native.outlookAttachments(m.entryId)
    if (!r.ok) return { note: `\n\n(附件读取失败:${r.error ?? "未知错误"})` }
    const names = (r.files ?? []).map((f) => f.name).join("、")
    const note =
      (names ? `\n\n(随信附件:${names})` : "\n\n(该邮件没有附件)") + (r.error ? `\n(${r.error})` : "")
    return { files: r.files && r.files.length > 0 ? r.files : undefined, note }
  } catch (e) {
    return { note: `\n\n(附件读取失败:${String(e)})` }
  }
}

async function dispatch(ctx: HostContext, rule: MailRule, m: MailMessage): Promise<MailQueueItem> {
  const item = queueItemFor(rule, m)
  try {
    if (rule.action === "notify") {
      const tpl = (rule.prompt && rule.prompt.trim()) || DEFAULT_PROMPT.notify
      await ctx.native.showToast({ title: `📧 ${rule.name || "邮件"}`, message: fill(tpl, m), level: "info" })
      item.status = "done"
      item.decidedAt = Date.now()
    } else if (rule.action === "trigger-session") {
      const att = await attachmentFiles(ctx, rule, m)
      const res = await sendWithDeadline(ctx, { text: mailText(rule, m) + att.note, files: att.files, model: rule.model })
      if (res.ok) {
        item.sessionId = res.sessionId
        item.status = "done"
        item.decidedAt = Date.now()
      } else {
        item.status = "error"
        item.error = res.error
      }
    } else {
      // ai-review-reply: draft only — never sends here.
      const att = await attachmentFiles(ctx, rule, m)
      const res = await sendWithDeadline(ctx, { text: mailText(rule, m) + att.note, files: att.files, model: rule.model })
      if (res.ok) {
        item.draft = res.reply ?? ""
        item.sessionId = res.sessionId
        item.status = "pending"
      } else {
        item.status = "error"
        item.error = res.error
      }
    }
  } catch (e) {
    item.status = "error"
    item.error = String(e)
  }
  return item
}

/** Scan every enabled rule's folder, act on fresh matches (rate-limited), dedup.
 *  A brand-new rule baselines its current backlog (no retroactive firing) unless
 *  `force` is set (the panel's manual "立即处理" / test). */
// Serialize every scan (poller / manual / multiple clients) onto one chain so
// two scans never overlap — overlapping scans re-read the same dedup baseline
// and double-fire (duplicate toasts / sessions / drafts) + lost-update the
// processed set.
function scan(ctx: HostContext, force: boolean): Promise<MailScanRes> {
  const run = scanChain.then(
    () => doScan(ctx, force),
    () => doScan(ctx, force),
  )
  scanChain = run.catch(() => {})
  return run
}

async function doScan(ctx: HostContext, force: boolean): Promise<MailScanRes> {
  const st = ensureState(ctx)
  const allRules = parseRules(ctx)
  const rules = allRules.filter((r) => r.enabled)
  const maxPerScan = Math.max(1, Number(ctx.config().maxPerScan ?? 5))
  let scanned = 0
  let matched = 0
  const errors: string[] = []
  const newItems: MailQueueItem[] = []

  // Prune processed-sets for rules that no longer exist — the panel mints a fresh
  // id per created rule, so delete-and-recreate cycles would otherwise accumulate
  // orphan 300-entry baselines in mailflow-state.json forever. Keyed on ALL rules
  // (not just enabled) so toggling a rule off keeps its baseline.
  const liveRuleIds = new Set(allRules.map((r) => r.id))
  for (const k of Object.keys(st.processed)) {
    if (!liveRuleIds.has(k)) delete st.processed[k]
  }

  for (const rule of rules) {
    const list = await ctx.native.outlookList({ folder: rule.folder, top: 30, unreadOnly: rule.match?.unreadOnly })
    if (!list.ok) {
      errors.push(`「${rule.name || rule.id}」:${list.error || "读取失败"}`)
      continue
    }
    if (!list.mails) continue
    scanned += list.mails.length
    const seen = st.processed[rule.id]
    const firstRun = seen === undefined
    const seenSet = new Set(seen ?? [])
    const matches = list.mails.filter((m) => m.entryId && matchRule(rule, m))
    matched += matches.length

    if (firstRun && !force) {
      // Baseline only — remember the existing backlog so it never fires; future
      // mail (or a forced scan) acts from here on.
      st.processed[rule.id] = matches.map((m) => m.entryId)
      continue
    }

    const fresh = matches.filter((m) => !seenSet.has(m.entryId)).slice(0, maxPerScan)
    for (const m of fresh) {
      const item = await dispatch(ctx, rule, m)
      st.queue.unshift(item)
      newItems.push(item)
      seenSet.add(m.entryId)
      if (item.status === "pending") {
        ctx.emit("mailflow:queued", { id: item.id, ruleName: item.ruleName, subject: item.mail.subject })
      } else if (item.action === "trigger-session" && item.sessionId) {
        ctx.emit("mailflow:session", { sessionId: item.sessionId, subject: item.mail.subject })
      }
    }
    st.processed[rule.id] = Array.from(seenSet).slice(-300)
  }

  if (st.queue.length > 200) {
    // Cap history but NEVER evict an item still awaiting approval / in flight.
    let kept = 0
    st.queue = st.queue.filter((q) => {
      if (q.status === "pending" || q.status === "sending") return true
      kept += 1
      return kept <= 200
    })
  }
  saveState()
  if (scanned === 0 && errors.length) {
    return { ok: false, error: errors.join("; "), scanned, matched, queued: newItems.length, items: newItems }
  }
  return { ok: true, scanned, matched, queued: newItems.length, items: newItems }
}

export const mailflowCapability: Capability = {
  id: "mailflow",
  title: "邮件工作流",
  icon: "📨",
  description: "规则驱动:监控指定 Outlook 文件夹的新邮件 → 通知 / 触发 session / AI 起草回复(审核后才发)。",
  hasPanel: true,
  events: ["mailflow:queued", "mailflow:session", "mailflow:sent"],

  configSchema: {
    fields: [
      {
        key: "pollSeconds",
        label: "轮询间隔(秒)",
        type: "number",
        default: 15,
        help: "后台每隔多少秒扫描各规则的文件夹(最小 15)。设 0 = 关闭自动轮询(仅手动「立即扫描」)。",
      },
      {
        key: "maxPerScan",
        label: "每规则每次最多处理",
        type: "number",
        default: 5,
        help: "限流:防止规则刚建立或长时间未扫时一次性触发大量邮件。",
      },
      // NOTE: rulesJson is still persisted under capabilities.mailflow (the
      // 邮件工作流 panel edits it), it's just no longer surfaced in 管理 —
      // capConfig keeps persisted keys that aren't in the schema.
    ],
  },

  // The agent's mail tools live here too (one "邮件" capability instead of a
  // separate outlook one), so the management page shows a single mail card.
  // Chain: outlook_search (find, returns entryId) → outlook_read (full body /
  // thread) → outlook_attachments (files saved where the WSL agent can read).
  tools: [
    {
      name: "outlook_search",
      description:
        "Read the user's classic Outlook inbox on their Windows host. Returns recent emails " +
        "(subject, sender, time, unread, a short preview, and an entryId), optionally filtered by a " +
        "keyword matched against subject/sender. The entryId is the handle for follow-ups: pass it to " +
        "outlook_read for the FULL body / conversation history, or to outlook_attachments to fetch " +
        "attachments. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword to match subject/sender. Empty = latest." },
          top: { type: "integer", minimum: 1, maximum: 50, description: "How many emails to return (default 15)." },
        },
      },
      handler: async (args, ctx) => {
        const r = await ctx.native.outlookSearch({ query: args?.query, top: args?.top })
        if (!r.ok) return { text: `读取 Outlook 失败:${r.error}`, isError: true }
        const tag = r.mock ? "(mock 数据,非 Windows 环境)\n" : ""
        const mails = r.mails ?? []
        return { text: tag + (mails.length ? JSON.stringify(mails, null, 2) : "没有匹配的邮件。") }
      },
    },
    {
      name: "outlook_read",
      description:
        "Read ONE Outlook email in FULL: complete body (not the 200-char preview), recipients, and its " +
        "attachment list. Identify the mail by entryId (from outlook_search) or by folder + subject " +
        "keyword (first match). Set thread=true to also list the other mails of the same conversation " +
        "(the back-and-forth history). Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          entryId: { type: "string", description: "MAPI EntryID from outlook_search (preferred)." },
          folder: { type: "string", description: 'Folder path like "收件箱\\\\Bugzilla" (used with subjectContains; empty = Inbox).' },
          subjectContains: { type: "string", description: "Subject keyword — first matching mail is read (when no entryId)." },
          thread: { type: "boolean", description: "Also list same-conversation mails (≤10, newest first)." },
        },
      },
      handler: async (args, ctx) => {
        const r = await ctx.native.outlookRead({
          entryId: args?.entryId ? String(args.entryId) : undefined,
          folder: args?.folder ? String(args.folder) : undefined,
          subjectContains: args?.subjectContains ? String(args.subjectContains) : undefined,
          thread: args?.thread === true,
        })
        if (!r.ok) return { text: `读取邮件失败:${r.error}`, isError: true }
        if (r.mock) return { text: "(mock:非 Windows 环境,无邮件内容)" }
        if (!r.mail) return { text: "没有找到匹配的邮件。" }
        return { text: JSON.stringify({ mail: r.mail, thread: r.thread ?? [] }, null, 2) }
      },
    },
    {
      name: "outlook_attachments",
      description:
        "Save an Outlook email's attachments to disk and return their file paths (both the Windows " +
        "path and the WSL /mnt/... path). You can then READ the files directly with your own tools. " +
        "Identify the mail by entryId (from outlook_search / outlook_read).",
      inputSchema: {
        type: "object",
        properties: {
          entryId: { type: "string", description: "MAPI EntryID of the mail whose attachments to save." },
        },
        required: ["entryId"],
      },
      handler: async (args, ctx) => {
        const entryId = String(args?.entryId ?? "")
        const dir = attachmentSaveDir(entryId)
        const r = await ctx.native.outlookSaveAttachments(entryId, dir)
        if (!r.ok) return { text: `保存附件失败:${r.error}`, isError: true }
        const files = (r.files ?? []).map((f) => ({
          name: f.name,
          size: f.size,
          winPath: f.winPath,
          wslPath: winPathToWsl(f.winPath),
        }))
        return { text: files.length ? JSON.stringify(files, null, 2) : "该邮件没有附件。" }
      },
    },
  ],

  routes: [
    {
      method: "POST",
      path: "/scan",
      handler: async (req, ctx) => ({ body: await scan(ctx, !!(req.body as any)?.force) }),
    },
    {
      method: "GET",
      path: "/queue",
      handler: async (_req, ctx) => ({ body: { ok: true, queue: ensureState(ctx).queue } }),
    },
    {
      method: "GET",
      path: "/folders",
      handler: async (_req, ctx) => ({ body: await ctx.native.outlookFolders() }),
    },
    {
      method: "POST",
      path: "/approve",
      handler: async (req, ctx) => {
        const st = ensureState(ctx)
        const { id, body } = (req.body ?? {}) as { id?: string; body?: string }
        const item = st.queue.find((q) => q.id === id)
        if (!item) return { status: 404, body: { ok: false, error: "找不到该队列项" } }
        if (item.status !== "pending") return { status: 400, body: { ok: false, error: `该项已处理(${item.status})` } }
        if (item.action !== "ai-review-reply") {
          item.status = "done"
          item.decidedAt = Date.now()
          saveState()
          return { body: { ok: true, item } }
        }
        const replyBody = typeof body === "string" && body.trim() ? body : item.draft ?? ""
        if (!replyBody.trim()) return { status: 400, body: { ok: false, error: "回复正文为空" } }
        // Claim it synchronously BEFORE the await so a concurrent /approve (double
        // click / retry / second client) hits the `status !== "pending"` guard and
        // can't trigger a second irreversible send.
        item.status = "sending"
        const res = await ctx.native.outlookReply({ entryId: item.mail.entryId, body: replyBody, send: true })
        if (!res.ok) {
          item.status = "error"
          item.error = res.error
          saveState()
          return { status: 500, body: { ok: false, error: res.error, item } }
        }
        item.draft = replyBody
        item.status = "done"
        item.decidedAt = Date.now()
        saveState()
        ctx.emit("mailflow:sent", { id: item.id, subject: item.mail.subject })
        return { body: { ok: true, item, sent: res.sent, mock: res.mock } }
      },
    },
    {
      method: "POST",
      path: "/reject",
      handler: async (req, ctx) => {
        const st = ensureState(ctx)
        const { id } = (req.body ?? {}) as { id?: string }
        const item = st.queue.find((q) => q.id === id)
        if (!item) return { status: 404, body: { ok: false, error: "找不到该队列项" } }
        item.status = "rejected"
        item.decidedAt = Date.now()
        saveState()
        return { body: { ok: true, item } }
      },
    },
    {
      method: "POST",
      path: "/preview",
      handler: async (req, ctx) => {
        const { ruleId } = (req.body ?? {}) as { ruleId?: string }
        const rule = parseRules(ctx).find((r) => r.id === ruleId)
        if (!rule) return { status: 404, body: { ok: false, error: "找不到规则" } }
        const list = await ctx.native.outlookList({ folder: rule.folder, top: 30, unreadOnly: rule.match?.unreadOnly })
        if (!list.ok) return { status: 500, body: { ok: false, error: list.error } }
        const mails = (list.mails ?? []).map((m) => ({
          subject: m.subject,
          from: m.from,
          received: m.received,
          unread: m.unread,
          matched: matchRule(rule, m),
        }))
        return { body: { ok: true, mock: list.mock, mails, matchedCount: mails.filter((x) => x.matched).length } }
      },
    },
    {
      method: "POST",
      path: "/clear",
      handler: async (_req, ctx) => {
        const st = ensureState(ctx)
        st.queue = st.queue.filter((q) => q.status === "pending")
        saveState()
        return { body: { ok: true, queue: st.queue } }
      },
    },
  ],

  init(ctx) {
    ensureState(ctx)
    pollStop = false
    if (pollTimer) clearTimeout(pollTimer)
    // Always-on heartbeat that reads pollSeconds LIVE each tick, so enabling or
    // changing it from the console takes effect WITHOUT a daemon restart.
    // pollSeconds<=0 → don't scan, just re-check in 60s. Self-rescheduling so a
    // slow (LLM) scan never stacks ticks; interval clamped to a 15s minimum.
    const tick = () => {
      if (pollStop) return
      const seconds = Number(ctx.config().pollSeconds ?? 0)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        pollTimer = setTimeout(tick, 60_000)
        return
      }
      void scan(ctx, false)
        .catch((e) => ctx.log("poll scan failed", e))
        .finally(() => {
          if (!pollStop) pollTimer = setTimeout(tick, Math.max(15, seconds) * 1000)
        })
    }
    pollTimer = setTimeout(tick, 5_000)
  },

  dispose() {
    pollStop = true
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
  },
}
