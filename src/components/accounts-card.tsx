import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { StatusDot } from '@/components/common'
import { CredentialSheet } from '@/components/credentials/credential-sheet'
import { accountName, credState, reserveHold, reserveNote } from '@/components/credentials/lib'
import { ModelsDialog } from '@/components/credentials/models-dialog'
import { CredentialStatus } from '@/components/credentials/status'
import { AccountMeters } from '@/components/limit-meter'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { hasReading } from '@/lib/limits'
import { providerLabel } from '@/lib/providers'
import { queries } from '@/lib/queries'
import { hasAccountPool, keepsCachesWarm, routingOf, strategyLabel } from '@/lib/routing'
import type { Credential, ReserveStatus } from '@/lib/types'

const PROVIDER_ORDER = ['claude', 'codex']

/** Providers first, then the order fill-first routing tries accounts in: priority, then file name. */
function byRoutingOrder(a: Credential, b: Credential) {
  const rank = (c: Credential) => (PROVIDER_ORDER.includes(c.provider) ? PROVIDER_ORDER.indexOf(c.provider) : PROVIDER_ORDER.length)
  return rank(a) - rank(b) || a.provider.localeCompare(b.provider) || (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Every account with its usage limits, as the provider last reported them. */
export function AccountsCard({ running }: { running: boolean }) {
  const now = useNow(30_000)
  const credentials = useQuery({ ...queries.credentials(), enabled: running })
  const stored = useQuery({ ...queries.limits(), enabled: running })
  const config = useQuery({ ...queries.config(), enabled: running })
  const reserve = useQuery({ ...queries.reserve(), enabled: running })
  const accounts = [...(credentials.data?.files ?? [])].sort(byRoutingOrder)
  const routing = routingOf(config.data)
  const scattered = hasAccountPool(accounts) && !keepsCachesWarm(routing)
  const [open, setOpen] = useState<string | null>(null)
  const [modelsFor, setModelsFor] = useState<Credential | null>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <CardDescription>How much of each usage limit is left, as each provider last reported it. Select an account for details.</CardDescription>
        <CardAction>
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
            <ul className="divide-y">
              {accounts.map((c) => (
                <AccountRow
                  key={c.id}
                  account={c}
                  reading={hasReading(c.quota) ? c.quota : stored.data?.[c.name]}
                  reserve={reserve.data}
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
        credential={accounts.find((c) => c.name === open) ?? null}
        focusEdit={false}
        onOpenChange={(o) => !o && setOpen(null)}
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
  reading,
  reserve,
  now,
  onOpen,
}: {
  account: Credential
  reading?: Credential['quota']
  reserve?: ReserveStatus
  now: number
  onOpen: () => void
}) {
  const hold = reserveHold(c, reserve)
  const recent = c.recent_requests.at(-1)
  const inUse = credState(c) === 'active' && !!recent && recent.success + recent.failed > 0

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
                    <span className="cursor-default text-xs text-muted-foreground/80">· reserve overridden</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{reserveNote(hold, reserve.limits)}</TooltipContent>
                </Tooltip>
              )}
            </span>
          ) : (
            <CredentialStatus credential={c} />
          )}
        </div>
      </div>
      <AccountMeters account={c} reading={reading} reserve={reserve} now={now} className="sm:grid-cols-3 xl:grid-cols-4" />
    </li>
  )
}
