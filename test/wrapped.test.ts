import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { awards, dayIndex, deriveWrapped } from '../src/lib/wrapped.ts'
import type { ShareSummary } from '../src/lib/types.ts'

/** A summary with only what the wrapped reads, tokens at local `[y, m, d, hour]` times. */
function summary(hours: [number, number, number, number, number][], extra: Partial<ShareSummary> = {}) {
  const series = hours.map(([y, m, d, h, tokens]) => ({ t: new Date(y, m - 1, d, h).getTime(), tokens }))
  const tokens = series.reduce((a, h) => a + h.tokens, 0)
  return {
    tokens,
    requests: 10,
    output: tokens / 2,
    value: 0,
    planPrice: null,
    cacheHitRate: null,
    topModel: null,
    topModels: [],
    sessions: { count: 0, requests: 0, compactions: 0, longest: null },
    hours: series,
    ...extra,
  } as unknown as ShareSummary
}

describe('deriveWrapped', () => {
  test('a month counts its days from the 1st', () => {
    const s = summary([
      [2026, 9, 1, 10, 100],
      [2026, 9, 2, 10, 300],
      [2026, 9, 30, 23, 50],
    ])
    const w = deriveWrapped(s, { from: new Date(2026, 8, 1).getTime(), days: 30 })
    assert.equal(w.perDay.length, 30)
    assert.deepEqual([w.perDay[0], w.perDay[1], w.perDay[29]], [100, 300, 50])
    assert.equal(w.busiest, 1)
    assert.equal(w.months, 1)
    assert.equal(w.allTime, false)
    assert.deepEqual(w.streak, { days: 2, start: 0, end: 1 })
    // September 1, 2026 is a Tuesday.
    assert.equal(w.firstWeekday, 1)
  })

  test('all time runs across months and years, streaks included', () => {
    const s = summary([
      [2025, 12, 30, 9, 10],
      [2025, 12, 31, 9, 10],
      [2026, 1, 1, 9, 10],
      [2026, 1, 2, 9, 500],
      [2026, 3, 1, 9, 10],
    ])
    const from = new Date(2025, 11, 30).getTime()
    const days = dayIndex(from, new Date(2026, 2, 1, 12).getTime()) + 1
    const w = deriveWrapped(s, { from, days, allTime: true })
    // December 30 and 31, January, February and March 1.
    assert.equal(days, 2 + 31 + 28 + 1)
    assert.equal(w.perDay.length, days)
    assert.equal(w.activeDays, 5)
    assert.equal(w.busiest, 3)
    assert.deepEqual(w.streak, { days: 4, start: 0, end: 3 })
    assert.equal(w.months, 4)
    assert.equal(w.perDay[days - 1], 10)
  })
})

describe('awards', () => {
  const month = { from: new Date(2026, 8, 1).getTime(), days: 30 }
  const all = { from: new Date(2026, 6, 1).getTime(), days: 92, allTime: true }

  test('a month says in one month', () => {
    const s = summary([[2026, 9, 3, 10, 2e9]])
    const line = awards(s, deriveWrapped(s, month)).find((a) => a.id === 'billion')?.line
    assert.equal(line, '2B tokens in one month')
  })

  test('all time says all time', () => {
    const s = summary([[2026, 9, 3, 10, 2e9]])
    const line = awards(s, deriveWrapped(s, all)).find((a) => a.id === 'billion')?.line
    assert.equal(line, '2B tokens all time')
    const nine = summary([[2026, 9, 3, 10, 2e8]])
    assert.equal(awards(nine, deriveWrapped(nine, all)).find((a) => a.id === 'hundred-million')?.title, 'Nine-figure club')
  })

  test('all time weighs the value against every month of the plan', () => {
    // $1,000 against a $100 plan: 10× for a month, 10 / 3 over July to September.
    const s = summary([[2026, 9, 3, 10, 100]], { value: 1000, planPrice: 100 })
    assert.equal(awards(s, deriveWrapped(s, month)).find((a) => a.id === 'value')?.line, '10× the plan price in API value')
    assert.equal(awards(s, deriveWrapped(s, all)).find((a) => a.id === 'value'), undefined)
    const big = { ...s, value: 1500 }
    assert.equal(awards(big, deriveWrapped(big, all)).find((a) => a.id === 'value')?.line, '5× what the plan cost in API value')
  })
})
