import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { consoleApi, mgmt } from './api'
import type { ApiKeyGroup, ConsoleStatus, CredentialsList, ReleaseInfo, UsageFacets, UsageSummary, V8Config } from './types'

export const queries = {
  status: () =>
    queryOptions({
      queryKey: ['console', 'status'],
      queryFn: () => consoleApi<ConsoleStatus>('/status'),
      refetchInterval: (q) => {
        const s = q.state.data
        const busy = s?.process.state === 'starting' || s?.process.state === 'stopping'
        const installing = s?.cpa.install && !['done', 'error'].includes(s.cpa.install.phase)
        return busy || installing ? 1000 : 5000
      },
    }),
  latestRelease: () =>
    queryOptions({
      queryKey: ['console', 'release'],
      queryFn: () => consoleApi<ReleaseInfo>('/release/latest'),
      staleTime: 30 * 60_000,
      retry: false,
    }),
  config: () =>
    queryOptions({
      queryKey: ['mgmt', 'config'],
      queryFn: () => mgmt<V8Config>('/config'),
    }),
  credentials: () =>
    queryOptions({
      queryKey: ['mgmt', 'credentials'],
      queryFn: () => mgmt<CredentialsList>('/credentials'),
      refetchInterval: 10_000,
    }),
  providerGroups: (provider: string) =>
    queryOptions({
      queryKey: ['mgmt', 'config', 'api-keys', provider],
      queryFn: async () => (await mgmt<ApiKeyGroup[] | null>(`/config/api-keys/${provider}`).catch(() => null)) ?? [],
    }),
}

/** Writes a config node (PUT replaces, PATCH merges) and refreshes everything derived from config. */
export function useConfigWrite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ path, value, method = 'PUT' }: { path: string; value: unknown; method?: 'PUT' | 'PATCH' | 'DELETE' }) =>
      mgmt(`/config${path}`, { method, body: method === 'DELETE' ? undefined : (value as object) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mgmt'] })
      void qc.invalidateQueries({ queryKey: ['console', 'status'] })
    },
    onError: (err) => toast.error('Could not save', { description: err.message }),
  })
}

export interface UsageParams {
  from: number
  to: number
  model?: string
  provider?: string
  authIndex?: string
  apiKey?: string
  status?: 'ok' | 'failed'
}

export const usageQueries = {
  summary: (p: UsageParams) =>
    queryOptions({
      queryKey: ['console', 'usage', 'summary', p],
      queryFn: () => consoleApi<UsageSummary>('/usage/summary', { query: { ...p, tz: new Date().getTimezoneOffset() } }),
      placeholderData: (prev) => prev,
      refetchInterval: 15_000,
    }),
  facets: (from: number, to: number) =>
    queryOptions({
      queryKey: ['console', 'usage', 'facets', from, to],
      queryFn: () => consoleApi<UsageFacets>('/usage/facets', { query: { from, to } }),
      placeholderData: (prev) => prev,
    }),
}

/** Maps auth_index → a human label, from OAuth credentials and config API keys. */
export function useCredentialLabels() {
  const creds = useQuery({ ...queries.credentials(), refetchInterval: false })
  const config = useQuery(queries.config())
  const map = new Map<string, { label: string; provider: string }>()
  for (const c of creds.data?.files ?? []) {
    map.set(c.auth_index, { label: c.email || c.label || c.name, provider: c.provider })
  }
  for (const [provider, groups] of Object.entries((config.data?.['api-keys'] ?? {}) as Record<string, ApiKeyGroup[]>)) {
    for (const g of groups ?? []) {
      if (g.auth_index) map.set(g.auth_index, { label: g.name || g['base-url'] || provider, provider })
      for (const k of g.keys ?? []) {
        if (k.auth_index) map.set(k.auth_index, { label: `${g.name || provider} · …${k['api-key'].slice(-4)}`, provider })
      }
    }
  }
  return map
}
