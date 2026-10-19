import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { DownloadIcon, GiftIcon, ImageIcon, LinkIcon, TriangleAlertIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/common'
import { PlanPriceField, ShareLink, UnpricedNote, useShareActions, valueHeadline } from '@/components/share-card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { consoleApi } from '@/lib/api'
import { fmtCompact, fmtNumber, fmtPercent, fmtUsd } from '@/lib/format'
import { PRICES_AS_OF } from '@/lib/prices'
import { useCredentialLabels } from '@/lib/queries'
import { accountNames } from '@/lib/share'
import type { ShareSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/wrapped')({ component: WrappedPage })

/** Every slide is one 16:9 image, the size X shows uncropped in the timeline. */
const W = 1200
const H = 675
const MAX_ACCOUNTS = 5

/** "2026-09" → that month in the viewer's time zone, [from, to). */
function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number)
  return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime(), days: new Date(y, m, 0).getDate() }
}

const monthName = (month: string) => new Date(`${month}-01T00:00`).toLocaleDateString('en', { month: 'long', year: 'numeric' })

function lastCompleteMonth() {
  const d = new Date()
  d.setDate(0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function WrappedPage() {
  const months = useQuery({
    queryKey: ['console', 'share', 'months'],
    queryFn: () => consoleApi<{ months: string[] }>('/share/months', { query: { tz: new Date().getTimezoneOffset() } }),
  })
  const [picked, setPicked] = useState<string>()
  const list = months.data?.months ?? []
  const fallback = lastCompleteMonth()
  const month = picked ?? (list.includes(fallback) ? fallback : list[0])
  const current = lastCompleteMonth() < (list[0] ?? '') ? list[0] : undefined

  return (
    <>
      <PageHeader
        title="Wrapped"
        description="A month of traffic as slides to post. Each one is a 1200×675 image; account names stay hidden unless you show them."
        actions={
          list.length > 0 && (
            <Select value={month} onValueChange={setPicked}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.map((m) => (
                  <SelectItem key={m} value={m}>
                    {monthName(m)}
                    {m === current && ' (so far)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        }
      />
      {months.error ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Could not load the months with usage</AlertTitle>
          <AlertDescription>{months.error.message}</AlertDescription>
        </Alert>
      ) : months.isPending ? (
        <Skeleton className="aspect-video w-full max-w-[1200px]" />
      ) : !month ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GiftIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing to wrap yet</EmptyTitle>
            <EmptyDescription>Once requests go through the proxy, each month with usage shows up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Recap key={month} month={month} />
      )}
    </>
  )
}

function Recap({ month }: { month: string }) {
  const { from, to, days } = monthRange(month)
  const summary = useQuery({
    queryKey: ['console', 'share', 'summary', from, to],
    queryFn: () => consoleApi<ShareSummary>('/share/summary', { query: { from, to, tz: new Date().getTimezoneOffset() } }),
  })
  const labels = useCredentialLabels()
  const [showNames, setShowNames] = useState(false)
  const [price, setPrice] = useState<number | null>()
  const share = useShareActions()
  const cover = useRef<HTMLDivElement>(null)

  if (summary.error) {
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Could not load {monthName(month)}</AlertTitle>
        <AlertDescription>{summary.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (!summary.data) return <Skeleton className="aspect-video w-full max-w-[1200px]" />

  const s = { ...summary.data, planPrice: price === undefined ? summary.data.planPrice : price }
  const names = accountNames(s.accounts.map((a) => a.key), labels, showNames)
  const name = monthName(month)
  const file = (slide: string) => `cpa-wrapped-${month}-${slide}.png`

  // The browser's own calendar days, from the hourly series.
  const perDay = Array.from({ length: days }, () => 0)
  for (const h of s.hours) perDay[new Date(h.t).getDate() - 1] += h.tokens
  const busiest = perDay.reduce((best, n, i) => (n > perDay[best] ? i : best), 0)

  const slides: { id: string; content: React.ReactNode }[] = [
    { id: 'summary', content: <SummarySlide s={s} /> },
    { id: 'value', content: <ValueSlide s={s} name={name} /> },
    { id: 'models', content: <ModelsSlide s={s} /> },
    { id: 'cache', content: <CacheSlide s={s} /> },
    { id: 'busiest-day', content: <BusiestDaySlide perDay={perDay} busiest={busiest} month={month} /> },
    { id: 'accounts', content: <AccountsSlide s={s} names={names} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Switch
            id="wrapped-names"
            checked={showNames}
            onCheckedChange={(v) => {
              setShowNames(v)
              share.reset()
            }}
          />
          <Label htmlFor="wrapped-names">Show account names</Label>
        </div>
        <PlanPriceField
          planPrice={s.planPrice}
          onChange={(v) => {
            setPrice(v)
            share.reset()
          }}
        />
        <Button variant="outline" disabled={!!share.busy} onClick={(e) => share.copyLink(cover.current!, e.currentTarget)}>
          {share.busy === 'link' ? <Spinner /> : <LinkIcon />}
          Copy link
        </Button>
        {share.link && (
          <div className="w-full">
            <ShareLink link={share.link} />
          </div>
        )}
      </div>

      {slides.map((slide, i) => (
        <SlideFrame
          key={slide.id}
          ref={i === 0 ? cover : undefined}
          month={name}
          busy={share.busy}
          id={slide.id}
          onCopy={(node) => share.copyImage(node, file(slide.id), `copy-${slide.id}`)}
          onDownload={(node) => share.download(node, file(slide.id), `download-${slide.id}`)}
        >
          {slide.content}
        </SlideFrame>
      ))}
    </div>
  )
}

/**
 * One slide at its real 1200×675, scaled down to fit the page. The scale sits on a wrapper, so the
 * captured element (and the image) stays full size.
 */
function SlideFrame({
  ref,
  id,
  month,
  busy,
  onCopy,
  onDownload,
  children,
}: {
  ref?: React.RefObject<HTMLDivElement | null>
  id: string
  month: string
  busy?: string
  onCopy: (node: HTMLElement) => void
  onDownload: (node: HTMLElement) => void
  children: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const own = useRef<HTMLDivElement>(null)
  const node = ref ?? own
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = box.current!
    const observer = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / W)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <section className="max-w-[1200px] space-y-2">
      <div ref={box} className="overflow-hidden rounded-xl border" style={{ height: H * scale }}>
        <div style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <div ref={node} className="flex flex-col bg-card p-16 text-card-foreground" style={{ width: W, height: H }}>
            <div className="min-h-0 flex-1">{children}</div>
            <div className="flex items-center justify-between pt-6 text-2xl text-muted-foreground">
              <span className="font-medium text-foreground">CPA Console</span>
              <span>{month} wrapped</span>
            </div>
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => onDownload(node.current!)}>
          {busy === `download-${id}` ? <Spinner /> : <DownloadIcon />}
          Download
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => onCopy(node.current!)}>
          {busy === `copy-${id}` ? <Spinner /> : <ImageIcon />}
          Copy image
        </Button>
      </div>
    </section>
  )
}

function Kicker({ children }: { children: React.ReactNode }) {
  return <div className="text-3xl font-medium text-muted-foreground">{children}</div>
}

/** The cover, and the image behind "Copy link": the month in one slide. */
function SummarySlide({ s }: { s: ShareSummary }) {
  return (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-4">
        <Kicker>This month through the proxy</Kicker>
        <div className="flex items-baseline gap-12">
          <div>
            <div className="text-[120px] leading-none font-semibold tracking-tight">{fmtCompact(s.tokens)}</div>
            <div className="mt-2 text-3xl text-muted-foreground">tokens</div>
          </div>
          <div>
            <div className="text-[120px] leading-none font-semibold tracking-tight">{fmtCompact(s.requests)}</div>
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

function ValueSlide({ s, name }: { s: ShareSummary; name: string }) {
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
            <div className="h-full rounded-full bg-primary" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function ModelsSlide({ s }: { s: ShareSummary }) {
  return (
    <div className="flex h-full flex-col gap-10">
      <Kicker>Top models by tokens</Kicker>
      <Bars rows={s.topModels.map((m) => ({ label: m.model, value: m.tokens, hint: `${fmtCompact(m.tokens)} · ${fmtPercent(s.tokens ? m.tokens / s.tokens : null, 0)}` }))} />
    </div>
  )
}

function CacheSlide({ s }: { s: ShareSummary }) {
  return (
    <div className="flex h-full flex-col justify-center gap-6">
      <Kicker>Cache hit rate</Kicker>
      <div className="text-[160px] leading-none font-semibold tracking-tight">{fmtPercent(s.cacheHitRate)}</div>
      <div className="text-3xl text-muted-foreground">of input tokens were read from the prompt cache</div>
    </div>
  )
}

function BusiestDaySlide({ perDay, busiest, month }: { perDay: number[]; busiest: number; month: string }) {
  const max = perDay[busiest] || 1
  const day = new Date(`${month}-${String(busiest + 1).padStart(2, '0')}T00:00`).toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })
  return (
    <div className="flex h-full flex-col gap-6">
      <Kicker>Busiest day</Kicker>
      <div>
        <div className="text-7xl font-semibold tracking-tight">{day}</div>
        <div className="mt-3 text-3xl text-muted-foreground">{fmtNumber(perDay[busiest])} tokens</div>
      </div>
      <div className="flex min-h-0 flex-1 items-end gap-1.5">
        {perDay.map((n, i) => (
          <div key={i} className={cn('flex-1 rounded-t', i === busiest ? 'bg-primary' : 'bg-muted')} style={{ height: `${Math.max(2, (n / max) * 100)}%` }} />
        ))}
      </div>
    </div>
  )
}

function AccountsSlide({ s, names }: { s: ShareSummary; names: string[] }) {
  const accounts = s.accounts.slice(0, MAX_ACCOUNTS)
  return (
    <div className="flex h-full flex-col gap-8">
      <Kicker>Served by {s.accounts.length === 1 ? '1 account' : `${s.accounts.length} accounts`}</Kicker>
      <Bars rows={accounts.map((a, i) => ({ label: names[i], value: a.tokens, hint: fmtCompact(a.tokens) }))} />
      {s.accounts.length > MAX_ACCOUNTS && <div className="text-2xl text-muted-foreground">and {s.accounts.length - MAX_ACCOUNTS} more</div>}
    </div>
  )
}
