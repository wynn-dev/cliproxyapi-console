import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { BadgeDollarSignIcon, BanIcon, ChartNoAxesColumnIcon, CircleGaugeIcon, CoinsIcon, EllipsisIcon, TimerIcon, Trash2Icon, TriangleAlertIcon, ZapIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader, StatCard, StatusDot } from '@/components/common'
import { confirm } from '@/components/confirm'
import { LatencyChart, RequestsChart, TokensChart } from '@/components/usage-charts'
import { Breakdown } from '@/components/usage/breakdown'
import type { CredentialLabels } from '@/components/usage/cells'
import { UsageFilterBar } from '@/components/usage/filter-bar'
import { RecentRequests } from '@/components/usage/recent-requests'
import { DEFAULT_RANGE, RANGES, bucketName, filterParams, hasFilters, validateUsageSearch } from '@/components/usage/search'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { consoleApi } from '@/lib/api'
import { fmtAgo, fmtCompact, fmtMs, fmtNumber, fmtPercent, fmtUsd } from '@/lib/format'
import { PRICES_AS_OF } from '@/lib/prices'
import { queries, useConfigWrite, useCredentialLabels, usageQueries } from '@/lib/queries'
import type { UsageSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/usage')({ validateSearch: validateUsageSearch, component: UsagePage })

function UsagePage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const range = search.range ?? DEFAULT_RANGE
  const rangeMs = RANGES[range].ms
  const now = useNow(range === '1h' ? 30_000 : 60_000)
  const from = now - rangeMs
  const labels = useCredentialLabels()

  const facets = useQuery(usageQueries.facets(from, now))
  // The URL only holds a client key suffix; wait for facets to resolve it before querying.
  const ready = !search.key || !!facets.data
  const filters = filterParams(search, facets.data?.apiKeys)
  const summary = useQuery({ ...usageQueries.summary({ from, to: now, ...filters }), enabled: ready })
  const s = summary.data
  const t = s?.totals

  // Dim only when the user changed the slice, not when the clock advanced the window.
  const sig = JSON.stringify([range, filters])
  const [settledSig, setSettledSig] = useState(sig)
  if (s && !summary.isPlaceholderData && settledSig !== sig) setSettledSig(sig)
  const refreshing = summary.isPlaceholderData && settledSig !== sig

  const subtitle = s ? `${RANGES[range].label} · ${bucketName(s.bucketMs)}` : RANGES[range].label

  return (
    <>
      <PageHeader
        title="Usage"
        description="Every request that went through the proxy, kept by this console. A request counts once, however many accounts it tried."
        actions={
          <>
            <CollectorHealth />
            <HistoryMenu />
          </>
        }
      />
      <StatisticsDisabledAlert />
      <UsageFilterBar facets={facets.data} labels={labels} />

      {summary.error ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Could not load usage</AlertTitle>
          <AlertDescription>{summary.error.message}</AlertDescription>
        </Alert>
      ) : s && t && t.requests === 0 && !refreshing ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChartNoAxesColumnIcon />
            </EmptyMedia>
            <EmptyTitle>{hasFilters(search) ? 'No requests match these filters' : 'No requests in this range'}</EmptyTitle>
            <EmptyDescription>
              {hasFilters(search)
                ? 'Try removing a filter or picking a longer time range.'
                : 'Requests show up here a few seconds after a client calls the proxy.'}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            {hasFilters(search) ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate({ search: (p) => ({ range: p.range }), replace: true })}
              >
                Clear filters
              </Button>
            ) : (
              <>
                {range !== '90d' && (
                  <Button variant="outline" size="sm" onClick={() => navigate({ search: (p) => ({ ...p, range: '90d' }), replace: true })}>
                    Show last 90 days
                  </Button>
                )}
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/connect">Connect a client</Link>
                </Button>
              </>
            )}
          </EmptyContent>
        </Empty>
      ) : (
        <div className={cn('space-y-6 transition-opacity', refreshing && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-4 max-sm:gap-3 lg:grid-cols-3">
            <StatCard
              label="Requests"
              icon={ZapIcon}
              loading={!s}
              value={fmtNumber(t?.requests)}
              hint={t?.failed ? `${fmtNumber(t.failed)} failed` : 'No failures'}
            />
            <StatCard
              label="Success rate"
              icon={CircleGaugeIcon}
              loading={!s}
              value={t?.requests ? fmtPercent(1 - t.failed / t.requests) : '—'}
              hint={t && `${fmtNumber(t.requests - t.failed)} succeeded${t.recovered ? `, ${fmtNumber(t.recovered)} after a retry` : ''}`}
            />
            <StatCard
              label="Turned away"
              icon={BanIcon}
              loading={!s}
              value={fmtNumber(t?.turnedAway)}
              hint={<TurnedAwayHint turnedAway={t?.turnedAway ?? 0} />}
            />
            <StatCard
              label="Value at API prices"
              icon={BadgeDollarSignIcon}
              loading={!s}
              value={t ? (t.value === 0 && t.unpricedTokens > 0 ? 'No price' : fmtUsd(t.value)) : '—'}
              hint={t && <ValueHint summary={s} labels={labels} />}
            />
            <StatCard
              label="Tokens"
              icon={CoinsIcon}
              loading={!s}
              value={fmtCompact(t?.total)}
              hint={t?.total ? `${fmtCompact(t.input)} in · ${fmtCompact(t.output)} out · ${fmtCompact(t.cached)} cached` : undefined}
            />
            <StatCard
              label="Avg latency"
              icon={TimerIcon}
              loading={!s}
              value={fmtMs(t?.avgLatency)}
              hint={t?.avgTtft ? `${fmtMs(t.avgTtft)} to first token` : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Requests" description={subtitle}>
              {s ? <RequestsChart series={s.series} bucketMs={s.bucketMs} /> : <Skeleton className="h-64 w-full" />}
            </ChartCard>
            <ChartCard title="Tokens" description={subtitle}>
              {s ? <TokensChart series={s.series} bucketMs={s.bucketMs} /> : <Skeleton className="h-64 w-full" />}
            </ChartCard>
          </div>
          <ChartCard title="Average latency" description={`${subtitle} · full request duration`}>
            {s ? <LatencyChart series={s.series} bucketMs={s.bucketMs} /> : <Skeleton className="h-48 w-full" />}
          </ChartCard>

          {s ? <Breakdown summary={s} labels={labels} /> : <Skeleton className="h-72 w-full rounded-xl" />}
        </div>
      )}

      {!(s && t?.requests === 0) && <RecentRequests rangeMs={rangeMs} filters={filters} enabled={ready} labels={labels} />}
    </>
  )
}

