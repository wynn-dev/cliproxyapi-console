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

  test('saves the hidden gauges with the console settings, once each', async () => {
    const hidden = [gaugeKey('codex', 'Weekly'), gaugeKey('claude', 'Fable'), gaugeKey('codex', 'Weekly')]
    const res = await call('PUT', { hidden })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { hidden: ['codex:Weekly', 'claude:Fable'] })
    assert.deepEqual(readState().hiddenGauges, ['codex:Weekly', 'claude:Fable'])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'console.json'), 'utf8')).hiddenGauges, ['codex:Weekly', 'claude:Fable'])
    assert.deepEqual(await (await call('GET')).json(), { hidden: ['codex:Weekly', 'claude:Fable'] })
  })

  test('refuses anything but a list of names', async () => {
    for (const hidden of [undefined, 'claude:5h', [1], [''], Array.from({ length: 201 }, (_, i) => `x:${i}`)]) {
      assert.equal((await call('PUT', { hidden })).status, 400)
    }
    assert.deepEqual(readState().hiddenGauges, ['codex:Weekly', 'claude:Fable'])
  })

  test('needs the management key', async () => {
    const res = await app.request('/console/api/gauges', {}, node)
    assert.equal(res.status, 401)
  })
})
