/**
 * Desktop toast via Electron's native Notification (carried over from
 * win-console). On Windows the daemon sets an AppUserModelID and registers it
 * under HKCU so toasts appear even for a portable exe — nothing goes through
 * PowerShell, so the GBK pitfall is gone. Imported only by the real native host
 * (the smoke test injects a stub instead), so electron stays out of the server.
 */
import { Notification } from "electron"
import { spawn } from "node:child_process"
import type { NotifyReq, NotifyRes } from "../../contracts"

export const APP_ID = "OpenCode.WinHost"

export function ensureWindowsToastIdentity(): void {
  if (process.platform !== "win32") return
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`
  const reg = (args: string[]) => {
    try {
      spawn("reg.exe", args, { stdio: "ignore" })
    } catch {
      /* best-effort */
    }
  }
  reg(["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "opencode Win Host", "/f"])
  reg(["add", key, "/v", "ShowInSettings", "/t", "REG_DWORD", "/d", "0", "/f"])
}

export async function showToast(req: NotifyReq): Promise<NotifyRes> {
  try {
    if (!Notification.isSupported()) return { ok: false, error: "当前系统不支持通知" }
    const n = new Notification({
      title: req.title || "通知",
      body: req.message || "",
      urgency: req.level === "error" ? "critical" : req.level === "warn" ? "normal" : "low",
    })
    n.show()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
