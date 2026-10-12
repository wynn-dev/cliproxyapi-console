import { keyMatchesConfig } from './auth.ts'
import { readState } from './state.ts'
import { supervisor } from './supervisor.ts'

/** Calls CPA's management API as the console. Undefined when CPA is not running or the key is stale. */
export async function management(path: string, init: { method?: string; body?: unknown } = {}) {
  const key = readState().managementKey
  // Never send a stale key: CPA bans 127.0.0.1 (i.e. the console) after five failures.
  if (supervisor.state !== 'running' || !supervisor.port || !keyMatchesConfig(key)) return
  return fetch(`http://127.0.0.1:${supervisor.port}/v8/management${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${key}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
}
