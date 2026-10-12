import { type PoolAccount, availability } from './availability.ts'
import { excludedModels, fableAdded } from './fable.ts'
import type { ListedCredential } from './limits.ts'
import { credentialFile, management, patchCredential } from './management.ts'
import { orderStatus } from './order.ts'
import { removeRow, rows, saveRow, setDisabled } from './reserve.ts'
import { db } from './usage.ts'

/**
 * Accounts that need a new sign-in. CPA cools an account down for 30 minutes after a 401 or 403
 * and then tries it again, forever, so a revoked account only ever looks like it is cooling down.
 *
 * The console disables an account (tracked like the reserve, reason `signed-out`) only when CPA
 * itself reports that its tokens are dead: refreshing them failed with invalid_grant or a 401 from
 * the token endpoint, or invalid_grant has persisted for over an hour. Even then it only warns when
 * that would leave the provider with no available account, or when half or more of the provider's
 * accounts trip within the same half hour: that looks like an incident at the provider, not a
 * revoked account.
 *
 * 401s and 403s in the console's own usage records only ever produce a warning: they also come from
 * upstream incidents, and 403s from suspended or region-blocked accounts that a new sign-in won't fix.
 *
 * Signing in again through the console enables the account again, with its fields kept, when the
 * login rewrote the account's own file. A hold also ends when CPA refreshes the account's token
 * after it began.
 */

const PROVIDERS = new Set(['claude', 'codex'])
/** Usage-record failures must span this long, and the last must be this recent, to warn. */
const MIN_SPAN = 5 * 60_000
const RECENT = 35 * 60_000
const LOOKBACK = 24 * 3_600_000
/** How long CPA may keep retrying a refresh token rejected with invalid_grant before it counts as dead. */
const INVALID_GRANT_MS = 3_600_000
/** How long CPA's bare `unauthorized` state must last. */
const UNAUTHORIZED_MS = 2 * 60_000
/** The usage records only change every few seconds and only feed a warning. */
const FAILURES_EVERY_MS = 30_000

/**
 * Failures before `since` no longer count: the account was signed in again or enabled by hand. The
 * row `*` is the first run of this check, so records from before it never count.
 */
const firstRun = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sign_in_floor'").get()
db.exec('CREATE TABLE IF NOT EXISTS sign_in_floor (name TEXT PRIMARY KEY, since INTEGER NOT NULL)')
const setFloor = db.prepare('INSERT INTO sign_in_floor (name, since) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET since = excluded.since')
if (firstRun) setFloor.run('*', Date.now())
const floors = () =>
  new Map((db.prepare('SELECT name, since FROM sign_in_floor').all() as { name: string; since: number }[]).map((r) => [r.name, r.since]))

/** Fields a user sets on an auth file, which a new sign-in must keep. */
const KEPT_FIELDS = ['priority', 'note', 'excluded_models', 'weight', 'prefix', 'proxy_url', 'request_retry', 'websockets', 'headers']

/** CPA's Cloudflare challenge patterns (conductor_cooldown.go): temporary, never a sign-in problem. */
const CLOUDFLARE = /challenge-platform|cf-mitigated|cloudflare challenge|just a moment[\s\S]*cloudflare|cloudflare[\s\S]*just a moment/i

/** Since when each account has shown a CPA state that only counts once it persists, by state. */
const persisting = new Map<string, { state: string; since: number }>()

/** How long `state` has persisted on the account (0 the first time it is seen). */
function persisted(name: string, state: string | undefined, now: number) {
  const seen = persisting.get(name)
  if (!state) persisting.delete(name)
  else if (seen?.state !== state) persisting.set(name, { state, since: now })
  return state ? now - persisting.get(name)!.since : 0
}

