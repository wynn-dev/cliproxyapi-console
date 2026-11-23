import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { StatusDot } from '@/components/common'
import { CredentialSheet } from '@/components/credentials/credential-sheet'
import { accountName, credState, reserveHold, reserveNote, useAccountParam } from '@/components/credentials/lib'
import { ModelsDialog } from '@/components/credentials/models-dialog'
import { CredentialStatus, SignInHint } from '@/components/credentials/status'
import { AccountMeters, PoolMeter } from '@/components/limit-meter'
import { PoolSummary } from '@/components/pool-availability'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { fmtAgo } from '@/lib/format'
import { accountReadings, limitWindows, poolLimits } from '@/lib/limits'
import { providerLabel } from '@/lib/providers'
import { queries } from '@/lib/queries'
import { hasAccountPool, keepsCachesWarm, routingOf, strategyLabel } from '@/lib/routing'
import type { Credential, LimitCheck, ReserveStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

const PROVIDER_ORDER = ['claude', 'codex']

/** Providers first, then the order fill-first routing tries accounts in: priority, then file name. */
function byRoutingOrder(a: Credential, b: Credential) {
  const rank = (c: Credential) => (PROVIDER_ORDER.includes(c.provider) ? PROVIDER_ORDER.indexOf(c.provider) : PROVIDER_ORDER.length)
  return rank(a) - rank(b) || a.provider.localeCompare(b.provider) || (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Every account with its usage limits, as the provider last reported them. */
export function AccountsCard({ running, account }: { running: boolean; account?: string }) {
  const now = useNow(30_000)
  const credentials = useQuery({ ...queries.credentials(), enabled: running })
  const stored = useQuery({ ...queries.limits(), enabled: running })
  const checks = useQuery({ ...queries.limitChecks(), enabled: running })
  const config = useQuery({ ...queries.config(), enabled: running })
  const reserve = useQuery({ ...queries.reserve(), enabled: running })
  const accounts = [...(credentials.data?.files ?? [])].sort(byRoutingOrder)
  const routing = routingOf(config.data)
  const scattered = hasAccountPool(accounts) && !keepsCachesWarm(routing)
  const setOpen = useAccountParam(account, credentials.data?.files)
  const [modelsFor, setModelsFor] = useState<Credential | null>(null)
  // The pool the forecast counts: accounts on, and those the console holds back, other than signed-out
  // ones. Which accounts are held is only known once the reserve status is in.
  const pools = poolLimits(
    reserve.data
      ? accounts.flatMap((c) => {
          const hold = reserve.data.accounts[c.name]
          if (!PROVIDER_ORDER.includes(c.provider) || (c.disabled && (!hold || hold.reason === 'signed-out'))) return []
          const weeklyHold = hold && (hold.windows as string[]).some((w) => w === 'weekly' || w === 'Weekly') ? hold.until : undefined
          const holds = { Weekly: weeklyHold, Fable: reserve.data.fable?.[c.name]?.until }
          return [{ provider: c.provider, ...accountReadings(c.quota, stored.data?.[c.name]), holds }]
        })
      : [],
    now,
  ).filter((p) => p.accounts > 1)

  // One column per limit any account reports, in a fixed order.
  const labels = new Set(accounts.flatMap((c) => limitWindows(c.provider, accountReadings(c.quota, stored.data?.[c.name]).reading, now).map((w) => w.label)))
  const columns = [...COLUMN_ORDER.filter((l) => labels.has(l)), ...[...labels].filter((l) => !COLUMN_ORDER.includes(l))]
  const grid = { '--cols': Math.max(columns.length, 1) } as React.CSSProperties

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <PoolSummary running={running} />
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/credentials">
              Manage <ArrowRightIcon />
            </Link>
          </Button>
        </CardAction>
        {config.data && accounts.length > 0 && (
          <p className="mt-auto hidden pt-4 text-xs leading-relaxed text-muted-foreground @5xl/main:block">
            <span className="inline-flex items-center gap-1.5 text-foreground">
              {scattered && <StatusDot tone="warn" />}
              {strategyLabel(routing.strategy)}
              {routing.affinity && ', sticky'}
            </span>
            <br />
            {scattered ? 'Conversations can move between accounts and lose their prompt cache. ' : ''}
            <Link to="/settings" search={{ section: 'routing' }} className="text-link hover:underline">
              {scattered ? 'Fix in Settings' : 'Routing settings'}
            </Link>
          </p>
        )}
      </CardHeader>
      <CardContent>
        {!running ? (
          <Empty>Start CLIProxyAPI to see your accounts.</Empty>
        ) : credentials.isPending ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : accounts.length === 0 ? (
          <Empty>
            No accounts yet.{' '}
            <Link to="/credentials" className="text-link hover:underline">
              Add one
            </Link>
          </Empty>
        ) : (
          <div style={grid}>
            <div className={cn(ROW_GRID, 'border-b pb-2 text-xs text-muted-foreground max-md:hidden')}>
              <span>Account</span>
              {columns.map((l) => (
                <span key={l}>{COLUMN_LABEL[l] ?? l}</span>
              ))}
            </div>
            {pools.length > 0 && (
              <ul className="border-b py-1.5">
                {[...new Set(pools.map((p) => p.provider))].map((provider) => {
                  const own = pools.filter((p) => p.provider === provider)
                  return (
                    <li key={provider} className={cn(ROW_GRID, 'py-2')}>
                      <div className="min-w-0 text-[0.84rem]">
                        <span className="font-medium">All {providerLabel(provider)}</span>
                        <span className="text-muted-foreground"> · {own[0]!.accounts} accounts</span>
                      </div>
                      {columns.map((l) => {
                        const p = own.find((x) => x.label === l)
                        return p ? (
                          <PoolMeter key={l} pool={p} reserve={reserve.data?.limits[p.label === 'Fable' ? 'fable' : 'weekly']} now={now} inline />
                        ) : (
                          <span key={l} aria-hidden className="max-md:hidden" />
                        )
                      })}
                    </li>
                  )
                })}
              </ul>
            )}
            <ul className="pt-1.5">
              {accounts.map((c) => (
                <AccountRow
                  key={c.id}
                  account={c}
                  readings={accountReadings(c.quota, stored.data?.[c.name])}
                  check={checks.data?.enabled ? checks.data.accounts[c.name] : undefined}
                  reserve={reserve.data}
                  columns={columns}
                  now={now}
                  onOpen={() => setOpen(c.name)}
                />
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <CredentialSheet
        credential={accounts.find((c) => c.name === account) ?? null}
        focusEdit={false}
        onOpenChange={(o) => !o && setOpen()}
        onShowModels={setModelsFor}
      />
      <ModelsDialog credential={modelsFor} onOpenChange={(o) => !o && setModelsFor(null)} />
    </Card>
  )
}

const COLUMN_ORDER = ['5h', 'Weekly', 'Fable']
const COLUMN_LABEL: Record<string, string> = { '5h': '5-hour' }
/** Account, then one cell per limit column; on phones each meter gets its own line. */
const ROW_GRID = 'grid items-center gap-x-6 gap-y-1.5 md:grid-cols-[minmax(0,13rem)_repeat(var(--cols),minmax(0,1fr))]'

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-6 text-sm text-muted-foreground">{children}</div>
}

function AccountRow({
  account: c,
  readings: { reading, older },
  check,
  reserve,
  columns,
  now,
  onOpen,
}: {
  account: Credential
  readings: ReturnType<typeof accountReadings>
  /** The account's last limit check, while checks are on. */
  check?: LimitCheck
  reserve?: ReserveStatus
  columns: string[]
  now: number
  onOpen: () => void
}) {
  const hold = reserveHold(c, reserve)
  const recent = c.recent_requests.at(-1)
  const inUse = credState(c) === 'active' && !!recent && recent.success + recent.failed > 0
  const observedAt = reading?.observed_at ? Date.parse(reading.observed_at) : undefined
  const checked = !!observedAt && observedAt === check?.okAt && limitWindows(c.provider, reading, now).length > 0
  // A live reading since the failed check shows the account works.
  const checkFailed = !!check?.error && !(observedAt && observedAt > check.checkedAt)

  return (
    // The whole row opens the account panel, where everything the tooltips say is also spelled out for touch screens.
    <li
      className={cn(ROW_GRID, 'group -mx-2.5 cursor-pointer rounded-md px-2.5 py-2.5 transition-colors hover:bg-foreground/[0.035] dark:hover:bg-foreground/[0.05]')}
      onClick={onOpen}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <button
            type="button"
            aria-haspopup="dialog"
            className="truncate rounded-sm text-left text-[0.84rem] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
          >
            {accountName(c)}
          </button>
          <span className="shrink-0 text-xs text-muted-foreground capitalize">
            {[providerLabel(c.provider), c.id_token?.plan_type].filter(Boolean).join(' · ')}
          </span>
          <ChevronRightIcon aria-hidden className="ml-auto size-4 shrink-0 self-center text-muted-foreground/60 md:hidden" />
        </div>
        <div className="text-xs text-muted-foreground">
          {credState(c) === 'active' ? (
            <span className="inline-flex items-center gap-2">
              <StatusDot tone="good" pulse={inUse} />
              {inUse ? 'In use' : 'Ready'}
              {hold && reserve && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default text-muted-foreground/80">· {hold.released ? 'released' : 'reserve overridden'}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{reserveNote(hold, reserve.limits)}</TooltipContent>
                </Tooltip>
              )}
              <SignInHint credential={c} />
            </span>
          ) : (
            <CredentialStatus credential={c} />
          )}
          {checkFailed ? (
            <span className="block truncate" title={check.error}>
              Limit check failed: {check.error}
            </span>
          ) : (
            checked && <span> · checked {fmtAgo(observedAt)}</span>
          )}
        </div>
      </div>
      <AccountMeters account={c} reading={reading} older={older} checkedAt={check?.okAt} reserve={reserve} now={now} columns={columns} />
    </li>
  )
}
