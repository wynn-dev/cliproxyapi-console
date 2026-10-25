import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  BadgeDollarSignIcon,
  CoinsIcon,
  CompassIcon,
  FlameIcon,
  FootprintsIcon,
  GemIcon,
  HeartIcon,
  MoonIcon,
  PartyPopperIcon,
  SunIcon,
  SunriseIcon,
  SunsetIcon,
  ZapIcon,
} from 'lucide-react'
import { UnpricedNote, valueHeadline } from '@/components/share-card'
import { fmtCompact, fmtDuration, fmtMs, fmtNumber, fmtPercent, fmtUsd } from '@/lib/format'
import { PRICES_AS_OF } from '@/lib/prices'
import { providerLabel } from '@/lib/providers'
import type { ShareSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { DAY_PARTS, type Award, type Personality, type Wrapped } from '@/lib/wrapped'

/**
 * The wrapped slides. Each fills the 1072×491 content box of a 1200×675 slide; `--slide` is the
 * slide's accent color, set by the frame.
 */

const MAX_ACCOUNTS = 5
const ACCENT = 'var(--slide)'

/** The accent mixed into the muted track: a heat level from 0 (empty) to 1 (the most). */
const heat = (level: number) => (level <= 0 ? 'var(--muted)' : `color-mix(in oklab, ${ACCENT} ${Math.round(18 + level * 82)}%, var(--muted))`)

const dayLabel = (month: string, day: number, opts: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric' }) =>
  new Date(`${month}-${String(day + 1).padStart(2, '0')}T00:00`).toLocaleDateString('en', opts)

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-3xl font-medium" style={{ color: ACCENT }}>
      {children}
    </div>
  )
}

function Big({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('text-[120px] leading-none font-semibold tracking-tight', className)}>{children}</div>
}

/** The cover, and the image behind "Copy link": the month in one slide. */
export function SummarySlide({ s }: { s: ShareSummary }) {
  return (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-4">
        <Kicker>This month through the proxy</Kicker>
        <div className="flex items-baseline gap-12">
          <div>
            <Big>{fmtCompact(s.tokens)}</Big>
            <div className="mt-2 text-3xl text-muted-foreground">tokens</div>
          </div>
          <div>
            <Big>{fmtCompact(s.requests)}</Big>
            <div className="mt-2 text-3xl text-muted-foreground">requests</div>
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <div className="text-4xl font-semibold tracking-tight">{valueHeadline(s.value, s.planPrice, 'this month')}</div>
        <div className="flex gap-10 text-2xl text-muted-foreground">
          <span>
            Top model <span className="font-medium text-foreground">{s.topModel?.model ?? '—'}</span>
          </span>
          <span>
            Cache hit rate <span className="font-medium text-foreground">{fmtPercent(s.cacheHitRate)}</span>
          </span>
        </div>
        <UnpricedNote summary={s} className="text-xl text-muted-foreground" />
      </div>
    </div>
  )
}

