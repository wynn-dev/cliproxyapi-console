import { format } from 'date-fns'
import { Bar, BarChart, type BarShapeProps, CartesianGrid, Line, LineChart, Rectangle, XAxis, YAxis } from 'recharts'
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { fmtCompact, fmtMs } from '@/lib/format'
import type { UsagePoint } from '@/lib/types'

export function bucketLabel(t: number, bucketMs: number) {
  return bucketMs >= 86_400_000 ? format(t, 'MMM d') : bucketMs >= 3_600_000 ? format(t, 'MMM d HH:mm') : format(t, 'HH:mm')
}

/** X-axis props: clock times within a day or two, local-midnight date ticks for longer sub-day bucketed ranges. */
function timeAxis(series: UsagePoint[], bucketMs: number) {
  const span = series.length * bucketMs
  if (bucketMs >= 86_400_000) return { tickFormatter: (t: number) => format(t, 'MMM d') }
  if (span <= 2 * 86_400_000) return { tickFormatter: (t: number) => format(t, 'HH:mm') }
  const ticks = series.filter((p) => new Date(p.t).getHours() === 0 && new Date(p.t).getMinutes() === 0).map((p) => p.t)
  return { ticks, tickFormatter: (t: number) => format(t, 'MMM d') }
}

const requestsConfig = {
  ok: { label: 'Succeeded', color: 'var(--chart-1)' },
  failed: { label: 'Failed', color: 'var(--critical)' },
} satisfies ChartConfig

export function RequestsChart({ series, bucketMs, className }: { series: UsagePoint[]; bucketMs: number; className?: string }) {
  const data = series.map((p) => ({ t: p.t, ok: p.requests - p.failed, failed: p.failed }))
  return (
    <ChartContainer config={requestsConfig} className={className ?? 'aspect-auto h-64 w-full'}>
      <BarChart data={data} barCategoryGap="15%" maxBarSize={24} margin={{ left: 0, right: 0, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={40} {...timeAxis(series, bucketMs)} />
        <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} tickFormatter={fmtCompact} />
        <ChartTooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
          content={<ChartTooltipContent labelFormatter={(_, p) => bucketLabel(p?.[0]?.payload.t, bucketMs)} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="ok"
          stackId="r"
          fill="var(--color-ok)"
          // Round the top only when no failed segment sits on it.
          shape={(p: BarShapeProps) => <Rectangle {...p} radius={p.payload.failed ? 0 : [3, 3, 0, 0]} />}
        />
        <Bar dataKey="failed" stackId="r" fill="var(--color-failed)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartContainer>
  )
}

const tokensConfig = {
  input: { label: 'Input', color: 'var(--chart-1)' },
  cached: { label: 'Cached input', color: 'var(--chart-3)' },
  output: { label: 'Output', color: 'var(--chart-2)' },
} satisfies ChartConfig

export function TokensChart({ series, bucketMs, className }: { series: UsagePoint[]; bucketMs: number; className?: string }) {
  // CPA reports cached tokens as part of input; split them so the stack sums to the real total.
  const data = series.map((p) => ({ t: p.t, input: Math.max(0, p.input - p.cached), cached: p.cached, output: p.output }))
  return (
    <ChartContainer config={tokensConfig} className={className ?? 'aspect-auto h-64 w-full'}>
      <BarChart data={data} barCategoryGap="15%" maxBarSize={24} margin={{ left: 0, right: 0, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={40} {...timeAxis(series, bucketMs)} />
        <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={fmtCompact} />
        <ChartTooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
          content={<ChartTooltipContent labelFormatter={(_, p) => bucketLabel(p?.[0]?.payload.t, bucketMs)} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="cached" stackId="t" fill="var(--color-cached)" />
        <Bar dataKey="input" stackId="t" fill="var(--color-input)" />
        <Bar dataKey="output" stackId="t" fill="var(--color-output)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartContainer>
  )
}

/** Ranked horizontal meter list — reads better than a pie for "top N by volume". */
export function RankedList({
  items,
  valueLabel = (n) => fmtCompact(n),
  empty = 'No data yet',
}: {
  items: { key: string; label: React.ReactNode; value: number; hint?: React.ReactNode }[]
  valueLabel?: (n: number) => React.ReactNode
  empty?: string
}) {
  const max = Math.max(1, ...items.map((i) => i.value))
  if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.key} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium">{i.label}</span>
            <span className="shrink-0 text-muted-foreground tabular">
              {i.hint && <span className="mr-2 text-xs">{i.hint}</span>}
              {valueLabel(i.value)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-chart-1" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

const latencyConfig = {
  avgLatency: { label: 'Avg latency', color: 'var(--chart-1)' },
} satisfies ChartConfig

const latencyTick = (ms: number) => (ms === 0 ? '0' : ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`)

/** Single-series average latency per bucket. Buckets without traffic are gaps; dots keep isolated buckets visible. */
export function LatencyChart({ series, bucketMs, className }: { series: UsagePoint[]; bucketMs: number; className?: string }) {
  return (
    <ChartContainer config={latencyConfig} className={className ?? 'aspect-auto h-48 w-full'}>
      <LineChart data={series} margin={{ left: 0, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={40} {...timeAxis(series, bucketMs)} />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={latencyTick} />
        <ChartTooltip
          cursor={{ stroke: 'var(--border)' }}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, p) => bucketLabel(p?.[0]?.payload.t, bucketMs)}
              formatter={(v) => (
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">Avg latency</span>
                  <span className="font-mono font-medium text-foreground tabular-nums">{fmtMs(Number(v))}</span>
                </div>
              )}
            />
          }
        />
        <Line
          dataKey="avgLatency"
          type="monotone"
          stroke="var(--color-avgLatency)"
          strokeWidth={2}
          dot={{ r: 2.5, strokeWidth: 0, fill: 'var(--color-avgLatency)', fillOpacity: 1 }}
          activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
