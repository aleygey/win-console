/**
 * Tiny in-process event bus. Capabilities call emit(); the HTTP layer turns each
 * subscriber into an SSE connection. Late subscribers can replay the last few
 * events so a front-end that connects right after an event still sees it.
 */
import type { HostEvent } from "../contracts"

type Listener = (e: HostEvent) => void

export interface EventBus {
  emit(type: string, capability?: string, payload?: unknown): void
  subscribe(fn: Listener): () => void
  recent(): HostEvent[]
}

export function createEventBus(replay = 20): EventBus {
  const listeners = new Set<Listener>()
  const ring: HostEvent[] = []

  return {
    emit(type, capability, payload) {
      const e: HostEvent = { type, capability, payload, at: clock() }
      ring.push(e)
      if (ring.length > replay) ring.shift()
      for (const fn of listeners) {
        try {
          fn(e)
        } catch (err) {
          console.warn("[events] listener threw:", err)
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    recent: () => ring.slice(),
  }
}

/** Monotonic-ish timestamp without relying on Date.now (kept in one place so a
 *  future deterministic clock is a one-line swap). */
function clock(): number {
  return Date.now()
}
