import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ExternalLinkIcon,
  FileJsonIcon,
  RotateCwIcon,
  UploadIcon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, mgmt } from '@/lib/api'
import { fmtBytes } from '@/lib/format'
import { OAUTH_PROVIDERS } from '@/lib/providers'
import { cn } from '@/lib/utils'

export function AddCredentialDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState('oauth')
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add credential</DialogTitle>
          <DialogDescription>Sign in with a Claude or Codex account, or upload auth files you already have.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="oauth">Sign in</TabsTrigger>
            <TabsTrigger value="upload">Upload files</TabsTrigger>
          </TabsList>
          {/* forceMount keeps an in-progress sign-in alive while switching tabs */}
          <TabsContent value="oauth" forceMount className="data-[state=inactive]:hidden">
            <OAuthPanel onDone={close} />
          </TabsContent>
          <TabsContent value="upload">
            <UploadPanel onDone={close} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// --- OAuth -------------------------------------------------------------------------------------

type Provider = (typeof OAUTH_PROVIDERS)[number]

interface AuthUrlResponse {
  status: string
  url: string
  state: string
}

interface Flow {
  provider: Provider
  state: string
  url: string
}

type Outcome = { ok: true } | { ok: false; error: string }

function OAuthPanel({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const [flow, setFlow] = useState<Flow | null>(null)

  const start = useMutation({
    mutationFn: (p: Provider) => mgmt<AuthUrlResponse>('/oauth/auth-url', { query: { provider: p.id, is_webui: true } }),
    onSuccess: (r, p) => setFlow({ provider: p, state: r.state, url: r.url }),
  })

  const status = useQuery({
    queryKey: ['oauth-status', flow?.state],
    queryFn: () =>
      mgmt<{ status: 'ok' | 'wait' | 'error'; error?: string }>('/oauth/status', { query: { state: flow!.state } }).catch((e: Error) => ({
        status: 'error' as const,
        error: e.message,
      })),
    enabled: !!flow,
    refetchInterval: (q) => (!q.state.data || q.state.data.status === 'wait' ? 2000 : false),
    refetchOnWindowFocus: false,
    gcTime: 0,
  })
  const s = status.data
  const outcome: Outcome | null = !s || s.status === 'wait' ? null : s.status === 'ok' ? { ok: true } : { ok: false, error: s.error || 'Sign-in failed' }

  // Cancel a pending session when the dialog closes or the user backs out.
  const pending = useRef<string | null>(null)
  useEffect(() => {
    pending.current = flow && !outcome ? flow.state : null
  })
  const cancel = (state: string) => void mgmt('/oauth/session', { method: 'DELETE', query: { state } }).catch(() => {})
  useEffect(() => () => void (pending.current && cancel(pending.current)), [])

  const succeeded = outcome?.ok === true
  useEffect(() => {
    if (!succeeded || !flow) return
    toast.success(`${flow.provider.name} account added`)
    void qc.invalidateQueries({ queryKey: ['mgmt', 'credentials'] })
    const t = setTimeout(onDone, 1200)
    return () => clearTimeout(t)
  }, [succeeded]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => {
    if (pending.current) cancel(pending.current)
    setFlow(null)
  }

  if (!flow) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {OAUTH_PROVIDERS.map((p) => {
            const loading = start.isPending && start.variables?.id === p.id
            return (
              <button
                key={p.id}
                type="button"
                disabled={start.isPending}
                onClick={() => start.mutate(p)}
                className="group relative flex min-h-18 flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-xs leading-snug text-muted-foreground">{p.description}</span>
                {loading && <Spinner className="absolute top-3 right-3" />}
              </button>
            )
          })}
        </div>
        {start.error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Could not start sign-in</AlertTitle>
            <AlertDescription>{start.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
    )
  }

  if (outcome?.ok) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <CheckCircle2Icon className="size-8 text-success" />
        <div className="font-medium">{flow.provider.name} account added</div>
        <div className="text-sm text-muted-foreground">It's now part of the rotation.</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Choose another provider" onClick={back}>
          <ArrowLeftIcon />
        </Button>
        <div className="font-medium">Sign in to {flow.provider.name}</div>
      </div>

      {outcome && !outcome.ok ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Sign-in failed</AlertTitle>
          <AlertDescription className="space-y-3">
            <p className="line-clamp-4 break-words">{outcome.error}</p>
            <Button variant="outline" size="sm" onClick={() => start.mutate(flow.provider)} disabled={start.isPending}>
              {start.isPending ? <Spinner /> : <RotateCwIcon />}
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <BrowserFlow flow={flow} onSubmitted={() => void status.refetch()} />
      )}

      {!outcome && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Waiting for sign-in…
        </div>
      )}
    </div>
  )
}

