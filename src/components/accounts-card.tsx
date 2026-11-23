import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, ChevronRightIcon, GaugeIcon } from 'lucide-react'
import { useState } from 'react'
import { StatusDot } from '@/components/common'
import { CredentialSheet } from '@/components/credentials/credential-sheet'
import { accountName, credState, reserveHold, reserveNote, useAccountParam } from '@/components/credentials/lib'
import { ModelsDialog } from '@/components/credentials/models-dialog'
import { CredentialStatus, SignInHint } from '@/components/credentials/status'
import { AccountMeters, PoolMeter } from '@/components/limit-meter'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { fmtAgo } from '@/lib/format'
import { accountReadings, gaugeKey, limitWindows, poolLimits } from '@/lib/limits'
import { providerLabel } from '@/lib/providers'
import { queries, useGaugesWrite } from '@/lib/queries'
import { hasAccountPool, keepsCachesWarm, routingOf, strategyLabel } from '@/lib/routing'
import type { Credential, LimitCheck, ReserveStatus } from '@/lib/types'

const PROVIDER_ORDER = ['claude', 'codex', 'antigravity']

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
  const hiddenList = useQuery(queries.gauges()).data?.hidden
  const hidden = new Set(hiddenList)
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
  // Every gauge the accounts have, for the picker: each limit once per provider, in the accounts' order.
  const gauges = new Map<string, string>()
  for (const c of accounts) {
    const { reading, older } = accountReadings(c.quota, stored.data?.[c.name])
    for (const w of [...limitWindows(c.provider, reading, now), ...limitWindows(c.provider, older, now)]) {
      gauges.set(gaugeKey(c.provider, w.label), `${providerLabel(c.provider)} ${w.label}`)
    }
  }
  const shownPools = pools.filter((p) => !hidden.has(gaugeKey(p.provider, p.label)))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <CardDescription>How much of each usage limit is left, as each provider last reported it. Select an account for details.</CardDescription>
        <CardAction className="flex items-center gap-1">
          {running && gauges.size > 0 && <GaugePicker gauges={gauges} hidden={hiddenList ?? []} />}
          <Button variant="ghost" size="sm" asChild>
            <Link to="/credentials">
              Manage <ArrowRightIcon />
            </Link>
          </Button>
        </CardAction>
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
            <Link to="/credentials" className="text-foreground underline underline-offset-4">
              Add one
            </Link>
          </Empty>
        ) : (
          <>
            {shownPools.length > 0 && (
              <div className="grid items-start gap-x-8 gap-y-3 border-b pb-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
                <div className="space-y-1">
                  <div className="text-sm font-medium">All accounts</div>
                  <div className="text-sm text-muted-foreground">
                    {[...new Set(shownPools.map((p) => p.label))].join(', ').replace(/, ([^,]*)$/, ' and $1')} limits added up, per provider
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                  {pools.map((p) => (
                    <PoolMeter key={`${p.provider}:${p.label}`} pool={p} reserve={reserve.data?.limits[p.label === 'Fable' ? 'fable' : 'weekly']} now={now} />
                  ))}
                </div>
              </div>
            )}
            <ul className="divide-y">
              {accounts.map((c) => (
                <AccountRow
                  key={c.id}
                  account={c}
                  readings={accountReadings(c.quota, stored.data?.[c.name])}
                  check={checks.data?.enabled ? checks.data.accounts[c.name] : undefined}
                  reserve={reserve.data}
                  hidden={hidden}
                  now={now}
                  onOpen={() => setOpen(c.name)}
                />
              ))}
            </ul>
            {config.data && (
              <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
                <Badge variant="outline" className="gap-1.5 font-normal">
                  {scattered && <StatusDot tone="warn" />}
                  {strategyLabel(routing.strategy)}
                  {routing.affinity && ' · sticky sessions'}
                </Badge>
                {scattered
                  ? 'Conversations can move between accounts and lose their prompt cache.'
                  : keepsCachesWarm(routing)
                    ? 'One account is used until it runs out, and each conversation stays on its account.'
                    : 'How requests are spread across accounts.'}
                <Link to="/settings" search={{ section: 'routing' }} className="text-foreground underline underline-offset-4">
                  {scattered ? 'Fix in Settings' : 'Routing settings'}
                </Link>
              </p>
            )}
          </>
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

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</div>
}

function AccountRow({
  account: c,
  readings: { reading, older },
  check,
  reserve,
  hidden,
  now,
  onOpen,
}: {
  account: Credential
  readings: ReturnType<typeof accountReadings>
  /** The account's last limit check, while checks are on. */
  check?: LimitCheck
  reserve?: ReserveStatus
  /** Gauges the user left out of the Overview, by gaugeKey. */
  hidden: ReadonlySet<string>
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
      className="group -mx-2 grid cursor-pointer items-start gap-x-8 gap-y-3 rounded-lg px-2 py-4 transition-colors hover:bg-muted/40 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]"
      onClick={onOpen}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            aria-haspopup="dialog"
            className="truncate rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
          >
            {accountName(c)}
          </button>
          <Badge variant="secondary" className="h-4.5 px-1.5 text-[11px]">
            {providerLabel(c.provider)}
          </Badge>
          {c.id_token?.plan_type && (
            <Badge variant="outline" className="h-4.5 px-1.5 text-[11px] capitalize">
              {c.id_token.plan_type}
            </Badge>
          )}
          <ChevronRightIcon aria-hidden className="ml-auto size-4 shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground lg:hidden" />
        </div>
        <div className="text-sm text-muted-foreground">
          {credState(c) === 'active' ? (
            <span className="inline-flex items-center gap-2">
              <StatusDot tone="good" pulse={inUse} />
              {inUse ? 'In use' : 'Ready'}
              {hold && reserve && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default text-xs text-muted-foreground/80">· {hold.released ? 'released' : 'reserve overridden'}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{reserveNote(hold, reserve.limits)}</TooltipContent>
                </Tooltip>
              )}
              <SignInHint credential={c} />
            </span>
          ) : (
            <CredentialStatus credential={c} />
          )}
        </div>
        {checkFailed ? (
          <div className="truncate text-xs text-muted-foreground" title={check.error}>
            Limit check failed: {check.error}
          </div>
        ) : (
          checked && <div className="text-xs text-muted-foreground">Limits checked {fmtAgo(observedAt)}</div>
        )}
      </div>
      <AccountMeters
        account={c}
        reading={reading}
        older={older}
        checkedAt={check?.okAt}
        reserve={reserve}
        now={now}
        hidden={hidden}
        className="sm:grid-cols-3 xl:grid-cols-4"
      />
    </li>
  )
}

/**
 * Which limit gauges the Overview shows, saved in the console so it holds for every browser. Only
 * what is shown here: the account panel still shows every limit, and the reserve ignores this.
 */
function GaugePicker({ gauges, hidden }: { gauges: Map<string, string>; hidden: string[] }) {
  const write = useGaugesWrite()
  const shown = [...gauges.keys()].filter((k) => !hidden.includes(k)).length
  const toggle = (key: string, on: boolean) => write.mutate(on ? hidden.filter((k) => k !== key) : [...hidden, key])
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <GaugeIcon />
          Gauges
          {shown < gauges.size && (
            <span className="text-muted-foreground tabular">
              {shown}/{gauges.size}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 space-y-1 p-2">
        <div className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">Limits shown here. Account panels still show every limit.</div>
        {[...gauges].map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
            <Checkbox checked={!hidden.includes(key)} onCheckedChange={(v) => toggle(key, v === true)} />
            {label}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  )
}
