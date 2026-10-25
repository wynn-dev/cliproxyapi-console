import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { consoleApi, mgmt } from '@/lib/api'
import { API_KEY_PROVIDERS } from '@/lib/providers'
import type { ApiKeyEntry, ApiKeyGroup, ApiKeysStatus, ApiKeyUsage, V8Config } from '@/lib/types'

export type ProviderId = (typeof API_KEY_PROVIDERS)[number]['id']
export type ProviderMeta = (typeof API_KEY_PROVIDERS)[number]

export const PROVIDER_INFO: Record<ProviderId, { description: string; baseUrlRequired?: boolean }> = {
  gemini: { description: 'Google AI Studio (Gemini API) keys.' },
  claude: { description: 'Anthropic API keys, or any Claude-compatible endpoint.' },
  codex: { description: 'OpenAI API keys for Codex and Responses API models.', baseUrlRequired: true },
  'openai-compatibility': { description: 'Any OpenAI-compatible endpoint, such as OpenRouter or a local server.', baseUrlRequired: true },
  vertex: { description: 'Vertex-style endpoints that authenticate with a plain API key.' },
  xai: { description: 'xAI Grok API keys.', baseUrlRequired: true },
  interactions: { description: 'Gemini Interactions API keys.' },
  meta: { description: 'Meta Llama API keys.' },
}

export const isCompat = (provider: string) => provider === 'openai-compatibility'

export const apiKeyUsageQuery = () =>
  queryOptions({
    queryKey: ['mgmt', 'observability', 'usage', 'api-keys'],
    queryFn: () => mgmt<ApiKeyUsage>('/observability/usage/api-keys'),
    refetchInterval: 10_000,
  })

/** Providers whose subscription accounts an API key group can stand behind as a fallback. */
export const FALLBACK_PROVIDERS = new Set(['claude', 'codex'])

/** Spend, credits, rate limits and fallback state of every API key, by auth_index. */
export const apiKeysQuery = () =>
  queryOptions({
    queryKey: ['console', 'api-keys'],
    queryFn: () => consoleApi<ApiKeysStatus>('/api-keys'),
    refetchInterval: 15_000,
  })

/** A group is a fallback when the console has its keys marked so. */
export const isFallbackGroup = (g: ApiKeyGroup | undefined, status: ApiKeysStatus | undefined) =>
  !!g && (g.keys ?? []).some((k) => k.auth_index && status?.keys[k.auth_index]?.fallback)

/** CPA's pattern for a config API key that serves no model; the console sets it on a fallback standing by. */
export const ALL_MODELS = '*'

export function useSetFallback(provider: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ keys, on }: { keys: string[]; on: boolean }) =>
      consoleApi<ApiKeysStatus>('/api-keys/fallback', { method: 'PUT', body: { provider, keys, on } }),
    onSuccess: (data) => {
      qc.setQueryData(['console', 'api-keys'], data)
      void qc.invalidateQueries({ queryKey: ['mgmt', 'config'] })
    },
  })
}

export function useSetBalance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, balance }: { key: string; balance: number | null }) =>
      consoleApi<ApiKeysStatus>('/api-keys/balance', { method: 'PUT', body: { key, balance } }),
    onSuccess: (data) => qc.setQueryData(['console', 'api-keys'], data),
  })
}

export function groupsOf(config: V8Config | undefined, provider: string): ApiKeyGroup[] {
  const groups = config?.['api-keys']?.[provider]
  return Array.isArray(groups) ? (groups as ApiKeyGroup[]) : []
}

