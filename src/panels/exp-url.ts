/**
 * Resolve the exp (playbook) backend URL from the daemon, so the single place it
 * is configured is the console (exp capability's playbookUrl). Front-ends call
 * this at open time, then point their ExpClient straight at the VM backend.
 * Falls back to the conventional dev default if the daemon isn't reachable.
 */
import { api } from "./bridge"

const DEFAULT_EXP_URL = "http://localhost:53550"

export async function resolveExpUrl(): Promise<string> {
  try {
    const caps = await api.capabilities()
    const url = caps.find((c) => c.id === "exp")?.config?.playbookUrl
    if (typeof url === "string" && url.trim()) return url.trim()
  } catch {
    /* daemon down — fall through to default */
  }
  return DEFAULT_EXP_URL
}
