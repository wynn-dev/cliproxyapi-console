import { toBlob } from 'html-to-image'
import { consoleApi } from './api'

/**
 * Export helpers for share cards: render a card element to PNG in the browser, copy or download it,
 * and upload it as a public snapshot.
 */

/** The element as a 2× PNG, on its own background so it reads the same in light and dark mode. */
export async function renderPng(node: HTMLElement) {
  const blob = await toBlob(node, { pixelRatio: 2, backgroundColor: getComputedStyle(node).backgroundColor, cacheBust: true })
  if (!blob) throw new Error('Could not render the image')
  return blob
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/**
 * Copies the PNG to the clipboard, or downloads it where the browser can't: image clipboard needs a
 * secure context (HTTPS or localhost), and the console is often opened over plain HTTP. The blob is
 * passed as a promise so Safari keeps the click's permission while it renders.
 */
export async function copyPng(png: Promise<Blob>, filename: string): Promise<'copied' | 'downloaded'> {
  if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      return 'copied'
    } catch {
      /* fall back to a download */
    }
  }
  downloadBlob(await png, filename)
  return 'downloaded'
}

/** Stores the PNG on the console and returns its public URL. */
export async function uploadSnapshot(png: Blob) {
  const { url } = await consoleApi<{ url: string }>('/share/snapshots', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } })
  return new URL(url, window.location.origin).href
}

/** Display names for accounts in order: "Account 1", "Account 2"… unless real names are shown. */
export function accountNames(keys: string[], labels: Map<string, { label: string }>, showNames: boolean) {
  return keys.map((key, i) => (showNames && labels.get(key)?.label) || `Account ${i + 1}`)
}
