import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { format } from 'date-fns'
import { ArrowRightIcon } from 'lucide-react'
import { RequestSparkline } from '@/components/common'
import { ModelName, StatusLabel } from '@/components/usage/cells'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useNow } from '@/hooks/use-now'
import { consoleApi } from '@/lib/api'
import { fmtCompact, fmtNumber, fmtPercent } from '@/lib/format'
import { usageQueries } from '@/lib/queries'
import type { UsageRequest } from '@/lib/types'

const DAY = 86_400_000
const SHOWN = 6

/**
 * An account's last 24 hours from the console's own usage history, which survives CPA restarts
 * (CPA's per-account counters don't).
 */
export function AccountRequests({ authIndex }: { authIndex: string }) {
  const now = useNow(60_000)
  const summary = useQuery(usageQueries.summary({ from: now - DAY, to: now, authIndex }))
  const latest = useQuery({
    queryKey: ['console', 'usage', 'requests', 'account', authIndex],
    queryFn: () => consoleApi<UsageRequest[]>('/usage/requests', { query: { authIndex, from: Date.now() - DAY, to: Date.now() + 60_000, limit: SHOWN } }),
    refetchInterval: 15_000,
  })
  const t = summary.data?.totals
  const bucketMs = summary.data?.bucketMs ?? 0
  const buckets = (summary.data?.series ?? []).map((p) => ({
    success: p.requests - p.failed,
    failed: p.failed,
    time: `${format(p.t, 'HH:mm')}–${format(p.t + bucketMs, 'HH:mm')}`,
  }))

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="Requests" value={t ? fmtNumber(t.requests) : undefined} />
        <MiniStat label="Failed" value={t ? fmtNumber(t.failed) : undefined} />
        <MiniStat label="Success rate" value={t ? (t.requests ? fmtPercent(1 - t.failed / t.requests) : '—') : undefined} />
      </div>
      {!!t?.requests && (
        <div className="space-y-1.5 rounded-lg border p-3">
          <RequestSparkline buckets={buckets} className="h-12 gap-0 [&>div]:w-auto [&>div]:flex-1" />
          <div className="flex justify-between text-xs text-muted-foreground tabular">
            <span>24h ago</span>
            <span>Now</span>
          </div>
        </div>
      )}
      {!latest.data ? (
        <Skeleton className="h-24 w-full" />
      ) : latest.data.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">No requests in the last 24 hours.</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {latest.data.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2">
              <span className="w-12 shrink-0 text-xs text-muted-foreground tabular" title={new Date(r.ts).toLocaleString()}>
                {format(r.ts, 'HH:mm')}
              </span>
              <ModelName model={r.model} alias={r.alias} className="min-w-0 flex-1" />
              <span className="shrink-0 text-xs text-muted-foreground tabular max-sm:hidden" title={`${fmtNumber(r.input)} in · ${fmtNumber(r.output)} out`}>
                {r.input || r.output ? `${fmtCompact(r.input)} → ${fmtCompact(r.output)}` : ''}
              </span>
              <span className="shrink-0 text-xs">
                <StatusLabel failed={!!r.failed} code={r.statusCode} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" size="sm" className="w-full" asChild>
        <Link to="/usage" search={{ range: '24h', credential: authIndex }}>
          See all in Usage <ArrowRightIcon />
        </Link>
      </Button>
    </>
  )
}

function MiniStat({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      {value === undefined ? <Skeleton className="my-1 h-5 w-12" /> : <div className="text-lg font-semibold tracking-tight tabular">{value}</div>}
    </div>
  )
}
