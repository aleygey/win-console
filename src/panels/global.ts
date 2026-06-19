/**
 * Type surface for the panels. Everything is re-exported from contracts so the
 * panels carried over from win-console keep importing `../../global` unchanged,
 * while the single source of truth stays in src/contracts.
 */
export type {
  ChatSendReq,
  ChatSendRes,
  ChatMsg,
  ChatPart,
  ChatToolStatus,
  ChatSession,
  ModelInfo,
  ModelRef,
  NotifyLevel,
  NotifyReq,
  NotifyRes,
  OutlookSearchReq,
  OutlookMail,
  OutlookSearchRes,
  MailMatch,
  MailActionKind,
  MailRule,
  MailMessage,
  MailQueueItem,
  MailQueueStatus,
  MailScanRes,
  GlobalConfig,
  CapabilityInfo,
  HostEvent,
  ConfigField,
  ConfigSchema,
  WinHostClient,
} from "../contracts"

declare global {
  interface Window {
    /** Injected by the console/spotlight preloads, or set by the Obsidian host. */
    winhost?: {
      url: string
      platform: string
      mode?: string
      hide?: () => void
      /** Spotlight only: resize the frameless popup as the answer expands. */
      resize?: (height: number) => void
      /** Spotlight only: callback each time the hotkey re-shows the window. */
      onShown?: (cb: () => void) => void
    }
  }
}
