/**
 * Win32 helpers for the hotkey policy: is Obsidian running, and if so bring it
 * to the foreground. Both are best-effort PowerShell one-liners — if they fail
 * the caller falls back to the spotlight popup, so a wrong guess is never fatal.
 */
import { execFile } from "node:child_process"

/** Resolve true if an Obsidian.exe process is running (win32 only). */
export function isObsidianRunning(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile("tasklist.exe", ["/FI", "IMAGENAME eq Obsidian.exe", "/NH"], { windowsHide: true }, (err, stdout) => {
      resolve(!err && /Obsidian\.exe/i.test(stdout))
    })
  })
}

/** Bring the Obsidian window to the foreground via WScript.Shell.AppActivate. */
export function raiseObsidian(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false)
  const ps = `$ErrorActionPreference='SilentlyContinue'
$w = New-Object -ComObject WScript.Shell
if ($w.AppActivate('Obsidian')) { 'ok' } else { 'miss' }`
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
      { windowsHide: true },
      (err, stdout) => resolve(!err && /ok/.test(stdout)),
    )
  })
}
