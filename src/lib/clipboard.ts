/**
 * Browsers only offer the Clipboard API on HTTPS and localhost, and the console is usually opened
 * over plain HTTP on a LAN or tailnet address. There, copy through a selected text field. It is
 * placed next to the button so a dialog's focus trap doesn't pull focus (and the selection) away.
 */
export async function copyText(text: string, near: HTMLElement) {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text)
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  near.after(field)
  field.select()
  const ok = document.execCommand('copy')
  field.remove()
  near.focus()
  if (!ok) throw new Error('Copy failed')
}
