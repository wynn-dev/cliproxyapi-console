import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { CheckCircle2Icon, DicesIcon, RotateCwIcon, TerminalIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AuthShell } from '@/components/auth-shell'
import { CopyButton } from '@/components/common'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { auth, consoleApi } from '@/lib/api'
import { fmtBytes } from '@/lib/format'
import { queries } from '@/lib/queries'
import type { ConsoleState } from '@/lib/types'

export const Route = createFileRoute('/setup')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  beforeLoad: async () => {
    const state = await consoleApi<ConsoleState>('/state')
    if (state.configured) throw redirect({ to: auth.get() ? '/' : '/login' })
  },
  component: SetupPage,
})

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 32)
}

function SetupPage() {
  const [submitted, setSubmitted] = useState(false)
  return submitted ? <Installing /> : <SetupForm onDone={() => setSubmitted(true)} />
}

function SetupForm({ onDone }: { onDone: () => void }) {
  const linkToken = Route.useSearch().token
  const [token, setToken] = useState(linkToken ?? '')
  const [key, setKey] = useState(randomKey)
  const { data: state } = useQuery({
    queryKey: ['console', 'state'],
    queryFn: () => consoleApi<ConsoleState>('/state'),
    refetchInterval: (q) => (q.state.data?.installing?.phase === 'done' ? false : 1000),
  })
  const download = state?.installing
  const [port, setPort] = useState('8317')
  const [host, setHost] = useState('')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(undefined)
    try {
      await consoleApi('/setup', { body: { setupToken: token, managementKey: key, port: Number(port), host } })
      auth.set(key)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthShell title="Set up CPA Console" description="The console downloads CLIProxyAPI, writes its config and keeps it running.">
      <Card>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              {!linkToken && (
                <Field>
                  <FieldLabel htmlFor="token">Setup token</FieldLabel>
                  <Input id="token" autoFocus className="font-mono" value={token} onChange={(e) => setToken(e.target.value)} />
                  <FieldDescription className="flex items-center gap-1.5">
                    <TerminalIcon className="size-3.5 shrink-0" /> Open the setup link printed by cliproxyui, or paste its token here.
                  </FieldDescription>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="mkey">Management key</FieldLabel>
                <InputGroup>
                  <InputGroupInput id="mkey" className="font-mono" value={key} onChange={(e) => setKey(e.target.value)} />
                  <InputGroupAddon align="inline-end">
                    {key && <CopyButton value={key} />}
                    <InputGroupButton size="icon-xs" aria-label="Generate" onClick={() => setKey(randomKey())}>
                      <DicesIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>You sign in with this key. Copy it to your password manager now.</FieldDescription>
              </Field>
              <div className="grid grid-cols-[1fr_6rem] gap-3">
                <Field>
                  <FieldLabel>Proxy listens on</FieldLabel>
                  <Select value={host || 'all'} onValueChange={(v) => setHost(v === 'all' ? '' : v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All interfaces</SelectItem>
                      <SelectItem value="127.0.0.1">Localhost only</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="port">Port</FieldLabel>
                  <Input id="port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
                </Field>
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={!token || key.length < 12 || !port || pending}>
                {pending && <Spinner />}
                Start CLIProxyAPI
              </Button>
              {download && download.phase !== 'done' && (
                <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  {download.phase === 'error' ? (
                    <>Download failed: {download.error}</>
                  ) : (
                    <>
                      <Spinner className="size-3" /> Downloading CLIProxyAPI {download.tag}
                      {download.total > 0 && ` · ${Math.round((download.received / download.total) * 100)}%`}
                    </>
                  )}
                </p>
              )}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  )
}

function Installing() {
  const navigate = useNavigate()
  const { data, error } = useQuery({ ...queries.status(), refetchInterval: 700 })
  const retry = useMutation({ mutationFn: () => consoleApi('/release/install', { method: 'POST' }) })
  const install = data?.cpa.install
  const running = data?.process.state === 'running'

  useEffect(() => {
    if (running) {
      const t = setTimeout(() => navigate({ to: '/' }), 900)
      return () => clearTimeout(t)
    }
  }, [running, navigate])

  const phase = running
    ? 'CLIProxyAPI is running'
    : install?.phase === 'downloading'
      ? `Downloading ${install.tag}`
      : install?.phase === 'verifying'
        ? 'Verifying checksum'
        : install?.phase === 'extracting'
          ? 'Installing'
          : 'Starting CLIProxyAPI'
  const pct = install?.total ? (install.received / install.total) * 100 : undefined

  return (
    <AuthShell title="Getting things ready" description="This takes a few seconds on a normal connection.">
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            {running ? <CheckCircle2Icon className="size-4 text-success" /> : <Spinner />}
            {phase}
          </div>
          <Progress value={running ? 100 : install?.phase === 'downloading' ? (pct ?? 5) : install?.phase === 'done' ? 95 : 90} />
          {install?.phase === 'downloading' && install.total > 0 && (
            <p className="text-xs text-muted-foreground tabular">
              {fmtBytes(install.received)} of {fmtBytes(install.total)}
            </p>
          )}
          {(install?.error || data?.process.lastError || error) && (
            <Alert variant="destructive">
              <AlertDescription>{install?.error ?? data?.process.lastError ?? error?.message}</AlertDescription>
            </Alert>
          )}
          {install?.phase === 'error' && (
            <Button className="w-full" disabled={retry.isPending} onClick={() => retry.mutate()}>
              {retry.isPending ? <Spinner /> : <RotateCwIcon />} Try again
            </Button>
          )}
          {data?.process.state === 'crashed' && (
            <Button variant="outline" className="w-full" onClick={() => navigate({ to: '/logs' })}>
              Open the console to see logs
            </Button>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  )
}
