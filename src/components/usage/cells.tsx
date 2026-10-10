import { CircleCheckIcon, CircleXIcon } from 'lucide-react'
import { maskSecret } from '@/lib/format'
import { providerLabel } from '@/lib/providers'
import { cn } from '@/lib/utils'

export type CredentialLabels = Map<string, { label: string; provider: string }>

/** Human label for an auth_index; falls back to the raw index for removed credentials. */
export function CredentialName({
  authIndex,
  labels,
  provider,
  hideProvider,
  className,
}: {
  authIndex: string
  labels: CredentialLabels
  provider?: string
  hideProvider?: boolean
  className?: string
}) {
  if (!authIndex) return <span className="text-muted-foreground">—</span>
  const l = labels.get(authIndex)
  const p = l?.provider ?? provider
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5', className)} title={authIndex}>
      {l ? <span className="truncate">{l.label}</span> : <span className="truncate font-mono text-[13px] text-muted-foreground">{authIndex}</span>}
      {p && !hideProvider && <span className="shrink-0 text-xs text-muted-foreground">{providerLabel(p)}</span>}
    </span>
  )
}

export function ClientKey({ value }: { value: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return <code className="font-mono text-[13px]">{maskSecret(value)}</code>
}

export function StatusLabel({ failed, code }: { failed: boolean; code: number }) {
  return failed ? (
    <span className="inline-flex items-center gap-1.5 font-medium text-critical">
      <CircleXIcon className="size-3.5" />
      {code || 'Failed'}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <CircleCheckIcon className="size-3.5 text-success" />
      {code || 'OK'}
    </span>
  )
}

export function ModelName({ model, alias, className }: { model: string; alias: string; className?: string }) {
  const routed = alias && alias !== model
  return (
    <span className={cn('block truncate font-mono text-[13px]', className)} title={routed ? `Requested ${alias}, routed to ${model}` : model}>
      {routed && <span className="text-muted-foreground">{alias} → </span>}
      {model || '—'}
    </span>
  )
}
