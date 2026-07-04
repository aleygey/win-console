/**
 * Shared markdown → HTML helper for every surface that renders model output
 * (spotlight quick-ask, 会话监控 timeline). One config, one hardening spot.
 *
 * Raw HTML in the source is ESCAPED, not passed through: marked v18 has no
 * sanitizer, and model output can relay markup from tool results (web pages,
 * files) — injecting that verbatim into the renderer is an XSS surface and a
 * styling wildcard. GFM markdown (tables, task lists, code, …) still renders.
 */
import { marked, type Tokens } from "marked"

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text)
    },
  },
})

export const md = (t: string): string => marked.parse(t, { async: false }) as string
