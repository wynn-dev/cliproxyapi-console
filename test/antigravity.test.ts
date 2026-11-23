import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, mock, test } from 'node:test'

const H = 3_600_000
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

// Antigravity's fetchAvailableModels, mocked, and every request it got.
const google = {
  answer: { json: {} } as Answer,
  requests: [] as { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[],
}
const googleUrl = await serve(({ method, url, headers, body }) => {
  google.requests.push({ method, path: url.pathname, headers, body })
  return google.answer
})

// CPA's management API, as much of it as the checks and the hold use.
const cpa = {
  files: [] as Record<string, unknown>[],
  /** Auth files as on disk, by name. */
  disk: {} as Record<string, Record<string, unknown>>,
  calls: [] as { auth_index: string; method: string; url: string; header: Record<string, string>; data?: string; proxy_url?: string }[],
}
const cpaUrl = await serve(async ({ method, url, body }) => {
  const route = `${method} ${url.pathname.replace('/v8/management', '')}`
  const sent = body ? JSON.parse(body) : {}
  if (route === 'GET /credentials') return { json: { files: cpa.files } }
  if (route === 'GET /credentials/download') return { json: cpa.disk[url.searchParams.get('name') ?? ''] ?? {} }
  if (route === 'PATCH /credentials/fields') {
    const { name, ...fields } = sent
    cpa.disk[name] = Object.fromEntries(Object.entries({ ...cpa.disk[name], ...fields }).filter(([, v]) => v !== null))
    return { json: { status: 'ok' } }
  }
  if (route === 'POST /requests/api-call') {
    cpa.calls.push(sent)
    // A test must never reach a real provider.
    if (new URL(sent.url).hostname !== '127.0.0.1') return { status: 502, json: { error: 'not this machine' } }
    const header = Object.fromEntries(Object.entries(sent.header as Record<string, string>).map(([k, v]) => [k, v.replaceAll('$TOKEN$', `token-of-${sent.auth_index}`)]))
    const answer = await fetch(sent.url, { method: sent.method, headers: header, body: sent.data })
    return { json: { status_code: answer.status, body: await answer.text() } }
  }
  return { status: 404, json: { error: `no ${route}` } }
})

// paths and the endpoints are fixed when the server modules load, so set them before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-antigravity-test-'))
process.env.CPA_CONSOLE_DATA = data
process.env.CPA_CONSOLE_ANTIGRAVITY_USAGE_URL = `${googleUrl}/v1internal:fetchAvailableModels`
fs.writeFileSync(path.join(data, 'config.yaml'), 'management:\n  secret-key: test-key\n')
fs.writeFileSync(path.join(data, 'console.json'), JSON.stringify({ managementKey: 'test-key', reserve: { '5h': 10 } }))
// Claude and Codex have no mock here, which is said once on loading.
mock.method(console, 'error', () => {})
mock.method(console, 'log', () => {})
const { antigravitySignals, checkNext, limitCheckStatus } = await import('../server/limit-checks.ts')
const { limitReadings } = await import('../server/limits.ts')
const { antigravityAdded, antigravityStatus, applyAntigravity } = await import('../server/antigravity.ts')
const { supervisor } = await import('../server/supervisor.ts')
const { db } = await import('../server/usage.ts')
const { limitWindows, poolLimits } = await import('../src/lib/limits.ts')

supervisor.state = 'running'
supervisor.port = Number(new URL(cpaUrl).port)
after(() => fs.rmSync(data, { recursive: true, force: true }))

/** A fetchAvailableModels answer: share left and reset per model id. */
function models(now: number, quotas: Record<string, { left?: number; resetsIn?: number } | null>) {
  return {
    models: Object.fromEntries(
      Object.entries(quotas).map(([id, q]) => [
        id,
        {
          displayName: id,
          ...(q && { quotaInfo: { ...(q.left !== undefined && { remainingFraction: q.left }), ...(q.resetsIn !== undefined && { resetTime: iso(now + q.resetsIn) }) } }),
        },
      ]),
    ),
  }
}

describe('antigravitySignals', () => {
  const now = Date.parse('2026-11-20T09:00:00Z')

  test("reads each family's model with the least left", () => {
    const body = models(now, {
      'gemini-4-argon-high': { left: 0.6, resetsIn: 3 * H },
      'gemini-3-flash': { left: 0.9, resetsIn: 4 * H },
      'claude-opus-5-5-high': { left: 0.25, resetsIn: 2 * H },
      'claude-sonnet-5-5-high': { left: 0.25, resetsIn: 2 * H },
      'gpt-oss-120b-medium': { left: 1, resetsIn: 5 * H },
    })
    assert.deepEqual(antigravitySignals(body, now), {
      'antigravity-gemini-remaining': '0.6',
      'antigravity-gemini-reset': seconds(now + 3 * H),
      'antigravity-claude-remaining': '0.25',
      'antigravity-claude-reset': seconds(now + 2 * H),
      'antigravity-gpt-remaining': '1',
      'antigravity-gpt-reset': seconds(now + 5 * H),
    })
  })

  test('a quota with a reset time and no share left is used up', () => {
    const signals = antigravitySignals(models(now, { 'gemini-3-flash': { resetsIn: H } }), now) as Record<string, string>
    assert.equal(signals['antigravity-gemini-remaining'], '0')
  })

  test('leaves out internal models, models without a quota and numbers it cannot trust', () => {
    const body = models(now, {
      'chat_20706': { left: 0.1, resetsIn: H },
      'tab_flash_lite_preview': { left: 0, resetsIn: H },
      'gemini-3.1-flash-image': null,
      'gemini-3-flash': { left: 1.7, resetsIn: H },
      'claude-sonnet-4-6': { left: 0.5, resetsIn: 30 * 24 * H },
    })
    // The Claude reset is no window's: the share stays, the reset goes.
    assert.deepEqual(antigravitySignals(body, now), { 'antigravity-claude-remaining': '0.5' })
    assert.equal(antigravitySignals({ models: {} }, now), 'The answer had no model quotas')
    assert.equal(antigravitySignals({ error: 'x' }, now), 'The answer listed no models')
  })

  test('reads as one limit per family', () => {
    const signals = antigravitySignals(models(now, { 'gemini-3-flash': { left: 0.125, resetsIn: H }, 'claude-sonnet-4-6': { left: 1, resetsIn: 5 * H } }), now) as Record<string, string>
    const windows = limitWindows('antigravity', { observed_at: iso(now), signals }, now)
    assert.deepEqual(
      windows.map((w) => [w.label, w.left, w.level, w.resetsAt]),
      [
        ['Gemini', 0.125, 'warning', now + H],
        ['Claude', 1, 'ok', now + 5 * H],
      ],
    )
  })
})

describe('poolLimits', () => {
  const now = Date.parse('2026-11-20T09:00:00Z')
  test("adds up the Gemini quota of Antigravity accounts", () => {
    const reading = (gemini: number) => ({ observed_at: iso(now), signals: { 'antigravity-gemini-remaining': String(gemini), 'antigravity-gemini-reset': seconds(now + H) } })
    const pools = poolLimits([{ provider: 'antigravity', reading: reading(0.5) }, { provider: 'antigravity', reading: reading(0.25) }, { provider: 'antigravity' }], now)
    const gemini = pools.find((p) => p.label === 'Gemini')!
    assert.equal(gemini.accounts, 3)
    assert.equal(gemini.left, 1.75)
    assert.equal(gemini.unread, 1)
  })
})

describe('reading an Antigravity account', () => {
  const account = { name: 'antigravity-a@example.com.json', provider: 'antigravity', account_type: 'oauth', auth_index: 'ag1', project_id: 'proj-123' }

  beforeEach(() => {
    db.exec('DELETE FROM limits; DELETE FROM limit_checks')
    cpa.files = [account]
    cpa.disk = { [account.name]: { type: 'antigravity', email: 'a@example.com' } }
    cpa.calls = []
    google.requests = []
  })

  test('asks through CPA as the Antigravity app, with limit checks off, and keeps the reading', async () => {
    const now = Date.now()
    google.answer = { json: models(now, { 'gemini-3-flash': { left: 0.4, resetsIn: 2 * H } }) }
    assert.equal(limitCheckStatus().enabled, false)
    await checkNext(now)

    assert.equal(cpa.calls.length, 1)
    const call = cpa.calls[0]!
    assert.equal(call.auth_index, 'ag1')
    assert.equal(call.method, 'POST')
    assert.deepEqual(JSON.parse(call.data!), { project: 'proj-123' })
    assert.equal(call.header.Authorization, 'Bearer $TOKEN$')
    assert.match(call.header['User-Agent']!, /^antigravity\/hub\/\d/)
    assert.deepEqual(Object.keys(call.header).sort(), ['Authorization', 'Content-Type', 'User-Agent'])
    assert.equal(google.requests[0]!.path, '/v1internal:fetchAvailableModels')
    assert.equal(google.requests[0]!.headers.authorization, 'Bearer token-of-ag1')

    const reading = limitReadings()[account.name]!
    assert.equal(Date.parse(reading.observed_at!), now)
    assert.equal(limitWindows('antigravity', reading, now)[0]!.left, 0.4)
    assert.equal(limitCheckStatus().accounts[account.name]?.okAt, now)
  })

  test("uses the user agent the account's file sets, as CPA does", async () => {
    cpa.disk[account.name]!.user_agent = 'antigravity/hub/9.9.9 (aidev_client; os_type=linux; arch=x64) google-api-nodejs-client/10.3.0'
    google.answer = { json: models(Date.now(), { 'gemini-3-flash': { left: 1, resetsIn: H } }) }
    await checkNext()
    assert.equal(cpa.calls[0]!.header['User-Agent'], 'antigravity/hub/9.9.9 (aidev_client; os_type=linux; arch=x64)')
  })

  test('a failed reading says why and is tried again later', async () => {
    const now = Date.now()
    google.answer = { status: 403, json: { error: { message: 'The caller does not have permission' } } }
    await checkNext(now)
    assert.equal(limitCheckStatus().accounts[account.name]?.error, 'HTTP 403: The caller does not have permission')
    await checkNext(now + 60_000)
    assert.equal(cpa.calls.length, 1)
  })
})

describe('Antigravity reserve', () => {
  const name = 'antigravity-b@example.com.json'
  const now = Date.parse('2026-11-20T09:00:00Z')
  const reading = (gemini: number, claude: number, at = now) => ({
    observed_at: iso(at),
    signals: {
      'antigravity-gemini-remaining': String(gemini),
      'antigravity-gemini-reset': seconds(now + 2 * H),
      'antigravity-claude-remaining': String(claude),
      'antigravity-claude-reset': seconds(now + 4 * H),
    },
  })

  beforeEach(() => {
    db.exec('DELETE FROM antigravity_hold')
    cpa.files = [{ name, provider: 'antigravity' }]
    cpa.disk = { [name]: { excluded_models: ['gpt-*'] } }
  })

  test('holds a family down to its reserve and releases it when it resets, keeping what the user excluded', async () => {
    await applyAntigravity(cpa.files, { [name]: reading(0.08, 0.5) }, now)
    assert.deepEqual(cpa.disk[name]!.excluded_models, ['gpt-*', 'gemini-*'])
    assert.deepEqual(antigravityStatus(), { [name]: { Gemini: now + 2 * H } })
    assert.deepEqual(antigravityAdded(name), ['gemini-*'])

    // Still short: nothing changes.
    await applyAntigravity(cpa.files, { [name]: reading(0.05, 0.5) }, now + H)
    assert.deepEqual(cpa.disk[name]!.excluded_models, ['gpt-*', 'gemini-*'])

    // Past its reset, the old reading counts as unused.
    await applyAntigravity(cpa.files, { [name]: reading(0.05, 0.5) }, now + 2 * H + 1)
    assert.deepEqual(cpa.disk[name]!.excluded_models, ['gpt-*'])
    assert.deepEqual(antigravityStatus(), {})
  })

  test('leaves a family the user excluded alone', async () => {
    cpa.disk[name]!.excluded_models = ['claude-*']
    await applyAntigravity(cpa.files, { [name]: reading(0.5, 0.01) }, now)
    assert.deepEqual(cpa.disk[name]!.excluded_models, ['claude-*'])
    assert.deepEqual(antigravityStatus(), {})
  })

  test('only holds Antigravity accounts', async () => {
    cpa.files = [{ name, provider: 'claude' }]
    await applyAntigravity(cpa.files, { [name]: reading(0, 0) }, now)
    assert.deepEqual(cpa.disk[name]!.excluded_models, ['gpt-*'])
  })
})
