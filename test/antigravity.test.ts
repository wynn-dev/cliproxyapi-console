import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, describe, mock, test } from 'node:test'

/**
 * Gemini subscriptions signed in through Antigravity. Every request for them must look exactly like
 * the Antigravity app's, so the console itself never sends one: these tests hold it to that.
 */

const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

type Answer = { status?: number; json: unknown }

/** A JSON server on this machine, on a port of its own. */
async function serve(handler: (req: { method: string; url: URL; body: string }) => Answer | Promise<Answer>) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', async () => {
      const out = await handler({ method: req.method ?? 'GET', url: new URL(req.url ?? '/', 'http://127.0.0.1'), body })
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  after(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// Claude's usage endpoint, mocked, so the limit checks have an account they may read.
const claudeUrl = await serve(() => ({
  json: { five_hour: { utilization: 10, resets_at: iso(Date.now() + 2 * H) }, seven_day: { utilization: 20, resets_at: iso(Date.now() + 3 * 24 * H) } },
}))

// CPA's management API, as much of it as the limit checks and the sign-in check use.
const cpa = {
  files: [] as Record<string, unknown>[],
  /** Every call the console asked CPA to make upstream. */
  calls: [] as { auth_index: string; url: string }[],
}
const cpaUrl = await serve(async ({ method, url, body }) => {
  const route = `${method} ${url.pathname.replace('/v8/management', '')}`
  const sent = body ? JSON.parse(body) : {}
  if (route === 'GET /credentials') return { json: { files: cpa.files } }
  if (route === 'GET /credentials/download') return { json: {} }
  if (route === 'PATCH /credentials/status') {
    Object.assign(cpa.files.find((f) => f.name === sent.name) ?? {}, { disabled: sent.disabled })
    return { json: { status: 'ok' } }
  }
  if (route === 'POST /requests/api-call') {
    cpa.calls.push(sent)
    if (new URL(sent.url).hostname !== '127.0.0.1') return { status: 502, json: { error: 'not this machine' } }
    const answer = await fetch(sent.url, { method: sent.method, body: sent.data })
    return { json: { status_code: answer.status, body: await answer.text() } }
  }
  return { status: 404, json: { error: `no ${route}` } }
})

// paths and the endpoints are fixed when the server modules load, so set them before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-antigravity-test-'))
process.env.CPA_CONSOLE_DATA = data
process.env.CPA_CONSOLE_CLAUDE_USAGE_URL = `${claudeUrl}/api/oauth/usage`
fs.writeFileSync(path.join(data, 'config.yaml'), 'management:\n  secret-key: test-key\n')
fs.writeFileSync(path.join(data, 'console.json'), JSON.stringify({ managementKey: 'test-key', limitChecks: true }))
mock.method(console, 'error', () => {})
mock.method(console, 'log', () => {})
const { checkNext } = await import('../server/limit-checks.ts')
const { applySignIn } = await import('../server/sign-in.ts')
const { reserveStatus } = await import('../server/reserve.ts')
const { supervisor } = await import('../server/supervisor.ts')
const { limitWindows, poolLimits } = await import('../src/lib/limits.ts')

supervisor.state = 'running'
supervisor.port = Number(new URL(cpaUrl).port)
after(() => fs.rmSync(data, { recursive: true, force: true }))

const antigravity = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  provider: 'antigravity',
  account_type: 'oauth',
  auth_index: `idx-${name}`,
  project_id: 'proj-1',
  ...extra,
})

describe('Antigravity accounts', () => {
  test('limit checks never send a request for them, even with checks on and no reading', async () => {
    cpa.files = [antigravity('antigravity-a@example.com.json'), { name: 'claude-a.json', provider: 'claude', account_type: 'oauth', auth_index: 'idx-claude' }]
    cpa.calls = []
    await checkNext()
    await checkNext()
    // The Claude account was read (its limits, then its Fable reset); nothing was asked for the Antigravity one.
    assert.ok(cpa.calls.length > 0)
    assert.deepEqual(new Set(cpa.calls.map((c) => c.auth_index)), new Set(['idx-claude']))
  })

  test('have no limits, and are left out of the limits added up across accounts', () => {
    const now = Date.now()
    assert.deepEqual(limitWindows('antigravity', { observed_at: iso(now), signals: { 'x-anything': '1' } }, now), [])
    assert.deepEqual(poolLimits([{ provider: 'antigravity' }, { provider: 'antigravity' }], now), [])
  })

  test('one CPA says needs a new sign-in is taken out of rotation, like Claude and Codex accounts', async () => {
    const dead = antigravity('antigravity-dead@example.com.json', { status: 'error', status_message: 'unauthorized (refresh token invalid)' })
    cpa.files = [dead, antigravity('antigravity-ok@example.com.json')]
    await applySignIn(cpa.files)
    assert.equal(dead.disabled, true)
    assert.equal(reserveStatus().accounts[dead.name]?.reason, 'signed-out')
  })
})
