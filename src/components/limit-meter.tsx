import { Countdown } from '@/components/credentials/status'
import { holdLabel, reserveHold } from '@/components/credentials/lib'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtAgo, fmtWhen } from '@/lib/format'
import { fmtAccounts } from '@/lib/insights'
import { RESERVE_WINDOWS, limitWindows, type LimitReading, type LimitWindow, type PoolWeekly } from '@/lib/limits'
import { providerLabel } from '@/lib/providers'
import type { Credential, ReserveStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

function fmtUntil(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d) return `${d}d ${h}h`
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

/** Limits every model shares. A limit check only reports these, so the others come from an older reading. */
const SHARED_WINDOWS = new Set(['5h', '7d', ':primary', ':secondary'])

/** An account's limit meters, captioned with the reserve hold when there is one. */
export function AccountMeters({
  account: c,
  reading,
  older,
  checkedAt,
  reserve,
  now,
  detailed,
  className,
}: {
  account: Credential
  reading?: LimitReading
  /** An older reading, for model-scoped limits (Fable) the newer one lacks. */
  older?: LimitReading
  /** When a limit check last read this account, to tell its readings from live ones. */
  checkedAt?: number
  reserve?: ReserveStatus
  now: number
  /** Spell out what the tooltip says, for places a tap must reach it (the account panel). */
  detailed?: boolean
  className?: string
}) {
  const observedAt = reading?.observed_at ? Date.parse(reading.observed_at) : undefined
  const olderAt = older?.observed_at ? Date.parse(older.observed_at) : undefined
  // A check stores its reading with its own time, so equal times mean the reading came from it.
  const checked = !!observedAt && observedAt === checkedAt
  const fresh = limitWindows(c.provider, reading, now)
  const kept = limitWindows(c.provider, older, now).filter((w) => !SHARED_WINDOWS.has(w.id) && !fresh.some((f) => f.id === w.id))
  const meters = [...fresh.map((w) => ({ w, at: observedAt, checked, kept: false })), ...kept.map((w) => ({ w, at: olderAt, checked: false, kept: true }))]
  const windows = meters.map((m) => m.w)
  const hold = reserveHold(c, reserve)
  // The caption goes on the limits that tripped the hold, or on all of them when none of them did.
  const tripped = (w: LimitWindow) => !!hold && (hold.reason === 'extra-usage' ? hold.windows.includes(w.label) : hold.windows.includes(RESERVE_WINDOWS[w.label]!))
  // A needed sign-in has no end to count down to; the status says it.
  const held = hold && !hold.overridden && hold.reason !== 'signed-out' ? { label: holdLabel(hold), until: hold.until } : undefined
  const heldOn = windows.some(tripped) ? tripped : () => true
  // The Fable reserve holds only the Fable models, on its own meter; this is the console's own hold,
  // whichever reading the meter shows.
  const fable = reserve?.fable?.[c.name]
  const fableHeld = fable && { label: fable.billing ? 'Paid extra usage' : 'Reserved', until: fable.until }

  if (!windows.length) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        {['claude', 'codex'].includes(c.provider) ? "No reading yet. Limits appear after this account's next request." : 'This provider does not report usage limits.'}
      </p>
    )
  }
  return (
    <div className={cn('grid grid-cols-2 gap-x-6 gap-y-3', className)}>
      {meters.map(({ w, at, checked, kept }) => {
        const id = RESERVE_WINDOWS[w.label]
        const isFable = c.provider === 'claude' && w.label === 'Fable'
        return (
          <LimitMeter
            key={w.id}
            window={w}
            now={now}
            observedAt={at}
            checked={checked}
            older={kept}
            reserve={id ? reserve?.limits[id] : isFable ? reserve?.limits.fable : undefined}
            held={held && heldOn(w) ? held : isFable ? fableHeld : undefined}
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
  checked,
  older,
  reserve,
  held,
  detailed,
}: {
  window: LimitWindow
  now: number
  observedAt?: number
  /** The reading came from a limit check rather than live traffic. */
  checked?: boolean
  /** From an older reading than the account's other meters. */
  older?: boolean
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
              {older && observedAt && <div>Reported {fmtAgo(observedAt)}</div>}
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
        {observedAt && (
          <div className="opacity-80">
            {checked ? 'Checked' : 'Reported'} {fmtAgo(observedAt)}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** A provider's weekly limits added up over its accounts, as one meter. */
export function PoolWeeklyMeter({ pool: p, reserve, now }: { pool: PoolWeekly; reserve?: number; now: number }) {
  const share = p.left / p.accounts
  const pct = Math.round(share * 100)
  const tone = METER_TONE[share <= 0 ? 'exhausted' : share <= 0.2 ? 'warning' : 'ok']
  const name = providerLabel(p.provider)
  const gain = p.nextReset && Math.round((p.nextReset.gain / p.accounts) * 100)
  const reset = p.nextReset && `${p.left < p.accounts ? 'first ' : ''}reset in ${fmtUntil(p.nextReset.at - now)}${gain ? `, +${gain}%` : ''}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="min-w-0 cursor-default space-y-1.5" role="meter" aria-label={`${name} weekly limit left, all accounts`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-muted-foreground">
              <span className="font-medium text-foreground">{name}</span> · {p.accounts} accounts
            </span>
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
          <div className="text-[11px] text-muted-foreground first-letter:uppercase">{reset ?? ' '}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <div className="font-medium">
          {name} weekly, all accounts: {pct}% left
        </div>
        <div>
          {fmtAccounts(p.left).replace(/^./, (c) => c.toUpperCase())} left of {p.accounts}
        </div>
        {p.nextReset && (
          <div>
            Next reset {fmtWhen(p.nextReset.at)}
            {gain ? `, gives back ${gain}%` : ''}
          </div>
        )}
        {!!reserve && <div>{reserve}% of each account kept in reserve for direct use (the tick)</div>}
        {p.unread > 0 && (
          <div>
            {p.unread} account{p.unread === 1 ? " hasn't" : "s haven't"} reported {p.unread === 1 ? 'its' : 'their'} weekly limit yet and count
            {p.unread === 1 ? 's' : ''} as unused.
          </div>
        )}
        <div className="opacity-80">Every account counts the same, whatever its plan. Accounts you turned off are left out.</div>
      </TooltipContent>
    </Tooltip>
  )
}
