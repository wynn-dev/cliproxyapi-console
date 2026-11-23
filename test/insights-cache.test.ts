import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'

// paths are fixed when env.ts loads, so point the data dir at a scratch dir before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-cache-breaks-test-'))
process.env.CPA_CONSOLE_DATA = data
const { db, clearUsage } = await import('../server/usage.ts')
const { cacheBreaks } = await import('../server/insights-cache.ts')

after(() => fs.rmSync(data, { recursive: true, force: true }))

const MINUTE = 60_000
const DAY = 86_400_000

/** Two requests of one session a minute apart; the second sends its 50k-token cache again. */
function lostCache(ts: number, session: string) {
  const add = db.prepare(
    `INSERT INTO requests (ts, request_id, failed, model, provider, auth_index, session_id, input_tokens, cached_tokens, cache_write_tokens, latency_ms)
     VALUES (?, ?, 0, 'm', 'claude', 'a', ?, 60000, 0, ?, 1000)`,
  )
  add.run(ts, `${session}-1`, session, 50_000)
  add.run(ts + MINUTE, `${session}-2`, session, 55_000)
}

describe('cache-break detector', () => {
  test('finds breaks when it first ran with no recent history', () => {
    const now = Date.now()
    db.prepare("INSERT INTO requests (ts, request_id, failed, model, session_id) VALUES (?, 'old', 0, 'm', 'old')").run(now - 60 * DAY)
    assert.equal(cacheBreaks(now - DAY, now).breaks.length, 0)
    lostCache(now, 's1')
    const later = cacheBreaks(now - DAY, now + 2 * MINUTE)
    assert.deepEqual(later.breaks.map((b) => b.sessionId), ['s1'])
    assert.equal(later.sessions, 1)
  })

  test('forgets its breaks when usage is cleared, and sees new ones after', () => {
    const now = Date.now()
    assert.equal(cacheBreaks(now - DAY, now + 2 * MINUTE).breaks.length, 1)
    clearUsage()
    assert.deepEqual(cacheBreaks(now - DAY, now + 2 * MINUTE), { breaks: [], sessions: 0 })
    lostCache(now + 5 * MINUTE, 's2')
    assert.deepEqual(cacheBreaks(now - DAY, now + 10 * MINUTE).breaks.map((b) => b.sessionId), ['s2'])
  })
})