export function hostOf(url?: string | null) {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function groupTitle(g: ApiKeyGroup, meta: ProviderMeta, index: number) {
  return g.name || hostOf(g['base-url']) || hostOf(meta.defaultBaseUrl) || `${meta.name} group ${index + 1}`
}

/** CPA keys usage by `<base_url>|<api_key>` under the provider (or compat group name); match on the api key. */
export function findKeyUsage(usage: ApiKeyUsage | undefined, provider: string, group: ApiKeyGroup, apiKey: string) {
  if (!usage || !apiKey) return undefined
  const preferred = [provider, group.name?.toLowerCase()].filter(Boolean) as string[]
  const buckets = [...preferred.map((p) => usage[p]).filter(Boolean), ...Object.values(usage)]
  const base = group['base-url'] ?? ''
  for (const bucket of buckets) {
    if (bucket[`${base}|${apiKey}`]) return bucket[`${base}|${apiKey}`]
  }
  for (const bucket of buckets) {
    for (const [k, v] of Object.entries(bucket)) if (k.endsWith(`|${apiKey}`)) return v
  }
  return undefined
}

function withoutAuthIndex<T extends { auth_index?: string }>(o: T): T {
  const copy = { ...o }
  delete copy.auth_index
  return copy
}

export function cleanGroup(g: ApiKeyGroup): ApiKeyGroup {
  return { ...withoutAuthIndex(g), keys: (g.keys ?? []).map(withoutAuthIndex) }
}

/** Replaces the whole `api-keys.<provider>` list (lists can't be patched by index). */
export function useSaveGroups(provider: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (groups: ApiKeyGroup[]) =>
      groups.length
        ? mgmt(`/config/api-keys/${provider}`, { method: 'PUT', body: groups.map(cleanGroup) })
        : mgmt(`/config/api-keys/${provider}`, { method: 'DELETE' }),
    onSuccess: (_, groups) => {
      qc.setQueryData<V8Config>(['mgmt', 'config'], (c) => c && { ...c, 'api-keys': { ...c['api-keys'], [provider]: groups } })
      void qc.invalidateQueries({ queryKey: ['mgmt'] })
    },
  })
}

// --- Editor drafts ----------------------------------------------------------------------------

let seq = 0
export const rowId = () => `r${++seq}`

export interface PairRow {
  id: string
  a: string
  b: string
  extra?: Record<string, unknown>
}

export interface KeyDraft {
  id: string
  apiKey: string
  weight: string
  proxyUrl: string
  extra: Record<string, unknown>
}

export interface GroupDraft {
  name: string
  baseUrl: string
  prefix: string
  priority: string
  proxyUrl: string
  headers: PairRow[]
  models: PairRow[]
  excluded: string[]
  disableCooling: boolean
  requestRetry: string
  disabled: boolean
  /** Only takes traffic while no subscription account can; the console then owns priority and the ALL_MODELS exclusion. */
  fallback: boolean
  keys: KeyDraft[]
}

const MANAGED = new Set([
  'name',
  'disabled',
  'base-url',
  'prefix',
  'priority',
  'proxy-url',
  'headers',
  'models',
  'excluded-models',
  'disable-cooling',
  'request-retry',
  'keys',
  'auth_index',
])

const str = (v: unknown) => (v == null ? '' : String(v))

export function keyToDraft(k?: ApiKeyEntry): KeyDraft {
  const { 'api-key': apiKey, weight, 'proxy-url': proxyUrl, ...extra } = withoutAuthIndex(k ?? { 'api-key': '' })
  return { id: rowId(), apiKey: apiKey ?? '', weight: str(weight), proxyUrl: str(proxyUrl), extra }
}

export function toDraft(g: ApiKeyGroup | undefined, provider: string, fallback = false): GroupDraft {
  const meta = API_KEY_PROVIDERS.find((p) => p.id === provider)
  return {
    name: g?.name ?? '',
    baseUrl: g?.['base-url'] ?? (g ? '' : PROVIDER_INFO[provider as ProviderId]?.baseUrlRequired ? (meta?.defaultBaseUrl ?? '') : ''),
    prefix: str(g?.prefix),
    priority: str(g?.priority),
    proxyUrl: str(g?.['proxy-url']),
    headers: Object.entries(g?.headers ?? {}).map(([a, b]) => ({ id: rowId(), a, b })),
    models: (g?.models ?? []).map(({ name, alias, ...extra }) => ({ id: rowId(), a: name, b: alias, extra })),
    excluded: (g?.['excluded-models'] ?? []).filter((m) => !fallback || m.trim() !== ALL_MODELS),
    disableCooling: g?.['disable-cooling'] === true,
    requestRetry: str(g?.['request-retry']),
    disabled: g?.disabled === true,
    fallback,
    keys: g ? (g.keys ?? []).map(keyToDraft) : [keyToDraft()],
  }
}

