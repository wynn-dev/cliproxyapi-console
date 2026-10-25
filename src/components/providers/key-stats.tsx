import { CircleAlertIcon, LifeBuoyIcon, WalletIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtAgo, fmtCompact, fmtNumber, fmtUsd, fmtWhen, maskSecret } from '@/lib/format'
import type { ApiKeyInfo, FallbackState, KeyRateLimit } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useSetBalance } from './model'

/** Credits, spend, rate limits and last use of one API key, under its row. */
export function KeyStats({ apiKey, info, provider }: { apiKey: string; info: ApiKeyInfo; provider: string }) {
  const s = info.spend
  const limits = (['requests', 'input-tokens', 'output-tokens', 'tokens'] as const).flatMap((k) => (info.limits?.[k] ? [[k, info.limits[k]!] as const] : []))
  return (
    <div className="flex basis-full flex-wrap items-center gap-x-4 gap-y-1 pb-0.5 text-xs text-muted-foreground">
      <Credits apiKey={apiKey} info={info} provider={provider} />
      {s.requests > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default tabular">
              <span className="text-foreground">{fmtUsd(s.day)}</span> 24h · {fmtUsd(s.week)} 7d · {fmtUsd(s.month)} 30d
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Spend at API list prices, from the traffic the console recorded. 30 days: {fmtNumber(s.requests)} {s.requests === 1 ? 'request' : 'requests'}
            {s.failed > 0 && `, ${fmtNumber(s.failed)} failed`}, {fmtCompact(s.input)} input tokens ({fmtCompact(s.cached)} from cache), {fmtCompact(s.output)} output.
            {s.unpricedTokens > 0 && ` ${fmtCompact(s.unpricedTokens)} tokens of models without a list price are not counted.`}
          </TooltipContent>
        </Tooltip>
      )}
      {limits.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default tabular">
              {limits.map(([k, l]) => `${fmtCompact(l.remaining)}/${fmtCompact(l.limit)} ${LIMIT_LABELS[k].short}`).join(' · ')}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="mb-1">Rate limits left, from its last response {fmtAgo(info.limits!.at)}:</p>
            <ul className="space-y-0.5">
              {limits.map(([k, l]) => (
                <li key={k} className="tabular">
                  {LIMIT_LABELS[k].long}: {fmtNumber(l.remaining)} of {fmtNumber(l.limit)}
                  {resetLabel(l) && `, full ${resetLabel(l)}`}
                </li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      )}
      {info.lastOkAt && <span>Used {fmtAgo(info.lastOkAt)}</span>}
    </div>
  )
}

const LIMIT_LABELS: Record<'requests' | 'tokens' | 'input-tokens' | 'output-tokens', { short: string; long: string }> = {
  requests: { short: 'req/min', long: 'Requests per minute' },
  'input-tokens': { short: 'in/min', long: 'Input tokens per minute' },
  'output-tokens': { short: 'out/min', long: 'Output tokens per minute' },
  tokens: { short: 'tok/min', long: 'Tokens per minute' },
}

/** Anthropic sends an ISO time, OpenAI a duration ("6m0s"). */
function resetLabel(l: KeyRateLimit) {
  if (!l.reset) return ''
  const at = Date.parse(l.reset)
  return Number.isNaN(at) ? `in ${l.reset}` : `at ${fmtWhen(at)}`
}

function Credits({ apiKey, info, provider }: { apiKey: string; info: ApiKeyInfo; provider: string }) {
  const [open, setOpen] = useState(false)
  const b = info.balance
  const anthropic = provider === 'claude'
  let content: React.ReactNode
  if (info.outOfCredits) {
    content = (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex cursor-default items-center gap-1 font-medium text-critical">
            <CircleAlertIcon className="size-3.5" />
            Out of credits
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {anthropic ? 'Anthropic' : 'The provider'} turned it away {fmtAgo(info.outOfCredits.at)}: “{info.outOfCredits.error}”
          {info.fallback && ' The console keeps it out of rotation.'} Enter the new balance once you have topped up.
        </TooltipContent>
      </Tooltip>
    )
  } else if (b) {
    const share = b.set > 0 ? Math.max(0, Math.min(1, b.left / b.set)) : 0
    content = (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex cursor-default items-center gap-1.5 tabular">
            <span className={cn('font-medium', b.left <= 0 ? 'text-critical' : share < 0.2 ? 'text-warning' : 'text-foreground')}>
              {b.left <= 0 ? `${fmtUsd(-b.left)} over` : `${fmtUsd(b.left)} left`}
            </span>
            <span className="relative h-1 w-12 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('absolute inset-y-0 left-0 rounded-full', share < 0.2 ? 'bg-warning' : 'bg-success')}
                style={{ width: `${share * 100}%` }}
              />
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {fmtUsd(b.set)} entered {fmtWhen(b.at)}, {fmtUsd(b.spent)} spent since at API list prices. An estimate from the traffic the console recorded:
          check the billing page for the exact balance.
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <>
      {content}
      <Button variant="link" size="xs" className="h-auto p-0 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        <WalletIcon />
        {b || info.outOfCredits ? 'Update balance' : 'Set credit balance'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          {open && <BalanceForm apiKey={apiKey} info={info} anthropic={anthropic} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function BalanceForm({ apiKey, info, anthropic, onDone }: { apiKey: string; info: ApiKeyInfo; anthropic: boolean; onDone: () => void }) {
  const [value, setValue] = useState(info.balance ? info.balance.left.toFixed(2) : '')
  const [error, setError] = useState<string | null>(null)
  const save = useSetBalance()

  const submit = (balance: number | null) =>
    save
      .mutateAsync({ key: apiKey, balance })
      .then(() => {
        toast.success(balance == null ? 'Balance cleared' : 'Balance saved', { description: maskSecret(apiKey) })
        onDone()
      })
      .catch((err: Error) => setError(err.message))

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = Number(value.replace(/[$,\s]/g, ''))
    if (!value.trim() || !Number.isFinite(n) || n < 0) return setError('Enter an amount in USD, like 25 or 12.50.')
    void submit(n)
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Credit balance</DialogTitle>
        <DialogDescription>{maskSecret(apiKey)}</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="b-usd">Balance now (USD)</FieldLabel>
        <Input id="b-usd" value={value} autoFocus inputMode="decimal" placeholder="25.00" className="tabular" onChange={(e) => setValue(e.target.value)} />
        <FieldDescription>
          {anthropic ? (
            <>
              The remaining balance on{' '}
              <a href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer" className="underline underline-offset-2">
                platform.claude.com/settings/billing
              </a>
              . Anthropic has no API for it,
            </>
          ) : (
            'Your remaining credits with the provider, which has no API for it,'
          )}{' '}
          so the console subtracts what this key spends from here on, at API list prices. Keys of one organization share a balance: enter it on one of
          them. Update it after a top-up{info.outOfCredits ? ', which also puts the key back in rotation' : ''}.
        </FieldDescription>
      </Field>
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter>
        {info.balance && (
          <Button type="button" variant="ghost" className="mr-auto text-muted-foreground" disabled={save.isPending} onClick={() => void submit(null)}>
            Clear
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}

/** A fallback group's state: in use (billed), standing by, or out of credits. */
export function FallbackBadge({ inRotation, state, outOfCredits, name }: { inRotation: boolean; state?: FallbackState; outOfCredits: boolean; name: string }) {
  let label: string
  let tip: string
  let className = ''
  let variant: 'secondary' | 'destructive' | 'outline' = 'secondary'
  if (outOfCredits) {
    label = 'Fallback · out of credits'
    tip = `Every key in this group ran out of credits, so it stays out of rotation even when no ${name} account can take requests. Update the balance once you have topped up.`
    variant = 'destructive'
  } else if (inRotation) {
    label = 'Fallback · in use'
    tip = state?.available
      ? `A ${name} account is available again. This group leaves rotation once it has stayed available for a minute${state.until ? ` (${fmtWhen(state.until)})` : ''}.`
      : `No ${name} account can take requests, so this group serves them, billed at API prices. It leaves rotation once an account is back.`
    variant = 'outline'
    className = 'border-warning/50 bg-warning/10'
  } else {
    label = 'Fallback · standing by'
    tip = `${state ? `${state.available} ${name} ${state.available === 1 ? 'account' : 'accounts'} can take requests. ` : ''}This group takes over only when none can.`
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className={cn('cursor-default', className)}>
          <LifeBuoyIcon />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tip}</TooltipContent>
    </Tooltip>
  )
}
