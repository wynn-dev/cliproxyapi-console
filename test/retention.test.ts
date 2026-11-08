import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

// paths are fixed when env.ts loads, so point the data dir at a scratch dir before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-retention-test-'))
process.env.CPA_CONSOLE_DATA = data
delete process.env.USAGE_RETENTION_DAYS
const { env } = await import('../server/env.ts')
const { db, pruneUsage, usageSummary } = await import('../server/usage.ts')
const { pruneLimitHistory } = await import('../server/limit-history.ts')

after(() => fs.rmSync(data, { recursive: true, force: true }))

const D = 86_400_000
const now = Date.now()
const ages = [1, 89, 91, 400]

function seed() {
  for (const t of ['requests', 'turned_away', 'limit_history']) db.exec(`DELETE FROM ${t}`)
  for (const days of ages) {
    const ts = now - days * D
    db.prepare('INSERT INTO requests (ts, request_id, failed) VALUES (?, ?, 0)').run(ts, `r${days}`)
    db.prepare('INSERT INTO turned_away (ts, request_id, status_code) VALUES (?, ?, 429)').run(ts, `t${days}`)
    db.prepare("INSERT INTO limit_history (name, window_id, ts, used) VALUES ('a.json', '5h', ?, 0.5)").run(ts)
  }
}

/** Age in days of each row left in `table`, newest first. */
const left = (table: string) =>
  (db.prepare(`SELECT ts FROM ${table} ORDER BY ts DESC`).all() as { ts: number }[]).map((r) => Math.round((now - r.ts) / D))

const prune = () => {
  pruneUsage()
  pruneLimitHistory()
}

describe('history retention', () => {
  beforeEach(seed)

  test('unset keeps every row', () => {
    assert.equal(env.usageRetentionDays, 0)
    prune()
    for (const t of ['requests', 'turned_away', 'limit_history']) assert.deepEqual(left(t), ages, t)
  })

  test('0 keeps every row', (t) => {
    t.after(() => (env.usageRetentionDays = 0))
    env.usageRetentionDays = 0
    prune()
    for (const t of ['requests', 'turned_away', 'limit_history']) assert.deepEqual(left(t), ages, t)
  })

  test('N days drops rows older than N days', (t) => {
    t.after(() => (env.usageRetentionDays = 0))
    env.usageRetentionDays = 90
    prune()
    for (const t of ['requests', 'turned_away', 'limit_history']) assert.deepEqual(left(t), [1, 89], t)
  })
})

describe('all-time summary', () => {
  beforeEach(seed)

  test('starts at the first record in Monday-aligned weeks', () => {
    const s = usageSummary({ from: 0, to: now }, 0)
    assert.equal(s.bucketMs, 7 * D)
    assert.equal(s.totals.requests, 8)
    assert.ok(s.series.length <= 60, `${s.series.length} points`)
    assert.ok(s.series[0].t <= now - 400 * D && s.series[0].t > now - 407 * D)
    for (const p of s.series) assert.equal(new Date(p.t).getUTCDay(), 1)
    assert.equal(s.series.reduce((n, p) => n + p.requests, 0), 8)
  })
})
