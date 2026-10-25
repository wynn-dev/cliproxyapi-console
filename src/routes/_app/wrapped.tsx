import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { DownloadIcon, GiftIcon, ImageIcon, LinkIcon, PlayIcon, TriangleAlertIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/common'
import { PlanPriceField, ShareLink, useShareActions } from '@/components/share-card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { SlideCanvas } from '@/components/wrapped/canvas'
import {
  AccountsSlide,
  AwardsSlide,
  BusiestDaySlide,
  CacheSlide,
  CalendarSlide,
  ConversationsSlide,
  ModelsSlide,
  NumbersSlide,
  RhythmSlide,
  StackSlide,
  SummarySlide,
  ValueSlide,
  VersusSlide,
} from '@/components/wrapped/slides'
import { StoryPlayer } from '@/components/wrapped/story'
import { consoleApi } from '@/lib/api'
import { useCredentialLabels } from '@/lib/queries'
import { accountNames } from '@/lib/share'
import type { ShareSummary } from '@/lib/types'
import { accentFor, awards, deriveWrapped, H, W } from '@/lib/wrapped'

export const Route = createFileRoute('/_app/wrapped')({ component: WrappedPage })

/** "2026-09" → that month in the viewer's time zone, [from, to). */
function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number)
  return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime(), days: new Date(y, m, 0).getDate() }
}

/** The month before "2026-09", as "2026-08". */
function previousMonth(month: string) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
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
        description="A month of traffic as slides to post, or to play as a story. Each one is a 1200×675 image; account names stay hidden unless you show them."
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
        <Recap key={month} month={month} hasPrevious={list.includes(previousMonth(month))} />
      )}
    </>
  )
}

function Recap({ month, hasPrevious }: { month: string; hasPrevious: boolean }) {
  const { from, to, days } = monthRange(month)
  const tz = new Date().getTimezoneOffset()
  const summary = useQuery({
    queryKey: ['console', 'share', 'summary', from, to],
    queryFn: () => consoleApi<ShareSummary>('/share/summary', { query: { from, to, tz } }),
  })
  const before = monthRange(previousMonth(month))
  const previous = useQuery({
    queryKey: ['console', 'share', 'summary', before.from, before.to],
    queryFn: () => consoleApi<ShareSummary>('/share/summary', { query: { from: before.from, to: before.to, tz } }),
    enabled: hasPrevious,
  })
  const labels = useCredentialLabels()
  const [showNames, setShowNames] = useState(false)
  const [price, setPrice] = useState<number | null>()
  const [playing, setPlaying] = useState(false)
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
  const w = deriveWrapped(s, month, days)
  const earned = awards(s, w)
  const prev = previous.data && previous.data.tokens > 0 ? previous.data : undefined

  const slides = (
    [
      { id: 'summary', content: <SummarySlide s={s} /> },
      prev && { id: 'versus', content: <VersusSlide s={s} prev={prev} prevName={monthName(previousMonth(month)).split(' ')[0]} /> },
      { id: 'value', content: <ValueSlide s={s} name={name} /> },
      { id: 'models', content: <ModelsSlide s={s} /> },
      (s.providers.length > 1 || s.clients.length > 0) && { id: 'stack', content: <StackSlide s={s} /> },
      { id: 'cache', content: <CacheSlide s={s} /> },
      { id: 'busiest-day', content: <BusiestDaySlide w={w} month={month} /> },
      { id: 'rhythm', content: <RhythmSlide w={w} /> },
      { id: 'calendar', content: <CalendarSlide w={w} month={month} /> },
      s.sessions.count > 0 && { id: 'conversations', content: <ConversationsSlide s={s} /> },
      { id: 'numbers', content: <NumbersSlide s={s} w={w} /> },
      { id: 'accounts', content: <AccountsSlide s={s} names={names} /> },
      earned.length > 0 && { id: 'awards', content: <AwardsSlide awards={earned} /> },
    ].filter(Boolean) as { id: string; content: React.ReactNode }[]
  ).map((slide, i) => ({ ...slide, accent: accentFor(i) }))

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
        <div className="flex gap-2">
          <Button variant="outline" disabled={!!share.busy} onClick={(e) => share.copyLink(cover.current!, e.currentTarget)}>
            {share.busy === 'link' ? <Spinner /> : <LinkIcon />}
            Copy link
          </Button>
          <Button onClick={() => setPlaying(true)}>
            <PlayIcon />
            Play
          </Button>
        </div>
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
          accent={slide.accent}
          busy={share.busy}
          id={slide.id}
          onCopy={(node) => share.copyImage(node, file(slide.id), `copy-${slide.id}`)}
          onDownload={(node) => share.download(node, file(slide.id), `download-${slide.id}`)}
        >
          {slide.content}
        </SlideFrame>
      ))}

      {playing && <StoryPlayer slides={slides} month={name} onClose={() => setPlaying(false)} />}
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
  accent,
  busy,
  onCopy,
  onDownload,
  children,
}: {
  ref?: React.RefObject<HTMLDivElement | null>
  id: string
  month: string
  accent: string
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
          <SlideCanvas ref={node} accent={accent} month={month}>
            {children}
          </SlideCanvas>
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