function BrowserFlow({ flow, onSubmitted }: { flow: Flow; onSubmitted: () => void }) {
  const [url, setUrl] = useState('')
  const [invalid, setInvalid] = useState(false)
  const submit = useMutation({
    mutationFn: (redirect_url: string) => mgmt('/oauth/callback', { body: { redirect_url } }),
    onSuccess: onSubmitted,
  })

  return (
    <ol className="space-y-4 text-sm">
      <Step n={1} title="Open the sign-in page">
        <div className="flex gap-2">
          <Button size="sm" onClick={() => window.open(flow.url, '_blank', 'noopener')}>
            <ExternalLinkIcon />
            Open sign-in page
          </Button>
          <div className="flex min-w-0 flex-1 items-center rounded-lg border bg-muted/40 pr-0.5 pl-2.5">
            <code className="flex-1 truncate font-mono text-xs text-muted-foreground">{flow.url}</code>
            <CopyButton value={flow.url} label="Copy link" />
          </div>
        </div>
      </Step>
      <Step n={2} title="Sign in and approve access">
        <p className="text-muted-foreground">
          Afterwards your browser is sent to a <code className="font-mono text-xs">localhost</code> address that will probably fail to load.
          That's expected.
        </p>
      </Step>
      <Step n={3} title="Paste the URL from the address bar">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            const v = url.trim()
            const ok = URL.canParse(v) && /[?&](code|error)=/.test(v)
            setInvalid(!ok)
            if (ok) submit.mutate(v)
          }}
        >
          <Field data-invalid={invalid || !!submit.error}>
            <div className="flex gap-2">
              <Input
                placeholder="http://localhost:…/callback?code=…"
                className="font-mono text-xs md:text-xs"
                value={url}
                aria-invalid={invalid || !!submit.error}
                aria-label="Redirect URL"
                onChange={(e) => {
                  setUrl(e.target.value)
                  setInvalid(false)
                  submit.reset()
                }}
              />
              <Button type="submit" variant="secondary" disabled={!url.trim() || submit.isPending || submit.isSuccess}>
                {(submit.isPending || submit.isSuccess) && <Spinner />}
                Submit
              </Button>
            </div>
            <FieldError>{invalid ? 'Paste the full URL, including ?code=…' : submit.error?.message}</FieldError>
          </Field>
        </form>
      </Step>
    </ol>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="font-medium">{title}</div>
        {children}
      </div>
    </li>
  )
}

// --- Upload ------------------------------------------------------------------------------------

type FileResult = { ok: true } | { ok: false; error: string }

function UploadPanel({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [results, setResults] = useState<Record<string, FileResult> | null>(null)
  const [dragging, setDragging] = useState(false)

  const add = (list: FileList | null) => {
    if (!list?.length) return
    setResults(null)
    setFiles((prev) => {
      const byName = new Map(prev.map((f) => [f.name, f]))
      for (const f of Array.from(list)) byName.set(f.name, f)
      return [...byName.values()]
    })
  }

  const upload = useMutation({
    mutationFn: async (list: File[]) => {
      const out: Record<string, FileResult> = {}
      const valid = list.filter((f) => f.name.toLowerCase().endsWith('.json'))
      for (const f of list) if (!valid.includes(f)) out[f.name] = { ok: false, error: 'Not a .json file' }
      if (!valid.length) return out
      const fd = new FormData()
      for (const f of valid) fd.append('file', f, f.name)
      try {
        const res = await mgmt<{ failed?: { name: string; error: string }[] }>('/credentials', { body: fd })
        const failed = new Map((res?.failed ?? []).map((f) => [f.name, f.error]))
        for (const f of valid) out[f.name] = failed.has(f.name) ? { ok: false, error: failed.get(f.name)! } : { ok: true }
      } catch (err) {
        const body = err instanceof ApiError ? (err.body as { failed?: { name: string; error: string }[] }) : undefined
        const failed = new Map((body?.failed ?? []).map((f) => [f.name, f.error]))
        for (const f of valid) out[f.name] = { ok: false, error: failed.get(f.name) ?? (err as Error).message }
      }
      return out
    },
    onSuccess: (out) => {
      setResults(out)
      const ok = Object.values(out).filter((r) => r.ok).length
      const bad = Object.keys(out).length - ok
      if (ok) void qc.invalidateQueries({ queryKey: ['mgmt', 'credentials'] })
      if (!bad) {
        toast.success(ok === 1 ? 'Credential uploaded' : `${ok} credentials uploaded`)
        onDone()
      } else if (ok) {
        toast.warning(`${ok} uploaded, ${bad} failed`)
      } else {
        toast.error(bad === 1 ? 'Upload failed' : `${bad} uploads failed`)
      }
    },
  })

  const pendingFiles = results ? files.filter((f) => !results[f.name]?.ok) : files

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          add(e.dataTransfer.files)
        }}
        className={cn(
          'flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors outline-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          dragging && 'border-ring bg-muted/60',
        )}
      >
        <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
          <UploadIcon className="size-4" />
        </div>
        <div className="font-medium">Drop auth files here, or click to browse</div>
        <div className="text-xs text-muted-foreground">JSON files created by CLIProxyAPI or its CLI login commands</div>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          add(e.target.files)
          e.target.value = ''
        }}
      />

      {files.length > 0 && (
        <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border">
          {files.map((f) => {
            const r = results?.[f.name]
            return (
              <li key={f.name} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                {r ? (
                  r.ok ? (
                    <CircleCheckIcon className="size-4 shrink-0 text-success" aria-label="Uploaded" />
                  ) : (
                    <CircleXIcon className="size-4 shrink-0 text-critical" aria-label="Failed" />
                  )
                ) : (
                  <FileJsonIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px]">{f.name}</div>
                  {r && !r.ok && <div className="truncate text-xs text-critical">{r.error}</div>}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground tabular">{fmtBytes(f.size)}</span>
                {!r?.ok && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${f.name}`}
                    disabled={upload.isPending}
                    onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                  >
                    <XIcon />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex justify-end">
        <Button disabled={!pendingFiles.length || upload.isPending} onClick={() => upload.mutate(pendingFiles)}>
          {upload.isPending ? <Spinner /> : <UploadIcon />}
          {results && pendingFiles.length ? 'Retry failed' : `Upload${pendingFiles.length ? ` ${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''}` : ''}`}
        </Button>
      </div>
    </div>
  )
}
