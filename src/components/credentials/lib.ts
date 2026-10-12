import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, download, mgmt } from '@/lib/api'
import { fmtDuration, fmtWhen } from '@/lib/format'
import type { ReserveWindow } from '@/lib/limits'
import { queries } from '@/lib/queries'
import type { Cooldown, Credential, CredentialsList, OrderPlacement, ReserveHold, ReserveStatus } from '@/lib/types'

export type CredState = 'active' | 'cooling' | 'error' | 'disabled'

export const STATE_META: Record<CredState, { label: string; tone: 'good' | 'warn' | 'bad' | 'idle'; rank: number }> = {
  error: { label: 'Error', tone: 'bad', rank: 0 },
  cooling: { label: 'Cooling down', tone: 'warn', rank: 1 },
  active: { label: 'Active', tone: 'good', rank: 2 },
  disabled: { label: 'Disabled', tone: 'idle', rank: 3 },
}

export const accountName = (c: Credential) => c.email || c.label || c.name

const validTime = (s?: string) => {
  if (!s) return null
  const t = new Date(s).getTime()
  return Number.isNaN(t) || t < 946_684_800_000 ? null : t
}

/** When the credential becomes usable again: the next_retry_after hint, else the soonest cooldown expiry. */
export function cooldownUntil(c: Credential): number | null {
  const next = validTime(c.next_retry_after)
  if (next) return next
  const times = (c.cooldowns ?? []).map((cd) => validTime(cd.retry_at)).filter((t): t is number => t != null)
  return times.length ? Math.min(...times) : null
}

export function credState(c: Credential): CredState {
  if (c.disabled || c.status === 'disabled') return 'disabled'
  if (c.status === 'error') return 'error'
  if (c.unavailable || (c.cooldowns?.length ?? 0) > 0) return 'cooling'
  return 'active'
}

/**
 * The account reserve's hold on a credential: holding it back (disabled until `until`), or overridden
 * (enabled by hand). None while the credential and the reserve disagree, until the server's next pass.
 */
export function reserveHold(c: Credential, reserve: ReserveStatus | undefined) {
  const hold = reserve?.accounts[c.name]
  const disabled = credState(c) === 'disabled'
  return hold && (hold.overridden ? !disabled : disabled) ? hold : undefined
}

const WINDOW_NAMES: Record<ReserveWindow, string> = { '5h': '5\u2011hour', weekly: 'weekly' }
/** By limit label, as limitWindows gives them. */
const LIMIT_NAMES: Record<string, string> = { '5h': '5\u2011hour', Weekly: 'weekly' }

/** What the status shows for an account the console holds back. */
export const holdLabel = (hold: ReserveHold) => (hold.reason === 'extra-usage' ? 'Paid extra usage' : 'Reserved')

