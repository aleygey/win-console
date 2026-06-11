/**
 * Shared file-attachment handling for the chat surfaces (console + spotlight).
 *
 * The whole point: give the agent a file by sending its CONTENT inline — no
 * working directory, no Windows<->Linux path mapping (which is unsolvable across
 * WSL / VirtualBox shares). So:
 *   - images   -> a file part (data URL); the model sees them via vision.
 *   - text/code -> inlined into the prompt as a fenced block (the agent reads it
 *                  directly — bulletproof, needs no filesystem).
 *   - other binary -> a file part (data URL), best-effort.
 */

export type Attachment = {
  name: string
  mime: string
  isImage: boolean
  /** Set for images + binary files (sent as a file part). */
  dataUrl?: string
  /** Set for text/code files (inlined into the prompt). */
  text?: string
}

/** Per-file cap on inlined text so one big file can't blow up the prompt. */
const TEXT_MAX = 256 * 1024

/** Classify + read a File into an {@link Attachment}. */
export async function readAttachment(file: File): Promise<Attachment> {
  const mime = file.type || "application/octet-stream"
  if (mime.startsWith("image/")) {
    return { name: file.name, mime, isImage: true, dataUrl: await readDataUrl(file) }
  }
  const text = await readText(file)
  if (text != null && !looksBinary(text)) {
    const clipped = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + "\n…(已截断)" : text
    return { name: file.name, mime: "text/plain", isImage: false, text: clipped }
  }
  return { name: file.name, mime, isImage: false, dataUrl: await readDataUrl(file) }
}

/** Read a list of dropped/picked files — same classification each. */
export const readFiles = (files: FileList | File[]): Promise<Attachment[]> =>
  Promise.all(Array.from(files).map(readAttachment))

/**
 * Split attachments into what the chat send needs:
 *   - textSuffix: fenced blocks for text files, appended to the user's prompt
 *   - files:      image/binary file parts (data URLs)
 */
export function buildAttachmentPayload(atts: Attachment[]): {
  textSuffix: string
  files: Array<{ name: string; mime: string; dataUrl: string }>
} {
  const files = atts
    .filter((a) => a.dataUrl)
    .map((a) => ({ name: a.name, mime: a.mime, dataUrl: a.dataUrl! }))
  const blocks = atts
    .filter((a) => a.text != null)
    .map((a) => "[附件 " + a.name + "]\n```\n" + a.text + "\n```")
  return { textSuffix: blocks.length ? "\n\n" + blocks.join("\n\n") : "", files }
}

function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error("read failed"))
    r.readAsDataURL(f)
  })
}
function readText(f: File): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(typeof r.result === "string" ? r.result : null)
    r.onerror = () => resolve(null)
    r.readAsText(f)
  })
}
/** Heuristic: a NUL byte or many control chars in the first 2KB ⇒ treat as binary. */
function looksBinary(s: string): boolean {
  let ctrl = 0
  const n = Math.min(s.length, 2000)
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    if (c === 0) return true
    if (c < 9 || (c > 13 && c < 32)) ctrl++
  }
  return ctrl / Math.max(1, n) > 0.05
}
