import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRightIcon } from 'lucide-react'
import { StatusDot } from '@/components/common'
import { CredentialStatus } from '@/components/credentials/status'
import { accountName, credState, reserveHold, reserveNote } from '@/components/credentials/lib'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { fmtAgo, fmtWhen } from '@/lib/format'
import { RESERVE_WINDOWS, hasReading, limitWindows, type LimitWindow } from '@/lib/limits'
import { providerLabel } from '@/lib/providers'
import { queries } from '@/lib/queries'
import { hasAccountPool, keepsCachesWarm, routingOf, strategyLabel } from '@/lib/routing'
import type { Credential, ReserveStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

const PROVIDER_ORDER = ['claude', 'codex']

/** Providers first, then the order fill-first routing tries accounts in: priority, then file name. */
function byRoutingOrder(a: Credential, b: Credential) {
  const rank = (c: Credential) => (PROVIDER_ORDER.includes(c.provider) ? PROVIDER_ORDER.indexOf(c.provider) : PROVIDER_ORDER.length)
  return rank(a) - rank(b) || a.provider.localeCompare(b.provider) || (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function fmtUntil(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d) return `${d}d ${h}h`
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

/** Every account with its usage limits, as the provider last reported them. */
export function AccountsCard({ running }: { running: boolean }) {
  const now = useNow(30_000)
  const credentials = useQuery({ ...queries.credentials(), enabled: running })
  const stored = useQuery({ ...queries.limits(), enabled: running })
  const config = useQuery({ ...queries.config(), enabled: running })
  const reserve = useQuery({ ...queries.reserve(), enabled: running })
  const accounts = [...(credentials.data?.files ?? [])].sort(byRoutingOrder)
  const routing = routingOf(config.data)
  const scattered = hasAccountPool(accounts) && !keepsCachesWarm(routing)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <CardDescription>How much of each usage limit is left, as each provider last reported it.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/credentials">
              Manage <ArrowRightIcon />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {!running ? (
          <Empty>Start CLIProxyAPI to see your accounts.</Empty>
        ) : credentials.isPending ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : accounts.length === 0 ? (
          <Empty>
            No accounts yet.{' '}
            <Link to="/credentials" className="text-foreground underline underline-offset-4">
              Add one
            </Link>
          </Empty>
        ) : (
          <>
            <ul className="divide-y">
              {accounts.map((c) => (
                <AccountRow
                  key={c.id}
                  account={c}
                  reading={hasReading(c.quota) ? c.quota : stored.data?.[c.name]}
                  reserve={reserve.data}
                  now={now}
                />
              ))}
            </ul>
            {config.data && (
              <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
                <Badge variant="outline" className="gap-1.5 font-normal">
                  {scattered && <StatusDot tone="warn" />}
                  {strategyLabel(routing.strategy)}
                  {routing.affinity && ' · sticky sessions'}
                </Badge>
                {scattered
                  ? 'Conversations can move between accounts and lose their prompt cache.'
                  : keepsCachesWarm(routing)
                    ? 'One account is used until it runs out, and each conversation stays on its account.'
                    : 'How requests are spread across accounts.'}
                <Link to="/settings" className="text-foreground underline underline-offset-4">
                  {scattered ? 'Fix in Settings' : 'Routing settings'}
                </Link>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</div>
}

function AccountRow({
  account: c,
  reading,
  reserve,
  now,
}: {
  account: Credential
  reading?: Credential['quota']
  reserve?: ReserveStatus
  now: number
}) {
  const windows = limitWindows(c.provider, reading, now)
  const hold = reserveHold(c, reserve)
  const recent = c.recent_requests.at(-1)
  const inUse = credState(c) === 'active' && !!recent && recent.success + recent.failed > 0
  const observedAt = reading?.observed_at ? Date.parse(reading.observed_at) : undefined

  return (
    <li className="grid items-start gap-x-8 gap-y-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{accountName(c)}</span>
          <Badge variant="secondary" className="h-4.5 px-1.5 text-[11px]">
            {providerLabel(c.provider)}
          </Badge>
          {c.id_token?.plan_type && (
            <Badge variant="outline" className="h-4.5 px-1.5 text-[11px] capitalize">
              {c.id_token.plan_type}
            </Badge>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          {credState(c) === 'active' ? (
            <span className="inline-flex items-center gap-2">
              <StatusDot tone="good" pulse={inUse} />
              {inUse ? 'In use' : 'Ready'}
              {hold && reserve && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default text-xs text-muted-foreground/80">· reserve overridden</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{reserveNote(hold, reserve.limits)}</TooltipContent>
                </Tooltip>
              )}
            </span>
          ) : (
            <CredentialStatus credential={c} />
          )}
        </div>
      </div>
      {windows.length ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-4">
          {windows.map((w) => (
            <LimitMeter key={w.id} window={w} now={now} observedAt={observedAt} reserve={reserve?.limits[RESERVE_WINDOWS[w.label]]} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground lg:pt-0.5">
          {['claude', 'codex'].includes(c.provider) ? "No reading yet. Limits appear after this account's next request." : 'This provider does not report usage limits.'}
        </p>
      )}
    </li>
  )
}

// The track is a lighter step of the fill's own color, so the state reads across the whole bar.
const METER_TONE = {
  ok: { track: 'bg-chart-1/15', fill: 'bg-chart-1' },
  warning: { track: 'bg-warning/25', fill: 'bg-warning' },
  exhausted: { track: 'bg-critical/20', fill: 'bg-critical' },
}

function LimitMeter({ window: w, now, observedAt, reserve }: { window: LimitWindow; now: number; observedAt?: number; reserve?: number }) {
  const pct = Math.round(w.left * 100)
  const tone = METER_TONE[w.level]
  const resets = w.resetsAt ? `resets in ${fmtUntil(w.resetsAt - now)}` : undefined
  const caption = w.reset ? 'Reset since the last reading' : w.level === 'exhausted' ? ['Limit reached', resets].filter(Boolean).join(' · ') : resets

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
          <div className={cn('h-1.5 overflow-hidden rounded-full', tone.track)}>
            <div className={cn('h-full rounded-full', tone.fill)} style={{ width: `${pct}%`, minWidth: pct > 0 ? 4 : 0 }} />
          </div>
          <div className="text-[11px] text-muted-foreground first-letter:uppercase">{caption ?? ' '}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="font-medium">
          {w.label}: {pct}% left
        </div>
        <div>{Math.round(w.used * 100)}% used</div>
        {w.resetsAt && <div>Resets {fmtWhen(w.resetsAt)}</div>}
        {!!reserve && <div>{reserve}% kept in reserve for direct use</div>}
        {w.reset && <div>This window has reset since the last reading.</div>}
        {observedAt && <div className="opacity-80">Reported {fmtAgo(observedAt)}</div>}
      </TooltipContent>
    </Tooltip>
  )
}
