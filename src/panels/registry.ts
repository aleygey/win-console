/**
 * Plugin panel registry — same contract as opencode-exp-console's registry.ts,
 * on purpose: panels are portable between the two. Every plugin contributes
 * exactly one Panel; the shell (App.tsx) reads listPanels() to render one
 * left-rail item each and calls the active panel's render() on the right.
 *
 * Registration is a side effect of importing a panel module (e.g.
 * `import "./panels/sessions"`), which calls registerPanel at module load. Adding a
 * plugin = write a panel module that calls registerPanel, then import it once in
 * App.tsx — a new rail item appears automatically, no other wiring.
 */
import type { JSX } from "solid-js"

export type Panel = {
  /** Stable unique id, also the rail selection key (e.g. "chat"). */
  id: string
  /** Human-facing rail label (e.g. "对话"). */
  title: string
  /** Optional icon/glyph the shell renders beside the title. */
  icon?: string
  /** Returns the panel's UI. Called when this panel becomes active. */
  render: () => JSX.Element
}

const panels: Panel[] = []

/** Register a panel. Idempotent per id (repeat replaces in place — HMR-safe). */
export function registerPanel(p: Panel): void {
  const i = panels.findIndex((x) => x.id === p.id)
  if (i >= 0) panels[i] = p
  else panels.push(p)
}

/** All registered panels, in registration order (shallow copy). */
export function listPanels(): Panel[] {
  return panels.slice()
}