/** Why the reserve holds an account back, or leaves it on, and until when. */
export function reserveNote(hold: ReserveHold, limits: ReserveStatus['limits']) {
  if (hold.reason === 'extra-usage') {
    const ran = hold.windows.length ? `its ${hold.windows.map((w) => LIMIT_NAMES[w] ?? w).join(' and ')} limit ran out` : 'a limit ran out'
    return `Turned off because ${ran} and it started billing its owner for extra usage. It stays off until ${fmtWhen(hold.until)}; to use it anyway, turn off holding these accounts under Settings → Routing.`
  }
  const share = hold.windows.map((w) => `${limits[w]}% of its ${WINDOW_NAMES[w]} limit`).join(' and ')
  return hold.overridden
    ? `Enabled by hand with ${share} or less left. The account reserve leaves it on until ${fmtWhen(hold.until)}.`
    : `Turned off by the account reserve to keep ${share} free for direct use, until ${fmtWhen(hold.until)}. Enable it to use it anyway.`
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`

/** Why smart account order put an account where it is, e.g. "Used first" and "its weekly limit resets soonest, in 1d 4h". */
export function orderReason(p: OrderPlacement, now: number) {
  if (p.tier === 'held') {
    const names = (p.windows ?? []).map((w) => WINDOW_NAMES[w]).join(' and ')
    return { title: 'Held for new conversations', detail: `Its ${names} limit is close to its reserve. Conversations already on it stay.` }
  }
  const title = p.rank === 1 ? 'Used first' : `${ordinal(p.rank)} in line`
  if (p.tier === 'unknown' || p.weeklyResetsAt === undefined) return { title, detail: 'No current weekly reading, so accounts with one go first.' }
  const left = fmtDuration(Math.max(0, p.weeklyResetsAt - now))
  return { title, detail: p.rank === 1 ? `Its weekly limit resets soonest, in ${left}.` : `Its weekly limit resets in ${left}.` }
}

export function cooldownLabel(cd: Cooldown) {
  return cd.scope === 'model' && cd.model_key ? cd.model_key : 'Whole credential'
}

export const totalRequests = (c: Credential) => c.success + c.failed

/** Re-renders every `ms` while `active`; returns the current time. */
export function useTicker(active: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return now
}

const KEY = ['mgmt', 'credentials']

interface BatchResult {
  ok: string[]
  failed: { name: string; error: string }[]
}

async function settle(names: string[], fn: (name: string) => Promise<unknown>): Promise<BatchResult> {
  const results = await Promise.allSettled(names.map(fn))
  const out: BatchResult = { ok: [], failed: [] }
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.ok.push(names[i])
    else out.failed.push({ name: names[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  })
  return out
}

function reportBatch([verb, infinitive]: [string, string], r: BatchResult, id?: string | number) {
  if (!r.failed.length) {
    toast.success(r.ok.length === 1 ? `${verb} ${r.ok[0]}` : `${verb} ${r.ok.length} credentials`, { id })
  } else if (!r.ok.length) {
    toast.error(`Could not ${infinitive} ${r.failed.length === 1 ? r.failed[0].name : `${r.failed.length} credentials`}`, {
      id,
      description: r.failed[0].error,
    })
  } else {
    toast.warning(`${verb} ${r.ok.length}, ${r.failed.length} failed`, {
      id,
      description: r.failed.map((f) => `${f.name}: ${f.error}`).join('\n'),
    })
  }
}

/**
 * Enables/disables credentials with an optimistic cache update. Accounts held for paid extra usage
 * are not enabled: the console would turn them off again, after they served billed requests.
 */
export function useSetDisabled() {
  const qc = useQueryClient()
  const billing = (names: string[], disabled: boolean) => {
    const held = qc.getQueryData(queries.reserve().queryKey)?.accounts ?? {}
    return disabled ? [] : names.filter((n) => held[n]?.reason === 'extra-usage' && held[n].until > Date.now())
  }
  const sendable = (names: string[], disabled: boolean) => {
    const skip = new Set(billing(names, disabled))
    return names.filter((n) => !skip.has(n))
  }
  return useMutation({
    mutationFn: ({ names, disabled }: { names: string[]; disabled: boolean }) =>
      settle(sendable(names, disabled), (name) => mgmt('/credentials/status', { method: 'PATCH', body: { name, disabled } })),
    onMutate: async ({ names, disabled }) => {
      const blocked = billing(names, disabled)
      if (blocked.length) {
        const one = blocked.length === 1
        toast.warning(one ? `${blocked[0]} is using paid extra usage` : `${blocked.length} accounts are using paid extra usage`, {
          description: one
            ? "It stays off until its limit resets, so it doesn't bill its owner. To use it anyway, turn off holding these accounts under Settings → Routing."
            : "They stay off until their limits reset, so they don't bill their owners. To use them anyway, turn off holding these accounts under Settings → Routing.",
        })
      }
      await qc.cancelQueries({ queryKey: KEY })
      const prev = qc.getQueryData<CredentialsList>(KEY)
      if (prev) {
        const set = new Set(sendable(names, disabled))
        qc.setQueryData<CredentialsList>(KEY, {
          ...prev,
          files: prev.files.map((f) => (set.has(f.name) ? { ...f, disabled, status: disabled ? 'disabled' : 'active' } : f)),
        })
      }
      return { prev }
    },
    onSuccess: (r, { names, disabled }, ctx) => {
      if (r.failed.length && ctx?.prev) qc.setQueryData(KEY, ctx.prev)
      if ((names.length > 1 && r.ok.length) || r.failed.length) reportBatch(disabled ? ['Disabled', 'disable'] : ['Enabled', 'enable'], r)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useRefreshCredentials() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (names: string[]) => settle(names, (name) => mgmt('/credentials/refresh', { body: { name } })),
    onMutate: (names) => ({ toastId: toast.loading(names.length === 1 ? `Refreshing ${names[0]}…` : `Refreshing ${names.length} credentials…`) }),
    onSuccess: (r, _, ctx) => reportBatch(['Refreshed', 'refresh'], r, ctx?.toastId),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useResetCooldown() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (c: Credential) => mgmt('/routing/cooldown/reset', { body: { auth_index: c.auth_index } }),
    onSuccess: (_, c) => toast.success(`Cooldown cleared for ${accountName(c)}`),
    onError: (err) => toast.error('Could not reset cooldown', { description: err.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteCredentials() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (names: string[]): Promise<BatchResult> => {
      const qs = names.map((n) => `name=${encodeURIComponent(n)}`).join('&')
      const res = await mgmt<{ failed?: { name: string; error: string }[] }>(`/credentials?${qs}`, { method: 'DELETE' })
      const failed = res?.failed ?? []
      const bad = new Set(failed.map((f) => f.name))
      return { ok: names.filter((n) => !bad.has(n)), failed }
    },
    onSuccess: (r) => reportBatch(['Deleted', 'delete'], r),
    onError: (err) => toast.error('Could not delete', { description: err.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export async function downloadCredential(name: string) {
  try {
    await download(`/credentials/download?name=${encodeURIComponent(name)}`, name)
  } catch (err) {
    toast.error('Download failed', { description: err instanceof ApiError ? err.message : String(err) })
  }
}
