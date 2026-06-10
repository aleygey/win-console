/**
 * winhost-plugin — a self-registration client for win-host.
 *
 * Drop this into ANY opencode plugin (or any Node process) to make it appear in
 * the win console with no host rebuild:
 *   - register()    POSTs your manifest → the daemon adds your capability
 *   - heartbeat()   keeps it alive + pulls the user's latest config from 管理
 *   - emit()        push a structured event onto the host bus (rail/console react)
 *   - notify()      convenience: pop a Windows toast via the host's native bridge
 *   - stop()        unregisters cleanly on shutdown
 *
 * If the host restarts (your heartbeat 404s), this re-registers automatically. If
 * your id is already taken by a DIFFERENT plugin instance, registration is
 * rejected and the loop stops (no storm).
 *
 * Auth: if the daemon runs with WIN_HOST_PLUGIN_TOKEN set, pass the same value as
 * `token` (or via the WIN_HOST_PLUGIN_TOKEN env) and it's sent as x-winhost-token.
 *
 * Requires Node 18+ (global fetch). No dependencies.
 */

export function createWinhostPlugin({ host = "http://127.0.0.1:8799", manifest, onConfig, token } = {}) {
  if (!manifest?.id) throw new Error("createWinhostPlugin: manifest.id is required")
  const base = host.replace(/\/+$/, "")
  const authToken = token ?? process.env.WIN_HOST_PLUGIN_TOKEN
  let regToken = null
  let timer = null
  let stopped = false

  async function postJson(path, body) {
    const headers = { "content-type": "application/json" }
    if (authToken) headers["x-winhost-token"] = authToken
    const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body ?? {}) })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, body: json }
  }

  async function register() {
    const { status, body } = await postJson("/capabilities/register", manifest)
    if (!body.ok) {
      const err = new Error(body.error || `register failed (${status})`)
      // 409 = id taken by a different instance (or token conflict) — fatal, don't loop.
      err.fatal = status === 409 || status === 401
      throw err
    }
    regToken = body.token
    onConfig?.(body.config ?? {}, body.enabled !== false)
    return body
  }

  async function heartbeat() {
    if (stopped) return
    if (!regToken) return register()
    const { body } = await postJson("/capabilities/heartbeat", { id: manifest.id, token: regToken })
    if (body.ok) {
      onConfig?.(body.config ?? {}, body.enabled !== false)
    } else {
      // Host restarted or our TTL lapsed → re-register so we reappear.
      regToken = null
      await register().catch((e) => {
        if (e.fatal) {
          console.error(`[winhost-plugin] 注册被拒(${e.message}) — 停止心跳`)
          stop()
        }
      })
    }
  }

  async function start({ heartbeatMs = 10_000 } = {}) {
    await register()
    timer = setInterval(() => heartbeat().catch(() => {}), heartbeatMs)
    timer.unref?.()
  }

  async function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    if (regToken) await postJson("/capabilities/unregister", { id: manifest.id, token: regToken }).catch(() => {})
    regToken = null
  }

  /** Push a structured event onto the host bus (delivered over SSE to consoles).
   *  The host namespaces it as "<id>:<type>" so front-ends can filter by plugin. */
  async function emit(type, payload) {
    if (!regToken) return
    await postJson("/capabilities/event", { id: manifest.id, token: regToken, type, payload }).catch(() => {})
  }

  /** Pop a native Windows toast through the host's notify capability. */
  async function notify(title, message, level = "info") {
    await postJson("/cap/notify/test", { title, message, level }).catch(() => {})
  }

  return {
    start,
    stop,
    register,
    heartbeat,
    emit,
    notify,
    get token() {
      return regToken
    },
  }
}
