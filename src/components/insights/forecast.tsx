import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, InfoIcon } from 'lucide-react'
import { StatusDot } from '@/components/common'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { fiveHourSentence, fmtAccounts, fmtSpan, insightQueries, weeklySentence, type PoolForecast } from '@/lib/insights'
import { providerLabel } from '@/lib/providers'

/** Run-out forecast per provider, for the Insights page. */
export function ForecastCard() {
  const { data, error } = useQuery(insightQueries.forecast())
  const now = useNow(60_000)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Run-out forecast</CardTitle>
        <CardDescription>When each pool of accounts reaches its reserve if use goes on at the pace of the last few days.</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-critical">{error.message}</p>
        ) : !data ? (
          <Skeleton className="h-20 w-full" />
        ) : !data.providers.length ? (
          <p className="text-sm text-muted-foreground">No Claude or Codex accounts in use.</p>
        ) : (
          <ul className="divide-y">
            {data.providers.map((p) => (
              <PoolRow key={p.provider} pool={p} now={now} reserve={data.reserve.weekly} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function PoolRow({ pool: p, now, reserve }: { pool: PoolForecast; now: number; reserve: number }) {
  const w = p.weekly
  const weekly = weeklySentence(w, now)
  const fiveHour = fiveHourSentence(p.fiveHour, now)
  const hasPace = w.perHour !== undefined
  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <StatusDot tone={weekly.tone} />
          {providerLabel(p.provider)}
          <span className="font-normal text-muted-foreground">
            · {p.accounts} account{p.accounts === 1 ? '' : 's'}
          </span>
        </div>
        <p className="text-sm">{weekly.text}</p>
        {fiveHour && <p className="text-sm text-muted-foreground">{fiveHour}</p>}
      </div>
      {w.status !== 'learning' && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <Fact label="Left above the reserve" value={fmtAccounts(w.left)} hint={`Weekly limits of the accounts in the pool, counted down to the ${reserve}% reserve.`} />
          {hasPace && (
            <Fact
              label="Pace"
              value={`${fmtAccounts(w.perHour! * 24)} a day`}
              hint="Weekly limit used per day by all accounts together, as far as the console has seen it."
            />
          )}
          {hasPace && <Fact label="Based on" value={`Last ${fmtSpan(w.basisMs)}`} hint="Time the pool was dry doesn't count." />}
          {(w.read < p.accounts || w.stale > 0) && (
            <Fact
              label="Readings"
              value={[w.read < p.accounts && `${w.read} of ${p.accounts} accounts`, w.stale > 0 && `${w.stale} over 12h old`].filter(Boolean).join(' · ')}
              hint="An account only reports its limits when it serves a request, so idle accounts have old readings or none. Accounts without a reading count as unused. Turning on idle account limits (Settings → Routing) keeps them fresh."
            />
          )}
        </dl>
      )}
    </li>
  )
}

function Fact({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={`About ${label.toLowerCase()}`} className="text-muted-foreground/70 hover:text-foreground">
                <InfoIcon className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{hint}</TooltipContent>
          </Tooltip>
        )}
      </dt>
      <dd className="font-medium tabular">{value}</dd>
    </div>
  )
}

/**
 * The forecast in a line per provider, for the Overview. Shows nothing until there is a forecast
 * or the 5-hour limits run short, so a new install's Overview stays quiet.
 */
export function ForecastLine() {
  const { data } = useQuery(insightQueries.forecast())
  const now = useNow(60_000)
  const lines = (data?.providers ?? [])
    .map((p) => ({ provider: p.provider, weekly: p.weekly.status === 'learning' ? undefined : weeklySentence(p.weekly, now), fiveHour: fiveHourSentence(p.fiveHour, now) }))
    .filter((l) => l.weekly || l.fiveHour)
  if (!lines.length) return null
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-xl px-4 py-3 text-sm ring-1 ring-foreground/10">
      <ul className="min-w-0 flex-1 basis-full space-y-1 sm:basis-0">
        {lines.map((l) => (
          <li key={l.provider} className="flex items-baseline gap-2">
            <StatusDot tone={l.weekly?.tone ?? 'warn'} className="translate-y-[-1px]" />
            <span>
              <span className="font-medium">{providerLabel(l.provider)}:</span> {l.weekly?.text}
              {l.fiveHour && <span className={l.weekly ? 'text-muted-foreground' : undefined}> {l.fiveHour}</span>}
            </span>
          </li>
        ))}
      </ul>
      <Link to="/insights" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground max-sm:pl-4">
        Insights <ArrowRightIcon className="size-3.5" />
      </Link>
    </div>
  )
}
