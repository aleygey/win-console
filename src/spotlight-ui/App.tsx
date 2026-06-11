/**
 * Spotlight — the hotkey quick-ask. A Raycast/macOS-Spotlight-style single-line
 * bar that appears at the cursor and springs open into a compact conversation.
 * (The full chat panel lives in the console; this is the lightweight "ask or
 * assign a task anytime" surface.)
 */
import type { JSX } from "solid-js"
import { QuickAsk } from "./quick-ask"

export default function App(): JSX.Element {
  return <QuickAsk />
}
