/**
 * Global hotkey registration. The daemon OWNS the hotkey (only one process may),
 * which is exactly why the native bits live here and not in Obsidian: Ctrl+Space
 * works system-wide regardless of which window has focus.
 */
import { globalShortcut } from "electron"

/** Register `accelerator`, replacing any prior binding. Returns false if it is
 *  invalid or already taken by another app. */
export function registerHotkey(accelerator: string, onPress: () => void): boolean {
  try {
    globalShortcut.unregisterAll()
    return globalShortcut.register(accelerator, onPress)
  } catch {
    return false
  }
}
