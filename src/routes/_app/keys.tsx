import { useQueries, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRoundIcon, PlusIcon, ShieldAlertIcon, SparklesIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CopyButton, PageHeader, SecretText } from '@/components/common'
import { confirm } from '@/components/confirm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { consoleApi } from '@/lib/api'
import { fmtAgo, fmtCompact, fmtNumber, maskSecret } from '@/lib/format'
import { queries, useConfigWrite, usageQueries } from '@/lib/queries'
import type { UsageRequest } from '@/lib/types'

export const Route = createFileRoute('/_app/keys')({ component: ClientKeys })

const DAY = 86_400_000

function generateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24)) // 24 bytes → 32 base64url chars
  const b64 = btoa(String.fromCharCode(...bytes))
  return `sk-${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

function ClientKeys() {
  const config = useQuery(queries.config())
  const keys: string[] = Array.isArray(config.data?.access?.['api-keys']) ? config.data.access['api-keys'] : []
  const write = useConfigWrite()
  const [created, setCreated] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const saveKeys = (next: string[]) => write.mutateAsync({ path: '/access/api-keys', value: next })

  const generate = async () => {
    const key = generateKey()
    await saveKeys([...keys, key])
    setCreated(key)
  }

  const remove = (key: string) => {
    const last = keys.length === 1
    confirm({
      title: last ? 'Delete the last client key?' : `Delete key ${maskSecret(key)}?`,
      description: last ? (
        <span className="block space-y-2">
          <span className="block font-medium text-destructive">
            With no client keys, CLIProxyAPI accepts requests without authentication — anyone who can reach the proxy can use your providers.
          </span>
          <span className="block">The playground also stops working until you add a key.</span>
        </span>
      ) : (
        'Clients using this key get 401 errors right away.'
      ),
      confirmLabel: last ? 'Delete and allow open access' : 'Delete key',
      destructive: true,
      onConfirm: () => saveKeys(keys.filter((k) => k !== key)).then(() => toast.success('Client key deleted')),
    })
  }

  return (
    <>
      <PageHeader
        title="Client keys"
        description="Keys your tools use to call the proxy's /v1 API."
        actions={
          <>
            <Button variant="outline" onClick={() => setAdding(true)} disabled={!config.data}>
              <PlusIcon />
              Add existing
            </Button>
            <Button onClick={() => void generate().catch(() => {})} disabled={!config.data || write.isPending}>
              {write.isPending ? <Spinner /> : <SparklesIcon />}
              Generate key
            </Button>
          </>
        }
      />

      {config.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the configuration</AlertTitle>
          <AlertDescription>{config.error.message}</AlertDescription>
        </Alert>
      )}
      {config.data && keys.length === 0 && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>The proxy is open</AlertTitle>
          <AlertDescription>No client keys are configured, so CLIProxyAPI accepts unauthenticated requests. Generate a key to lock it down.</AlertDescription>
        </Alert>
      )}

      <KeysCard keys={keys} loading={config.isLoading} onDelete={remove} />
      <ConnectCard />

      <GeneratedDialog value={created} onClose={() => setCreated(null)} />
      <AddExistingDialog
        open={adding}
        keys={keys}
        onOpenChange={setAdding}
        onSave={async (key) => {
          await saveKeys([...keys, key])
          toast.success('Client key added')
        }}
      />
    </>
  )
}

function KeysCard({ keys, loading, onDelete }: { keys: string[]; loading: boolean; onDelete: (key: string) => void }) {
  const now = useNow(60_000)
  const usage = useQuery(usageQueries.summary({ from: now - 30 * DAY, to: now }))
  const byKey = new Map((usage.data?.byApiKey ?? []).map((u) => [u.key, u]))
  const last = useQueries({
    queries: keys.map((k) => ({
      queryKey: ['console', 'usage', 'last', k],
      queryFn: () => consoleApi<UsageRequest[]>('/usage/requests', { query: { apiKey: k, limit: 1, from: 0, to: Date.now() + 60_000 } }),
      refetchInterval: 30_000,
    })),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Keys</CardTitle>
        <CardDescription>{keys.length ? `${keys.length} ${keys.length === 1 ? 'key' : 'keys'} · usage over the last 30 days` : 'Usage over the last 30 days'}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : keys.length === 0 ? (
          <Empty className="border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle>No client keys</EmptyTitle>
              <EmptyDescription>Generate a key and use it as the Bearer token in your client.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Last used</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k, i) => {
                const u = byKey.get(k)
                const lastTs = last[i]?.data?.[0]?.ts
                return (
                  <TableRow key={k}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <SecretText value={k} />
                        {i === 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="secondary" className="cursor-default">
                                Console
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>The playground and model list use the first key.</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className={u?.requests ? 'text-right tabular' : 'text-right text-muted-foreground tabular'}>
                      {usage.data ? fmtNumber(u?.requests ?? 0) : '—'}
                    </TableCell>
                    <TableCell className={u?.failed ? 'text-right text-critical tabular' : 'text-right text-muted-foreground tabular'}>
                      {usage.data ? fmtNumber(u?.failed ?? 0) : '—'}
                    </TableCell>
                    <TableCell className={u?.total ? 'text-right tabular' : 'text-right text-muted-foreground tabular'}>
                      {usage.data ? fmtCompact(u?.total ?? 0) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{lastTs ? fmtAgo(lastTs) : 'Never'}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Delete key" onClick={() => onDelete(k)}>
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function ConnectCard() {
  const { data: status } = useQuery(queries.status())
  const port = status?.config?.port ?? 8317
  const baseUrl = `${window.location.protocol}//${window.location.hostname}:${port}/v1`
  return (
    <Card>
      <CardHeader>
        <CardTitle>Using a key</CardTitle>
        <CardDescription>Send it as a Bearer token (or x-api-key / x-goog-api-key) to the proxy.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Base URL</div>
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
            <code className="truncate font-mono text-[13px]">{baseUrl}</code>
            <CopyButton value={baseUrl} />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Header</div>
          <div className="flex items-center rounded-md border bg-muted/40 py-1 pr-1 pl-3">
            <code className="truncate py-1 font-mono text-[13px]">Authorization: Bearer &lt;client-key&gt;</code>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function GeneratedDialog({ value, onClose }: { value: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New client key</DialogTitle>
          <DialogDescription>Copy it into your client now. It is saved in the proxy config and active immediately.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
          <code className="font-mono text-[13px] break-all">{value}</code>
          <CopyButton value={value ?? ''} />
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddExistingDialog({
  open,
  keys,
  onOpenChange,
  onSave,
}: {
  open: boolean
  keys: string[]
  onOpenChange: (open: boolean) => void
  onSave: (key: string) => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const key = value.trim()
    if (!key) return setError('Enter a key.')
    if (/\s/.test(key)) return setError('Keys cannot contain spaces.')
    if (keys.includes(key)) return setError('This key already exists.')
    setPending(true)
    try {
      await onSave(key)
      onOpenChange(false)
      setValue('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) {
          setValue('')
          setError(null)
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add existing key</DialogTitle>
            <DialogDescription>Reuse a key your clients already have, e.g. when migrating from another proxy.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="existing-key">Key</FieldLabel>
            <Input
              id="existing-key"
              value={value}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-[13px]"
              placeholder="sk-…"
              aria-invalid={!!error}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
            />
            {error ? <FieldError>{error}</FieldError> : <FieldDescription>Any string works; long random keys are safest.</FieldDescription>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => (onOpenChange(false), setValue(''), setError(null))}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              Add key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
