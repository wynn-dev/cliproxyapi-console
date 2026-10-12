/**
 * Usage limits per account, read from the rate-limit headers CPA last saw for it
 * (`anthropic-ratelimit-unified-*` for Claude, `x-codex-*` for Codex). Shared by the server (the
 * account reserve) and the SPA, so it imports nothing.
 */

export interface LimitReading {
  observed_at?: string
  signals: Record<string, string>
}

export interface LimitWindow {
  id: string
  label: string
  /** Share of the limit used, 0 to 1. */
  used: number
  /** Share of the limit left, 0 to 1. Zero once the provider rejects requests, even below 100% used. */
  left: number
  /** When the window resets (ms). Absent when unknown or already passed. */
  resetsAt?: number
  /** The window reset after the reading was taken, so nothing has been used since. */
  reset: boolean
  level: 'ok' | 'warning' | 'exhausted'
}

const num = (v: string | undefined) => {
  const n = Number(v)
  return v != null && v.trim() !== '' && Number.isFinite(n) ? n : undefined
}

const CLAUDE_LABELS: Record<string, string> = { '5h': '5h', '7d': 'Weekly', '7d_oi': 'Fable' }

function windowLabel(minutes: number | undefined, slot: string) {
  if (!minutes) return slot === 'primary' ? '5h' : 'Weekly'
  if (Math.abs(minutes - 10_080) < 60) return 'Weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`
}

const titleCase = (s: string) => s.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase())

export const hasReading = (r: LimitReading | undefined): r is LimitReading => !!r && Object.keys(r.signals ?? {}).length > 0

export function limitWindows(provider: string, reading: LimitReading | undefined, now: number): LimitWindow[] {
  if (!hasReading(reading)) return []
  const s = Object.fromEntries(Object.entries(reading.signals).map(([k, v]) => [k.toLowerCase(), v]))
  const observedAt = Date.parse(reading.observed_at ?? '') || now
  const out: LimitWindow[] = []
  const add = (w: { id: string; label: string; used: number; resetsAt?: number; rejected?: boolean; warned?: boolean }) => {
    const reset = w.resetsAt !== undefined && w.resetsAt <= now
    const used = reset ? 0 : Math.min(1, Math.max(0, w.used))
    const level = reset ? 'ok' : w.rejected || w.used >= 1 ? 'exhausted' : w.warned || w.used >= 0.8 ? 'warning' : 'ok'
    out.push({ id: w.id, label: w.label, used, left: level === 'exhausted' ? 0 : 1 - used, resetsAt: reset ? undefined : w.resetsAt, reset, level })
  }

  if (provider === 'claude') {
    const prefix = 'anthropic-ratelimit-unified-'
    const ids = Object.keys(s)
      .filter((k) => k.startsWith(prefix) && k.endsWith('-utilization'))
      .map((k) => k.slice(prefix.length, -'-utilization'.length))
      .filter((id) => id !== 'overage')
    const rank = (id: string) => (id in CLAUDE_LABELS ? Object.keys(CLAUDE_LABELS).indexOf(id) : 99)
    for (const id of ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      const used = num(s[`${prefix}${id}-utilization`])
      if (used === undefined) continue
      const reset = num(s[`${prefix}${id}-reset`])
      const status = s[`${prefix}${id}-status`]
      add({ id, label: CLAUDE_LABELS[id] ?? id, used, resetsAt: reset ? reset * 1000 : undefined, rejected: status === 'rejected', warned: status === 'allowed_warning' })
    }
  } else if (provider === 'codex') {
    const windows: { scope: string; slot: string }[] = []
    for (const k of Object.keys(s)) {
      const m = /^x-codex-(?:(.+)-)?(primary|secondary)-used-percent$/.exec(k)
      if (m) windows.push({ scope: m[1] ?? '', slot: m[2] })
    }
    windows.sort((a, b) => a.scope.localeCompare(b.scope) || a.slot.localeCompare(b.slot))
    for (const { scope, slot } of windows) {
      const base = `x-codex-${scope ? `${scope}-` : ''}${slot}-`
      const used = num(s[`${base}used-percent`])
      if (used === undefined) continue
      const resetAt = num(s[`${base}reset-at`])
      const resetAfter = num(s[`${base}reset-after-seconds`])
      const label = windowLabel(num(s[`${base}window-minutes`]), slot)
      const name = scope && (s[`x-codex-${scope}-limit-name`] || titleCase(scope.replace(/^additional-/, '')))
      add({
        id: `${scope}:${slot}`,
        label: name ? `${name} · ${label}` : label,
        used: used / 100,
        resetsAt: resetAt ? resetAt * 1000 : resetAfter !== undefined ? observedAt + resetAfter * 1000 : undefined,
      })
    }
  }
  return out
}
