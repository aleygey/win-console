/** Read the current clipboard image as a PNG data: URL (or null if none). */
import { clipboard } from "electron"

export function readImageDataUrl(): string | null {
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  return img.toDataURL()
}
