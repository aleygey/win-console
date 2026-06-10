/**
 * Window diagnostics — turn a silent blank window (the recurring corp-Win10 /
 * 工位 failure) into something you can SEE and read.
 *
 *   - logs renderer console (warn/error), load failures, and renderer crashes to
 *     <userData>/winhost-renderer.log,
 *   - paints a visible error page into the window when the document fails to load
 *     (instead of leaving it blank),
 *   - opens DevTools automatically when WINHOST_DEVTOOLS=1.
 *
 * Pure diagnostics — no behavior change in the happy path.
 */
import { app, type BrowserWindow } from "electron"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

function logLine(label: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${label}] ${msg}`
  try {
    appendFileSync(join(app.getPath("userData"), "winhost-renderer.log"), line + "\n")
  } catch {
    /* best effort */
  }
  console.log(line)
}

export function rendererLogPath(): string {
  try {
    return join(app.getPath("userData"), "winhost-renderer.log")
  } catch {
    return "winhost-renderer.log"
  }
}

export function attachWindowDiagnostics(win: BrowserWindow, label: string): void {
  const wc = win.webContents

  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    logLine(label, `did-fail-load code=${code} "${desc}" url=${url} mainFrame=${isMainFrame}`)
    // code -3 = ERR_ABORTED (normal on redirects/reloads) — don't overwrite.
    if (isMainFrame && code !== -3) {
      const html =
        `<body style="font:13px/1.6 monospace;background:#111;color:#f88;margin:0;padding:18px;white-space:pre-wrap">` +
        `控制台加载失败  (${code})  ${desc}\nURL: ${url}\n\n` +
        `排查:\n` +
        ` 1) daemon 在跑吗?  curl ${url}\n` +
        ` 2) 公司代理拦了 127.0.0.1?  用 --proxy-bypass-list 或本版本已默认绕过\n` +
        ` 3) GPU/显卡策略?  用 --disable-gpu 启动\n\n` +
        `详见日志: ${rendererLogPath()}` +
        `</body>`
      void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html))
    }
  })

  wc.on("render-process-gone", (_e, details) =>
    logLine(label, `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`),
  )
  wc.on("unresponsive", () => logLine(label, "renderer unresponsive"))
  wc.on("did-finish-load", () => logLine(label, "did-finish-load OK"))

  // Mirror renderer console warnings/errors into the log file.
  wc.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) logLine(label, `console[${level === 3 ? "error" : "warn"}] ${message} (${sourceId}:${line})`)
  })

  if (process.env.WINHOST_DEVTOOLS === "1") {
    try {
      wc.openDevTools({ mode: "detach" })
    } catch {
      /* ignore */
    }
  }
}
