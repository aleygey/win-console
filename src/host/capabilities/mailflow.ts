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
  MailRule,
  MailMessage,
  MailQueueItem,
  MailScanRes,
  MailActionKind,
} from "../../contracts"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

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

const DEFAULT_PROMPT: Record<MailActionKind, string> = {
  notify: "新邮件:{subject} — {from}",
  "trigger-session":
    "下面是一封邮件,请据此开始处理对应任务,完成后简要说明你做了什么。\n\n" +
    "主题:{subject}\n发件人:{from}\n时间:{received}\n\n正文:\n{body}",
  "ai-review-reply":
    "下面是一封需要我回复的邮件(例如 Gerrit 评审、问题咨询)。请先做初步审查/分析," +
    "再用中文起草一封专业、简洁、可直接发送的回复邮件正文。只输出回复正文本身," +
    "不要任何解释、不要主题行。\n\n主题:{subject}\n发件人:{from}\n\n正文:\n{body}",
}

function fill(tpl: string, m: MailMessage): string {
  return tpl
    .replace(/\{subject\}/g, m.subject)
    .replace(/\{from\}/g, m.from)
    .replace(/\{received\}/g, m.received)
    .replace(/\{body\}/g, m.body)
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
async function dispatch(ctx: HostContext, rule: MailRule, m: MailMessage): Promise<MailQueueItem> {
  const item = queueItemFor(rule, m)
  const prompt = (rule.prompt && rule.prompt.trim()) || DEFAULT_PROMPT[rule.action]
  try {
    if (rule.action === "notify") {
      await ctx.native.showToast({ title: `📧 ${rule.name || "邮件"}`, message: fill(prompt, m), level: "info" })
      item.status = "done"
      item.decidedAt = Date.now()
    } else if (rule.action === "trigger-session") {
      const res = await ctx.native.chat.send({ text: fill(prompt, m), directory: rule.directory, model: rule.model })
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
      const res = await ctx.native.chat.send({ text: fill(prompt, m), directory: rule.directory, model: rule.model })
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
  const rules = parseRules(ctx).filter((r) => r.enabled)
  const maxPerScan = Math.max(1, Number(ctx.config().maxPerScan ?? 5))
  let scanned = 0
  let matched = 0
  const errors: string[] = []
  const newItems: MailQueueItem[] = []

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
      {
        key: "rulesJson",
        label: "规则(JSON)",
        type: "string",
        default: "[]",
        help: '建议在「邮件工作流」面板里可视化编辑;此处是底层 JSON 数组。',
      },
    ],
  },

  // The agent's read-mail tool lives here too (one "邮件" capability instead of a
  // separate outlook one), so the management page shows a single mail card.
  tools: [
    {
      name: "outlook_search",
      description:
        "Read the user's classic Outlook inbox on their Windows host. Returns recent emails " +
        "(subject, sender, time, unread, a short preview), optionally filtered by a keyword matched " +
        "against subject/sender. Use to summarize mail, find a message, or pull context the user " +
        "refers to. Read-only.",
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
