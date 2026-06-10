/**
 * The built-in capability set. This is the ONE list you touch to add a plugin:
 * write a Capability module, import it here. It then surfaces to the agent (its
 * tools), the UIs (its routes + panel), and the console (its config) with no
 * other wiring.
 *
 * (A future step could scan a `capabilities/` folder at runtime for drop-in
 *  modules; for now the set is compiled in, which keeps types end-to-end.)
 */
import type { Capability } from "../../contracts"
import { chatCapability } from "./chat"
import { mailflowCapability } from "./mailflow"
import { notifyCapability } from "./notify"
import { clipboardCapability } from "./clipboard"
import { expCapability } from "./exp"

// Note: the old standalone `outlook` capability was folded into `mailflow`
// (its outlook_search tool moved there), so the management page shows a single
// mail card instead of "邮件" + "邮件工作流".
export const builtinCapabilities: Capability[] = [
  chatCapability,
  mailflowCapability,
  notifyCapability,
  clipboardCapability,
  expCapability,
]
