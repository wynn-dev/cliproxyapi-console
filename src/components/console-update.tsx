import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActivityIcon, ArrowUpCircleIcon, HistoryIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CopyButton } from '@/components/common'
import { confirm } from '@/components/confirm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { consoleApi } from '@/lib/api'
import type { ConsoleState } from '@/lib/types'

interface UpdateProgress {
  version: string
  phase: 'installing' | 'verifying' | 'restarting' | 'failed'
  startedAt: number
  error?: string
}

interface SelfUpdate {
  /** Whether Update installs from the UI: a service install, with in-UI updates not turned off. */
  canUpdate: boolean
  /** The version Roll back restores. */
  previous: string | null
  progress: UpdateProgress | null
}

interface ConsoleLatest extends SelfUpdate {
  current: string
  latest: string
  service: boolean
  command: string
}

const nightly = (v: string) => Number(v.match(/-nightly\.(\d+)$/)?.[1] ?? NaN)
const short = (v: string) => v.replace(/^.*-nightly\./, '#')

/** Console version in the sidebar footer, with an update (or the command for one) when a newer nightly exists. */
export function ConsoleVersion({ version }: { version?: string }) {
  const { data } = useQuery({
    queryKey: ['console', 'latest'],
    queryFn: () => consoleApi<ConsoleLatest>('/console/latest'),
    staleTime: 30 * 60_000,
    retry: false,
  })
  // Development builds have no nightly number and never prompt.
  const outdated = data && nightly(data.latest) > nightly(data.current)
  const canRollBack = data?.canUpdate && data.previous

  const label = (
    <span className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
      <ActivityIcon className="size-3.5" />
      Console {version ?? ''}
    </span>
  )
  if (!outdated && !canRollBack) return label

  return (
    <Dialog>
      <DialogTrigger asChild>
        {outdated ? (
          <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-chart-1 hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden">
            <ArrowUpCircleIcon className="size-3.5" />
            <span className="flex-1">Update available</span>
            <span className="text-muted-foreground">{short(data.latest)}</span>
          </button>
        ) : (
          <button className="w-full rounded-md text-left hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden">{label}</button>
        )}
      </DialogTrigger>
      <DialogContent>
        {data.canUpdate ? (
          <SelfUpdateDialog data={data} outdated={!!outdated} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Update CPA Console</DialogTitle>
              <DialogDescription>
                You're on {data.current}; the latest nightly is {data.latest}.{' '}
                {data.service
                  ? 'Run this on the server. It reinstalls the service with the latest nightly and keeps your data and CLIProxyAPI settings.'
                  : 'Stop the console, then run this on the server to start the latest nightly.'}
              </DialogDescription>
            </DialogHeader>
            <div className="relative">
              <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
                {data.command}
              </pre>
              <CopyButton value={data.command} className="absolute top-1.5 right-1.5" />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Gives up waiting for the console to come back after this long, and says where to look. */
const RECONNECT_MS = 2 * 60_000

/** How long polls fail after the check before that is taken as the restart, not a blip. */
const DOWN_MS = 10_000

/** Update and Roll back for a service install: progress, then a reconnecting state until the new version answers. */
function SelfUpdateDialog({ data, outdated }: { data: ConsoleLatest; outdated: boolean }) {
  const qc = useQueryClient()
  const [opened] = useState(Date.now)
  // Started here, or already running when the dialog opened.
  const [watching, setWatching] = useState(data.progress?.phase === 'installing' || data.progress?.phase === 'verifying')

  const progress = useQuery({
    queryKey: ['console', 'update'],
    queryFn: () => consoleApi<SelfUpdate>('/console/update'),
    enabled: watching,
    // Polls on through a failed poll (a network blip, a proxy hiccup); it is not the restart by itself.
    refetchInterval: (q) => (q.state.data?.progress?.phase === 'restarting' || (q.state.data && !q.state.data.progress) ? false : 1000),
    retry: false,
  })
  const update = useMutation({
    mutationFn: () => consoleApi<UpdateProgress>('/console/update', { body: { version: data.latest } }),
    onSuccess: (p) => {
      qc.setQueryData(['console', 'update'], { ...data, progress: p })
      setWatching(true)
    },
  })
  const rollback = useMutation({
    mutationFn: () => consoleApi<UpdateProgress>('/console/rollback', { method: 'POST' }),
    onSuccess: (p) => qc.setQueryData(['console', 'update'], { ...data, progress: p }),
  })

  const p = rollback.data || (watching ? (progress.data?.progress ?? update.data ?? data.progress ?? undefined) : undefined)
  // The server answers once more before it exits, if a poll comes in time. Otherwise the restart shows as a console that
  // answers without the update (a new process; Reconnecting then waits for the new version), or as polls failing for a
  // while after the check, which the swap and the exit follow.
  const fresh = watching && !!progress.data && !progress.data.progress
  const down =
    watching && !!progress.error && p?.phase === 'verifying' && progress.errorUpdatedAt - Math.max(progress.dataUpdatedAt, opened) >= DOWN_MS
  const restarting = p?.phase === 'restarting' || fresh || down
  const running = watching && !restarting && p?.phase !== 'failed'

  if (restarting && p) return <Reconnecting version={p.version} />

  const failed = p?.phase === 'failed' ? p : undefined
  const error = failed?.error ?? update.error?.message ?? rollback.error?.message
  const busy = running || update.isPending || rollback.isPending

  return (
    <>
      <DialogHeader>
        <DialogTitle>Update CPA Console</DialogTitle>
        <DialogDescription>
          {outdated ? (
            <>
              You're on {data.current}; the latest nightly is {data.latest}. Update installs it beside the running version and checks it
              starts, then restarts the console on it. The console and CLIProxyAPI are down for a few seconds; your data and settings are
              kept.
            </>
          ) : (
            <>You're on the latest nightly, {data.current}.</>
          )}
        </DialogDescription>
      </DialogHeader>
      {running && p && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {p.phase === 'verifying' ? `Checking ${p.version} starts…` : `Installing ${p.version}…`}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{rollback.error ? 'Could not roll back' : 'Update failed'}</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs whitespace-pre-wrap break-all">{error}</span>
            <span>Still running {data.current}.</span>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {data.previous && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              confirm({
                title: `Roll back to ${data.previous}?`,
                description: `The console restarts on ${data.previous}, the version it ran before its last update. You can switch back to ${data.current} the same way.`,
                confirmLabel: 'Roll back',
                onConfirm: () => rollback.mutateAsync().catch(() => {}),
              })
            }
          >
            {rollback.isPending ? <Spinner /> : <HistoryIcon />}
            Roll back to {short(data.previous)}
          </Button>
        )}
        {outdated && (
          <Button size="sm" disabled={busy} onClick={() => update.mutate()}>
            {busy && !rollback.isPending ? <Spinner /> : <ArrowUpCircleIcon />}
            {failed || update.error ? 'Try again' : `Update to ${short(data.latest)}`}
          </Button>
        )}
      </div>
    </>
  )
}

/** Polls until the console answers on the new version, then reloads the page for its UI. */
function Reconnecting({ version }: { version: string }) {
  const [since] = useState(Date.now)
  const state = useQuery({
    queryKey: ['console', 'reconnect', version],
    queryFn: () => consoleApi<ConsoleState>('/state'),
    refetchInterval: 1000,
    retry: false,
  })
  const back = state.data?.consoleVersion === version
  const late = useLate(since + RECONNECT_MS)
  useEffect(() => {
    if (back) window.location.reload()
  }, [back])

  return (
    <>
      <DialogHeader>
        <DialogTitle>Restarting on {version}</DialogTitle>
        <DialogDescription>The console is restarting. It's back in a few seconds; this page reloads when it is.</DialogDescription>
      </DialogHeader>
      {late ? (
        <Alert variant="destructive">
          <AlertTitle>The console has not come back yet</AlertTitle>
          <AlertDescription>
            {state.data
              ? `It answers, but on ${state.data.consoleVersion}.`
              : 'It does not answer.'}{' '}
            Check <code className="font-mono text-xs">cliproxyui service status</code> on the server; <code className="font-mono text-xs">cliproxyui service rollback</code> restores the previous version.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Reconnecting…
        </p>
      )}
    </>
  )
}

/** Whether a time has passed, re-rendering once it does. */
function useLate(at: number) {
  const [late, setLate] = useState(() => Date.now() >= at)
  useEffect(() => {
    if (late) return
    const t = setTimeout(() => setLate(true), at - Date.now())
    return () => clearTimeout(t)
  }, [at, late])
  return late
}
