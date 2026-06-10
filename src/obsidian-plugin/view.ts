/**
 * The Obsidian view — a thin iframe that embeds the win-host console served by
 * the daemon at its own origin. Why an iframe and not mounting the SolidJS
 * panels directly: Obsidian's theme CSS and the panels' design-token CSS share
 * variable names (--line-height-normal, --font-size-*, …) and both touch
 * body/:root, so mounting in-document caused two-way CSS bleed (overlapping
 * text). An iframe is a separate document — the console renders exactly as it
 * does standalone, Obsidian's styles can't leak in, ours can't leak out.
 */
import { ItemView, type WorkspaceLeaf } from "obsidian"

export const VIEW_TYPE = "winhost-console"

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

  async onOpen(): Promise<void> {
    const host = this.contentEl
    host.empty()
    host.addClass("winhost-root")
    const frame = host.createEl("iframe", { cls: "winhost-iframe" })
    frame.src = this.url
    frame.setAttribute("allow", "clipboard-read; clipboard-write")
    this.frame = frame
  }

  async onClose(): Promise<void> {
    this.frame?.remove()
    this.frame = undefined
  }

  /** Re-point the iframe (e.g. when the daemon URL setting changes). */
  setUrl(url: string): void {
    this.url = url
    if (this.frame) this.frame.src = url
  }

  /** Deep-link to a panel (used by the summon-chat hotkey). */
  select(panel: string): void {
    if (this.frame) this.frame.src = this.url.replace(/#.*$/, "") + "#panel=" + panel
  }
}
