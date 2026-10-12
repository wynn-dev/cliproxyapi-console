import { useQuery } from '@tanstack/react-query'
import { StatusDot } from '@/components/common'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtDuration } from '@/lib/format'
import { queries } from '@/lib/queries'
import type { Cooldown, Credential } from '@/lib/types'
import { STATE_META, cooldownLabel, cooldownUntil, credState, holdLabel, reserveHold, reserveNote, useTicker } from './lib'

/** Live "4m 12s" countdown to a timestamp. */
export function Countdown({ until, endLabel = 'retrying' }: { until: number; endLabel?: string }) {
  const now = useTicker(true)
  const left = until - now
  return <span className="tabular">{left > 0 ? fmtDuration(left) : endLabel}</span>
}

export function CooldownTooltipBody({ cooldowns }: { cooldowns: Cooldown[] }) {
  return (
    <ul className="space-y-1.5">
      {cooldowns.map((cd, i) => (
        <li key={i}>
          <div className="font-medium">{cooldownLabel(cd)}</div>
          <div className="opacity-80">
            {cd.reason || 'cooldown'}
            {cd.http_status ? ` · HTTP ${cd.http_status}` : ''}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function CredentialStatus({ credential: c }: { credential: Credential }) {
  const reserve = useQuery(queries.reserve()).data
  const state = credState(c)
  const meta = STATE_META[state]
  const hold = reserveHold(c, reserve)
  const reserved = !!hold && !hold.overridden
  const until = state === 'cooling' ? cooldownUntil(c) : reserved ? hold.until : null
  const cooldowns = c.cooldowns ?? []
  const onlyModels = cooldowns.length > 0 && cooldowns.every((cd) => cd.scope === 'model')

  const label = (
    <span className="inline-flex items-center gap-2">
      <StatusDot tone={meta.tone} />
      <span>
        {reserved ? holdLabel(hold) : state === 'cooling' && onlyModels ? `${cooldowns.length} model${cooldowns.length > 1 ? 's' : ''} cooling` : meta.label}
      </span>
      {until && (
        <span className="text-xs text-muted-foreground">
          <Countdown until={until} endLabel={reserved ? 'resuming' : undefined} />
        </span>
      )}
    </span>
  )

  const tip =
    reserved && reserve ? (
      <span className="block max-w-xs whitespace-normal">{reserveNote(hold, reserve.limits)}</span>
    ) : state === 'error' && c.status_message ? (
      <span className="block max-w-xs whitespace-normal">{c.status_message}</span>
    ) : state === 'cooling' && cooldowns.length ? (
      <CooldownTooltipBody cooldowns={cooldowns} />
    ) : null

  if (!tip) return label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{label}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}