const isInt = (s: string) => /^-?\d+$/.test(s.trim())

export function validateDraft(d: GroupDraft, provider: string): string | null {
  const compat = isCompat(provider)
  if (compat && !d.name.trim()) return 'Name is required.'
  if (PROVIDER_INFO[provider as ProviderId]?.baseUrlRequired && !d.baseUrl.trim()) return 'Base URL is required.'
  if (d.baseUrl.trim() && !/^https?:\/\/\S+$/.test(d.baseUrl.trim())) return 'Base URL must start with http:// or https://.'
  if (!d.fallback && d.priority.trim() && !isInt(d.priority)) return 'Priority must be a whole number.'
  if (d.requestRetry.trim() && !(isInt(d.requestRetry) && Number(d.requestRetry) >= 0)) return 'Request retry must be 0 or more.'
  if (d.models.some((m) => m.b.trim() && !m.a.trim())) return 'Each model alias needs an upstream model name.'
  const keys = d.keys.filter((k) => k.apiKey.trim())
  if (!compat && keys.length === 0) return 'Add at least one API key.'
  if (new Set(keys.map((k) => k.apiKey.trim())).size !== keys.length) return 'The same API key is listed twice.'
  for (const k of keys) {
    if (k.weight.trim() && !(isInt(k.weight) && Number(k.weight) >= 1 && Number(k.weight) <= 1_000_000)) {
      return 'Key weight must be a whole number between 1 and 1,000,000.'
    }
  }
  return null
}

export function draftToKey(k: KeyDraft): ApiKeyEntry {
  const out: ApiKeyEntry = { 'api-key': k.apiKey.trim() }
  if (k.weight.trim()) out.weight = Number(k.weight)
  if (k.proxyUrl.trim()) out['proxy-url'] = k.proxyUrl.trim()
  return { ...out, ...k.extra }
}

/** Builds the saved group: only non-empty fields, unknown fields from the original kept as-is. */
export function fromDraft(d: GroupDraft, provider: string, original?: ApiKeyGroup): ApiKeyGroup {
  const compat = isCompat(provider)
  const g: Record<string, unknown> = {}
  const set = (k: string, v: unknown) => {
    if (v === '' || v == null || (Array.isArray(v) && v.length === 0)) return
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return
    g[k] = v
  }
  set('name', d.name.trim())
  if (compat && d.disabled) g.disabled = true
  set('base-url', d.baseUrl.trim())
  set('prefix', d.prefix.trim())
  if (d.fallback) {
    // The console keeps it below every account; a new group starts below the default 0, standing by.
    g.priority = original ? (original.priority ?? null) : -1
    if (g.priority == null) delete g.priority
  } else set('priority', d.priority.trim() ? Number(d.priority) : null)
  if (!compat) set('proxy-url', d.proxyUrl.trim())
  set('headers', Object.fromEntries(d.headers.filter((h) => h.a.trim()).map((h) => [h.a.trim(), h.b])))
  const models = d.models
    .filter((m) => m.a.trim())
    .map((m) => ({ name: m.a.trim(), ...(m.b.trim() && { alias: m.b.trim() }), ...m.extra }))
  set('models', models)
  // A fallback keeps whether the console has it standing by; one that no longer is goes back in rotation.
  const standingBy = d.fallback && (!original || (original['excluded-models'] ?? []).some((m) => m.trim() === ALL_MODELS))
  if (!compat) set('excluded-models', standingBy ? [...d.excluded, ALL_MODELS] : d.excluded)
  if (d.disableCooling) g['disable-cooling'] = true
  else if (original?.['disable-cooling'] === false) g['disable-cooling'] = false
  set('request-retry', d.requestRetry.trim() ? Number(d.requestRetry) : null)
  for (const [k, v] of Object.entries(original ?? {})) if (!MANAGED.has(k)) g[k] = v
  g.keys = d.keys.filter((k) => k.apiKey.trim()).map(draftToKey)
  return g as ApiKeyGroup
}
