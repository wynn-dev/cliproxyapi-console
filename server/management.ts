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

/** An auth file's JSON as CPA has it on disk (tokens included, so never send it to the browser). */
export async function credentialFile(name: string) {
  const res = await management(`/credentials/download?name=${encodeURIComponent(name)}`)
  if (!res?.ok) throw new Error(`could not read ${name}${res ? ` (HTTP ${res.status})` : ''}`)
  return (await res.json()) as Record<string, unknown>
}

/** Sets fields of an auth file. CPA writes the file and reloads the account from it. */
export async function patchCredential(name: string, fields: Record<string, unknown>) {
  const res = await management('/credentials/fields', { method: 'PATCH', body: { name, ...fields } })
  if (!res?.ok) throw new Error(`could not update ${name}${res ? ` (HTTP ${res.status})` : ''}`)
}
