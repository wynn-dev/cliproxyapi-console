import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangleIcon, CircleAlertIcon } from 'lucide-react'
import { StatusDot } from '@/components/common'
import { reserveHold, useTicker } from '@/components/credentials/lib'
import { Countdown } from '@/components/credentials/status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { type Availability, type ProviderAvailability, availability, poolAvailability } from '@/lib/availability'
import { providerLabel } from '@/lib/providers'
import { queries } from '@/lib/queries'
import type { ReserveStatus } from '@/lib/types'

const PROVIDER_ORDER = ['claude', 'codex']

/** Why accounts are out, in the order a user can act on them. */
const REASONS: { state: Exclude<Availability, 'available'>; label: (n: number) => string }[] = [
  { state: 'reserved', label: (n) => `${n} held back by the account reserve` },
  { state: 'extra-usage', label: (n) => `${n} held back because ${n === 1 ? 'it is' : 'they are'} using paid extra usage` },
  { state: 'signed-out', label: (n) => `${n} signed out` },
  { state: 'cooling', label: (n) => `${n} cooling down after errors` },
  { state: 'disabled', label: (n) => `${n} turned off` },
]

/** How many accounts per provider can take requests, and what to do when none can. */
export function PoolAvailability({ running }: { running: boolean }) {
  const credentials = useQuery({ ...queries.credentials(), enabled: running })
  const reserve = useQuery({ ...queries.reserve(), enabled: running })
  const now = useTicker(running, 5_000)
  const files = credentials.data?.files ?? []
  if (!running || !files.length) return null

  const byName = new Map(files.map((f) => [f.name, f]))
  const holdOf = (name: string) => {
    const hold = reserveHold(byName.get(name)!, reserve.data)
    return hold && !hold.overridden ? hold : undefined
  }
  const pools = poolAvailability(files, holdOf, now).sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider))
  const empty = pools.filter((p) => p.available === 0)
  // Fable held on every available Claude account: Fable requests fail while other models work.
  const claude = files.filter((f) => f.provider === 'claude' && availability(f, holdOf(f.name), now).state === 'available')
  const fable = claude.map((f) => reserve.data?.fable?.[f.name])
  const fableOut = claude.length > 0 && fable.every(Boolean)
  const fableBack = fableOut ? Math.min(...fable.map((h) => h!.until)) : 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm" aria-label="Accounts available">
        {pools.map((p) => (
          <span key={p.provider} className="inline-flex items-center gap-2">
            <StatusDot tone={p.available === 0 ? 'bad' : p.available < p.total ? 'warn' : 'good'} />
            <span className="font-medium">{providerLabel(p.provider)}</span>
            <span className="text-muted-foreground tabular">
              {p.available} of {p.total} available
            </span>
          </span>
        ))}
      </div>
      {empty.map((p) => (
        <EmptyPool key={p.provider} pool={p} reserve={reserve.data} />
      ))}
      {fableOut && (
        <Alert>
          <AlertTriangleIcon className="text-warning" />
          <AlertTitle>Fable is held back on every Claude account</AlertTitle>
          <AlertDescription>
            <p>
              Requests for Fable models fail until one is back, the first in <Countdown until={fableBack} endLabel="a moment" />. Other models still
              work. Lower the Fable reserve in Settings → Routing to use what is left.
            </p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

const rank = (p: string) => (PROVIDER_ORDER.includes(p) ? PROVIDER_ORDER.indexOf(p) : PROVIDER_ORDER.length)

function EmptyPool({ pool: p, reserve }: { pool: ProviderAvailability; reserve?: ReserveStatus }) {
  const name = providerLabel(p.provider)
  const held = p.held
  const todo: React.ReactNode[] = []
  if (held.reserved) {
    todo.push(
      reserve?.releaseWhenAllHeld
        ? 'If none is back within 2 minutes, the console turns on the reserved account with the most left.'
        : 'Enable a reserved account to use it anyway, or let the console do that when this happens (Settings → Routing).',
    )
  }
  if (held['signed-out']) todo.push('Open a signed-out account on Credentials and sign in again.')
  if (held.disabled) todo.push('Enable an account you turned off.')
  if (held['extra-usage'] && todo.length === 0) todo.push('These come back when their limits reset; enabling them bills their owners.')
  if (held.cooling && todo.length === 0) todo.push('CLIProxyAPI tries them again when their cooldown ends.')

  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>No {name} account is available</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>Requests for {name} models fail until one is back.</p>
        <ul className="list-disc space-y-0.5 pl-4">
          {REASONS.filter((r) => held[r.state]).map(({ state, label }) => {
            const { count, until } = held[state]!
            return (
              <li key={state}>
                {label(count)}
                {until && (
                  <>
                    {count > 1 ? ', the first back in ' : ', back in '}
                    <Countdown until={until} endLabel="a moment" />
                  </>
                )}
              </li>
            )
          })}
        </ul>
        {todo.length > 0 && <p>{todo.join(' ')}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" asChild>
            <Link to="/credentials">Credentials</Link>
          </Button>
          {held.reserved && !reserve?.releaseWhenAllHeld && (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/settings" search={{ section: 'routing' }}>
                Routing settings
              </Link>
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  )
}
