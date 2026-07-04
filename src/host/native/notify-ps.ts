/**
 * Real Windows desktop toast WITHOUT electron — drives the WinRT
 * ToastNotificationManager via PowerShell (script delivered as -EncodedCommand
 * UTF-16LE base64, so Chinese survives any code page). Used by the headless
 * "lite" daemon so notifications pop for real even when the Electron app isn't
 * running. The Electron daemon keeps using electron's Notification (notify.ts).
 */
import { spawn } from "node:child_process"
import type { NotifyReq, NotifyRes } from "../../contracts"

// WinRT toasts only appear for an AppUserModelId that Windows knows about. A
// custom AUMID needs a Start-Menu shortcut carrying it; lacking that, the toast
// silently no-ops. The PowerShell AUMID is always registered, so we use it for
// the headless lite daemon's toasts (the Electron daemon brands its own).
const PS_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
const APP_ID = PS_AUMID
let aumidDone = false

/** Register the AppUserModelId under HKCU so WinRT toasts actually appear
 *  (Win10/11 silently no-op without a registered AppID). Best-effort, once. */
function ensureAumid(): void {
  if (aumidDone || process.platform !== "win32") return
  aumidDone = true
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`
  try {
    spawn("reg.exe", ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "opencode Win Host", "/f"], { stdio: "ignore" })
    spawn("reg.exe", ["add", key, "/v", "ShowInSettings", "/t", "REG_DWORD", "/d", "0", "/f"], { stdio: "ignore" })
  } catch {
    /* best-effort */
  }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function psScript(title: string, message: string): string {
  const t = xmlEscape(title)
  const m = xmlEscape(message)
  return `$ErrorActionPreference='Stop'
$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
$null=[Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]
$null=[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]
$xml=@"
<toast><visual><binding template="ToastGeneric"><text>${t}</text><text>${m}</text></binding></visual></toast>
"@
$doc=New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast=New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`
}

export async function showToastPowerShell(req: NotifyReq): Promise<NotifyRes> {
  if (process.platform !== "win32") return { ok: false, error: "toast 仅 Windows" }
  ensureAumid()
  const encoded = Buffer.from(psScript(req.title || "通知", req.message || ""), "utf16le").toString("base64")
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ])
    let err = ""
    // Watchdog: same guard outlook.ts's runPowerShell uses — a wedged PowerShell
    // (AV interception, WinRT stall) would otherwise leak a child process and a
    // never-settling promise per toast.
    const watchdog = setTimeout(() => {
      ps.kill()
      resolve({ ok: false, error: "toast 超时(20s)" })
    }, 20_000)
    ps.stderr.on("data", (d) => (err += d.toString()))
    ps.on("error", (e) => {
      clearTimeout(watchdog)
      resolve({ ok: false, error: String(e) })
    })
    ps.on("close", (code) => {
      clearTimeout(watchdog)
      code === 0 ? resolve({ ok: true }) : resolve({ ok: false, error: err.trim() || `exit ${code}` })
    })
  })
}
