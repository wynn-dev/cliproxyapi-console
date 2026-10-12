import { Countdown } from '@/components/credentials/status'
import { holdLabel, reserveHold } from '@/components/credentials/lib'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtAgo, fmtWhen } from '@/lib/format'
import { RESERVE_WINDOWS, limitWindows, type LimitWindow } from '@/lib/limits'
import type { Credential, ReserveStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

function fmtUntil(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d) return `${d}d ${h}h`
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

/** An account's limit meters, captioned with the reserve hold when there is one. */
export function AccountMeters({
  account: c,
  reading,
  reserve,
  now,
  detailed,
  className,
}: {
  account: Credential
  reading?: Credential['quota']
  reserve?: ReserveStatus
  now: number
  /** Spell out what the tooltip says, for places a tap must reach it (the account panel). */
  detailed?: boolean
  className?: string
}) {
  const windows = limitWindows(c.provider, reading, now)
  const hold = reserveHold(c, reserve)
  // The caption goes on the limits that tripped the hold, or on all of them when none of them did.
  const tripped = (w: LimitWindow) => !!hold && (hold.reason === 'extra-usage' ? hold.windows.includes(w.label) : hold.windows.includes(RESERVE_WINDOWS[w.label]!))
  const held = hold && !hold.overridden ? { label: holdLabel(hold), until: hold.until } : undefined
  const heldOn = windows.some(tripped) ? tripped : () => true
  const observedAt = reading?.observed_at ? Date.parse(reading.observed_at) : undefined

  if (!windows.length) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        {['claude', 'codex'].includes(c.provider) ? "No reading yet. Limits appear after this account's next request." : 'This provider does not report usage limits.'}
      </p>
    )
  }
  return (
    <div className={cn('grid grid-cols-2 gap-x-6 gap-y-3', className)}>
      {windows.map((w) => {
        const id = RESERVE_WINDOWS[w.label]
        return (
          <LimitMeter
            key={w.id}
            window={w}
            now={now}
            observedAt={observedAt}
            reserve={id && reserve?.limits[id]}
            held={held && heldOn(w) ? held : undefined}
            detailed={detailed}
          />
        )
      })}
    </div>
  )
}

// The track is a lighter step of the fill's own color, so the state reads across the whole bar.
const METER_TONE = {
  ok: { track: 'bg-chart-1/15', fill: 'bg-chart-1' },
  warning: { track: 'bg-warning/25', fill: 'bg-warning' },
  exhausted: { track: 'bg-critical/20', fill: 'bg-critical' },
}

function LimitMeter({
  window: w,
  now,
  observedAt,
  reserve,
  held,
  detailed,
}: {
  window: LimitWindow
  now: number
  observedAt?: number
  /** Percent kept back for direct use, marked with a tick on the bar. */
  reserve?: number
  /** The console holds the account back because of this limit. */
  held?: { label: string; until: number }
  detailed?: boolean
}) {
  const pct = Math.round(w.left * 100)
  const tone = METER_TONE[w.level]
  const resets = w.resetsAt ? `resets in ${fmtUntil(w.resetsAt - now)}` : undefined
  // The same countdown as the account's status, so the two never disagree.
  const caption = held ? (
    <>
      {held.label} · back in <Countdown until={held.until} endLabel="a moment" />
    </>
  ) : w.reset ? (
    'Reset since the last reading'
  ) : w.level === 'exhausted' ? (
    ['Limit reached', resets].filter(Boolean).join(' · ')
  ) : (
    resets
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="min-w-0 cursor-default space-y-1.5" role="meter" aria-label={`${w.label} limit left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-muted-foreground">{w.label}</span>
            <span className="font-medium tabular">
              {pct}% <span className="font-normal text-muted-foreground">left</span>
            </span>
          </div>
          <div className="relative">
            <div className={cn('h-1.5 overflow-hidden rounded-full', tone.track)}>
              <div className={cn('h-full rounded-full', tone.fill)} style={{ width: `${pct}%`, minWidth: pct > 0 ? 4 : 0 }} />
            </div>
            {!!reserve && (
              <div aria-hidden className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70 ring-1 ring-card" style={{ left: `${reserve}%` }} />
            )}
          </div>
          <div className={cn('text-[11px] first-letter:uppercase', held ? 'font-medium text-foreground' : 'text-muted-foreground')}>{caption ?? ' '}</div>
          {detailed && (
            <div className="space-y-0.5 text-[11px] text-muted-foreground">
              {w.resetsAt && <div>Resets {fmtWhen(w.resetsAt)}</div>}
              {!!reserve && <div>{reserve}% kept in reserve (the tick)</div>}
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="font-medium">
          {w.label}: {pct}% left
        </div>
        <div>{Math.round(w.used * 100)}% used</div>
        {w.resetsAt && <div>Resets {fmtWhen(w.resetsAt)}</div>}
        {!!reserve && <div>{reserve}% kept in reserve for direct use (the tick)</div>}
        {w.reset && <div>This window has reset since the last reading.</div>}
        {observedAt && <div className="opacity-80">Reported {fmtAgo(observedAt)}</div>}
      </TooltipContent>
    </Tooltip>
  )
}