/** This month against the one before, when that one had traffic too. */
export function VersusSlide({ s, prev, prevName }: { s: ShareSummary; prev: ShareSummary; prevName: string }) {
  const change = (now: number, before: number) => (before ? now / before - 1 : null)
  const tokens = change(s.tokens, prev.tokens)
  const rows = [
    { label: 'Tokens', now: fmtCompact(s.tokens), before: fmtCompact(prev.tokens), change: tokens },
    { label: 'Requests', now: fmtCompact(s.requests), before: fmtCompact(prev.requests), change: change(s.requests, prev.requests) },
    { label: 'Value at API prices', now: fmtUsd(s.value), before: fmtUsd(prev.value), change: change(s.value, prev.value) },
  ]
  const up = (tokens ?? 0) >= 0
  return (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-4">
        <Kicker>Compared to {prevName}</Kicker>
        <div className="flex items-center gap-6">
          <Big>{tokens == null ? '—' : `${up ? '+' : '−'}${fmtPercent(Math.abs(tokens), 0)}`}</Big>
          {tokens != null && (up ? <ArrowUpRightIcon className="size-28" style={{ color: ACCENT }} /> : <ArrowDownRightIcon className="size-28 text-muted-foreground" />)}
        </div>
        <div className="text-3xl text-muted-foreground">{up ? 'more tokens than the month before' : 'fewer tokens than the month before'}</div>
      </div>
      <div className="grid grid-cols-3 gap-6">
        {rows.map((r) => (
          <div key={r.label} className="space-y-1 rounded-2xl bg-muted/60 p-6">
            <div className="text-xl text-muted-foreground">{r.label}</div>
            <div className="text-4xl font-semibold tracking-tight tabular">{r.now}</div>
            <div className="text-xl text-muted-foreground tabular">
              from {r.before}
              {r.change != null && ` · ${r.change >= 0 ? '+' : '−'}${fmtPercent(Math.abs(r.change), 0)}`}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ValueSlide({ s, name }: { s: ShareSummary; name: string }) {
  return (
    <div className="flex h-full flex-col justify-center gap-6">
      <Kicker>{name} at API prices</Kicker>
      <div className="text-[140px] leading-none font-semibold tracking-tight">{fmtUsd(s.value)}</div>
      {s.planPrice && <div className="text-4xl">{valueHeadline(s.value, s.planPrice, 'this month')}</div>}
      {s.planPrice && s.value > s.planPrice && (
        <div className="text-3xl text-muted-foreground">{(s.value / s.planPrice).toFixed(1)}× what the plan costs</div>
      )}
      <div className="space-y-1 text-xl text-muted-foreground">
        <div>At public API list prices as of {PRICES_AS_OF}</div>
        <UnpricedNote summary={s} className="" />
      </div>
    </div>
  )
}

function Bars({ rows }: { rows: { label: string; value: number; hint: string }[] }) {
  const max = rows[0]?.value || 1
  return (
    <div className="space-y-5">
      {rows.map((r, i) => (
        <div key={i} className="space-y-2">
          <div className="flex items-baseline justify-between gap-6 text-3xl">
            <span className="truncate font-medium">{r.label}</span>
            <span className="tabular shrink-0 text-muted-foreground">{r.hint}</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: ACCENT }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ModelsSlide({ s }: { s: ShareSummary }) {
  return (
    <div className="flex h-full flex-col gap-10">
      <Kicker>Top models by tokens</Kicker>
      <Bars rows={s.topModels.map((m) => ({ label: m.model, value: m.tokens, hint: `${fmtCompact(m.tokens)} · ${fmtPercent(s.tokens ? m.tokens / s.tokens : null, 0)}` }))} />
    </div>
  )
}

const STACK_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

/** Providers as one split bar, and the tools that sent the traffic. */
export function StackSlide({ s }: { s: ShareSummary }) {
  const total = s.providers.reduce((a, p) => a + p.tokens, 0) || 1
  const tools = s.clients.slice(0, 4)
  return (
    <div className="flex h-full flex-col gap-10">
      <Kicker>Your stack</Kicker>
      {s.providers.length > 0 && (
        <div className="space-y-4">
          <div className="flex h-16 overflow-hidden rounded-2xl">
            {s.providers.map((p, i) => (
              <div key={p.name} style={{ width: `${(p.tokens / total) * 100}%`, background: STACK_COLORS[i] }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-10 gap-y-2 text-3xl">
            {s.providers.map((p, i) => (
              <span key={p.name} className="flex items-center gap-3">
                <span className="size-5 rounded-md" style={{ background: STACK_COLORS[i] }} />
                <span className="font-medium">{providerLabel(p.name)}</span>
                <span className="text-muted-foreground tabular">{fmtPercent(p.tokens / total, 0)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {tools.length > 0 && (
        <div className="space-y-4">
          <div className="text-2xl text-muted-foreground">Sent from</div>
          <div className="grid grid-cols-2 gap-x-12 gap-y-4">
            {tools.map((t, i) => (
              <div key={t.name} className="flex items-baseline justify-between gap-4 border-b pb-3 text-3xl">
                <span className="truncate font-medium">
                  <span className="mr-3 text-muted-foreground tabular">{i + 1}</span>
                  {t.name}
                </span>
                <span className="shrink-0 text-muted-foreground tabular">{fmtCompact(t.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function CacheSlide({ s }: { s: ShareSummary }) {
  return (
    <div className="flex h-full flex-col justify-center gap-6">
      <Kicker>Cache hit rate</Kicker>
      <div className="text-[160px] leading-none font-semibold tracking-tight">{fmtPercent(s.cacheHitRate)}</div>
      <div className="text-3xl text-muted-foreground">of input tokens were read from the prompt cache</div>
    </div>
  )
}

export function BusiestDaySlide({ w, month }: { w: Wrapped; month: string }) {
  const max = w.perDay[w.busiest] || 1
  return (
    <div className="flex h-full flex-col gap-6">
      <Kicker>Busiest day</Kicker>
      <div>
        <div className="text-7xl font-semibold tracking-tight">{dayLabel(month, w.busiest, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div className="mt-3 text-3xl text-muted-foreground">{fmtNumber(w.perDay[w.busiest])} tokens</div>
      </div>
      <div className="flex min-h-0 flex-1 items-end gap-1.5">
        {w.perDay.map((n, i) => (
          <div key={i} className={cn('flex-1 rounded-t', i !== w.busiest && 'bg-muted')} style={{ height: `${Math.max(2, (n / max) * 100)}%`, background: i === w.busiest ? ACCENT : undefined }} />
        ))}
      </div>
    </div>
  )
}

const PERSONALITY_ICONS: Record<Personality, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  'early-bird': SunriseIcon,
  daytime: SunIcon,
  evening: SunsetIcon,
  'night-owl': MoonIcon,
}
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hourLabel = (h: number) => (h === 0 ? '12 am' : h === 12 ? '12 pm' : h < 12 ? `${h} am` : `${h - 12} pm`)

/** When in the week the tokens came: a weekday × hour heatmap, the part of the day that wins, and the peak hour. */
export function RhythmSlide({ w }: { w: Wrapped }) {
  const max = Math.max(1, ...w.grid.flat())
  const part = DAY_PARTS[w.personality.id]
  const Icon = PERSONALITY_ICONS[w.personality.id]
  const peak = w.peak && new Date(w.peak.t)
  return (
    <div className="flex h-full flex-col gap-7">
      <div className="flex items-start justify-between gap-8">
        <div className="space-y-2">
          <Kicker>Your rhythm</Kicker>
          <div className="flex items-center gap-4 text-7xl font-semibold tracking-tight">
            <Icon className="size-16" style={{ color: ACCENT }} />
            {part.title}
          </div>
          <div className="text-2xl text-muted-foreground">{part.line(fmtPercent(w.personality.share, 0))}</div>
        </div>
        {peak && (
          <div className="shrink-0 rounded-2xl bg-muted/60 px-6 py-4 text-right">
            <div className="text-xl text-muted-foreground">Peak hour</div>
            <div className="text-3xl font-semibold tracking-tight">
              {peak.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}, {hourLabel(peak.getHours())}
            </div>
            <div className="text-xl text-muted-foreground tabular">{fmtCompact(w.peak!.tokens)} tokens in one hour</div>
          </div>
        )}
      </div>
      <div className="grid grid-cols-[64px_repeat(24,1fr)] gap-1">
        {w.grid.map((row, d) => (
          <div key={d} className="contents">
            <div className="flex items-center text-lg text-muted-foreground">{WEEKDAYS[d]}</div>
            {row.map((n, h) => (
              <div key={h} className="h-7 rounded-[5px]" style={{ background: heat(n / max) }} />
            ))}
          </div>
        ))}
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-base whitespace-nowrap text-muted-foreground">
            {h % 6 === 0 ? hourLabel(h) : ''}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The month as a calendar, colored by tokens, with the longest run of active days outlined. */
export function CalendarSlide({ w, month }: { w: Wrapped; month: string }) {
  const max = Math.max(1, ...w.perDay)
  const cells = [...Array.from({ length: w.firstWeekday }, () => null), ...w.perDay.map((n, i) => ({ n, i }))]
  const inStreak = (i: number) => w.streak.days > 1 && i >= w.streak.start && i <= w.streak.end
  return (
    <div className="flex h-full items-center justify-between gap-12">
      <div className="space-y-8">
        <Kicker>Showing up</Kicker>
        <div>
          <Big>
            {w.activeDays}
            <span className="text-6xl text-muted-foreground">/{w.perDay.length}</span>
          </Big>
          <div className="mt-3 text-3xl text-muted-foreground">days with traffic</div>
        </div>
        {w.streak.days > 1 && (
          <div className="flex items-center gap-4">
            <FlameIcon className="size-12" style={{ color: ACCENT }} />
            <div>
              <div className="text-4xl font-semibold tracking-tight">{w.streak.days}-day streak</div>
              <div className="text-2xl text-muted-foreground">
                {dayLabel(month, w.streak.start, { month: 'short', day: 'numeric' })} – {dayLabel(month, w.streak.end, { month: 'short', day: 'numeric' })}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="grid shrink-0 grid-cols-7 gap-2.5">
        {WEEKDAYS.map((d) => (
          <div key={d} className="pb-1 text-center text-lg text-muted-foreground">
            {d.slice(0, 2)}
          </div>
        ))}
        {cells.map((c, k) =>
          c ? (
            <div
              key={k}
              className={cn('flex size-[54px] items-center justify-center rounded-xl text-lg tabular', c.n / max > 0.6 ? 'text-white' : 'text-muted-foreground')}
              style={{ background: heat(c.n / max), boxShadow: inStreak(c.i) ? `inset 0 0 0 3px ${ACCENT}` : undefined }}
            >
              {c.i + 1}
            </div>
          ) : (
            <div key={k} />
          ),
        )}
      </div>
    </div>
  )
}

export function ConversationsSlide({ s }: { s: ShareSummary }) {
  const l = s.sessions.longest
  return (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-4">
        <Kicker>Conversations</Kicker>
        <Big>{fmtNumber(s.sessions.count)}</Big>
        <div className="text-3xl text-muted-foreground">
          conversations, {fmtNumber(Math.round(s.requests / Math.max(1, s.sessions.count)))} requests each on average
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6">
        {l && (
          <div className="col-span-2 space-y-1 rounded-2xl bg-muted/60 p-6">
            <div className="text-xl text-muted-foreground">The longest one</div>
            <div className="text-4xl font-semibold tracking-tight">
              {fmtNumber(l.requests)} requests{l.ms >= 60_000 && ` over ${fmtDuration(l.ms)}`}
            </div>
            <div className="text-xl text-muted-foreground tabular">{fmtCompact(l.tokens)} tokens</div>
          </div>
        )}
        <div className="space-y-1 rounded-2xl bg-muted/60 p-6">
          <div className="text-xl text-muted-foreground">Compactions</div>
          <div className="text-4xl font-semibold tracking-tight tabular">{fmtNumber(s.sessions.compactions)}</div>
          <div className="text-xl text-muted-foreground">context squeezed to keep going</div>
        </div>
      </div>
    </div>
  )
}

/** The month in comparisons: novels written, War and Peace read, years of reading. */
export function NumbersSlide({ s, w }: { s: ShareSummary; w: Wrapped }) {
  const n = w.numbers
  const many = (x: number) => (x >= 10 ? fmtNumber(Math.round(x)) : x >= 1 ? x.toFixed(1) : x.toFixed(2))
  const items = [
    { big: many(n.novels), line: `novels' worth of words written by the models (${fmtCompact(s.output)} output tokens)` },
    { big: `${many(n.warAndPeace)}×`, line: 'War and Peace, counting everything read and written' },
    n.readingYears >= 1
      ? { big: `${many(n.readingYears)} yrs`, line: 'for one person to read it all, nonstop' }
      : { big: `${fmtNumber(Math.round(n.readingYears * 365))} days`, line: 'for one person to read it all, nonstop' },
    s.avgTtft
      ? { big: fmtMs(s.avgTtft), line: 'to the first token, on average' }
      : { big: fmtNumber(Math.round(n.perActiveDay)), line: 'requests on an active day' },
  ]
  return (
    <div className="flex h-full flex-col gap-10">
      <Kicker>By the numbers</Kicker>
      <div className="grid flex-1 grid-cols-2 gap-x-14 gap-y-8">
        {items.map((it) => (
          <div key={it.line} className="space-y-2">
            <div className="text-7xl font-semibold tracking-tight tabular">{it.big}</div>
            <div className="text-2xl leading-snug text-muted-foreground">{it.line}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

const AWARD_ICONS: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  billion: GemIcon,
  'hundred-million': CoinsIcon,
  value: BadgeDollarSignIcon,
  cache: ZapIcon,
  streak: FlameIcon,
  marathon: FootprintsIcon,
  weekend: PartyPopperIcon,
  loyal: HeartIcon,
  explorer: CompassIcon,
  ...PERSONALITY_ICONS,
}

export function AwardsSlide({ awards }: { awards: Award[] }) {
  return (
    <div className="flex h-full flex-col gap-8">
      <Kicker>This month's awards</Kicker>
      <div className={cn('grid flex-1 gap-5', awards.length > 4 ? 'grid-cols-3' : 'grid-cols-2')}>
        {awards.map((a, i) => {
          const Icon = AWARD_ICONS[a.id] ?? GemIcon
          const color = STACK_COLORS[i % STACK_COLORS.length]
          return (
            <div
              key={a.id}
              className="flex flex-col justify-center gap-3 rounded-2xl p-6"
              style={{ background: `color-mix(in oklab, ${color} 14%, var(--card))`, boxShadow: `inset 0 0 0 2px color-mix(in oklab, ${color} 35%, transparent)` }}
            >
              <Icon className="size-12" style={{ color }} />
              <div className="text-4xl font-semibold tracking-tight">{a.title}</div>
              <div className="text-xl text-muted-foreground">{a.line}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function AccountsSlide({ s, names }: { s: ShareSummary; names: string[] }) {
  const accounts = s.accounts.slice(0, MAX_ACCOUNTS)
  return (
    <div className="flex h-full flex-col gap-8">
      <Kicker>Served by {s.accounts.length === 1 ? '1 account' : `${s.accounts.length} accounts`}</Kicker>
      <Bars rows={accounts.map((a, i) => ({ label: names[i], value: a.tokens, hint: fmtCompact(a.tokens) }))} />
      {s.accounts.length > MAX_ACCOUNTS && <div className="text-2xl text-muted-foreground">and {s.accounts.length - MAX_ACCOUNTS} more</div>}
    </div>
  )
}
