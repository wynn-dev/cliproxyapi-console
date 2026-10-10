import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, download, mgmt } from '@/lib/api'
import type { Cooldown, Credential, CredentialsList } from '@/lib/types'

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

/** Enables/disables credentials with an optimistic cache update. */
export function useSetDisabled() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ names, disabled }: { names: string[]; disabled: boolean }) =>
      settle(names, (name) => mgmt('/credentials/status', { method: 'PATCH', body: { name, disabled } })),
    onMutate: async ({ names, disabled }) => {
      await qc.cancelQueries({ queryKey: KEY })
      const prev = qc.getQueryData<CredentialsList>(KEY)
      if (prev) {
        const set = new Set(names)
        qc.setQueryData<CredentialsList>(KEY, {
          ...prev,
          files: prev.files.map((f) => (set.has(f.name) ? { ...f, disabled, status: disabled ? 'disabled' : 'active' } : f)),
        })
      }
      return { prev }
    },
    onSuccess: (r, { names, disabled }, ctx) => {
      if (r.failed.length && ctx?.prev) qc.setQueryData(KEY, ctx.prev)
      if (names.length > 1 || r.failed.length) reportBatch(disabled ? ['Disabled', 'disable'] : ['Enabled', 'enable'], r)
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
