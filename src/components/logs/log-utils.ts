export const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type Level = (typeof LEVELS)[number]

export const LEVEL_STYLE: Record<Level, { label: string; dot: string; badge: string; row?: string }> = {
  debug: { label: 'Debug', dot: 'bg-muted-foreground/60', badge: 'bg-muted-foreground/10 text-muted-foreground' },
  info: { label: 'Info', dot: 'bg-chart-1', badge: 'bg-chart-1/10 text-chart-1' },
  warn: { label: 'Warn', dot: 'bg-warning', badge: 'bg-warning/15 text-foreground/80', row: 'bg-warning/5' },
  error: { label: 'Error', dot: 'bg-critical', badge: 'bg-critical/10 text-critical', row: 'bg-critical/5' },
}

export interface LogLine {
  id: number
  raw: string
  lower: string
  date?: string
  time?: string
  reqId?: string
  level?: Level
  source?: string
  message: string
  /** gin access log line for a management API request */
  mgmt: boolean
}

// [2026-10-10 12:00:00] [abcd1234] [info ] [file.go:12] message
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] \[([^\]]*)\] \[([^\]]*)\] \[([^\]]*)\] ?([\s\S]*)$/

function normalizeLevel(s: string): Level | undefined {
  const l = s.trim().toLowerCase()
  if (l === 'warning') return 'warn'
  if (l === 'fatal' || l === 'panic') return 'error'
  if (l === 'trace') return 'debug'
  return (LEVELS as readonly string[]).includes(l) ? (l as Level) : undefined
}

export function parseLine(raw: string, id: number): LogLine {
  const m = LINE_RE.exec(raw)
  const base = { id, raw, lower: raw.toLowerCase(), mgmt: raw.includes('"/v8/management') }
  if (!m) return { ...base, message: raw }
  const reqId = m[3].trim()
  const source = m[5].trim()
  return {
    ...base,
    date: m[1],
    time: m[2],
    reqId: reqId && !/^-+$/.test(reqId) ? reqId : undefined,
    level: normalizeLevel(m[4]),
    source,
    // gin pads access-log columns heavily; collapse the padding so lines fit
    message: source.startsWith('gin_logger') ? m[6].replace(/ {2,}/g, ' ').trim() : m[6],
  }
}

export function saveText(text: string, prefix: string) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  a.download = `${prefix}-${stamp}.log`
  a.click()
  URL.revokeObjectURL(a.href)
}

export function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}
