import { useQuery } from '@tanstack/react-query'
import { CircleAlertIcon, CircleCheckIcon, InfoIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { fmtCompact, fmtDuration, fmtNumber, fmtUsd, fmtWhen } from '@/lib/format'
import { CAUSES, insightQueries, useAccountNames, type DigestReport } from '@/lib/insights'
import { providerLabel } from '@/lib/providers'
import { cn } from '@/lib/utils'

type Line = { tone: 'good' | 'warn' | 'info'; text: string }

/** An account that never passed this share of its weekly limit had room to spare. */
const UNDERUSED = 0.5

/** Why CPA turned requests away (server/access-log.ts reasons), as a list item. */
const TURNED_AWAY: Record<string, string> = {
  cooldown: 'with every account cooling down',
  no_account: 'with no account available',
  unknown_model: 'for a model no account offers',
  client_key: 'with a refused client key',
  '': 'for other reasons',
}

const hours = (ms: number) => (ms < 3_600_000 ? fmtDuration(Math.round(ms / 60_000) * 60_000) : `${Math.round(ms / 3_600_000)}h`)

function lines(d: DigestReport, name: (n: string) => string): Line[] {
  const out: Line[] = []
  for (const p of d.pools) {
    const pool = `${providerLabel(p.provider)} pool`
    if (p.dryMs > 0) {
      const longest = p.dryStretches > 1 ? ` (longest ${hours(p.longestDryMs)})` : ''
      // A few minutes between one account running out and the next reset is no reason to buy more.
      const advice = p.dryMs >= 3_600_000 ? ' Add capacity.' : ''
      out.push({ tone: 'warn', text: `${pool} was dry for ${hours(p.dryMs)}${longest}: every account at its reserve or limit.${advice}` })
    } else out.push({ tone: 'good', text: `${pool} never ran dry.` })
  }
  const ta = d.turnedAway
  if (ta.total) {
    const reasons = Object.entries(ta.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${fmtNumber(n)} ${TURNED_AWAY[r] ?? TURNED_AWAY['']}`)
      .join(', ')
    const dry = ta.whileDry ? `, ${fmtNumber(ta.whileDry)} of them while a pool was dry` : ''
    out.push({ tone: 'warn', text: `${fmtNumber(ta.total)} requests turned away${dry} (${reasons}).` })
  }
  for (const a of d.accounts) {
    if (a.peakWeekly === undefined) out.push({ tone: 'info', text: `${name(a.name)} wasn't used this week.` })
    else if (a.peakWeekly < UNDERUSED) out.push({ tone: 'info', text: `${name(a.name)} never passed ${Math.round(a.peakWeekly * 100)}% of its weekly limit.` })
  }
  const c = d.cacheBreaks
  if (c.breaks) {
    const top = c.causes[0]
    out.push({
      tone: c.brokenSessions > c.sessions / 10 ? 'warn' : 'info',
      text: `${fmtNumber(c.brokenSessions)} of ${fmtNumber(c.sessions)} conversations lost their prompt cache, ${fmtCompact(c.resent)} tokens sent again. Most often: ${CAUSES[top.cause].label.toLowerCase()}.`,
    })
  } else if (c.sessions) out.push({ tone: 'good', text: `No conversation lost its prompt cache (${fmtNumber(c.sessions)} conversations).` })
  if (d.requests) {
    out.push({ tone: d.failed / d.requests > 0.05 ? 'warn' : 'info', text: `${fmtNumber(d.requests)} requests, ${d.failed ? `${fmtNumber(d.failed)} failed` : 'none failed'}.` })
  }
  if (d.value > 0) {
    const top = d.accounts.reduce((a, b) => (b.value > a.value ? b : a))
    const most = d.accounts.length > 1 && top.value > 0 ? `, most by ${name(top.name)} (${fmtUsd(top.value)})` : ''
    out.push({ tone: 'info', text: `The pool served ${fmtUsd(d.value)} of usage at API prices${most}.` })
  }
  return out
}

const TONE = {
  good: { icon: CircleCheckIcon, className: 'text-success' },
  warn: { icon: CircleAlertIcon, className: 'text-warning' },
  info: { icon: InfoIcon, className: 'text-muted-foreground' },
}

/** A plain-language summary of the last 7 days. */
export function DigestCard() {
  const { data, error } = useQuery(insightQueries.digest())
  const name = useAccountNames()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last 7 days</CardTitle>
        <CardDescription>
          {data?.historyFrom ? `Limit history starts ${fmtWhen(data.historyFrom)}, so dry time only counts from then.` : 'How the pool held up this week.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <p className="text-sm text-critical">{error.message}</p>
        ) : !data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <ul className="space-y-2">
              {lines(data, name).map((l, i) => {
                const t = TONE[l.tone]
                return (
                  <li key={i} className="flex gap-2.5 text-sm">
                    <t.icon className={cn('mt-0.5 size-4 shrink-0', t.className)} />
                    <span>{l.text}</span>
                  </li>
                )
              })}
            </ul>
            {data.accounts.length > 0 && <AccountTable data={data} name={name} />}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function AccountTable({ data, name }: { data: DigestReport; name: (n: string) => string }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[38rem] text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 text-left font-medium">Account</th>
            <th className="px-3 py-2 text-right font-medium whitespace-nowrap" title="Every attempt, so a request that failed over counts on each account it tried">
              Attempts
            </th>
            <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Tokens</th>
            <th className="px-3 py-2 text-right font-medium whitespace-nowrap" title="At public API prices">
              Value
            </th>
            <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Peak weekly use</th>
            <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Reached reserve</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.accounts.map((a) => (
            <tr key={a.name}>
              <td className="max-w-56 px-3 py-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{name(a.name)}</span>
                  <Badge variant="secondary" className="h-4.5 px-1.5 text-[11px]">
                    {providerLabel(a.provider)}
                  </Badge>
                </div>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular">
                {fmtNumber(a.requests)}
                {a.failed > 0 && <span className="text-xs text-muted-foreground"> · {fmtNumber(a.failed)} failed</span>}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular">{fmtCompact(a.tokens)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular">{a.value ? fmtUsd(a.value) : '—'}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular">{a.peakWeekly === undefined ? '—' : `${Math.round(a.peakWeekly * 100)}%`}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular">{a.reserveHits ? `${a.reserveHits}×` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