function TurnedAwayHint({ turnedAway }: { turnedAway: number }) {
  const { data } = useQuery(queries.status())
  const error = data?.collector.accessLogError
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('cursor-default', error && 'text-warning')}>
          {error ? 'Not tracked right now' : turnedAway ? 'Never reached an account' : 'None in this range'}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {error ??
          'Requests CLIProxyAPI refused before trying any account, for example because every account was cooling down or held back. They count as failed requests.'}
      </TooltipContent>
    </Tooltip>
  )
}

/** "alice@example.com served $2,140" for the top credential, with how the value is worked out on hover. */
function ValueHint({ summary, labels }: { summary: UsageSummary; labels: CredentialLabels }) {
  const top = summary.byCredential.reduce<UsageSummary['byCredential'][number] | undefined>((a, b) => (b.value > (a?.value ?? 0) ? b : a), undefined)
  const missing = summary.totals.unpricedModels
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default">
          {top && summary.byCredential.length > 1 ? `${labels.get(top.key)?.label ?? 'One account'} served ${fmtUsd(top.value)}` : `List prices as of ${PRICES_AS_OF}`}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 space-y-1.5">
        <p>
          What this traffic would have cost at the providers' public API prices as of {PRICES_AS_OF}. Claude fast mode counts at the
          standard price and cache writes at the 5-minute rate, so the real figure would be at least this.
        </p>
        {missing.length > 0 && (
          <p>
            No price for {missing.join(', ')} (or its service tier), so {fmtCompact(summary.totals.unpricedTokens)} tokens are left out.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function CollectorHealth() {
  const { data } = useQuery(queries.status())
  const now = useNow(5_000)
  const c = data?.collector
  if (!c || data.process.state !== 'running') return null
  const tone = c.lastError ? 'bad' : c.lastPollAt && now - c.lastPollAt < 60_000 ? 'good' : 'warn'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground">
          <StatusDot tone={tone} />
          {c.lastError ? 'Collector error' : c.lastPollAt ? `Synced ${fmtAgo(c.lastPollAt)}` : 'Waiting for first sync'}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {c.lastError ?? 'The console collects request records from CLIProxyAPI every 5 seconds and keeps them for 90 days.'}
      </TooltipContent>
    </Tooltip>
  )
}

function HistoryMenu() {
  const qc = useQueryClient()
  const clear = useMutation({
    mutationFn: () => consoleApi('/usage', { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Usage history cleared')
      void qc.invalidateQueries({ queryKey: ['console', 'usage'] })
    },
    onError: (err) => toast.error('Could not clear history', { description: err.message }),
  })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label="More actions">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          variant="destructive"
          onSelect={() =>
            confirm({
              title: 'Clear usage history?',
              description: 'This permanently deletes every recorded request from the console database. CLIProxyAPI is not affected.',
              confirmLabel: 'Clear history',
              destructive: true,
              onConfirm: () => clear.mutateAsync(),
            })
          }
        >
          <Trash2Icon />
          Clear history…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function StatisticsDisabledAlert() {
  const { data } = useQuery(queries.config())
  const write = useConfigWrite()
  if (data?.observability?.usage?.['usage-statistics-enabled'] !== false) return null
  return (
    <Alert className="border-warning/40 bg-warning/5">
      <TriangleAlertIcon className="text-warning!" />
      <AlertTitle>Usage statistics are turned off</AlertTitle>
      <AlertDescription>CLIProxyAPI is not publishing request records, so new traffic will not appear here.</AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          disabled={write.isPending}
          onClick={() =>
            write.mutate(
              { path: '/observability/usage/usage-statistics-enabled', value: true },
              { onSuccess: () => toast.success('Usage statistics enabled') },
            )
          }
        >
          {write.isPending && <Spinner />}
          Enable
        </Button>
      </AlertAction>
    </Alert>
  )
}
