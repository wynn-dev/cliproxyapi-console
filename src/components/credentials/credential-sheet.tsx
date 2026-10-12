import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BoxesIcon, DownloadIcon, RefreshCwIcon, ShieldIcon, TimerResetIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CopyButton, RequestSparkline, StatusDot } from '@/components/common'
import { confirm } from '@/components/confirm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { mgmt } from '@/lib/api'
import { fmtAgo, fmtBytes, fmtDateTime, fmtNumber, fmtPercent } from '@/lib/format'
import { providerLabel } from '@/lib/providers'
import { queries } from '@/lib/queries'
import type { Credential } from '@/lib/types'
import {
  STATE_META,
  accountName,
  cooldownLabel,
  cooldownUntil,
  credState,
  downloadCredential,
  reserveHold,
  reserveNote,
  useDeleteCredentials,
  useRefreshCredentials,
  useResetCooldown,
  useSetDisabled,
} from './lib'
import { Countdown } from './status'

export function CredentialSheet({
  credential,
  focusEdit,
  onOpenChange,
  onShowModels,
}: {
  credential: Credential | null
  focusEdit: boolean
  onOpenChange: (open: boolean) => void
  onShowModels: (c: Credential) => void
}) {
  return (
    <Sheet open={!!credential} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 data-[side=right]:sm:max-w-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {credential && (
          <SheetBody
            key={credential.name}
            credential={credential}
            focusEdit={focusEdit}
            onClose={() => onOpenChange(false)}
            onShowModels={onShowModels}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function SheetBody({
  credential: c,
  focusEdit,
  onClose,
  onShowModels,
}: {
  credential: Credential
  focusEdit: boolean
  onClose: () => void
  onShowModels: (c: Credential) => void
}) {
  const setDisabled = useSetDisabled()
  const refresh = useRefreshCredentials()
  const reset = useResetCooldown()
  const del = useDeleteCredentials()
  const reserve = useQuery(queries.reserve()).data
  const hold = reserveHold(c, reserve)
  const state = credState(c)
  const meta = STATE_META[state]
  const cooling = state === 'cooling' || (c.cooldowns?.length ?? 0) > 0
  const until = cooling ? cooldownUntil(c) : null
  const total = c.success + c.failed
  const signals = Object.entries(c.quota?.signals ?? {})
  // The list endpoint doesn't echo prefix/proxy_url, so read them from the file; only those two fields are kept.
  const fileFields = useQuery({
    queryKey: ['mgmt', 'credentials', 'file-fields', c.name],
    queryFn: async () => {
      const raw = await mgmt<Record<string, unknown>>('/credentials/download', { query: { name: c.name } })
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
      return { prefix: str(raw?.prefix), proxy_url: str(raw?.proxy_url) }
    },
  })

  return (
    <>
      <SheetHeader className="gap-3 border-b pr-12">
        <div className="space-y-1">
          <SheetTitle className="truncate text-lg">{accountName(c)}</SheetTitle>
          <SheetDescription className="truncate font-mono text-xs">{c.name}</SheetDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{providerLabel(c.provider)}</Badge>
          {c.id_token?.plan_type && <Badge variant="outline" className="capitalize">{c.id_token.plan_type}</Badge>}
          <Badge variant="outline" className="gap-1.5">
            <StatusDot tone={meta.tone} />
            {hold && !hold.overridden ? 'Reserved' : meta.label}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="mr-1 flex items-center gap-2 text-sm">
            <Switch
              checked={!c.disabled}
              onCheckedChange={(on) => setDisabled.mutate({ names: [c.name], disabled: !on })}
              aria-label="Enabled"
            />
            Enabled
          </label>
          <Button variant="outline" size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate([c.name])}>
            {refresh.isPending ? <Spinner /> : <RefreshCwIcon />}
            Refresh token
          </Button>
          <Button variant="outline" size="sm" onClick={() => onShowModels(c)}>
            <BoxesIcon />
            Models
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="Download" onClick={() => downloadCredential(c.name)}>
                <DownloadIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download JSON</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="destructive"
                size="icon-sm"
                aria-label="Delete"
                onClick={() =>
                  confirm({
                    title: `Delete ${accountName(c)}?`,
                    description: `${c.name} is removed from the auth directory. You'll need to sign in again to restore it.`,
                    confirmLabel: 'Delete',
                    destructive: true,
                    onConfirm: async () => {
                      await del.mutateAsync([c.name])
                      onClose()
                    },
                  })
                }
              >
                <Trash2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </div>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto">
        {(state === 'error' || cooling || c.status_message || hold) && (
          <Section title="Status">
            {hold && reserve && (
              <Alert>
                <ShieldIcon />
                <AlertTitle>
                  {hold.overridden ? (
                    'Reserve overridden'
                  ) : (
                    <>
                      Reserved · back in <Countdown until={hold.until} endLabel="a moment" />
                    </>
                  )}
                </AlertTitle>
                <AlertDescription>{reserveNote(hold, reserve.limits)}</AlertDescription>
              </Alert>
            )}
            {c.status_message && (
              <Alert variant={state === 'error' ? 'destructive' : 'default'}>
                <AlertTitle>{state === 'error' ? 'Error' : 'Status message'}</AlertTitle>
                <AlertDescription className="break-words">{c.status_message}</AlertDescription>
              </Alert>
            )}
            {cooling && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm">
                    {until ? (
                      <>
                        Usable again in{' '}
                        <span className="font-medium">
                          <Countdown until={until} />
                        </span>
                      </>
                    ) : (
                      'Temporarily unavailable'
                    )}
                  </div>
                  <Button variant="outline" size="sm" disabled={reset.isPending} onClick={() => reset.mutate(c)}>
                    {reset.isPending ? <Spinner /> : <TimerResetIcon />}
                    Reset cooldown
                  </Button>
                </div>
                {(c.cooldowns?.length ?? 0) > 0 && (
                  <ul className="divide-y rounded-lg border">
                    {c.cooldowns!.map((cd, i) => (
                      <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <div className={cd.scope === 'model' ? 'truncate font-mono text-[13px]' : 'font-medium'}>{cooldownLabel(cd)}</div>
                          <div className="text-xs text-muted-foreground">
                            {cd.reason || 'cooldown'}
                            {cd.http_status ? ` · HTTP ${cd.http_status}` : ''}
                            {cd.backoff_level ? ` · backoff ${cd.backoff_level}` : ''}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <Countdown until={new Date(cd.retry_at).getTime()} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Section>
        )}

        <Section title="Traffic" hint="Since CLIProxyAPI started">
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="Requests" value={fmtNumber(total)} />
            <MiniStat label="Failed" value={fmtNumber(c.failed)} />
            <MiniStat label="Success rate" value={total ? fmtPercent(c.success / total) : '—'} />
          </div>
          <div className="space-y-1.5 rounded-lg border p-3">
            <RequestSparkline buckets={c.recent_requests} className="h-16 [&>div]:w-auto [&>div]:flex-1" />
            <div className="flex justify-between text-xs text-muted-foreground tabular">
              <span>{c.recent_requests[0]?.time.split('-')[0]}</span>
              <span>Last 200 minutes</span>
              <span>{c.recent_requests.at(-1)?.time.split('-')[1]}</span>
            </div>
          </div>
        </Section>

        {signals.length > 0 && (
          <Section title="Quota signals" hint={c.quota?.observed_at ? `Observed ${fmtAgo(c.quota.observed_at)}` : undefined}>
            <dl className="divide-y rounded-lg border text-sm">
              {signals.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-4 px-3 py-1.5">
                  <dt className="truncate font-mono text-xs text-muted-foreground">{k}</dt>
                  <dd className="truncate font-mono text-xs tabular">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        <Section title="Settings">
          {fileFields.isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : (
            <EditForm credential={{ ...c, ...fileFields.data }} autoFocus={focusEdit} />
          )}
        </Section>

        <Section title="Details">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Meta label="Auth index" value={<code className="font-mono text-[13px]">{c.auth_index}</code>} copy={c.auth_index} />
            <Meta label="Type" value={c.type} />
            {c.project_id && <Meta label="Project" value={c.project_id} copy={c.project_id} />}
            {c.id_token?.chatgpt_account_id && <Meta label="ChatGPT account" value={c.id_token.chatgpt_account_id} copy={c.id_token.chatgpt_account_id} />}
            {c.account_type && <Meta label="Account type" value={c.account_type === 'api_key' ? 'API key' : 'OAuth'} />}
            <Meta label="Last refresh" value={fmtAgo(c.last_refresh)} title={c.last_refresh} />
            <Meta label="Created" value={c.created_at ? fmtDateTime(c.created_at) : '—'} />
            <Meta label="Updated" value={c.updated_at ? fmtDateTime(c.updated_at) : '—'} />
            <Meta label="File modified" value={c.modtime ? fmtDateTime(c.modtime) : '—'} />
            <Meta label="Size" value={fmtBytes(c.size)} />
            <Meta label="Source" value={c.runtime_only ? 'Runtime only' : c.source === 'file' ? 'File' : 'Memory'} />
          </dl>
        </Section>
      </div>
    </>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b px-4 py-5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tracking-tight tabular">{value}</div>
    </div>
  )
}

function Meta({ label, value, copy, title }: { label: string; value: React.ReactNode; copy?: string; title?: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1" title={title}>
        <span className="truncate">{value}</span>
        {copy && <CopyButton value={copy} className="-my-1 size-6" />}
      </dd>
    </div>
  )
}

// --- Edit form -------------------------------------------------------------------------------

type FormKey = 'priority' | 'weight' | 'prefix' | 'proxy_url' | 'request_retry' | 'note'
type FormValues = Record<FormKey, string>

const toForm = (c: Credential): FormValues => ({
  priority: String(c.priority ?? 0),
  weight: c.weight != null ? String(c.weight) : '',
  prefix: c.prefix ?? '',
  proxy_url: c.proxy_url ?? '',
  request_retry: c.request_retry != null ? String(c.request_retry) : '',
  note: c.note ?? '',
})

const INT = /^-?\d+$/

function validate(v: FormValues): Partial<Record<FormKey, string>> {
  const errors: Partial<Record<FormKey, string>> = {}
  if (v.priority.trim() && !INT.test(v.priority.trim())) errors.priority = 'Must be a whole number'
  const w = v.weight.trim()
  if (w && (!INT.test(w) || Number(w) < 1 || Number(w) > 1_000_000)) errors.weight = '1 to 1,000,000'
  const r = v.request_retry.trim()
  if (r && (!INT.test(r) || Number(r) < 0)) errors.request_retry = 'Whole number ≥ 0'
  return errors
}

/** Builds the PATCH body with only the fields that differ from the saved credential. */
function diff(base: FormValues, v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const changed = (k: FormKey) => base[k].trim() !== v[k].trim() || (k === 'note' && base.note !== v.note)
  if (changed('priority')) out.priority = v.priority.trim() ? Number(v.priority) : 0
  if (changed('weight')) out.weight = v.weight.trim() ? Number(v.weight) : null
  if (changed('request_retry')) out.request_retry = v.request_retry.trim() ? Number(v.request_retry) : null
  if (changed('prefix')) out.prefix = v.prefix.trim()
  if (changed('proxy_url')) out.proxy_url = v.proxy_url.trim()
  if (changed('note')) out.note = v.note
  return out
}

function EditForm({ credential, autoFocus }: { credential: Credential; autoFocus: boolean }) {
  const qc = useQueryClient()
  const firstRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    firstRef.current?.scrollIntoView({ block: 'center' })
    firstRef.current?.focus()
  }, [autoFocus])
  const base = toForm(credential)
  const [values, setValues] = useState(base)
  const [showErrors, setShowErrors] = useState(false)
  const errors = validate(values)
  const changes = diff(base, values)
  const dirty = Object.keys(changes).length > 0

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => mgmt('/credentials/fields', { method: 'PATCH', body: { name: credential.name, ...body } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['mgmt', 'credentials'] })
      setValues((v) => ({
        ...v,
        priority: String(Number(v.priority.trim() || 0)),
        weight: v.weight.trim() && String(Number(v.weight)),
        request_retry: v.request_retry.trim() && String(Number(v.request_retry)),
        prefix: v.prefix.trim(),
        proxy_url: v.proxy_url.trim(),
      }))
      setShowErrors(false)
      toast.success('Credential settings saved')
    },
    onError: (err) => toast.error('Could not save', { description: err.message }),
  })

  const field = (key: FormKey) => ({
    id: `cred-${key}`,
    value: values[key],
    'aria-invalid': showErrors && !!errors[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [key]: e.target.value })),
  })

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        setShowErrors(true)
        if (Object.keys(errors).length || !dirty) return
        save.mutate(changes)
      }}
    >
      <div className="grid grid-cols-3 gap-3">
        <Field data-invalid={showErrors && !!errors.priority}>
          <FieldLabel htmlFor="cred-priority">Priority</FieldLabel>
          <Input ref={firstRef} inputMode="numeric" className="tabular" {...field('priority')} />
          <FieldError>{showErrors && errors.priority}</FieldError>
        </Field>
        <Field data-invalid={showErrors && !!errors.weight}>
          <FieldLabel htmlFor="cred-weight">Weight</FieldLabel>
          <Input inputMode="numeric" placeholder="Default" className="tabular" {...field('weight')} />
          <FieldError>{showErrors && errors.weight}</FieldError>
        </Field>
        <Field data-invalid={showErrors && !!errors.request_retry}>
          <FieldLabel htmlFor="cred-request_retry">Request retry</FieldLabel>
          <Input inputMode="numeric" placeholder="Global" className="tabular" {...field('request_retry')} />
          <FieldError>{showErrors && errors.request_retry}</FieldError>
        </Field>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        Higher priority is tried first. Weight applies to weighted round-robin. Leave weight or retry empty to use the defaults.
      </p>
      <Field>
        <FieldLabel htmlFor="cred-prefix">Model prefix</FieldLabel>
        <Input placeholder="None" className="font-mono placeholder:font-sans" {...field('prefix')} />
        <FieldDescription className="text-xs">
          Exposes this account's models as <code className="font-mono">{values.prefix.trim() || 'prefix'}/model</code>.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="cred-proxy_url">Proxy URL</FieldLabel>
        <Input placeholder="Use global proxy" className="font-mono placeholder:font-sans" {...field('proxy_url')} />
        <FieldDescription className="text-xs">
          e.g. <code className="font-mono">socks5://host:1080</code>, or <code className="font-mono">direct</code> to bypass the global proxy.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="cred-note">Note</FieldLabel>
        <Textarea placeholder="Anything you want to remember about this account" className="min-h-16" {...field('note')} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setValues(base)
            setShowErrors(false)
          }}
        >
          Discard
        </Button>
        <Button type="submit" disabled={!dirty || save.isPending}>
          {save.isPending && <Spinner />}
          Save changes
        </Button>
      </div>
    </form>
  )
}
