/**
 * Mail workflow panel — define rules that watch Outlook folders and act on new
 * mail (notify / trigger an opencode session / AI-draft a reply). The approval
 * queue is the human-in-the-loop: AI-drafted replies wait here and are only sent
 * over Outlook COM after you approve (and can edit) them.
 *
 * Rules persist in the daemon config (capabilities.mailflow.rulesJson). The queue
 * + dedup state live host-side; this panel reads /queue and drives /scan,
 * /approve, /reject, /preview.
 */
import { createSignal, For, Index, Show, onMount } from "solid-js"
import { registerPanel } from "../../registry"
import { api } from "../../bridge"
import { Icon } from "../../icons"
import type { MailRule, MailQueueItem, MailActionKind } from "../../global"
import "./mailflow.css"

const ACTIONS: { value: MailActionKind; label: string; icon: string; hint: string }[] = [
  { value: "trigger-session", label: "触发会话处理", icon: "message-square", hint: "自动新建 opencode 会话按 prompt 处理(如 Bugzilla bug)。" },
  { value: "ai-review-reply", label: "AI 审查 + 起草回复", icon: "share-2", hint: "AI 先审查并起草回复,进待审队列,你批准后才经 Outlook 发送。" },
]
const actionMeta = (a: MailActionKind) => ACTIONS.find((x) => x.value === a) ?? ACTIONS[0]

function blankRule(): MailRule {
  return {
    id: `r_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`,
    name: "新规则",
    enabled: true,
    folder: "",
    match: {},
    action: "trigger-session",
    prompt: "",
  }
}

