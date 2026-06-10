/**
 * Console preload — the only bridge into the management renderer. It exposes
 * nothing but the daemon's self URL (passed via additionalArguments) and the
 * platform, so the web client can build a WinHostClient pointed at the daemon.
 * Everything else goes over HTTP, exactly like the Obsidian front-end.
 */
import { contextBridge } from "electron"

function selfUrl(): string {
  const arg = process.argv.find((a) => a.startsWith("--winhost-url="))
  return arg ? arg.slice("--winhost-url=".length) : "http://127.0.0.1:8799"
}

contextBridge.exposeInMainWorld("winhost", {
  url: selfUrl(),
  platform: process.platform,
  mode: "console",
})
