import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ArrowRightIcon } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { RankedList } from '@/components/usage-charts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { fmtCompact, fmtDateTime, fmtDuration, fmtNumber } from '@/lib/format'
import { CAUSES, insightQueries, useAccountNames, type CacheBreak, type CacheBreakReport } from '@/lib/insights'

const chartConfig = { sessions: { label: 'Conversations', color: 'var(--chart-1)' } } satisfies ChartConfig

/** Conversations that lost their prompt cache, why, and how often, over the last 7 days. */
export function CacheBreaksCard() {
  const { data, error } = useQuery(insightQueries.cacheBreaks())
  const name = useAccountNames()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lost prompt caches</CardTitle>
        <CardDescription>
          A conversation loses its prompt cache when it moves to another account or sits idle too long, and then sends its whole history again
          uncached. Last 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <p className="text-sm text-critical">{error.message}</p>
        ) : !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Headline report={data} />
            {data.breaks > 0 && (
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Per day</h3>
                  <ChartContainer config={chartConfig} className="aspect-auto h-40 w-full">
                    <BarChart data={data.days} maxBarSize={28} margin={{ left: 0, right: 0, top: 4 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickFormatter={(t: number) => format(t, 'EEE')} />
                      <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                      <ChartTooltip
                        cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
                        content={<ChartTooltipContent labelFormatter={(_, p) => format(p?.[0]?.payload.day, 'EEE, MMM d')} />}
                      />
                      <Bar dataKey="sessions" fill="var(--color-sessions)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                </div>
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Causes</h3>
                  <RankedList
                    items={data.causes.map((c) => ({
                      key: c.cause,
                      label: CAUSES[c.cause].label,
                      value: c.sessions,
                      hint: c.breaks > c.sessions ? `${fmtNumber(c.breaks)} times` : undefined,
                    }))}
                    valueLabel={fmtNumber}
                  />
                  <p className="text-xs text-muted-foreground">Conversations per cause. Codex caches on a best-effort basis, so it often shows no clear cause.</p>
                </div>
              </div>
            )}
            {data.recent.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">Latest</h3>
                <ul className="divide-y rounded-lg border">
                  {data.recent.slice(0, 10).map((b) => (
                    <BreakRow key={`${b.sessionId}-${b.ts}`} b={b} name={name} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Headline({ report: r }: { report: CacheBreakReport }) {
  const today = r.days.at(-1)
  const top = today?.causes[0]
  return (
    <div className="space-y-1">
      <p className="text-base font-medium">
        {!today?.sessions
          ? 'No conversation lost its prompt cache today.'
          : `${fmtNumber(today.sessions)} conversation${today.sessions === 1 ? '' : 's'} lost ${today.sessions === 1 ? 'its' : 'their'} prompt cache today${top ? `; ${CAUSES[top.cause].phrase(top.sessions)}` : ''}.`}
      </p>
      <p className="text-sm text-muted-foreground">
        {r.breaks
          ? `This week: ${fmtNumber(r.brokenSessions)} of ${fmtNumber(r.sessions)} conversations, ${fmtCompact(r.resent)} tokens sent again uncached.`
          : r.sessions
            ? `None of ${fmtNumber(r.sessions)} conversations this week lost it.`
            : 'No conversations this week yet. Clients that send a session id (Claude Code, Codex) show up here.'}
      </p>
    </div>
  )
}

function BreakRow({ b, name }: { b: CacheBreak; name: (n: string) => string }) {
  const moved = b.from !== b.to
  const detail = [
    b.cause === 'failure' && b.status ? `HTTP ${b.status}` : undefined,
    b.cause === 'idle' ? `idle ${fmtDuration(b.gapMs)}` : undefined,
    `${fmtCompact(b.resent)} tokens sent again`,
  ].filter(Boolean)
  return (
    <li className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <span className="text-muted-foreground tabular">{fmtDateTime(b.ts)}</span>
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">{CAUSES[b.cause].label}</div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {moved ? (
            <>
              <span className="truncate">{name(b.from)}</span>
              <ArrowRightIcon className="size-3 shrink-0" />
              <span className="truncate">{name(b.to)}</span>
            </>
          ) : (
            <span className="truncate">{name(b.to)}</span>
          )}
          <span>· {b.model}</span>
          <span>· {detail.join(' · ')}</span>
        </div>
      </div>
    </li>
  )
}
