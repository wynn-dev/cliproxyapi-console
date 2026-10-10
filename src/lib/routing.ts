import type { Credential, V8Config } from './types'

/**
 * Upstream prompt caches belong to one account, so with several accounts on the same provider every
 * switch re-sends the conversation uncached. Fill first keeps traffic on one account until it runs
 * out; session affinity keeps a conversation where it started when an earlier account recovers.
 */
export const SUBSCRIPTION_ROUTING = { strategy: 'fill-first', affinity: true } as const

/** Whether some provider has more than one enabled account to route between. */
export function hasAccountPool(credentials: Credential[] | undefined) {
  const counts = new Map<string, number>()
  for (const c of credentials ?? []) {
    if (c.disabled) continue
    counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1)
  }
  return [...counts.values()].some((n) => n > 1)
}

export function routingOf(config: V8Config | undefined) {
  return {
    strategy: (config?.routing?.strategy as string | undefined) || 'round-robin',
    affinity: config?.routing?.['session-affinity'] === true,
  }
}

export const keepsCachesWarm = (r: { strategy: string; affinity: boolean }) =>
  r.strategy === SUBSCRIPTION_ROUTING.strategy && r.affinity === SUBSCRIPTION_ROUTING.affinity
