import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowDownToLineIcon,
  ArrowRightIcon,
  ArrowUpCircleIcon,
  CircleGaugeIcon,
  CoinsIcon,
  PlayIcon,
  PlugIcon,
  RotateCwIcon,
  SquareIcon,
  TimerIcon,
  ZapIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { AccountsCard } from '@/components/accounts-card'
import { PROCESS_LABEL } from '@/components/app-sidebar'
import { CopyButton, PageHeader, StatCard, StatusDot } from '@/components/common'
import { confirm } from '@/components/confirm'
import { RankedList, RequestsChart } from '@/components/usage-charts'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useNow } from '@/hooks/use-now'
import { consoleApi } from '@/lib/api'
import { fmtAgo, fmtBytes, fmtCompact, fmtDuration, fmtMs, fmtNumber, fmtPercent } from '@/lib/format'
import { queries, usageQueries } from '@/lib/queries'
import type { ConsoleStatus } from '@/lib/types'

export const Route = createFileRoute('/_app/')({ component: Overview })

function compareTags(a: string, b: string) {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

function Overview() {
  const now = useNow(60_000)
  const { data: status } = useQuery(queries.status())
  const running = status?.process.state === 'running'
  const usage = useQuery(usageQueries.summary({ from: now - 86_400_000, to: now }))
  const t = usage.data?.totals

  return (
    <>
      <PageHeader
        title="Overview"
        description="Health of your CLIProxyAPI instance and the last 24 hours of traffic."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/connect">
              <PlugIcon />
              Connect Claude Code
            </Link>
          </Button>
        }
      />
      <ProcessCard status={status} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Requests · 24h" icon={ZapIcon} loading={!usage.data} value={fmtNumber(t?.requests)} hint={t?.failed ? `${fmtNumber(t.failed)} failed` : 'No failures'} />
        <StatCard
          label="Success rate"
          icon={CircleGaugeIcon}
          loading={!usage.data}
          value={t?.requests ? fmtPercent(1 - t.failed / t.requests) : '—'}
          hint="Across all credentials"
        />
        <StatCard
          label="Tokens · 24h"
          icon={CoinsIcon}
          loading={!usage.data}
          value={fmtCompact(t?.total)}
          hint={t?.total ? `${fmtCompact(t.input)} in · ${fmtCompact(t.output)} out · ${fmtCompact(t.cached)} cached` : undefined}
        />
        <StatCard label="Avg latency" icon={TimerIcon} loading={!usage.data} value={fmtMs(t?.avgLatency)} hint={t?.avgTtft ? `${fmtMs(t.avgTtft)} to first token` : undefined} />
      </div>

      <AccountsCard running={running} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Requests</CardTitle>
            <CardDescription>Last 24 hours</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/usage">
                  Usage <ArrowRightIcon />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {usage.data ? <RequestsChart series={usage.data.series} bucketMs={usage.data.bucketMs} /> : <Skeleton className="h-64 w-full" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top models</CardTitle>
            <CardDescription>By requests, last 24 hours</CardDescription>
          </CardHeader>
          <CardContent>
            <RankedList
              items={(usage.data?.byModel ?? []).slice(0, 6).map((m) => ({
                key: m.key,
                label: m.key || 'unknown',
                value: m.requests,
                hint: `${fmtCompact(m.total)} tok`,
              }))}
            />
          </CardContent>
        </Card>
      </div>

    </>
  )
}

/** The console was started in a terminal: offer the command that installs it as a service, with the same options. */
function KeepRunning({ command }: { command: string }) {
  return (
    <Dialog>
      <DialogTrigger className="text-foreground underline underline-offset-4">Keep it running</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keep the console running</DialogTitle>
          <DialogDescription>
            It runs in a terminal now, so it stops when that terminal closes or the machine restarts. As a background service it starts with the
            machine (launchd on macOS, systemd on Linux) and keeps your data, accounts and settings. Stop this console first (Ctrl+C in its terminal),
            then run:
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{command}</pre>
          <CopyButton value={command} className="absolute top-1.5 right-1.5" />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ProcessCard({ status }: { status?: ConsoleStatus }) {
  const qc = useQueryClient()
  const latest = useQuery(queries.latestRelease())
  const action = useMutation({
    mutationFn: (a: 'start' | 'stop' | 'restart') => consoleApi(`/process/${a}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['console', 'status'] }),
  })
  const update = useMutation({
    mutationFn: (tag: string | undefined) => consoleApi('/release/install', { body: { tag } }),
    onError: (err) => toast.error('Could not install CLIProxyAPI', { description: err.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['console', 'status'] }),
  })

  if (!status) return <Skeleton className="h-36 w-full rounded-xl" />
  const { process: p, cpa } = status
  const meta = PROCESS_LABEL[p.state]
  const install = cpa.install
  const installing = install && !['done', 'error'].includes(install.phase)
  const updateAvailable = latest.data && cpa.version && compareTags(latest.data.tag, cpa.version) > 0
  const busy = action.isPending || p.state === 'starting' || p.state === 'stopping' || !!installing

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          CLIProxyAPI
          <Badge variant="outline" className="gap-1.5">
            <StatusDot tone={meta.tone} pulse={p.state === 'starting'} />
            {meta.label}
          </Badge>
        </CardTitle>
        <CardDescription>
          Managed by this console · data in {status.dataDir}
          {!status.service && (
            <>
              {' · '}
              <KeepRunning command={status.serviceCommand} />
            </>
          )}
        </CardDescription>
        <CardAction className="flex gap-2">
          {p.state === 'running' || p.state === 'starting' ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => action.mutate('restart')}>
                {action.isPending && action.variables === 'restart' ? <Spinner /> : <RotateCwIcon />}
                Restart
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  confirm({
                    title: 'Stop CLIProxyAPI?',
                    description: 'Clients will get connection errors until you start it again. It stays stopped across console restarts.',
                    confirmLabel: 'Stop',
                    destructive: true,
                    onConfirm: () => action.mutateAsync('stop'),
                  })
                }
              >
                <SquareIcon />
                Stop
              </Button>
            </>
          ) : !cpa.version ? (
            <Button size="sm" disabled={!!installing || update.isPending} onClick={() => update.mutate(undefined)}>
              {installing || update.isPending ? <Spinner /> : <ArrowDownToLineIcon />}
              Install CLIProxyAPI
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => action.mutate('start')}>
              {action.isPending ? <Spinner /> : <PlayIcon />}
              Start
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <Meta label="Version" value={cpa.version ?? 'Not installed'} />
          <Meta label="Uptime" value={p.startedAt ? fmtDuration(Date.now() - p.startedAt) : '—'} />
          <Meta label="Listening on" value={status.config ? `${status.config.host || '0.0.0.0'}:${p.port ?? status.config.port}` : '—'} />
          <Meta label="Crash restarts" value={p.restarts ? String(p.restarts) : 'None'} />
        </dl>

        {p.state === 'running' && status.config && p.port && status.config.port !== p.port && (
          <Alert>
            <AlertTitle>Restart to apply the new port</AlertTitle>
            <AlertDescription>
              config.yaml now uses port {status.config.port}, but CLIProxyAPI is still listening on {p.port}.
            </AlertDescription>
          </Alert>
        )}

        {p.lastError && p.state !== 'running' && (
          <Alert variant="destructive">
            <AlertTitle>Last error</AlertTitle>
            <AlertDescription className="font-mono text-xs">{p.lastError}</AlertDescription>
          </Alert>
        )}

        {installing && install && (
          <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium">
                <Spinner /> Installing {install.tag} · {install.phase}
              </span>
              {install.total > 0 && (
                <span className="text-xs text-muted-foreground tabular">
                  {fmtBytes(install.received)} / {fmtBytes(install.total)}
                </span>
              )}
            </div>
            <Progress value={install.total ? (install.received / install.total) * 100 : 50} />
          </div>
        )}
        {install?.phase === 'error' && (
          <Alert variant="destructive">
            <AlertTitle>Update to {install.tag} failed</AlertTitle>
            <AlertDescription>{install.error}</AlertDescription>
          </Alert>
        )}
        {updateAvailable && !installing && latest.data && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-chart-1/30 bg-chart-1/5 p-3 text-sm">
            <ArrowUpCircleIcon className="size-4 text-chart-1" />
            <span className="flex-1">
              <span className="font-medium">{latest.data.tag}</span> is available
              <span className="text-muted-foreground"> · released {fmtAgo(latest.data.publishedAt)} · </span>
              <a href={latest.data.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                Release notes
              </a>
            </span>
            <Button
              size="sm"
              onClick={() =>
                confirm({
                  title: `Update to ${latest.data!.tag}?`,
                  description: 'The release is downloaded and checksum-verified first. CLIProxyAPI then restarts, which interrupts in-flight requests for a moment.',
                  confirmLabel: 'Update',
                  onConfirm: () => update.mutateAsync(latest.data!.tag),
                })
              }
            >
              Update
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular">{value}</dd>
    </div>
  )
}
