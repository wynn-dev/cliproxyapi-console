import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, mock, test } from 'node:test'

// paths are fixed when the server modules load, so set them before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-gauges-test-'))
process.env.CPA_CONSOLE_DATA = data
fs.writeFileSync(path.join(data, 'config.yaml'), 'management:\n  secret-key: test-key\n')
fs.writeFileSync(path.join(data, 'console.json'), JSON.stringify({ managementKey: 'test-key', autostart: false }))
mock.method(console, 'error', () => {})
mock.method(console, 'log', () => {})
const { app } = await import('../server/app.ts')
const { readState } = await import('../server/state.ts')
const { gaugeKey } = await import('../src/lib/limits.ts')
after(() => fs.rmSync(data, { recursive: true, force: true }))

/** What @hono/node-server gives a request, which the console reads the client's address from. */
const node = { incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 50000, remoteFamily: 'IPv4' } } }

const call = (method: string, body?: unknown) =>
  app.request(
    '/console/api/gauges',
    { method, headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
    node,
  )

describe('Overview gauges', () => {
  test('shows every gauge until the user hides one', async () => {
    const res = await call('GET')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { hidden: [] })
  })

  test('hides and shows one gauge at a time, saved with the console settings', async () => {
    assert.deepEqual(await (await call('PATCH', { gauge: gaugeKey('codex', 'Weekly'), shown: false })).json(), { hidden: ['codex:Weekly'] })
    // Hiding it again changes nothing.
    assert.deepEqual(await (await call('PATCH', { gauge: gaugeKey('codex', 'Weekly'), shown: false })).json(), { hidden: ['codex:Weekly'] })
    assert.deepEqual(await (await call('PATCH', { gauge: gaugeKey('claude', 'Fable'), shown: false })).json(), { hidden: ['codex:Weekly', 'claude:Fable'] })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'console.json'), 'utf8')).hiddenGauges, ['codex:Weekly', 'claude:Fable'])
    assert.deepEqual(await (await call('PATCH', { gauge: gaugeKey('codex', 'Weekly'), shown: true })).json(), { hidden: ['claude:Fable'] })
    assert.deepEqual(await (await call('GET')).json(), { hidden: ['claude:Fable'] })
  })

  test('toggles sent at once each stick', async () => {
    await Promise.all([
      call('PATCH', { gauge: gaugeKey('claude', '5h'), shown: false }),
      call('PATCH', { gauge: gaugeKey('claude', 'Weekly'), shown: false }),
      call('PATCH', { gauge: gaugeKey('claude', 'Fable'), shown: true }),
    ])
    assert.deepEqual(new Set(readState().hiddenGauges), new Set(['claude:5h', 'claude:Weekly']))
  })

  test('refuses anything but one gauge name and whether it is shown', async () => {
    for (const body of [{}, { gauge: 'claude:5h' }, { gauge: '', shown: false }, { gauge: 1, shown: false }, { gauge: 'claude:5h', shown: 'no' }, { hidden: ['claude:5h'] }]) {
      assert.equal((await call('PATCH', body)).status, 400)
    }
    assert.equal((await call('PUT', { hidden: [] })).status, 404)
    assert.deepEqual(new Set(readState().hiddenGauges), new Set(['claude:5h', 'claude:Weekly']))
  })

  test('needs the management key', async () => {
    const res = await app.request('/console/api/gauges', {}, node)
    assert.equal(res.status, 401)
  })
})
