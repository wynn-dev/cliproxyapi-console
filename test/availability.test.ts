import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type PoolAccount, type PoolHold, poolAvailability, turnedOff } from '../server/availability.ts'

const now = Date.parse('2026-11-23T12:00:00Z')

const accounts: PoolAccount[] = [
  { name: 'on.json', provider: 'claude' },
  { name: 'off.json', provider: 'claude', disabled: true },
  { name: 'off-status.json', provider: 'claude', status: 'disabled' },
  { name: 'reserved.json', provider: 'claude', disabled: true },
  { name: 'signed-out.json', provider: 'claude', disabled: true },
  { name: 'codex-off.json', provider: 'codex', disabled: true },
]
const holds: Record<string, PoolHold> = {
  'reserved.json': { reason: 'reserve', until: now + 3_600_000 },
  'signed-out.json': { reason: 'signed-out', until: 0 },
}
const holdOf = (name: string) => holds[name]
/** What the Overview lists and counts. */
const overview = (list: PoolAccount[]) => list.filter((a) => !turnedOff(a, holdOf(a.name)))

test('the Overview leaves out accounts turned off by hand, not those the console holds back', () => {
  assert.deepEqual(
    overview(accounts).map((a) => a.name),
    ['on.json', 'reserved.json', 'signed-out.json'],
  )
})

test('accounts turned off by hand are not counted in the Overview totals', () => {
  assert.deepEqual(poolAvailability(overview(accounts), holdOf, now), [
    {
      provider: 'claude',
      total: 3,
      available: 1,
      held: { reserved: { count: 1, until: now + 3_600_000 }, 'signed-out': { count: 1 } },
    },
  ])
})

test('enabling an account brings it back on the Overview', () => {
  const enabled = accounts.map((a) => (a.name === 'off.json' ? { ...a, disabled: false } : a))
  assert.ok(overview(enabled).some((a) => a.name === 'off.json'))
  assert.equal(poolAvailability(overview(enabled), holdOf, now)[0]!.available, 2)
})
