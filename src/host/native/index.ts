/**
 * The real NativeHost — wires the electron/COM-backed primitives into the
 * interface capabilities consume. This is the ONE place electron is imported on
 * the host data path; the server, registry, and capabilities all stay
 * electron-free and therefore smoke-testable (the smoke injects a stub of this).
 */
import type { GlobalConfig, NativeHost } from "../../contracts"
import { showToast } from "./notify"
import {
  outlookSearch,
  outlookList,
  outlookReply,
  outlookFolders,
  outlookAttachments,
  outlookRead,
  outlookSaveAttachments,
} from "./outlook"
import { readImageDataUrl } from "./clipboard"
import { createChat } from "../chat"

export function createNativeHost(getConfig: () => GlobalConfig): NativeHost {
  return {
    platform: process.platform,
    showToast,
    outlookSearch,
    outlookList,
    outlookReply,
    outlookFolders,
    outlookAttachments,
    outlookRead,
    outlookSaveAttachments,
    clipboardImage: async () => readImageDataUrl(),
    chat: createChat(getConfig),
  }
}