/** CPA's own verdict that only a new sign-in helps (conductor_refresh.go). */
function terminal(f: ListedCredential, now: number) {
  const msg = (f.status_message ?? '').trim().toLowerCase()
  if (msg === 'unauthorized (refresh token invalid)' || msg === 'disabled (invalid grant)') {
    persisted(f.name, undefined, now)
    return 'The provider rejected its refresh token.'
  }
  // A 401 from the token endpoint itself: CPA schedules no retry. A request-level 401 can look
  // the same for a moment, so it has to last.
  const unauthorized = msg === 'unauthorized' && f.status === 'error' && f.unavailable && !f.next_retry_after
  const state = unauthorized ? 'unauthorized' : msg === 'invalid grant (retrying)' ? 'invalid-grant' : undefined
  const lasted = persisted(f.name, state, now)
  if (state === 'unauthorized' && lasted >= UNAUTHORIZED_MS) return 'The provider rejected its refresh token.'
  if (state === 'invalid-grant' && lasted >= INVALID_GRANT_MS) return 'The provider has rejected its refresh token for over an hour.'
}

/** The provider's message from a failed request's stored error body. */
function errorMessage(status: number, body: string) {
  let msg = body.trim()
  try {
    const j = JSON.parse(msg) as { error?: { message?: string } | string; message?: string }
    msg = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message ?? msg
  } catch {
    // Not JSON: keep the raw text.
  }
  return `HTTP ${status}${msg ? `: ${msg.slice(0, 300)}` : ''}`
}

type Failure = { auth_index: string; ts: number; status_code: number; error: string }
let cached: { at: number; failures: Map<string, Failure[]>; lastOk: Map<string, number> } | undefined

/** 401 and 403 failures per auth index since its last success, from the console's own usage records. */
function authFailures(now: number) {
  if (cached && now - cached.at < FAILURES_EVERY_MS) return cached
  const from = now - LOOKBACK
  const lastOk = new Map(
    (db.prepare('SELECT auth_index, MAX(ts) AS ts FROM requests WHERE ts > ? AND failed = 0 GROUP BY auth_index').all(from) as { auth_index: string; ts: number }[]).map(
      (r) => [r.auth_index, r.ts],
    ),
  )
  const failures = db
    .prepare("SELECT auth_index, ts, status_code, error FROM requests WHERE ts > ? AND failed = 1 AND status_code IN (401, 403) AND auth_index != '' ORDER BY ts")
    .all(from) as Failure[]
  const out = new Map<string, Failure[]>()
  for (const r of failures) {
    if (r.ts <= (lastOk.get(r.auth_index) ?? 0) || CLOUDFLARE.test(r.error)) continue
    out.set(r.auth_index, [...(out.get(r.auth_index) ?? []), r])
  }
  cached = { at: now, failures: out, lastOk }
  return cached
}

/** A pattern of 401s and 403s that suggests the account needs a new sign-in, for a warning only. */
function suspect(f: ListedCredential, failures: Failure[], since: number, now: number) {
  // A refresh after the last 401 (not the one CPA makes while retrying it) means those 401s were
  // about an older token.
  const refreshed = Date.parse(f.last_refresh ?? '') || 0
  const last401 = Math.max(0, ...failures.filter((r) => r.status_code === 401).map((r) => r.ts))
  const stale = refreshed > last401 + 10_000 ? refreshed : 0
  const recent = failures.filter((r) => r.ts > since && (r.status_code !== 401 || r.ts >= stale))
  const last = recent.at(-1)
  if (!last || recent.length < 2 || last.ts - recent[0].ts < MIN_SPAN || now - last.ts > RECENT) return
  return { unauthorized: recent.some((r) => r.status_code === 401), detail: errorMessage(last.status_code, last.error) }
}

export interface SignInWarning {
  /** `signed-out`: likely needs a new sign-in. `problem`: 403s, which a new sign-in may not fix. */
  kind: 'signed-out' | 'problem'
  detail: string
  /** Why the console did not turn it off, when CPA itself says its tokens are dead. */
  kept?: string
}

