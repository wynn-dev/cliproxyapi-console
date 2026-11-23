import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

// paths are fixed when env.ts loads, so point the data dir at a scratch dir before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-rollup-test-'))
process.env.CPA_CONSOLE_DATA = data
const { db, usageFacets, usageSummary } = await import('../server/usage.ts')

after(() => fs.rmSync(data, { recursive: true, force: true }))

const SLOT = 900_000
const HOUR = 3_600_000
// Whole slots, so tests can put attempts on either side of a slot boundary.
const T0 = Math.floor((Date.now() - 3 * 86_400_000) / SLOT) * SLOT

interface Attempt {
  ts: number
  id?: string
  failed?: boolean
  model?: string
  auth?: string
  input?: number
  output?: number
}

function add({ ts, id = '', failed = false, model = 'm', auth = 'a', input = 10, output = 5 }: Attempt) {
  db.prepare(
    `INSERT INTO requests (ts, request_id, failed, model, provider, auth_index, api_key, input_tokens, output_tokens, total_tokens, latency_ms)
     VALUES (?, ?, ?, ?, 'p', ?, 'k', ?, ?, ?, 100)`,
  ).run(ts, id, failed ? 1 : 0, model, auth, input, output, input + output)
}

const summary = (from: number, to: number, f: object = {}) => usageSummary({ from, to, ...f }, 0)
const pick = ({ requests, failed, recovered, attempts, failedAttempts, turnedAway, input, output }: Record<string, number>) => ({
  requests,
  failed,
  recovered,
  attempts,
  failedAttempts,
  turnedAway,
  input,
  output,
})

describe('usage rollup', () => {
  beforeEach(() => db.exec('DELETE FROM requests; DELETE FROM turned_away'))

  test('a failed attempt and its retry on another account are one recovered request', () => {
    add({ ts: T0 + SLOT - 1000, id: 'r1', failed: true, auth: 'a' })
    add({ ts: T0 + SLOT + 1000, id: 'r1', auth: 'b' })
    const s = summary(T0 - HOUR, T0 + 12 * HOUR)
    assert.deepEqual(pick(s.totals), { requests: 1, failed: 0, recovered: 1, attempts: 2, failedAttempts: 1, turnedAway: 0, input: 20, output: 10 })
    assert.deepEqual(
      s.byCredential.map((c) => [c.key, c.requests, c.failed]).sort(),
      [
        ['a', 1, 1],
        ['b', 1, 0],
      ],
    )
  })

  test('a success that arrives later turns an already summed failure into a recovery', () => {
    add({ ts: T0 + 1000, id: 'r1', failed: true })
    assert.deepEqual(pick(summary(T0, T0 + 12 * HOUR).totals), { requests: 1, failed: 1, recovered: 0, attempts: 1, failedAttempts: 1, turnedAway: 0, input: 10, output: 5 })
    add({ ts: T0 + 2 * HOUR, id: 'r1' })
    const s = summary(T0, T0 + 12 * HOUR)
    assert.equal(s.totals.failed, 0)
    assert.equal(s.totals.recovered, 1)
    assert.equal(summary(T0, T0 + 12 * HOUR, { status: 'failed' }).totals.requests, 0)
    assert.equal(summary(T0, T0 + 12 * HOUR, { status: 'ok' }).totals.attempts, 2)
  })

  test('each success ends a request when one request_id carries several turns', () => {
    add({ ts: T0 + 1000, id: 'ws' })
    add({ ts: T0 + 2000, id: 'ws', failed: true })
    add({ ts: T0 + 3000, id: 'ws' })
    add({ ts: T0 + 4000, id: 'ws', failed: true })
    assert.deepEqual(pick(summary(T0, T0 + 12 * HOUR).totals), { requests: 3, failed: 1, recovered: 1, attempts: 4, failedAttempts: 2, turnedAway: 0, input: 40, output: 20 })
  })

  test('turned-away requests follow inserts, updates and deletes', () => {
    db.prepare("INSERT INTO turned_away (ts, request_id, status_code, model) VALUES (?, 'x', 429, '')").run(T0 + 1000)
    assert.equal(summary(T0, T0 + 12 * HOUR).totals.turnedAway, 1)
    db.exec("UPDATE turned_away SET model = 'late'")
    const s = summary(T0, T0 + 12 * HOUR)
    assert.deepEqual(
      s.byModel.map((m) => [m.key, m.requests, m.failed, m.turnedAway]),
      [['late', 1, 1, 1]],
    )
    assert.equal(summary(T0, T0 + 12 * HOUR, { status: 'turned_away' }).totals.requests, 1)
    assert.equal(summary(T0, T0 + 12 * HOUR, { authIndex: 'a' }).totals.requests, 0)
    db.exec('DELETE FROM turned_away')
    assert.equal(summary(T0, T0 + 12 * HOUR).totals.requests, 0)
  })

  test('ranges that cut through a slot count only what lies inside them', () => {
    for (let i = 0; i < 8; i++) {
      add({ ts: T0 + i * 5 * 60_000, model: `m${i % 2}` })
      add({ ts: T0 + 12 * HOUR + i * 5 * 60_000, model: 'm2' })
    }
    // From 7 minutes past the first slot to 22 minutes past the one 12 hours later: 6 and 5 attempts.
    const s = summary(T0 + 7 * 60_000, T0 + 12 * HOUR + 22 * 60_000)
    assert.equal(s.totals.requests, 11)
    assert.deepEqual(
      s.byModel.map((m) => [m.key, m.requests]).sort(),
      [
        ['m0', 3],
        ['m1', 3],
        ['m2', 5],
      ],
    )
    assert.deepEqual(usageFacets(T0 + 7 * 60_000, T0 + 12 * HOUR).models, ['m0', 'm1'])
    assert.deepEqual(usageFacets(T0 + 36 * 60_000, T0 + 12 * HOUR).models, [])
  })

  test('summing slots gives what the attempts give', () => {
    let seed = 1
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    const batch = () => {
      for (let i = 0; i < 300; i++) {
        const ts = T0 + Math.floor(random() * 24 * HOUR)
        const id = random() < 0.9 ? `r${Math.floor(random() * 250)}` : ''
        add({ ts, id, failed: random() < 0.3, model: `m${Math.floor(random() * 3)}`, auth: `a${Math.floor(random() * 3)}`, input: Math.floor(random() * 1000) })
      }
    }
    // A 24-hour range adds up slots; 6 hours or less sums the attempts themselves (one-minute buckets
    // and less): both must agree, also after more attempts land in slots already summed.
    for (let round = 0; round < 2; round++) {
      batch()
      const whole = summary(T0, T0 + 24 * HOUR)
      const parts = [0, 1, 2, 3].map((q) => summary(T0 + q * 6 * HOUR, T0 + (q + 1) * 6 * HOUR))
      assert.ok(whole.bucketMs >= SLOT && parts[0].bucketMs < SLOT)
      for (const key of ['requests', 'failed', 'recovered', 'attempts', 'failedAttempts', 'input', 'output', 'total'] as const) {
        assert.equal(whole.totals[key], parts.reduce((n, p) => n + p.totals[key], 0), key)
      }
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM usage_rollup_dirty').get() as { n: number }).n, 0)
  })
})
