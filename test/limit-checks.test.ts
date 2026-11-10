import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, mock, test } from 'node:test'

const H = 3_600_000
const D = 24 * H
const P = 'anthropic-ratelimit-unified-'
const ORG = '0b9f2c64-5d1e-4a7b-9c3f-1e2d3c4b5a69'
const iso = (ms: number) => new Date(ms).toISOString()
const seconds = (ms: number) => String(Math.floor(ms / 1000))

type Answer = { status?: number; json: unknown }

/** A JSON server on this machine, on a port of its own. */
async function serve(handler: (req: { method: string; url: URL; headers: http.IncomingHttpHeaders; body: string }) => Answer | Promise<Answer>) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', async () => {
      const out = await handler({ method: req.method ?? 'GET', url: new URL(req.url ?? '/', 'http://127.0.0.1'), headers: req.headers, body })
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  after(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// The provider, mocked: what its usage endpoint answers (plainly, when asked as Claude Code asks at
// the 5-hour limit, and when asked about the resets it granted), what using a reset answers, and
// every request it got.
const provider = {
  usage: {} as object,
  /** The status of a plain usage read, to have it fail. */
  usageStatus: 200,
  atWall: {} as unknown,
  /** The `cedar_ember` block of an answer about granted resets; left out when undefined. */
  cedarEmber: undefined as unknown,
  reset: { status: 200, json: {} as unknown },
  requests: [] as { method: string; path: string; query: string; headers: http.IncomingHttpHeaders; body: string }[],
}
const providerUrl = await serve(({ method, url, headers, body }) => {
  provider.requests.push({ method, path: url.pathname, query: url.search, headers, body })
  if (method === 'POST') return provider.reset
  if (url.searchParams.has('at_wall')) return { json: provider.atWall }
  if (url.searchParams.has('cedar_ember')) return { json: { ...provider.usage, cedar_ember: provider.cedarEmber } }
  return { status: provider.usageStatus, json: provider.usage }
})

// CPA's management API, as much of it as limit checks and the Fable reserve use.
const cpa = {
  files: [] as Record<string, unknown>[],
  /** Auth files as on disk, by name. */
  disk: {} as Record<string, Record<string, unknown>>,
  cooldownResets: [] as unknown[],
}
const cpaUrl = await serve(async ({ method, url, body }) => {
  const route = `${method} ${url.pathname.replace('/v8/management', '')}`
  const sent = body ? JSON.parse(body) : {}
  if (route === 'GET /credentials') return { json: { files: cpa.files } }
  if (route === 'GET /credentials/download') return { json: cpa.disk[url.searchParams.get('name') ?? ''] ?? {} }
  if (route === 'PATCH /credentials/status') {
    Object.assign(cpa.files.find((f) => f.name === sent.name) ?? {}, { disabled: sent.disabled })
    return { json: { status: 'ok' } }
  }
  if (route === 'PATCH /credentials/fields') {
    const { name, ...fields } = sent
    cpa.disk[name] = Object.fromEntries(Object.entries({ ...cpa.disk[name], ...fields }).filter(([, v]) => v !== null))
    return { json: { status: 'ok' } }
  }
  if (route === 'POST /routing/cooldown/reset') {
    cpa.cooldownResets.push(sent)
    return { json: { status: 'ok' } }
  }
  if (route === 'POST /requests/api-call') {
    const call = sent as { auth_index: string; method: string; url: string; header: Record<string, string>; data?: string }
    // A test must never reach a real provider.
    if (new URL(call.url).hostname !== '127.0.0.1') return { status: 502, json: { error: 'not this machine' } }
    const header = Object.fromEntries(Object.entries(call.header).map(([k, v]) => [k, v.replaceAll('$TOKEN$', `token-of-${call.auth_index}`)]))
    const answer = await fetch(call.url, { method: call.method, headers: header, body: call.data })
    return { json: { status_code: answer.status, body: await answer.text() } }
  }
  return { status: 404, json: { error: `no ${route}` } }
})

// paths and the endpoints are fixed when the server modules load, so set them before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-limit-checks-test-'))
process.env.CPA_CONSOLE_DATA = data
process.env.CPA_CONSOLE_CLAUDE_USAGE_URL = `${providerUrl}/api/oauth/usage`
process.env.CPA_CONSOLE_CLAUDE_RESET_URL = providerUrl
fs.writeFileSync(path.join(data, 'config.yaml'), 'management:\n  secret-key: test-key\n')
fs.writeFileSync(path.join(data, 'console.json'), JSON.stringify({ managementKey: 'test-key', reserve: { fable: 0 } }))
// Codex has no mock here, which is said once on loading.
mock.method(console, 'error', () => {})
mock.method(console, 'log', () => {})
const { claudeSignals, limitCheckStatus, useLimitReset } = await import('../server/limit-checks.ts')
const { fableResetStatus, resetStatus } = await import('../server/limit-resets.ts')
const { limitReadings, saveReading } = await import('../server/limits.ts')
const { applyReserve, reserveStatus } = await import('../server/reserve.ts')
const { applyFable, fableStatus } = await import('../server/fable.ts')
const { updateState } = await import('../server/state.ts')
const { supervisor } = await import('../server/supervisor.ts')
const { db } = await import('../server/usage.ts')
const { poolLimits } = await import('../src/lib/limits.ts')

supervisor.state = 'running'
supervisor.port = Number(new URL(cpaUrl).port)
after(() => fs.rmSync(data, { recursive: true, force: true }))

/** A usage response: percent used of the 5-hour, weekly and (if given) Fable limits. */
function usage(now: number, fiveHour: number, weekly: number, fable?: number) {
  return {
    five_hour: { utilization: fiveHour, resets_at: iso(now + 2 * H) },
    seven_day: { utilization: weekly, resets_at: iso(now + 3 * D) },
    seven_day_opus: null,
    limits:
      fable === undefined
        ? []
        : [
            { kind: 'weekly_scoped', group: 'model', percent: 12, resets_at: iso(now + 3 * D), severity: 'ok', is_active: true, scope: { model: { display_name: 'Sonnet' } } },
            { kind: 'weekly_scoped', group: 'model', percent: fable, resets_at: iso(now + 4 * D), severity: 'ok', is_active: true, scope: { model: { display_name: 'Fable' } } },
          ],
  }
}

describe('claudeSignals', () => {
  const now = Date.parse('2026-11-03T09:00:00Z')

  test('reads the Fable window from the limits list as the 7d_oi headers', () => {
    assert.deepEqual(claudeSignals(usage(now, 40, 25, 62.5), now), {
      [`${P}5h-utilization`]: '0.4',
      [`${P}5h-reset`]: seconds(now + 2 * H),
      [`${P}7d-utilization`]: '0.25',
      [`${P}7d-reset`]: seconds(now + 3 * D),
      [`${P}7d_oi-utilization`]: '0.625',
      [`${P}7d_oi-reset`]: seconds(now + 4 * D),
    })
  })

  test('matches the model name whatever its case, and only Fable models', () => {
    const body = usage(now, 40, 25, 80)
    body.limits[1]!.scope.model.display_name = 'FABLE 5.1'
    assert.equal((claudeSignals(body, now) as Record<string, string>)[`${P}7d_oi-utilization`], '0.8')
    body.limits[1]!.scope.model.display_name = 'Opus'
    assert.ok(!(`${P}7d_oi-utilization` in (claudeSignals(body, now) as Record<string, string>)))
  })

  test('leaves Fable out, and keeps the rest, when the answer has none or it cannot be trusted', () => {
    const rest = claudeSignals(usage(now, 40, 25), now)
    assert.deepEqual(Object.keys(rest), [`${P}5h-utilization`, `${P}5h-reset`, `${P}7d-utilization`, `${P}7d-reset`])
    const bad = (change: (fable: Record<string, unknown>, limits: unknown[]) => void) => {
      const body = usage(now, 40, 25, 50)
      change(body.limits[1]!, body.limits)
      return claudeSignals(body, now)
    }
    // Not a percent, a reset no weekly window can have, no reset with usage, and two Fable entries.
    assert.deepEqual(bad((f) => (f.percent = 250)), rest)
    assert.deepEqual(bad((f) => (f.percent = 'half')), rest)
    assert.deepEqual(bad((f) => (f.resets_at = iso(now + 30 * D))), rest)
    assert.deepEqual(bad((f) => (f.resets_at = null)), rest)
    assert.deepEqual(bad((f, limits) => limits.push({ ...f, scope: { model: { display_name: 'Fable 5' } } })), rest)
    assert.deepEqual(claudeSignals({ ...usage(now, 40, 25), limits: 'none' }, now), rest)
  })

  test('an unused Fable window with no reset yet reads as unused', () => {
    const body = usage(now, 40, 25, 0)
    body.limits[1]!.resets_at = null as never
    const signals = claudeSignals(body, now) as Record<string, string>
    assert.equal(signals[`${P}7d_oi-utilization`], '0')
    assert.ok(!(`${P}7d_oi-reset` in signals))
  })

  test('still fails on a 5-hour or weekly window it cannot read', () => {
    assert.equal(claudeSignals({ ...usage(now, 40, 25, 50), seven_day: { utilization: 'x' } }, now), 'The answer had no valid weekly usage')
  })
})

describe('poolLimits', () => {
  const now = Date.parse('2026-11-03T09:00:00Z')
  /** A Claude reading: share used of the weekly limit, and of the Fable one if given. */
  const reading = (weekly: number, fable?: number, fableResetsAt = now + 4 * D) => ({
    observed_at: iso(now - 60_000),
    signals: {
      [`${P}7d-utilization`]: String(weekly),
      [`${P}7d-reset`]: seconds(now + 3 * D),
      ...(fable === undefined ? {} : { [`${P}7d_oi-utilization`]: String(fable), [`${P}7d_oi-reset`]: seconds(fableResetsAt) }),
    },
  })
  const pool = (accounts: Parameters<typeof poolLimits>[0], label: string, provider = 'claude') => poolLimits(accounts, now).find((p) => p.provider === provider && p.label === label)

  test("adds up Claude's Fable limit beside the weekly one", () => {
    const accounts = [
      { provider: 'claude', reading: reading(0.5, 0.25, now + 2 * D) },
      { provider: 'claude', reading: reading(0.1, 1) },
      // No reading yet: counted as unused.
      { provider: 'claude' },
      { provider: 'codex' },
      { provider: 'codex' },
    ]
    assert.deepEqual(
      poolLimits(accounts, now).map((p) => `${p.provider} ${p.label}`),
      ['claude Weekly', 'claude Fable', 'codex Weekly'],
    )
    const fable = pool(accounts, 'Fable')!
    assert.equal(fable.accounts, 3)
    assert.equal(fable.left, 0.75 + 0 + 1)
    assert.equal(fable.unread, 1)
    assert.deepEqual(fable.nextReset, { at: Math.floor((now + 2 * D) / 1000) * 1000, gain: 0.25 })
    const weekly = pool(accounts, 'Weekly')!
    assert.equal(weekly.accounts, 3)
    assert.equal(weekly.left, 0.5 + 0.9 + 1)
  })

  test('an account whose reading has no Fable window is left out, unless an older reading or a hold says', () => {
    const none = { provider: 'claude', reading: reading(0.5) }
    assert.equal(pool([none, { provider: 'claude', reading: reading(0.2, 0.5) }], 'Fable')!.accounts, 1)
    // The reading before it had one, as the account's own Fable meter shows.
    const older = pool([{ ...none, older: reading(0.4, 0.3) }, { provider: 'claude', reading: reading(0.2, 0.5) }], 'Fable')!
    assert.equal(older.accounts, 2)
    assert.equal(older.left, 0.7 + 0.5)
    // Held for Fable: counted as used up until the hold ends.
    const held = pool([{ ...none, holds: { Fable: now + D } }, { provider: 'claude', reading: reading(0.2, 0.5) }], 'Fable')!
    assert.equal(held.accounts, 2)
    assert.equal(held.left, 0.5)
    assert.deepEqual(held.nextReset, { at: now + D, gain: 1 })
    // The weekly limit never comes from the older reading.
    assert.equal(pool([{ provider: 'claude', reading: reading(0, 0.5), older: reading(0.9) }], 'Weekly')!.left, 1)
  })
})

describe('resetStatus', () => {
  const now = Date.parse('2026-11-03T09:00:00Z')

  test('reads the block as Claude Code does', () => {
    assert.deepEqual(resetStatus({ eligible: true, arm: 'reset', available: true }, now), { readAt: now, state: 'available' })
    assert.deepEqual(resetStatus({ eligible: true, arm: 'reset', available: false, next_available_at: iso(now + 2 * D) }, now), {
      readAt: now,
      state: 'used',
      nextAvailableAt: now + 2 * D,
    })
    assert.deepEqual(resetStatus({ eligible: false, ineligible_reason: 'tier' }, now), { readAt: now, state: 'not-offered', reason: 'tier' })
    assert.deepEqual(resetStatus({ eligible: true, arm: 'control', available: true }, now), { readAt: now, state: 'not-offered', reason: undefined })
  })

  test('says nothing when the answer does not', () => {
    assert.equal(resetStatus(undefined, now), undefined)
    assert.equal(resetStatus({ available: true }, now), undefined)
    assert.equal(resetStatus({ eligible: false, ineligible_reason: 'not_at_wall' }, now), undefined)
  })
})

describe('using a limit reset', () => {
  const NAME = 'claude-ada.json'
  beforeEach(() => {
    db.exec('DELETE FROM limit_resets; DELETE FROM limit_checks; DELETE FROM limits; DELETE FROM reserve')
    cpa.files = [
      { name: NAME, provider: 'claude', account_type: 'oauth', auth_index: 'a1' },
      { name: 'codex-ada.json', provider: 'codex', account_type: 'oauth', auth_index: 'c1' },
    ]
    cpa.disk = { [NAME]: { type: 'claude', organization_uuid: ORG } }
    cpa.cooldownResets = []
    provider.requests = []
    provider.usage = usage(Date.now(), 100, 60, 30)
    provider.usageStatus = 200
    provider.atWall = {}
    provider.cedarEmber = undefined
    provider.reset = { status: 200, json: {} }
  })
  const posts = () => provider.requests.filter((r) => r.method === 'POST')

  test('asks the provider as the account, says how it went and reads the limits again', async () => {
    const next = Date.now() + 6 * D
    provider.reset = { status: 200, json: { result: 'reset', next_available_at: iso(next), weekly_resets_at: iso(Date.now() + 3 * D) } }
    // What the provider reports once the 5-hour limit is cleared.
    provider.usage = usage(Date.now(), 0, 60, 30)
    const out = await useLimitReset(NAME)
    assert.equal(out.ok, true)
    assert.equal(out.message, 'The 5-hour limit was reset. The weekly limit still applies.')

    assert.equal(posts().length, 1)
    const [post] = posts()
    assert.equal(post.path, `/api/organizations/${ORG}/reset_rate_limits`)
    assert.deepEqual(JSON.parse(post.body), { program: 'juniper_tide' })
    assert.equal(post.headers.authorization, 'Bearer token-of-a1')
    assert.equal(post.headers['anthropic-beta'], 'oauth-2025-04-20')
    assert.equal(post.headers['content-type'], 'application/json')

    assert.deepEqual(limitCheckStatus().resets[NAME], { readAt: limitCheckStatus().resets[NAME].readAt, state: 'used', nextAvailableAt: next, reason: undefined })
    // The account's limits were read again, Fable included, and CPA's rest for the old limit lifted.
    const { signals } = limitReadings()[NAME]
    assert.equal(signals['Anthropic-Ratelimit-Unified-5h-Utilization'], '0')
    assert.equal(signals['Anthropic-Ratelimit-Unified-7d_oi-Utilization'], '0.3')
    assert.ok(Number(signals['Anthropic-Ratelimit-Unified-7d_oi-Reset']) > Date.now() / 1000)
    assert.deepEqual(cpa.cooldownResets, [{ auth_index: 'a1' }])
  })

  /** The account as the reserve holds it at its 5-hour limit, from a reading with these other signals. */
  async function held(weekly = 0.6, more: Record<string, string> = {}) {
    const now = Date.now()
    saveReading(NAME, now - 60_000, {
      [`${P}5h-utilization`]: '1',
      [`${P}5h-reset`]: seconds(now + 2 * H),
      [`${P}7d-utilization`]: String(weekly),
      [`${P}7d-reset`]: seconds(now + 3 * D),
      ...more,
    })
    await applyReserve(cpa.files as never, limitReadings(), now)
    assert.equal(cpa.files[0].disabled, true)
    provider.reset = { status: 200, json: { result: 'reset', next_available_at: iso(now + 6 * D) } }
  }
  /** What the reserve makes of the account on its next round. */
  async function afterNextRound() {
    await applyReserve(cpa.files as never, limitReadings(), Date.now())
    return { disabled: cpa.files[0].disabled, hold: reserveStatus().accounts[NAME] }
  }

  test('a reset ends a hold for the 5-hour limit, whatever is read afterwards', async () => {
    const now = Date.now()
    // After a reset no 5-hour window is running: the provider leaves it out, or reports it unused
    // with no reset time, or the read fails and the last reading still has the old window.
    const after: (() => void)[] = [
      () => (provider.usage = { ...usage(now, 0, 60, 30), five_hour: null }),
      () => (provider.usage = { ...usage(now, 0, 60, 30), five_hour: { utilization: 0, resets_at: null } }),
      () => (provider.usageStatus = 500),
    ]
    for (const answer of after) {
      await held()
      assert.deepEqual(reserveStatus().accounts[NAME].windows, ['5h'])
      answer()
      assert.equal((await useLimitReset(NAME)).ok, true)
      assert.equal(cpa.files[0].disabled, false)
      assert.equal(reserveStatus().accounts[NAME], undefined)
      // The other windows are still known, the old 5-hour one is not, so nothing holds it again.
      const { signals } = limitReadings()[NAME]
      assert.equal(signals['Anthropic-Ratelimit-Unified-7d-Utilization'] ?? signals[`${P}7d-utilization`], '0.6')
      assert.ok(Object.keys(signals).every((k) => !/-5h-reset$/i.test(k)))
      assert.deepEqual(await afterNextRound(), { disabled: false, hold: undefined })
      provider.usageStatus = 200
      db.exec('DELETE FROM limit_checks; DELETE FROM limits')
    }
  })

  test('a reset leaves a hold for another limit in place', async () => {
    await held(0.97)
    assert.deepEqual(reserveStatus().accounts[NAME].windows, ['5h', 'weekly'])
    provider.usage = { ...usage(Date.now(), 0, 97, 30), five_hour: null }
    assert.equal((await useLimitReset(NAME)).ok, true)
    assert.equal(cpa.files[0].disabled, true)
    assert.deepEqual(reserveStatus().accounts[NAME].windows, ['weekly'])
    assert.deepEqual((await afterNextRound()).hold?.windows, ['weekly'])
  })

  test('a reset ends a hold for paid extra usage past the 5-hour limit', async () => {
    await held(0.6, { [`${P}status`]: 'rejected', [`${P}5h-status`]: 'rejected', [`${P}overage-status`]: 'allowed' })
    assert.equal(reserveStatus().accounts[NAME].reason, 'extra-usage')
    provider.usageStatus = 500
    assert.equal((await useLimitReset(NAME)).ok, true)
    assert.equal(cpa.files[0].disabled, false)
    assert.deepEqual(await afterNextRound(), { disabled: false, hold: undefined })
  })

  test('an answer other than a reset leaves the hold alone', async () => {
    await held()
    provider.reset = { status: 200, json: { result: 'already_used', next_available_at: iso(Date.now() + 2 * D) } }
    assert.equal((await useLimitReset(NAME)).ok, false)
    assert.equal(cpa.files[0].disabled, true)
    assert.deepEqual((await afterNextRound()).hold?.windows, ['5h'])
  })

  test("says so when this week's reset is already used", async () => {
    const next = Date.now() + 2 * D
    provider.reset = { status: 200, json: { result: 'already_used', next_available_at: iso(next) } }
    const out = await useLimitReset(NAME)
    assert.deepEqual([out.ok, out.message], [false, "This week's reset was already used. The limit was not reset."])
    assert.equal(limitCheckStatus().resets[NAME].state, 'used')
    assert.equal(limitCheckStatus().resets[NAME].nextAvailableAt, next)
    assert.deepEqual(cpa.cooldownResets, [])
    // Known to be used: the check that follows does not ask about the reset again.
    assert.ok(!provider.requests.some((r) => r.query.includes('at_wall')))
  })

  test("passes on the provider's refusals in plain words", async () => {
    provider.reset = { status: 200, json: { result: 'ineligible' } }
    assert.equal((await useLimitReset(NAME)).message, 'The provider does not offer this account a limit reset right now. The limit was not reset.')
    provider.reset = { status: 200, json: { result: 'not_limited' } }
    assert.equal((await useLimitReset(NAME)).message, 'The 5-hour limit was not in effect, so there was nothing to reset.')
    provider.reset = { status: 401, json: { error: { message: 'OAuth token has expired' } } }
    assert.match((await useLimitReset(NAME)).message, /refused this account's sign-in \(HTTP 401\)\. Sign in again/)
    provider.reset = { status: 429, json: {} }
    assert.match((await useLimitReset(NAME)).message, /Try again in a moment/)
    provider.reset = { status: 500, json: { error: { message: 'Internal error' } } }
    assert.equal((await useLimitReset(NAME)).message, 'The provider answered HTTP 500: Internal error. The limit was not reset.')
  })

  test('never asks the provider for an account that has no reset to use', async () => {
    assert.match((await useLimitReset('codex-ada.json')).message, /Only Claude subscription accounts/)
    assert.match((await useLimitReset('gone.json')).message, /no longer exists/)
    cpa.disk[NAME] = { type: 'claude' }
    assert.match((await useLimitReset(NAME)).message, /does not say which organization/)
    cpa.disk[NAME] = { type: 'claude', organization_uuid: '../../v1/messages' }
    assert.match((await useLimitReset(NAME)).message, /does not say which organization/)
    assert.equal(provider.requests.length, 0)
  })

  test('a check at the 5-hour limit asks whether the reset is left, as Claude Code does', async () => {
    provider.reset = { status: 200, json: { result: 'unavailable' } }
    provider.atWall = { ...usage(Date.now(), 100, 60, 30), juniper_tide: { eligible: true, in_experiment: true, arm: 'reset', available: true, resets_per_week: 1 } }
    assert.equal((await useLimitReset(NAME)).message, 'The provider could not reset the limit right now. Try again in a moment.')
    assert.equal(limitCheckStatus().resets[NAME].state, 'available')
    // The Fable reset is told at any time, so the check asks about it too, once in a few days.
    assert.deepEqual(provider.requests.filter((r) => r.method === 'GET').map((r) => r.query), ['', '?at_wall=1&skip_spend=1', '?cedar_ember=1&skip_spend=1'])
    assert.equal(limitCheckStatus().fableResets[NAME].state, 'not-offered')

    // Below the limit there is nothing to ask.
    provider.requests = []
    provider.usage = usage(Date.now(), 40, 60, 30)
    await useLimitReset(NAME)
    assert.deepEqual(provider.requests.filter((r) => r.method === 'GET').map((r) => r.query), [''])
    assert.equal(limitCheckStatus().resets[NAME].state, 'available')
  })
})

describe('fableResetStatus', () => {
  const now = Date.parse('2026-11-03T09:00:00Z')
  const ends = now + 20 * D
  const grant = (more: object = {}) => ({
    id: 'fable-launch',
    type: 'full',
    gives_back_weekly: true,
    resets_total: 3,
    resets_left: 2,
    ends_at: iso(ends),
    clears: ['seven_day_overage_included'],
    usable_now: true,
    ...more,
  })
  const status = (...grants: object[]) => fableResetStatus({ eligible: true, at_limit: true, grants }, now)

  test('reads the grants as Claude Code does', () => {
    assert.deepEqual(status(grant()), { readAt: now, state: 'available', left: 2, endsAt: ends, grantId: 'fable-launch' })
    // Not at the Fable limit: the resets are left, and none can be used now.
    assert.deepEqual(status(grant({ usable_now: false })), { readAt: now, state: 'available', left: 2, endsAt: ends, grantId: undefined })
    assert.deepEqual(status(grant({ clears: ['five_hour'] })), { readAt: now, state: 'available', left: 2, endsAt: ends, grantId: undefined })
    assert.deepEqual(status(grant({ resets_left: 0 })), { readAt: now, state: 'used' })
    assert.deepEqual(status(grant({ ends_at: iso(now - H) })), { readAt: now, state: 'used' })
    assert.deepEqual(status(grant({ paused: true })), { readAt: now, state: 'used' })
    assert.deepEqual(status(grant({ resets_left: 0 }), grant({ id: 'second', resets_left: 1 })), { readAt: now, state: 'available', left: 1, endsAt: ends, grantId: 'second' })
  })

  test('a reset of another limit is not a Fable reset', () => {
    assert.deepEqual(status(grant({ id: 'session-1', type: 'session', gives_back_weekly: false, clears: ['five_hour'] })), { readAt: now, state: 'not-offered' })
    assert.deepEqual(status(grant({ id: 'Not An Id' })), { readAt: now, state: 'not-offered' })
    assert.deepEqual(status(), { readAt: now, state: 'not-offered' })
    assert.deepEqual(fableResetStatus({ eligible: false, ineligible_reason: 'tier', grants: [] }, now), { readAt: now, state: 'not-offered', reason: 'tier' })
    // An answer without the block: the provider has no such resets for this account.
    assert.deepEqual(fableResetStatus(undefined, now), { readAt: now, state: 'not-offered' })
  })

  test('says nothing when the answer does not', () => {
    assert.equal(fableResetStatus({ grants: [grant()] }, now), undefined)
    assert.equal(fableResetStatus('soon', now), undefined)
    assert.equal(fableResetStatus({ eligible: false, ineligible_reason: 'unavailable' }, now), undefined)
  })
})

describe('using a Fable reset', () => {
  const NAME = 'claude-ada.json'
  const ends = Date.now() + 20 * D
  let grants = 0
  /** The provider's answer about the account's resets: one grant of Fable resets, usable now. A new one each time. */
  const granted = (left = 2, more: object = {}) => ({
    eligible: true,
    at_limit: true,
    grants: [
      { id: `fable-${++grants}`, type: 'full', gives_back_weekly: true, resets_total: 3, resets_left: left, ends_at: iso(ends), clears: ['seven_day_overage_included'], usable_now: true, ...more },
    ],
  })
  const posts = () => provider.requests.filter((r) => r.method === 'POST')
  const sent = () => posts().map((r) => JSON.parse(r.body) as { program: string; grant_id: string; request_id: string })
  const fableReset = () => limitCheckStatus().fableResets[NAME]

  beforeEach(async () => {
    db.exec('DELETE FROM limit_resets; DELETE FROM limit_checks; DELETE FROM limits; DELETE FROM reserve; DELETE FROM fable_hold')
    cpa.files = [{ name: NAME, provider: 'claude', account_type: 'oauth', auth_index: 'a1' }]
    cpa.disk = { [NAME]: { type: 'claude', organization_uuid: ORG } }
    cpa.cooldownResets = []
    provider.usageStatus = 200
    provider.atWall = {}
    provider.cedarEmber = granted()
    provider.reset = { status: 200, json: { result: 'reset', resets_left: 1, cleared: ['seven_day_overage_included'] } }
    // The account at its Fable limit, its Fable models held for the reserve.
    const now = Date.now()
    updateState({ reserve: { fable: 10 } })
    saveReading(NAME, now - 60_000, {
      [`${P}5h-utilization`]: '0.4',
      [`${P}5h-reset`]: seconds(now + 2 * H),
      [`${P}7d-utilization`]: '0.6',
      [`${P}7d-reset`]: seconds(now + 3 * D),
      [`${P}7d_oi-utilization`]: '1',
      [`${P}7d_oi-reset`]: seconds(now + 4 * D),
    })
    await applyFable(cpa.files as never, limitReadings(), now)
    assert.ok(fableStatus()[NAME])
    assert.deepEqual(cpa.disk[NAME].excluded_models, ['claude-fable-*'])
    provider.usage = usage(now, 40, 60, 100)
    provider.requests = []
  })
  after(() => updateState({ reserve: { fable: 0 } }))

  /** Whether the Fable models are held, now and after the Fable reserve's next round. */
  async function held() {
    const now = [!!fableStatus()[NAME], cpa.disk[NAME].excluded_models]
    await applyFable(cpa.files as never, limitReadings(), Date.now())
    assert.deepEqual([!!fableStatus()[NAME], cpa.disk[NAME].excluded_models], now)
    return now[0]
  }

  test('asks which reset can be used, uses it as the account and releases the Fable models', async () => {
    // What the provider reports once the Fable limit is cleared: what Fable used is back in the weekly limit.
    provider.usage = usage(Date.now(), 40, 45, 0)
    const out = await useLimitReset(NAME, 'fable')
    assert.deepEqual([out.ok, out.message], [true, 'The Fable limit was reset. What Fable used this week is back in the weekly limit.'])

    // Asked first, as Claude Code's /limit-reset asks, then the grant it named is used.
    assert.deepEqual(provider.requests.map((r) => `${r.method} ${r.query}`).slice(0, 2), ['GET ?cedar_ember=1&skip_spend=1', 'POST '])
    assert.equal(posts().length, 1)
    assert.equal(posts()[0].path, `/api/organizations/${ORG}/reset_rate_limits`)
    assert.equal(posts()[0].headers.authorization, 'Bearer token-of-a1')
    assert.deepEqual(sent()[0], { program: 'cedar_ember', grant_id: `fable-${grants}`, request_id: sent()[0].request_id })
    assert.match(sent()[0].request_id, /^[A-Za-z0-9_-]{1,64}$/)

    // One of the two is used, and the 5-hour reset is another matter.
    assert.deepEqual(fableReset(), { readAt: fableReset().readAt, state: 'available', nextAvailableAt: undefined, reason: undefined, left: 1, endsAt: ends })
    assert.equal(limitCheckStatus().resets[NAME], undefined)
    assert.equal(await held(), false)
    assert.equal(cpa.disk[NAME].excluded_models, undefined)
    const { signals } = limitReadings()[NAME]
    assert.equal(signals['Anthropic-Ratelimit-Unified-7d_oi-Utilization'], '0')
    assert.equal(signals['Anthropic-Ratelimit-Unified-7d-Utilization'], '0.45')
    assert.deepEqual(cpa.cooldownResets, [{ auth_index: 'a1' }])
  })

  test('the last Fable reset leaves none', async () => {
    provider.cedarEmber = granted(1)
    provider.reset = { status: 200, json: { result: 'reset' } }
    provider.usage = usage(Date.now(), 40, 45, 0)
    assert.equal((await useLimitReset(NAME, 'fable')).ok, true)
    assert.equal(fableReset().state, 'used')
    assert.equal(fableReset().left, undefined)
  })

  test('a reset releases the Fable models, whatever is read afterwards', async () => {
    const now = Date.now()
    // After a reset the provider may leave the Fable limit out, or report it unused with no reset
    // time, or the read fails and the last reading still has the used-up window.
    const after: (() => void)[] = [
      () => (provider.usage = usage(now, 40, 45)),
      () => (provider.usage = { ...usage(now, 40, 45), limits: [{ kind: 'weekly_scoped', percent: 0, resets_at: null, scope: { model: { display_name: 'Fable' } } }] }),
      () => (provider.usageStatus = 500),
    ]
    for (const answer of after) {
      answer()
      assert.equal((await useLimitReset(NAME, 'fable')).ok, true)
      assert.equal(await held(), false)
      // The other windows are still known, and the used-up Fable window is not.
      const signals = Object.fromEntries(Object.entries(limitReadings()[NAME].signals).map(([k, v]) => [k.toLowerCase(), v]))
      assert.ok(signals[`${P}7d-utilization`])
      assert.notEqual(signals[`${P}7d_oi-utilization`], '1')
      assert.equal(signals[`${P}7d_oi-reset`], undefined)
    }
  })

  test('says so when the reset was already used, and leaves the hold alone', async () => {
    provider.reset = { status: 200, json: { result: 'already_used', resets_left: 0 } }
    const out = await useLimitReset(NAME, 'fable')
    assert.deepEqual([out.ok, out.message], [false, 'That Fable reset was already used. The limit was not reset.'])
    assert.equal(fableReset().state, 'used')
    assert.equal(await held(), true)
    assert.deepEqual(cpa.cooldownResets, [])
  })

  test('a failure leaves the hold alone, and trying again repeats the same request', async () => {
    provider.reset = { status: 500, json: { error: { message: 'Internal error' } } }
    const out = await useLimitReset(NAME, 'fable')
    assert.deepEqual([out.ok, out.message], [false, 'The provider answered HTTP 500: Internal error. The limit was not reset.'])
    assert.deepEqual([fableReset().state, fableReset().left], ['available', 2])
    assert.equal(await held(), true)

    // The first try may have gone through all the same. Repeated as the same request it can't use a
    // second reset, and the provider saying it is used means the first one did.
    provider.reset = { status: 200, json: { result: 'already_used', resets_left: 1 } }
    provider.usage = usage(Date.now(), 40, 45, 0)
    const again = await useLimitReset(NAME, 'fable')
    assert.deepEqual([again.ok, again.message], [true, 'The earlier try went through after all: the Fable limit was reset.'])
    assert.equal(sent().length, 2)
    assert.deepEqual(sent()[1], sent()[0])
    assert.deepEqual([fableReset().state, fableReset().left], ['available', 1])
    assert.equal(await held(), false)

    // Answered: the next one is a request of its own.
    provider.reset = { status: 200, json: { result: 'not_limited' } }
    assert.equal((await useLimitReset(NAME, 'fable')).message, 'The Fable limit was not in effect, so there was nothing to reset.')
    assert.notEqual(sent()[2].request_id, sent()[0].request_id)
  })

  test("passes on the provider's refusals in plain words", async () => {
    provider.reset = { status: 200, json: { result: 'ineligible' } }
    assert.equal((await useLimitReset(NAME, 'fable')).message, 'The provider does not offer this account a Fable reset right now. The limit was not reset.')
    assert.equal(fableReset().state, 'not-offered')
    provider.reset = { status: 200, json: { result: 'cooldown' } }
    assert.match((await useLimitReset(NAME, 'fable')).message, /Another reset was just started on this account/)
    provider.reset = { status: 401, json: {} }
    assert.match((await useLimitReset(NAME, 'fable')).message, /refused this account's sign-in \(HTTP 401\)/)
    assert.equal(await held(), true)
  })

  test('never asks for a reset the provider did not say can be used', async () => {
    // What the provider says about the account's resets, and what the console then says without asking for one.
    const refusals: [unknown, string][] = [
      [undefined, 'The provider offers this account no Fable reset.'],
      [granted(0), 'This account has no Fable reset left.'],
      [granted(2, { usable_now: false }), "The provider says this account's Fable reset can't be used right now."],
      // A reset of the 5-hour limit from the same program is not a Fable reset.
      [granted(2, { type: 'session', gives_back_weekly: false, clears: ['five_hour'] }), 'The provider offers this account no Fable reset.'],
      [{ eligible: false, ineligible_reason: 'unavailable' }, 'The provider did not say whether this account has a Fable reset left.'],
    ]
    for (const [block, message] of refusals) {
      provider.cedarEmber = block
      assert.equal((await useLimitReset(NAME, 'fable')).message, `${message} Nothing was used.`)
    }
    assert.equal(posts().length, 0)
    assert.equal(await held(), true)
  })
})

describe('Fable reserve with readings from limit checks', () => {
  const NAME = 'claude-ada.json'
  const now = Date.parse('2026-11-03T09:00:00Z')
  const until = Math.floor((now + 4 * D) / 1000) * 1000
  const files = [{ name: NAME, provider: 'claude' }]
  /** A reading as a limit check stores it: the windows only. */
  const checked = (fable: number, resets = true) => ({
    observed_at: iso(now),
    signals: { [`${P}7d_oi-utilization`]: String(fable), ...(resets ? { [`${P}7d_oi-reset`]: seconds(until) } : {}) },
  })
  beforeEach(() => {
    db.exec('DELETE FROM fable_hold')
    cpa.disk = { [NAME]: { type: 'claude' } }
  })

  test('a Fable window from a check holds and releases the Fable models', async () => {
    updateState({ reserve: { fable: 10 } })
    await applyFable(files, { [NAME]: checked(0.95) }, now)
    assert.deepEqual(fableStatus()[NAME], { until, billing: false })
    assert.deepEqual(cpa.disk[NAME].excluded_models, ['claude-fable-*'])
    // Unused with no reset time can't be told from a window that has yet to start: still held.
    await applyFable(files, { [NAME]: checked(0, false) }, now + H)
    assert.ok(fableStatus()[NAME])
    await applyFable(files, { [NAME]: checked(0.5) }, now + H)
    assert.equal(fableStatus()[NAME], undefined)
    assert.equal(cpa.disk[NAME].excluded_models, undefined)
    updateState({ reserve: { fable: 0 } })
  })

  test('a check cannot say extra usage went off, so it keeps a billing hold while Fable is used up', async () => {
    const live = { observed_at: iso(now), signals: { ...checked(1).signals, [`${P}overage-status`]: 'allowed' } }
    await applyFable(files, { [NAME]: live }, now)
    assert.deepEqual(fableStatus()[NAME], { until, billing: true })
    await applyFable(files, { [NAME]: checked(1) }, now + H)
    assert.deepEqual(fableStatus()[NAME], { until, billing: true })
    // The provider turning extra usage off does release it, as before.
    await applyFable(files, { [NAME]: { ...live, signals: { ...live.signals, [`${P}overage-status`]: 'rejected' } } }, now + H)
    assert.equal(fableStatus()[NAME], undefined)
  })
})