/**
 * Accounts that look signed out but stay in rotation, by file name, with when they last tripped.
 * CPA forgets its own verdict whenever the file is written (the order changing a priority, say), so
 * a warning stays until the account succeeds again or has not tripped for half an hour.
 */
const warnings = new Map<string, { warning: SignInWarning; at: number }>()
export const signInWarnings = () => Object.fromEntries([...warnings].map(([name, w]) => [name, w.warning]))

/** When each account first tripped a check, recently: many at once looks like a provider incident. */
const trippedAt = new Map<string, number>()

/** Accounts whose last update failed, so a failure that repeats every tick is logged once. */
const failing = new Set<string>()

/** Takes accounts that need a new sign-in out of rotation. `files` is CPA's full credential list. */
export async function applySignIn(files: ListedCredential[], now = Date.now()) {
  const tracked = rows()
  const floor = floors()
  const { failures, lastOk } = authFailures(now)
  const next: Record<string, SignInWarning> = {}
  const listed = new Map(files.map((f) => [f.name, f]))
  const dead: { f: ListedCredential; detail: string }[] = []
  for (const [name, at] of trippedAt) if (now - at > RECENT) trippedAt.delete(name)

  for (const f of files) {
    if (!f.provider || !PROVIDERS.has(f.provider)) continue
    const row = tracked.get(f.name)
    try {
      if (row?.reason === 'signed-out') {
        if (row.pending) {
          if (!f.disabled) await setDisabled(f.name, true, ': it needs a new sign-in', 'Sign-in check')
          saveRow({ ...row, pending: false })
        } else if (!f.disabled) {
          // Enabled by hand: give it a fresh start.
          removeRow(f.name)
          setFloor.run(f.name, now)
          console.log(`Sign-in check: ${f.name} was enabled by hand`)
        } else if ((await refreshedSince(f, row.heldAt)) && !terminal(f, now)) {
          // CPA refreshed its token since the hold (signed in some other way, or the provider recovered).
          await setDisabled(f.name, false, ': its token was refreshed since', 'Sign-in check')
          removeRow(f.name)
          setFloor.run(f.name, now)
        }
        continue
      }
      failing.delete(f.name)
    } catch (err) {
      if (!failing.has(f.name)) console.error(`Sign-in check: ${(err as Error).message}`)
      failing.add(f.name)
      continue
    }
    const since = Math.max(floor.get(f.name) ?? 0, floor.get('*') ?? 0)
    const t = terminal(f, now)
    const sus = f.disabled ? undefined : suspect(f, failures.get(f.auth_index ?? '') ?? [], since, now)
    if (!t && !sus) {
      trippedAt.delete(f.name)
      continue
    }
    trippedAt.set(f.name, trippedAt.get(f.name) ?? now)
    // Disabled by the user: theirs to keep off, so only a warning. Held by the console: it can take over.
    if (t && (!f.disabled || row)) dead.push({ f, detail: t })
    else if (t) next[f.name] = { kind: 'signed-out', detail: t }
    else next[f.name] = { kind: sus!.unauthorized ? 'signed-out' : 'problem', detail: sus!.detail }
  }

  const holding = new Set<string>()
  for (const { f, detail } of dead) {
    const kept = keepReason(f, files, tracked, holding, now)
    if (kept) {
      next[f.name] = { kind: 'signed-out', detail, kept }
      continue
    }
    holding.add(f.name)
    try {
      // Saved first, so a disable CPA applies but reports as failed is still ours.
      const held = { name: f.name, until: 0, windows: [], overridden: false, reason: 'signed-out' as const, detail, heldAt: now }
      saveRow({ ...held, pending: !f.disabled })
      if (!f.disabled) await setDisabled(f.name, true, `: it needs a new sign-in (${detail})`, 'Sign-in check')
      saveRow({ ...held, pending: false })
    } catch (err) {
      if (!failing.has(f.name)) console.error(`Sign-in check: ${(err as Error).message}`)
      failing.add(f.name)
    }
  }
  for (const [name, w] of warnings) {
    const f = listed.get(name)
    const held = rows().get(name)?.reason === 'signed-out'
    if (!f || held || now - w.at > RECENT || (lastOk.get(f.auth_index ?? '') ?? 0) > w.at) warnings.delete(name)
  }
  for (const [name, warning] of Object.entries(next)) warnings.set(name, { warning, at: now })
}

