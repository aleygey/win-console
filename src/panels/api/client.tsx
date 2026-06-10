/**
 * Tiny typed HTTP client for the exp plugin API, plus a SolidJS context so any
 * panel can grab it via {@link useExpClient}.
 *
 * The exp plugin serves a self-contained Hono app (see the plugin's
 * `src/api/index.ts`) with permissive CORS, so the standalone console can call
 * it directly across ports without a proxy. The base URL comes from
 * `import.meta.env.VITE_EXP_API`, defaulting to the plugin's conventional
 * `http://localhost:53550`.
 *
 * All four verbs:
 *   - send/receive JSON,
 *   - throw on non-2xx (surfacing the server's `{ error }` message when present),
 *   - tolerate empty (204 / no-body) responses by resolving to `undefined`.
 */

import { createContext, useContext, type JSX } from "solid-js"

export type ExpClient = {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  patch<T>(path: string, body?: unknown): Promise<T>
  del<T>(path: string): Promise<T>
}

const DEFAULT_BASE_URL = "http://localhost:53550"

/** Resolve the configured base URL, falling back to the plugin default. */
export function resolveBaseUrl(): string {
  const fromEnv = (import.meta as any)?.env?.VITE_EXP_API as string | undefined
  return (fromEnv && fromEnv.trim()) || DEFAULT_BASE_URL
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "")
  const rel = path.startsWith("/") ? path : `/${path}`
  return `${base}${rel}`
}

async function request<T>(baseUrl: string, method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" }
    init.body = JSON.stringify(body)
  }

  const res = await fetch(joinUrl(baseUrl, path), init)

  // 204 / empty body: nothing to parse.
  if (res.status === 204) return undefined as T

  const text = await res.text()
  let data: unknown = undefined
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const serverMsg =
      data && typeof data === "object" && "error" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : typeof data === "string" && data
          ? data
          : `${res.status} ${res.statusText}`
    throw new Error(`exp api ${method} ${path} failed: ${serverMsg}`)
  }

  return data as T
}

/** Create a client bound to `baseUrl`. */
export function createClient(baseUrl: string): ExpClient {
  return {
    get: <T,>(path: string) => request<T>(baseUrl, "GET", path),
    post: <T,>(path: string, body?: unknown) => request<T>(baseUrl, "POST", path, body),
    put: <T,>(path: string, body?: unknown) => request<T>(baseUrl, "PUT", path, body),
    patch: <T,>(path: string, body?: unknown) => request<T>(baseUrl, "PATCH", path, body),
    del: <T,>(path: string) => request<T>(baseUrl, "DELETE", path),
  }
}

// -----------------------------------------------------------------------------
// SolidJS context
// -----------------------------------------------------------------------------

const ExpClientContext = createContext<ExpClient>()

/**
 * Provides an {@link ExpClient} to the tree. If no `client` prop is passed it
 * builds one from {@link resolveBaseUrl} (env `VITE_EXP_API` or the default).
 */
export function ExpClientProvider(props: { client?: ExpClient; children: JSX.Element }): JSX.Element {
  const client = props.client ?? createClient(resolveBaseUrl())
  return <ExpClientContext.Provider value={client}>{props.children}</ExpClientContext.Provider>
}

/** Grab the ambient {@link ExpClient}. Throws if used outside the provider. */
export function useExpClient(): ExpClient {
  const client = useContext(ExpClientContext)
  if (!client) {
    throw new Error("useExpClient must be used within an <ExpClientProvider>")
  }
  return client
}
