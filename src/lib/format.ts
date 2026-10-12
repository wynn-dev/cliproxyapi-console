import { formatDistanceToNowStrict } from 'date-fns'

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('en')

export const fmtCompact = (n: number | null | undefined) => (n == null ? '—' : compact.format(n))
export const fmtNumber = (n: number | null | undefined) => (n == null ? '—' : full.format(n))

export function fmtPercent(n: number | null | undefined, digits = 1) {
  if (n == null || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

export function fmtMs(ms: number | null | undefined) {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  return fmtDuration(ms)
}

export function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

export function fmtAgo(date: string | number | Date | undefined | null) {
  if (!date) return '—'
  const d = new Date(date)
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2000) return '—'
  return formatDistanceToNowStrict(d, { addSuffix: true })
}

export function fmtDateTime(date: string | number | Date) {
  return new Date(date).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** A point in the coming week or so, e.g. when a limit resets: "Mon, Oct 19, 14:00". */
export function fmtWhen(date: string | number | Date) {
  return new Date(date).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const usd0 = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Dollars: whole above $1,000, cents below. `small` shows two significant digits under a cent. */
export function fmtUsd(n: number | null | undefined, small = false) {
  if (n == null || Number.isNaN(n)) return '—'
  if (n >= 1000) return usd0.format(n)
  if (n >= 0.01 || n === 0) return usd2.format(n)
  return small ? `$${n.toPrecision(2)}` : '<$0.01'
}

/** Shows the first and last few characters of a secret. */
export function maskSecret(s: string, visible = 4) {
  if (!s) return ''
  if (s.length <= visible * 2 + 3) return '•'.repeat(Math.max(6, s.length))
  return `${s.slice(0, visible + (s.startsWith('sk-') ? 3 : 0))}…${s.slice(-visible)}`
}