/**
 * Whether CPA refreshed the account's token after `since`. The list's last_refresh is lost when CPA
 * reloads the file, so the file's own `last_refresh` is read too, once the file changed.
 */
async function refreshedSince(f: ListedCredential, since: number | undefined) {
  if (since === undefined) return false
  if (Date.parse(f.last_refresh ?? '') > since + 1_000) return true
  const modtime = Date.parse(f.modtime ?? '')
  // Read once per change of the file.
  if (!(modtime > since + 1_000) || checkedAt.get(f.name) === modtime) return false
  checkedAt.set(f.name, modtime)
  return Date.parse(String((await credentialFile(f.name)).last_refresh ?? '')) > since + 1_000
}
const checkedAt = new Map<string, number>()

/** Why a dead account stays on: taking it out would empty the provider, or too many trip at once. */
function keepReason(f: ListedCredential, files: ListedCredential[], tracked: ReturnType<typeof rows>, holding: Set<string>, now: number) {
  const pool = files.filter((x) => x.provider === f.provider)
  const tripped = pool.filter((x) => trippedAt.has(x.name)).length
  if (tripped >= 2 && tripped * 2 >= pool.length) return `${tripped} of ${pool.length} accounts tripped within half an hour, which looks like a problem at the provider.`
  const available = pool.filter((x) => {
    if (x.name === f.name || holding.has(x.name)) return false
    const r = tracked.get(x.name)
    return availability(x as PoolAccount, r && !r.overridden ? r : undefined, now).state === 'available'
  })
  if (!available.length) return 'Turning it off would leave no account available.'
}

// --- Signing in again --------------------------------------------------------------------------

/**
 * A sign-in only completes on its own when it rewrote the account's own file with a new access
 * token. Another file, even with the same email or organization, can be another seat of a shared
 * workspace, so the console changes nothing then and says what happened.
 */
interface Outcome {
  name: string
  /** The login rewrote this account's file with a new token. */
  signedIn: boolean
  /** Fields the console wrote back because the new file lacked them. */
  restored: string[]
  /** The console put it back in rotation (it was held as signed out). */
  enabled: boolean
  /** Files of the provider the login wrote instead. */
  other: string[]
}

export interface SignInResult {
  status: 'wait' | 'done' | 'error'
  error?: string
  account?: Outcome
}

interface Session {
  name: string
  provider: string
  startedAt: number
  fields: Record<string, unknown>
  /** The old access token: the file only counts as signed in again once it holds another one. */
  token: string
  /** The provider's files before the login. */
  before: Set<string>
  result: SignInResult
}

const sessions = new Map<string, Session>()
const POLL_MS = 2_000
/** CPA keeps an OAuth session for 30 minutes. */
const SESSION_MS = 31 * 60_000

async function listCredentials() {
  const res = await management('/credentials')
  if (!res?.ok) throw new Error(`could not list credentials${res ? ` (HTTP ${res.status})` : ''}`)
  return ((await res.json()) as { files?: ListedCredential[] }).files ?? []
}

