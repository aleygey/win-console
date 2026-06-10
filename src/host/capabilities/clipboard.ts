/**
 * clipboard capability — read the host clipboard image as a data: URL. No panel
 * of its own (the chat panel calls it to attach a pasted screenshot) and no
 * agent tool; just one read route.
 *
 *   route   GET /cap/clipboard/image → string | null
 */
import type { Capability } from "../../contracts"

export const clipboardCapability: Capability = {
  id: "clipboard",
  title: "剪贴板",
  icon: "📋",
  description: "读取剪贴板图片(对话面板贴图用)。",
  hasPanel: false,
  routes: [
    {
      method: "GET",
      path: "/image",
      handler: async (_req, ctx) => ({ body: { ok: true, dataUrl: await ctx.native.clipboardImage() } }),
    },
  ],
}
