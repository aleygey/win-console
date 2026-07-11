/**
 * The Obsidian view — a thin iframe that embeds the win-host console served by
 * the daemon at its own origin. Why an iframe and not mounting the SolidJS
 * panels directly: Obsidian's theme CSS and the panels' design-token CSS share
 * variable names (--line-height-normal, --font-size-*, …) and both touch
 * body/:root, so mounting in-document caused two-way CSS bleed (overlapping
 * text). An iframe is a separate document — the console renders exactly as it
 * does standalone, Obsidian's styles can't leak in, ours can't leak out.
 *
 * 主题跟随：iframe 是独立文档，prefers-color-scheme 跟的是 OS 而不是 Obsidian
 * 的明暗设置，所以要显式同步 —— 初始经 ?theme= 查询参数，切换经 postMessage
 * （main.ts 监听 css-change 后调 postTheme）。
 */
import { ItemView, type WorkspaceLeaf } from "obsidian"

export const VIEW_TYPE = "winhost-console"

/** Obsidian 当前是否深色主题（body.theme-dark 是官方约定 class）。 */
function obsidianDark(): boolean {
  return document.body.classList.contains("theme-dark")
}

export class WinHostView extends ItemView {
  private frame?: HTMLIFrameElement

  constructor(
    leaf: WorkspaceLeaf,
    private url: string,
  ) {
    super(leaf)
  }

  getViewType(): string {
    return VIEW_TYPE
  }
  getDisplayText(): string {
    return "opencode 控制台"
  }
  getIcon(): string {
    return "message-square"
  }

  /** Console URL with the theme query (+ optional panel deep-link hash). */
  private buildSrc(panel?: string): string {
    const base = this.url.replace(/[#?].*$/, "")
    return `${base}?theme=${obsidianDark() ? "dark" : "light"}${panel ? `#panel=${panel}` : ""}`
  }

  async onOpen(): Promise<void> {
    const host = this.contentEl
    host.empty()
    host.addClass("winhost-root")
    const frame = host.createEl("iframe", { cls: "winhost-iframe" })
    frame.src = this.buildSrc()
    frame.setAttribute("allow", "clipboard-read; clipboard-write")
    // 每次(重新)加载后补推一次当前主题 —— 覆盖 src 查询参数丢失的场景
    frame.addEventListener("load", () => this.postTheme())
    this.frame = frame
  }

  async onClose(): Promise<void> {
    this.frame?.remove()
    this.frame = undefined
  }

  /** 把 Obsidian 当前明暗推给 iframe（main.ts 在 css-change 时调用）。 */
  postTheme(): void {
    this.frame?.contentWindow?.postMessage({ type: "winhost-theme", dark: obsidianDark() }, "*")
  }

  /** Re-point the iframe (e.g. when the daemon URL setting changes). */
  setUrl(url: string): void {
    this.url = url
    if (this.frame) this.frame.src = this.buildSrc()
  }

  /** Deep-link to a panel (used by the summon-chat hotkey). */
  select(panel: string): void {
    if (this.frame) this.frame.src = this.buildSrc(panel)
  }
}
