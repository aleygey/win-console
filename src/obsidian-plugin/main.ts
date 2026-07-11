/**
 * Obsidian plugin entry — the daily unified entry. It embeds the win-host
 * console (served by the daemon over HTTP) in an iframe view. Ambient daemon
 * events (new mail) surface as notices. (The global hotkey opens the daemon's
 * own spotlight popup directly — no Obsidian involvement.)
 *
 * The plugin itself is tiny now (no bundled panels) — all UI lives in the
 * iframe, which is why there are no CSS conflicts with Obsidian's theme.
 */
import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, type WorkspaceLeaf } from "obsidian"
import { WinHostView, VIEW_TYPE } from "./view"
import "./styles.css"

interface WinHostSettings {
  winHostUrl: string
}
const DEFAULT_SETTINGS: WinHostSettings = {
  winHostUrl: "http://127.0.0.1:8799",
}

export default class WinHostPlugin extends Plugin {
  settings: WinHostSettings = DEFAULT_SETTINGS
  private es?: EventSource

  async onload(): Promise<void> {
    await this.loadSettings()

    this.registerView(VIEW_TYPE, (leaf) => new WinHostView(leaf, this.consoleUrl()))

    this.addRibbonIcon("message-square", "opencode 控制台", () => void this.activate())
    this.addCommand({ id: "open-console", name: "打开 opencode 控制台", callback: () => void this.activate() })
    this.addCommand({ id: "sessions", name: "opencode 会话监控", callback: () => void this.activate("sessions") })
    this.addCommand({
      id: "taskflow-launch",
      name: "Taskflow: 启动/继续当前任务",
      callback: () => void this.launchCurrentTask(),
    })

    this.subscribe()
    // Kanban(Taskflow) fork 的卡片脚注点「打开会话/启动」时广播此事件：
    // 激活控制台视图并深链到该会话的对话框。
    const onOpenSession = (ev: Event) => {
      const sid = (ev as CustomEvent).detail?.sessionId as string | undefined
      if (sid) void this.activate(`sessions&session=${sid}`)
    }
    window.addEventListener("taskflow:open-session", onOpenSession)
    this.register(() => window.removeEventListener("taskflow:open-session", onOpenSession))
    // taskflow 焦点联动：切换当前文档 → 告诉 daemon 当前活动文件的绝对路径，
    // daemon 判断是不是任务并广播 taskflow:focus，控制台据此浮出上下文条。
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.pushFocus()))
    this.registerEvent(this.app.workspace.on("file-open", () => this.pushFocus()))
    this.app.workspace.onLayoutReady(() => {
      this.reportVault()
      this.pushFocus()
    })

    this.addSettingTab(new WinHostSettingTab(this.app, this))
  }

  onunload(): void {
    this.es?.close()
    if (this.focusTimer) clearTimeout(this.focusTimer)
  }

  /** The console URL the iframe loads = the daemon serving out/console at `/`. */
  private consoleUrl(): string {
    return this.settings.winHostUrl.replace(/\/+$/, "") + "/"
  }

  /** Absolute filesystem path of a vault file (daemon keys its registry on it). */
  private absPath(file: TFile): string | null {
    const adapter = this.app.vault.adapter
    if (adapter instanceof FileSystemAdapter) return adapter.getFullPath(file.path)
    return null
  }

  /** 上报当前 vault 根目录 —— daemon 侧 vaultDir 未手动配置时的默认扫描根。 */
  private reportVault(): void {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) return
    void fetch(this.settings.winHostUrl.replace(/\/+$/, "") + "/cap/taskflow/vault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: adapter.getBasePath() }),
    }).catch(() => {
      /* daemon down — best-effort */
    })
  }

  private focusTimer?: ReturnType<typeof setTimeout>
  /** Debounced POST of the active file's abs path to the daemon (focus link). */
  private pushFocus(): void {
    if (this.focusTimer) clearTimeout(this.focusTimer)
    this.focusTimer = setTimeout(() => {
      const file = this.app.workspace.getActiveFile()
      const path = file ? this.absPath(file) : null
      void fetch(this.settings.winHostUrl.replace(/\/+$/, "") + "/cap/taskflow/focus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path ?? "" }),
      }).catch(() => {
        /* daemon down / no taskflow — focus is best-effort */
      })
    }, 150)
  }

  /** Command: launch/continue the opencode session for the currently open task. */
  private async launchCurrentTask(): Promise<void> {
    const file = this.app.workspace.getActiveFile()
    const path = file ? this.absPath(file) : null
    if (!path) {
      new Notice("请先在编辑器里打开一个任务文档")
      return
    }
    try {
      const r = await fetch(this.settings.winHostUrl.replace(/\/+$/, "") + "/cap/taskflow/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, mode: "continue" }),
      })
      const j = (await r.json()) as { ok?: boolean; error?: string }
      if (j.ok) {
        new Notice("已启动/继续任务会话")
        await this.activate("sessions")
      } else new Notice(`启动失败：${j.error ?? "该文档不是看板上的任务"}`)
    } catch {
      new Notice("连不上 win-host")
    }
  }

  /** Listen on the daemon SSE stream for ambient events (new mail, …). */
  private subscribe(): void {
    this.es?.close()
    try {
      this.es = new EventSource(this.settings.winHostUrl.replace(/\/+$/, "") + "/events")
      this.es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data) as { type?: string; payload?: { subject?: string } }
          if (e.type === "outlook:new-mail") new Notice(`📧 新邮件:${e.payload?.subject ?? ""}`)
        } catch {
          /* ignore malformed frame */
        }
      }
    } catch {
      /* EventSource unavailable */
    }
  }

  async activate(panel?: string): Promise<void> {
    const { workspace } = this.app
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)
      await leaf?.setViewState({ type: VIEW_TYPE, active: true })
    }
    if (leaf) {
      workspace.revealLeaf(leaf)
      if (panel && leaf.view instanceof WinHostView) leaf.view.select(panel)
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) }
  }

  private lastAppliedUrl?: string

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
    // Only re-subscribe + reload the iframes when the URL actually CHANGED —
    // the settings field fires per keystroke, and resubscribing/reassigning
    // iframe.src on every character reloads the console (losing its state) and
    // spins the EventSource retry loop against half-typed hosts.
    const url = this.consoleUrl()
    if (url === this.lastAppliedUrl) return
    this.lastAppliedUrl = url
    this.subscribe()
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof WinHostView) leaf.view.setUrl(url)
    }
  }
}

class WinHostSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: WinHostPlugin,
  ) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl("h3", { text: "opencode Win Host" })

    new Setting(containerEl)
      .setName("win-host 地址")
      .setDesc("常驻 daemon 的 HTTP 地址(默认本机 http://127.0.0.1:8799)。控制台页面与对话/邮件/通知都经它;经验库地址在控制台「管理」里配。")
      .addText((t) => {
        // Debounced: onChange fires per keystroke; applying a half-typed URL
        // reloads every console iframe + resubscribes SSE against garbage hosts.
        let timer: ReturnType<typeof setTimeout> | undefined
        t.setPlaceholder("http://127.0.0.1:8799")
          .setValue(this.plugin.settings.winHostUrl)
          .onChange((v) => {
            this.plugin.settings.winHostUrl = v.trim() || DEFAULT_SETTINGS.winHostUrl
            clearTimeout(timer)
            timer = setTimeout(() => void this.plugin.saveSettings(), 600)
          })
      })
  }
}
