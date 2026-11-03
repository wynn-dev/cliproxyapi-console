import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, mock, test } from 'node:test'

// paths are fixed when env.ts loads, so point the data dir at a scratch dir before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-order-test-'))
process.env.CPA_CONSOLE_DATA = data
fs.writeFileSync(path.join(data, 'config.yaml'), 'routing:\n  strategy: fill-first\n  session-affinity: true\n')
const { applyOrder, orderStatus } = await import('../server/order.ts')
const { db } = await import('../server/usage.ts')

after(() => fs.rmSync(data, { recursive: true, force: true }))
// CPA isn't running, so the priority writes fail; the order is computed all the same.
mock.method(console, 'error', () => {})
beforeEach(() => db.exec('DELETE FROM account_order'))

const H = 3_600_000
const D = 24 * H
const now = Date.parse('2026-11-03T09:00:00Z')
const P = 'anthropic-ratelimit-unified-'

/** A Claude reading: weekly share left and when it resets, and a 5-hour one if `fiveHourLeft` is given. */
function reading(weeklyLeft: number, weeklyResetsAt: number, fiveHourLeft?: number) {
  const signals: Record<string, string> = {
    [`${P}7d-utilization`]: String(1 - weeklyLeft),
    [`${P}7d-reset`]: String(Math.floor(weeklyResetsAt / 1000)),
  }
  if (fiveHourLeft !== undefined) {
    signals[`${P}5h-utilization`] = String(1 - fiveHourLeft)
    signals[`${P}5h-reset`] = String(Math.floor((now + 4 * H) / 1000))
  }
  return { observed_at: new Date(now - 60_000).toISOString(), signals }
}

// The reported accounts: wynn@ is in use with no 5-hour reading.
const readings = {
  'wynn.json': reading(0.95, now + 5 * D + 20 * H),
  'wlu.json': reading(0.49, now + D + 17 * H, 1),
  'lu.json': reading(0.89, now + 3 * D + H, 1),
}

const files = (priorities: Record<string, number> = {}) =>
  ['wynn.json', 'wlu.json', 'lu.json'].map((name) => ({ name, provider: 'claude', priority: priorities[name] ?? 0 }))

/** The order the card shows, first to last. */
const order = () =>
  Object.entries(orderStatus().accounts)
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([name]) => name)

describe('smart account order', () => {
  test('with equal own priorities, the soonest weekly reset goes first', async () => {
    await applyOrder(files(), readings, now)
    assert.deepEqual(order(), ['wlu.json', 'lu.json', 'wynn.json'])
    assert.ok(Object.values(orderStatus().accounts).every((p) => p.tier === 'first' && !p.ownDiffers))
  })

  test('an account whose week reset moves back once its new week shows', async () => {
    // Last week wynn@ reset soonest, so the console put it first.
    const last = { ...readings, 'wynn.json': reading(0.1, now - D - 4 * H, 1) }
    const listed = files()
    await applyOrder(listed, last, now - 2 * D)
    assert.deepEqual(order(), ['wynn.json', 'wlu.json', 'lu.json'])
    // CPA applies the console's priorities.
    for (const f of listed) f.priority = orderStatus().accounts[f.name].effective
    await applyOrder(listed, readings, now)
    assert.deepEqual(order(), ['wlu.json', 'lu.json', 'wynn.json'])
  })

  test('a higher own priority goes first, and says so', async () => {
    await applyOrder(files({ 'wynn.json': 1 }), readings, now)
    assert.deepEqual(order(), ['wynn.json', 'wlu.json', 'lu.json'])
    const { accounts } = orderStatus()
    assert.equal(accounts['wynn.json'].original, 1)
    assert.ok(Object.values(accounts).every((p) => p.ownDiffers))
  })
})
