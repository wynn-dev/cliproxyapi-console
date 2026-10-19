import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImageIcon, LinkIcon, Share2Icon, TriangleAlertIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { consoleApi } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { fmtCompact, fmtPercent, fmtUsd } from '@/lib/format'
import { PRICES_AS_OF } from '@/lib/prices'
import { useCredentialLabels } from '@/lib/queries'
import { accountNames, copyPng, renderPng, uploadSnapshot } from '@/lib/share'
import type { ShareSummary } from '@/lib/types'

const WEEK_MS = 7 * 86_400_000
const MAX_ACCOUNTS = 5

const plan = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 })

/** "$200/mo plan → $1,840 of usage this week", or just the usage while no plan price is set. */
function valueHeadline(value: number, planPrice: number | null) {
  const usage = `${fmtUsd(value)} of usage this week`
  return planPrice ? `${plan.format(planPrice)}/mo plan → ${usage}` : usage
}

export function ShareButton() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2Icon />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Share your week</DialogTitle>
          <DialogDescription>The last 7 days of traffic as an image. Account names stay hidden unless you show them.</DialogDescription>
        </DialogHeader>
        <ShareDialogBody />
      </DialogContent>
    </Dialog>
  )
}

function ShareDialogBody() {
  // Fixed when the dialog opens, so the card doesn't change under a copy.
  const [to] = useState(() => Date.now())
  const from = to - WEEK_MS
  const summary = useQuery({
    queryKey: ['console', 'share', 'summary', from, to],
    queryFn: () => consoleApi<ShareSummary>('/share/summary', { query: { from, to } }),
  })
  const labels = useCredentialLabels()
  const [showNames, setShowNames] = useState(false)
  const [link, setLink] = useState<string>()
  const [busy, setBusy] = useState<'image' | 'link'>()
  const card = useRef<HTMLDivElement>(null)
  const s = summary.data

  const copyImage = async () => {
    setBusy('image')
    try {
      const how = await copyPng(renderPng(card.current!), 'cpa-console-week.png')
      toast.success(how === 'copied' ? 'Image copied to clipboard' : 'Image downloaded', {
        description: how === 'downloaded' ? 'This browser only copies images on HTTPS or localhost.' : undefined,
      })
    } catch (err) {
      toast.error('Could not copy the image', { description: (err as Error).message })
    } finally {
      setBusy(undefined)
    }
  }

  const copyLink = async (button: HTMLElement) => {
    setBusy('link')
    try {
      const url = await uploadSnapshot(await renderPng(card.current!))
      setLink(url)
      await copyText(url, button).then(
        () => toast.success('Link copied', { description: url }),
        () => toast.success('Link ready', { description: url }),
      )
    } catch (err) {
      toast.error('Could not create a link', { description: (err as Error).message })
    } finally {
      setBusy(undefined)
    }
  }

  if (summary.error) {
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Could not load the last 7 days</AlertTitle>
        <AlertDescription>{summary.error.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="overflow-x-auto rounded-xl">
        {s ? (
          // Centered by a wrapper: the image would keep a margin on the captured element itself.
          <div className="mx-auto w-fit">
            <div ref={card} className="w-[520px] bg-background p-4">
              <WeekCard summary={s} names={accountNames(s.accounts.map((a) => a.key), labels, showNames)} />
            </div>
          </div>
        ) : (
          <Skeleton className="mx-auto h-72 w-[520px]" />
        )}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-2">
          <Switch id="share-names" checked={showNames} onCheckedChange={setShowNames} />
          <Label htmlFor="share-names">Show account names</Label>
        </div>
        {s && <PlanPriceField planPrice={s.planPrice} />}
      </div>

      {link && (
        <div className="flex items-center gap-1 rounded-md border px-3 py-1 text-sm">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
          <CopyButton value={link} label="Copy link" />
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" disabled={!s || !!busy} onClick={(e) => copyLink(e.currentTarget)}>
          {busy === 'link' ? <Spinner /> : <LinkIcon />}
          Copy link
        </Button>
        <Button disabled={!s || !!busy} onClick={copyImage}>
          {busy === 'image' ? <Spinner /> : <ImageIcon />}
          Copy image
        </Button>
      </DialogFooter>
    </div>
  )
}

/** The card itself: everything in here ends up in the image. */
function WeekCard({ summary: s, names }: { summary: ShareSummary; names: string[] }) {
  const range = `${new Date(s.from).toLocaleDateString('en', { month: 'short', day: 'numeric' })} – ${new Date(s.to).toLocaleDateString('en', { month: 'short', day: 'numeric' })}`
  const accounts = s.accounts.slice(0, MAX_ACCOUNTS)
  return (
    <div className="space-y-5 rounded-xl border bg-card p-6 text-card-foreground shadow-xs">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">CPA Console</span>
        <span>Last 7 days · {range}</span>
      </div>
      <div className="space-y-1">
        <div className="text-2xl font-semibold tracking-tight">{valueHeadline(s.value, s.planPrice)}</div>
        <div className="text-xs text-muted-foreground">At public API list prices as of {PRICES_AS_OF}</div>
      </div>
      <div className="grid grid-cols-[auto_1fr_auto] gap-3">
        <Stat label="Tokens" value={fmtCompact(s.tokens)} />
        <Stat label="Top model" value={s.topModel?.model ?? '—'} hint={s.topModel && s.tokens ? `${fmtPercent(s.topModel.tokens / s.tokens, 0)} of tokens` : undefined} />
        <Stat label="Cache hit rate" value={fmtPercent(s.cacheHitRate)} hint="of input tokens" />
      </div>
      {accounts.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Served by {s.accounts.length === 1 ? '1 account' : `${s.accounts.length} accounts`}</div>
          {accounts.map((a, i) => (
            <div key={a.key} className="flex items-center gap-3 text-sm">
              <span className="w-40 truncate">{names[i]}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${(a.tokens / s.accounts[0].tokens) * 100}%` }} />
              </div>
              <span className="tabular w-14 text-right text-xs text-muted-foreground">{fmtCompact(a.tokens)}</span>
            </div>
          ))}
          {s.accounts.length > MAX_ACCOUNTS && <div className="text-xs text-muted-foreground">and {s.accounts.length - MAX_ACCOUNTS} more</div>}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 space-y-0.5 rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-lg font-semibold tracking-tight">{value}</div>
      {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** What the user pays per month, saved on the console. Empty clears it. */
function PlanPriceField({ planPrice }: { planPrice: number | null }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState(planPrice == null ? '' : String(planPrice))
  const save = useMutation({
    mutationFn: (value: number | null) => consoleApi('/share/plan-price', { method: 'PUT', body: { planPrice: value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['console', 'share'] }),
    onError: (err) => toast.error('Could not save the plan price', { description: err.message }),
  })
  const commit = () => {
    const value = draft.trim() === '' ? null : Number(draft)
    if (value === planPrice) return
    if (value !== null && !(value > 0)) {
      toast.error('Enter the plan price in dollars, e.g. 200')
      return
    }
    save.mutate(value)
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor="share-plan">{planPrice == null ? 'What do you pay? Add your plan price' : 'Plan price'}</Label>
      <InputGroup className="w-40">
        <InputGroupAddon>
          <InputGroupText>$</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput
          id="share-plan"
          inputMode="decimal"
          className="tabular"
          placeholder="200"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{save.isPending ? <Spinner /> : '/mo'}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}
