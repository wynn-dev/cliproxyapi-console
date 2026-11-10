import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { apiValue, priceFor } from '../server/api-prices.ts'

const M = 1_000_000
const none = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

describe('Claude Fable 5.2 at API prices', () => {
  // USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing.
  test('the model as CPA reports it gets the list price, cache read and write included', () => {
    const value = (t: Partial<typeof none>) => apiValue('claude-fable-5-2', '', { ...none, ...t })
    assert.equal(value({ uncached: M }), 8)
    assert.equal(value({ output: M }), 40)
    assert.equal(value({ cacheRead: M }), 0.2)
    assert.equal(value({ cacheWrite: M }), 10)
    assert.equal(value({ uncached: M, cacheRead: M, cacheWrite: M, output: M }), 58.2)
  })

  test('dated and suffixed names, and Mythos 5.2, fold into the same row', () => {
    const row = priceFor('claude-fable-5-2')
    assert.equal(row?.label, 'Claude Fable and Mythos 5.2')
    for (const name of ['claude-fable-5-2-20261101', 'claude-fable-5-2-thinking', 'claude-fable-5-2(high)', 'claude-fable-5.2', 'claude-mythos-5-2']) {
      assert.equal(priceFor(name), row, name)
    }
    // 5.1 keeps its own, higher price.
    assert.equal(apiValue('claude-fable-5-1', '', { ...none, uncached: M }), 10)
  })

  test('batch is half price; a tier with no list price gets none', () => {
    assert.equal(apiValue('claude-fable-5-2', 'batch', { ...none, uncached: M, output: M }), 24)
    assert.equal(apiValue('claude-fable-5-2', 'priority', { ...none, uncached: M }), undefined)
  })
})