/** Follows "Sign in again" for `name`: a sign-in started with CPA's OAuth flow. */
export async function watchSignIn(state: string, provider: string, name: string) {
  const files = await listCredentials()
  if (!files.some((f) => f.name === name && f.provider === provider)) throw new Error(`${name} is not a ${provider} account`)
  const file = await credentialFile(name)
  const fields = Object.fromEntries(KEPT_FIELDS.filter((k) => k in file).map((k) => [k, file[k]]))
  if ('excluded-models' in file && !('excluded_models' in fields)) fields.excluded_models = file['excluded-models']
  const before = new Set(files.filter((f) => f.provider === provider).map((f) => f.name))
  const session: Session = { name, provider, startedAt: Date.now(), fields, token: String(file.access_token ?? ''), before, result: { status: 'wait' } }
  sessions.set(state, session)
  void poll(state, session)
  return session.result
}

export const signInResult = (state: string): SignInResult | undefined => sessions.get(state)?.result

async function poll(state: string, s: Session) {
  while (Date.now() - s.startedAt < SESSION_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    try {
      const res = await management(`/oauth/status?state=${encodeURIComponent(state)}`)
      const body = res?.ok ? ((await res.json()) as { status?: string; error?: string }) : undefined
      if (body?.status === 'wait' || !body) continue
      s.result = body.status === 'ok' ? { status: 'done', account: await finish(s) } : { status: 'error', error: body.error || 'Sign-in failed' }
    } catch (err) {
      s.result = { status: 'error', error: (err as Error).message }
    }
    break
  }
  if (s.result.status === 'wait') s.result = { status: 'error', error: 'Sign-in timed out' }
  // Kept a while so the browser can show the outcome.
  setTimeout(() => sessions.delete(state), 10 * 60_000).unref()
}

/** Puts the account back in rotation if the login rewrote its own file; otherwise only reports. */
async function finish(s: Session): Promise<Outcome> {
  const files = await listCredentials()
  const since = s.startedAt - 1_000
  const other = files.filter((f) => f.provider === s.provider && f.name !== s.name && (!s.before.has(f.name) || Date.parse(f.modtime ?? '') >= since)).map((f) => f.name)
  const f = files.find((x) => x.name === s.name)
  const current = f && Date.parse(f.modtime ?? '') >= since ? await credentialFile(f.name) : undefined
  if (!f || !current || current.access_token === s.token) {
    console.log(`Sign-in check: the sign-in for ${s.name} did not rewrite its file${other.length ? `; it wrote ${other.join(', ')}` : ''}`)
    return { name: s.name, signedIn: false, restored: [], enabled: false, other }
  }

  // CPA keeps the old file's fields through a new sign-in; this only fills in what it lost, never
  // what changed during the login.
  const ordered = orderStatus().active
  const restored: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s.fields)) {
    // Smart order owns the file's priority.
    if (k === 'priority' && ordered) continue
    if (k === 'excluded_models') {
      // Only the user's own entries; what the console excludes now (Fable) stays as it is.
      const mine = (list: string[]) => list.filter((m) => !fableAdded(s.name).some((a) => a.toLowerCase() === m.toLowerCase()))
      const have = excludedModels(current)
      const want = mine(excludedModels({ excluded_models: v }))
      if (want.length && !mine(have).length) restored[k] = [...want, ...have]
      continue
    }
    if (current[k] === undefined || current[k] === null) restored[k] = v
  }
  if (Object.keys(restored).length) await patchCredential(s.name, restored)

  // Checked again now: an account enabled or changed by hand during the login is left alone.
  const row = rows().get(s.name)
  const enabled = row?.reason === 'signed-out'
  if (enabled) {
    removeRow(s.name)
    setFloor.run(s.name, Date.now())
    // CPA keeps the old file's disabled flag through a new sign-in.
    if (f.disabled) await setDisabled(s.name, false, ': signed in again', 'Sign-in check')
    if (f.auth_index) await management('/routing/cooldown/reset', { method: 'POST', body: { auth_index: f.auth_index } })
  }
  console.log(`Sign-in check: ${s.name} signed in again${Object.keys(restored).length ? `; restored ${Object.keys(restored).join(', ')}` : ''}`)
  return { name: s.name, signedIn: true, restored: Object.keys(restored), enabled, other: [] }
}