function MailflowPanel() {
  const [rules, setRules] = createSignal<MailRule[]>([])
  const [queue, setQueue] = createSignal<MailQueueItem[]>([])
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [info, setInfo] = createSignal("")
  const [err, setErr] = createSignal("")
  const [saved, setSaved] = createSignal(false)
  const [showHistory, setShowHistory] = createSignal(false)
  const [folders, setFolders] = createSignal<string[]>([])
  // ids of rules currently expanded for editing (saved rules render collapsed).
  const [editingIds, setEditingIds] = createSignal<Set<string>>(new Set())
  const isEditing = (id: string) => editingIds().has(id)
  function toggleEdit(id: string) {
    setEditingIds((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  /** Folder options for the picker = fetched Outlook folders, plus the rule's
   *  current value if it isn't in the list (so a saved custom path survives). */
  const folderOptions = (current?: string): string[] => {
    const fs = folders()
    return current && current.trim() && !fs.includes(current) ? [current, ...fs] : fs
  }

  /** Short human summary of a rule's match criteria, for the collapsed card. */
  function ruleSummary(r: MailRule): string {
    const m = r.match ?? {}
    const parts: string[] = []
    if (m.fromContains) parts.push(`发件人含 ${m.fromContains}`)
    if (m.subjectRegex) parts.push(`主题正则 ${m.subjectRegex}`)
    else if (m.subjectContains) parts.push(`主题含 ${m.subjectContains}`)
    if (m.unreadOnly) parts.push("仅未读")
    return parts.length ? parts.join(" · ") : "匹配全部邮件"
  }

  async function loadRules() {
    try {
      const raw = (await api.getConfig()).capabilities?.mailflow?.rulesJson as string | undefined
      const parsed = raw ? JSON.parse(raw) : []
      setRules(Array.isArray(parsed) ? parsed : [])
    } catch {
      setRules([])
    }
  }
  async function loadQueue() {
    try {
      const r = await api.read<{ ok: boolean; queue: MailQueueItem[] }>("mailflow", "/queue")
      setQueue(r.queue ?? [])
    } catch {
      /* daemon offline → leave as-is */
    }
  }
  onMount(() => {
    void loadRules()
    void loadQueue()
    void api
      .read<{ ok: boolean; folders?: string[] }>("mailflow", "/folders")
      .then((r) => setFolders(r.folders ?? []))
      .catch(() => {})
  })

  async function saveRules() {
    setErr("")
    try {
      // Merge into the existing mailflow blob so we don't clobber pollSeconds/
      // maxPerScan (POST /config replaces a capability's blob wholesale).
      const cfg = await api.getConfig()
      const mf = ((cfg.capabilities as any)?.mailflow ?? {}) as Record<string, unknown>
      await api.setConfig({ capabilities: { mailflow: { ...mf, rulesJson: JSON.stringify(rules()) } } })
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (e) {
      setErr(String(e))
    }
  }

  function patchRule(i: number, patch: Partial<MailRule>) {
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function patchMatch(i: number, patch: Partial<MailRule["match"]>) {
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, match: { ...r.match, ...patch } } : r)))
  }

  async function scan() {
    setBusy(true)
    setErr("")
    setInfo("")
    try {
      const r = await api.call<any>("mailflow", "/scan", { force: true })
      if (!r?.ok) setErr(r?.error || "扫描失败")
      else setInfo(`扫描 ${r.scanned} 封 · 匹配 ${r.matched} · 新建 ${r.queued} 项`)
      await loadQueue()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function preview(rule: MailRule) {
    setErr("")
    setInfo("")
    try {
      const r = await api.call<any>("mailflow", "/preview", { ruleId: rule.id })
      if (!r?.ok) setErr(r?.error || "预览失败")
      else setInfo(`「${rule.name}」:${r.mails?.length ?? 0} 封中匹配 ${r.matchedCount} 封${r.mock ? "(mock 数据)" : ""}`)
    } catch (e) {
      setErr(String(e))
    }
  }

  async function approve(item: MailQueueItem) {
    setBusy(true)
    setErr("")
    try {
      const body = item.action === "ai-review-reply" ? drafts()[item.id] ?? item.draft ?? "" : undefined
      const r = await api.call<any>("mailflow", "/approve", { id: item.id, body })
      if (!r?.ok) setErr(r?.error || "操作失败")
      else if (item.action === "ai-review-reply") setInfo(r.mock ? "已批准(mock,未真正发送)" : "已发送回复 ✓")
      await loadQueue()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }
  async function reject(item: MailQueueItem) {
    setBusy(true)
    setErr("")
    try {
      const r = await api.call<any>("mailflow", "/reject", { id: item.id })
      if (!r?.ok) setErr(r?.error || "拒绝失败")
      await loadQueue()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const pending = () => queue().filter((q) => q.status === "pending")
  const history = () => queue().filter((q) => q.status !== "pending")

  function fmt(iso: string) {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false })
  }

  return (
    <div class="panel">
      <div class="panel-head">
        <div class="ph-title">
          <span class="ph-icon">
            <Icon name="mail" size={17} />
          </span>
          <div>
            <h2>邮件工作流</h2>
            <div class="sub">规则驱动 · 触发会话 / AI 起草回复(审核后发送)</div>
          </div>
        </div>
        <button class="mf-scan" disabled={busy()} onClick={scan}>
          <Icon name="refresh-cw" size={15} />
          {busy() ? "扫描中…" : "立即扫描"}
        </button>
      </div>

      <div class="panel-body">
        <Show when={err()}>
          <div class="mf-banner mf-err">{err()}</div>
        </Show>
        <Show when={info()}>
          <div class="mf-banner mf-info">{info()}</div>
        </Show>

        {/* ── Approval queue (human-in-the-loop) ───────────────────────────── */}
        <section class="mf-section">
          <div class="mf-section-head">
            <h3>
              待审队列
              <Show when={pending().length > 0}>
                <span class="mf-count">{pending().length}</span>
              </Show>
            </h3>
            <button class="mf-link" onClick={loadQueue}>
              <Icon name="rotate-ccw" size={13} /> 刷新
            </button>
          </div>

          <Show when={pending().length === 0}>
            <div class="mf-empty">没有待审项。AI 起草的回复会出现在这里,批准后才发送。</div>
          </Show>

          <For each={pending()}>
            {(item) => (
              <div class="mf-q mf-q-pending">
                <div class="mf-q-top">
                  <span class={`mf-tag mf-tag-${item.action}`}>
                    <Icon name={actionMeta(item.action).icon} size={12} />
                    {actionMeta(item.action).label}
                  </span>
                  <span class="mf-q-rule">{item.ruleName}</span>
                  <span class="mf-q-time">{fmt(item.mail.received)}</span>
                </div>
                <div class="mf-q-subject">{item.mail.subject || "(无主题)"}</div>
                <div class="mf-q-from">{item.mail.from}</div>
                <Show when={item.mail.preview}>
                  <div class="mf-q-preview">{item.mail.preview}</div>
                </Show>

                <Show when={item.action === "ai-review-reply"}>
                  <div class="mf-draft-label">AI 起草的回复(可编辑后再发送):</div>
                  <textarea
                    class="mf-draft"
                    rows={6}
                    value={drafts()[item.id] ?? item.draft ?? ""}
                    onInput={(e) => setDrafts((d) => ({ ...d, [item.id]: e.currentTarget.value }))}
                  />
                </Show>

                <div class="mf-q-actions">
                  <button class="mf-btn mf-approve" disabled={busy()} onClick={() => approve(item)}>
                    <Icon name={item.action === "ai-review-reply" ? "send" : "check"} size={14} />
                    {item.action === "ai-review-reply" ? "批准并发送" : "确认"}
                  </button>
                  <button class="mf-btn mf-reject" disabled={busy()} onClick={() => reject(item)}>
                    <Icon name="x" size={14} /> 拒绝
                  </button>
                </div>
              </div>
            )}
          </For>

          <Show when={history().length > 0}>
            <button class="mf-history-toggle" onClick={() => setShowHistory((v) => !v)}>
              <Icon name="chevron-down" size={14} class={showHistory() ? "mf-open" : ""} />
              历史记录({history().length})
            </button>
          </Show>
          <Show when={showHistory()}>
            <For each={history()}>
              {(item) => (
                <div class={`mf-h mf-h-${item.status}`}>
                  <span class={`mf-tag mf-tag-${item.action}`}>
                    <Icon name={actionMeta(item.action).icon} size={11} />
                    {actionMeta(item.action).label}
                  </span>
                  <span class="mf-h-subject">{item.mail.subject || "(无主题)"}</span>
                  <span class={`mf-status mf-status-${item.status}`}>
                    {item.status === "done" ? "已处理" : item.status === "rejected" ? "已拒绝" : "出错"}
                  </span>
                  <Show when={item.sessionId}>
                    <span class="mf-sess">会话 {item.sessionId}</span>
                  </Show>
                  <Show when={item.error}>
                    <span class="mf-h-err">{item.error}</span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </section>

        {/* ── Rules editor ─────────────────────────────────────────────────── */}
        <section class="mf-section">
          <div class="mf-section-head">
            <h3>规则</h3>
            <div class="mf-head-actions">
              <button
                class="mf-link"
                onClick={() => {
                  const r = blankRule()
                  setRules((rs) => [...rs, r])
                  setEditingIds((s) => new Set(s).add(r.id)) // open the new rule for editing
                }}
              >
                <Icon name="plus" size={13} /> 新增规则
              </button>
              <button class="mf-save" onClick={saveRules}>
                <Show when={saved()} fallback={<>保存规则</>}>
                  <Icon name="check" size={14} /> 已保存
                </Show>
              </button>
            </div>
          </div>

          <Show when={rules().length === 0}>
            <div class="mf-empty">还没有规则。点「新增规则」开始,例如:监控收件箱里来自 bugzilla 的邮件 → 触发会话处理。</div>
          </Show>

          {/* Index (not For): keys by position so editing a field in place updates
              only that binding instead of rebuilding the row — keeps input focus.
              Saved rules render as a compact summary; click to expand & edit. */}
          <Index each={rules()}>
            {(rule, i) => (
              <div class="mf-rule" data-off={!rule().enabled} data-editing={isEditing(rule().id)}>
                {/* compact summary — click anywhere to expand/collapse the editor */}
                <div class="mf-rule-summary" onClick={() => toggleEdit(rule().id)}>
                  <label class="mf-toggle" title={rule().enabled ? "启用" : "停用"} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={rule().enabled}
                      onChange={(e) => patchRule(i, { enabled: e.currentTarget.checked })}
                    />
                    <span class="mf-toggle-track">
                      <span class="mf-toggle-thumb" />
                    </span>
                  </label>
                  <div class="mf-rule-sum">
                    <span class="mf-rule-sum-name">{rule().name || "(未命名规则)"}</span>
                    <span class="mf-rule-sum-meta">
                      <span class={`mf-tag mf-tag-${rule().action}`}>{actionMeta(rule().action).label}</span>
                      <span class="mf-rule-sum-text">
                        {rule().folder || "收件箱"} · {ruleSummary(rule())}
                      </span>
                    </span>
                  </div>
                  <button
                    class="mf-icon-btn mf-danger"
                    title="删除规则"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRules((rs) => rs.filter((_, idx) => idx !== i))
                    }}
                  >
                    <Icon name="trash-2" size={15} />
                  </button>
                  <Icon name="chevron-down" size={16} class={`mf-rule-caret ${isEditing(rule().id) ? "mf-open" : ""}`} />
                </div>

                {/* expanded editor */}
                <Show when={isEditing(rule().id)}>
                  <div class="mf-rule-editor">
                    <label class="mf-field">
                      <span class="mf-label">规则名</span>
                      <input
                        value={rule().name}
                        placeholder="规则名"
                        onInput={(e) => patchRule(i, { name: e.currentTarget.value })}
                      />
                    </label>

                    <div class="mf-grid">
                      <label class="mf-field">
                        <span class="mf-label">Outlook 文件夹</span>
                        <select value={rule().folder ?? ""} onChange={(e) => patchRule(i, { folder: e.currentTarget.value })}>
                          <option value="">收件箱(默认)</option>
                          <For each={folderOptions(rule().folder)}>{(f) => <option value={f}>{f}</option>}</For>
                        </select>
                      </label>
                      <label class="mf-field">
                        <span class="mf-label">动作</span>
                        <select
                          value={rule().action}
                          onChange={(e) => patchRule(i, { action: e.currentTarget.value as MailActionKind })}
                        >
                          <For each={ACTIONS}>{(a) => <option value={a.value}>{a.label}</option>}</For>
                        </select>
                      </label>
                      <label class="mf-field">
                        <span class="mf-label">发件人含</span>
                        <input
                          value={rule().match?.fromContains ?? ""}
                          placeholder="如 459149100 / gerrit(子串,可空)"
                          onInput={(e) => patchMatch(i, { fromContains: e.currentTarget.value })}
                        />
                      </label>
                      <label class="mf-field">
                        <span class="mf-label">主题含</span>
                        <input
                          value={rule().match?.subjectContains ?? ""}
                          placeholder="如 [Bug / Change(可空)"
                          onInput={(e) => patchMatch(i, { subjectContains: e.currentTarget.value })}
                        />
                      </label>
                    </div>

                    <div class="mf-rule-flags">
                      <label class="mf-check">
                        <input
                          type="checkbox"
                          checked={!!rule().match?.unreadOnly}
                          onChange={(e) => patchMatch(i, { unreadOnly: e.currentTarget.checked })}
                        />
                        仅未读
                      </label>
                      <span class="mf-action-hint">{actionMeta(rule().action).hint}</span>
                    </div>

                    <label class="mf-field">
                      <span class="mf-label">工作目录(可空,触发会话用)</span>
                      <input
                        value={rule().directory ?? ""}
                        placeholder="如 D:\\proj\\foo(自动映射到 WSL)"
                        onInput={(e) => patchRule(i, { directory: e.currentTarget.value })}
                      />
                    </label>

                    <label class="mf-field">
                      <span class="mf-label">Prompt 模板(可空用默认 · 占位 {"{subject} {from} {body} {received}"})</span>
                      <textarea
                        class="mf-prompt"
                        rows={3}
                        value={rule().prompt ?? ""}
                        placeholder="留空使用内置 prompt(会把邮件主题/正文填进去)"
                        onInput={(e) => patchRule(i, { prompt: e.currentTarget.value })}
                      />
                    </label>

                    <div class="mf-editor-foot">
                      <button class="mf-link" onClick={() => preview(rule())}>
                        <Icon name="search" size={13} /> 预览匹配
                      </button>
                      <button class="mf-link" onClick={() => toggleEdit(rule().id)}>
                        <Icon name="check" size={13} /> 完成
                      </button>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </Index>
        </section>
      </div>
    </div>
  )
}

registerPanel({ id: "mailflow", title: "邮件工作流", icon: "📨", render: () => <MailflowPanel /> })
