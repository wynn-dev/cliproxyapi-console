import { useNavigate } from '@tanstack/react-router'
import { DownloadIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CopyButton, SecretText } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { ApiError, download } from '@/lib/api'
import { fmtMs, fmtNumber } from '@/lib/format'
import { providerLabel } from '@/lib/providers'
import type { UsageRequest } from '@/lib/types'
import { type CredentialLabels, CredentialName, ModelName, StatusLabel } from './cells'

function prettyError(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

export function RequestSheet({ request: r, labels, onClose }: { request: UsageRequest | null; labels: CredentialLabels; onClose: () => void }) {
  return (
    <Sheet open={!!r} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">{r && <Details r={r} labels={labels} />}</SheetContent>
    </Sheet>
  )
}

function Details({ r, labels }: { r: UsageRequest; labels: CredentialLabels }) {
  const navigate = useNavigate()
  const [downloading, setDownloading] = useState(false)

  const downloadLog = async () => {
    if (!r.requestId) return
    setDownloading(true)
    try {
      await download(`/observability/logs/requests/${encodeURIComponent(r.requestId)}`, `request-${r.requestId}.log`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast.error('No log for this request', {
          description: 'CLIProxyAPI only writes request logs while "Request log" is enabled in Settings.',
          action: { label: 'Settings', onClick: () => void navigate({ to: '/settings', search: { section: 'logging' } }) },
        })
      } else {
        toast.error('Download failed', { description: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      setDownloading(false)
    }
  }

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle className="flex items-center gap-2">
          <ModelName model={r.model} alias={r.alias} className="text-sm break-all whitespace-normal" />
        </SheetTitle>
        <SheetDescription className="flex items-center gap-2">
          {new Date(r.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2 text-sm">
          <StatusLabel failed={!!r.failed} code={r.statusCode} />
          <Badge variant="outline">{r.stream ? 'Stream' : 'Sync'}</Badge>
          {r.endpoint && <code className="font-mono text-xs text-muted-foreground">{r.endpoint}</code>}
        </div>
      </SheetHeader>

      <div className="flex-1 space-y-6 overflow-y-auto p-4">
        <Section title="Request">
          <Field label="Request ID" wide>
            {r.requestId ? (
              <span className="flex items-center gap-1">
                <code className="truncate font-mono text-[13px]">{r.requestId}</code>
                <CopyButton value={r.requestId} label="Copy request ID" className="-my-1.5" />
              </span>
            ) : (
              '—'
            )}
          </Field>
          <Field label="Provider">{r.provider ? providerLabel(r.provider) : '—'}</Field>
          <Field label="Auth type">{r.authType || '—'}</Field>
          <Field label="Credential" wide>
            <CredentialName authIndex={r.authIndex} labels={labels} />
            {labels.has(r.authIndex) && <div className="font-mono text-xs text-muted-foreground">{r.authIndex}</div>}
          </Field>
          <Field label="Client key" wide>
            {r.apiKey ? <SecretText value={r.apiKey} className="-my-1.5" /> : '—'}
          </Field>
          <Field label="Reasoning effort">{r.reasoningEffort || '—'}</Field>
          <Field label="Service tier">{r.serviceTier || '—'}</Field>
          <Field label="Client IP">
            <span className="font-mono text-[13px]">{r.clientIp || '—'}</span>
          </Field>
          <Field label="Latency">
            <span className="tabular">{fmtMs(r.latencyMs)}</span>
            {r.stream && r.ttftMs > 0 ? <span className="text-muted-foreground tabular"> · TTFT {fmtMs(r.ttftMs)}</span> : null}
          </Field>
          <Field label="User agent" wide>
            <span className="font-mono text-xs break-all">{r.userAgent || '—'}</span>
          </Field>
        </Section>

        <Section title="Tokens">
          <Field label="Input">
            {fmtNumber(r.input)}
            {r.cached + r.cacheWrite > 0 && (
              <span className="text-muted-foreground"> · {fmtNumber(Math.max(0, r.input - r.cached - r.cacheWrite))} uncached</span>
            )}
          </Field>
          <Field label="Output">{fmtNumber(r.output)}</Field>
          <Field label="Cache read">{fmtNumber(r.cached)}</Field>
          <Field label="Cache write">{fmtNumber(r.cacheWrite)}</Field>
          <Field label="Reasoning">{fmtNumber(r.reasoning)}</Field>
          <Field label="Total">
            <span className="font-medium">{fmtNumber(r.total)}</span>
          </Field>
        </Section>

        {!!r.failed && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Error response</h3>
            {r.error ? (
              <pre className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
                {prettyError(r.error)}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">No response body was recorded.</p>
            )}
          </div>
        )}
      </div>

      <SheetFooter className="border-t">
        <Button variant="outline" disabled={!r.requestId || downloading} onClick={downloadLog}>
          {downloading ? <Spinner /> : <DownloadIcon />}
          Download request log
        </Button>
      </SheetFooter>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">{children}</dl>
    </div>
  )
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0 space-y-0.5' : 'min-w-0 space-y-0.5'}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 tabular">{children}</dd>
    </div>
  )
}
