import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { format, isToday } from 'date-fns'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { consoleApi } from '@/lib/api'
import { fmtCompact, fmtMs, fmtNumber } from '@/lib/format'
import type { UsageParams } from '@/lib/queries'
import type { UsageRequest } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ClientKey, type CredentialLabels, CredentialName, ModelName, StatusLabel } from './cells'
import { RequestSheet } from './request-sheet'
import { turnedAwayReason } from './search'

const PAGE = 50

export function RecentRequests({
  rangeMs,
  filters,
  enabled,
  labels,
}: {
  rangeMs: number
  filters: Omit<UsageParams, 'from' | 'to'>
  enabled: boolean
  labels: CredentialLabels
}) {
  const [selected, setSelected] = useState<UsageRequest | null>(null)
  // Keyed by the relative range (not absolute timestamps) so loaded pages survive the clock ticking.
  const q = useInfiniteQuery({
    queryKey: ['console', 'usage', 'requests', rangeMs, filters],
    queryFn: ({ pageParam }) => {
      const now = Date.now()
      return consoleApi<UsageRequest[]>('/usage/requests', {
        query: { ...filters, from: now - rangeMs, to: now + 60_000, limit: PAGE, before: pageParam },
      })
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length === PAGE ? `${last.at(-1)!.ts}:${last.at(-1)!.id}` : undefined),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) <= 1 ? 15_000 : false),
    enabled,
  })
  const rows = q.data?.pages.flat() ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent requests</CardTitle>
        <CardDescription>
          Newest first, one row per attempt. A grey failure was retried and succeeded. Select a request for details and its log.
        </CardDescription>
      </CardHeader>
      <CardContent className={cn('transition-opacity', q.isPlaceholderData && 'opacity-60')}>
        {!q.data ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No requests match.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Credential</TableHead>
                  <TableHead className="max-2xl:hidden" title="The client key, or the address when there is none">Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Tokens in → out</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    onClick={() => setSelected(r)}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected(r)}
                  >
                    <TableCell className="text-muted-foreground tabular" title={new Date(r.ts).toLocaleString()}>
                      {format(r.ts, isToday(r.ts) ? 'HH:mm:ss' : 'MMM d, HH:mm')}
                    </TableCell>
                    <TableCell>
                      <ModelName model={r.model} alias={r.alias} className="max-w-64" />
                    </TableCell>
                    <TableCell>
                      {r.turnedAway ? (
                        <span className="block max-w-48 truncate text-muted-foreground" title={r.error || undefined}>
                          {turnedAwayReason(r.reason)}
                        </span>
                      ) : (
                        <CredentialName authIndex={r.authIndex} labels={labels} provider={r.provider} hideProvider className="max-w-48" />
                      )}
                    </TableCell>
                    <TableCell className="max-2xl:hidden">
                      {r.apiKey ? <ClientKey value={r.apiKey} /> : <span className="font-mono text-[13px] text-muted-foreground">{r.clientIp || '—'}</span>}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <StatusLabel failed={!!r.failed} code={r.statusCode} recovered={!!r.requestOk} turnedAway={!!r.turnedAway} />
                        {r.turnedAway ? <Badge variant="outline" className="text-muted-foreground">Turned away</Badge> : null}
                        {r.stream ? <Badge variant="outline" className="text-muted-foreground">Stream</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {fmtMs(r.latencyMs)}
                      {r.stream && r.ttftMs > 0 ? <div className="text-xs text-muted-foreground">TTFT {fmtMs(r.ttftMs)}</div> : null}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular" title={`${fmtNumber(r.input)} in · ${fmtNumber(r.output)} out`}>
                      {r.input || r.output ? (
                        <>
                          <span className="text-foreground">{fmtCompact(r.input)}</span> → <span className="text-foreground">{fmtCompact(r.output)}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {q.hasNextPage && (
              <div className="flex justify-center pt-3">
                <Button variant="outline" size="sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                  {q.isFetchingNextPage && <Spinner />}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
      <RequestSheet request={selected} labels={labels} onClose={() => setSelected(null)} />
    </Card>
  )
}
