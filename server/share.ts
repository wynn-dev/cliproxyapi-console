import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { paths } from './env.ts'
import { readState, updateState } from './state.ts'
import { usageSummary } from './usage.ts'

/** Share card: a summary of a time range and the PNG snapshots the browser renders of it. Mounted behind auth. */
export const share = new Hono()

const SNAPSHOT_DIR = path.join(paths.data, 'share')
const MAX_SNAPSHOT = 2 * 1024 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** 128 random bits, hex. The only thing that makes a snapshot's public URL hard to guess. */
const SNAPSHOT_FILE = /^[0-9a-f]{32}\.png$/

/** What the card shows for [from, to): the last 7 days now, a calendar month for a later recap. */
export function shareSummary(from: number, to: number) {
  const s = usageSummary({ from, to }, 0)
  const t = s.totals
  const topModel = s.byModel.reduce<(typeof s.byModel)[number] | undefined>((a, b) => (b.total > (a?.total ?? 0) ? b : a), undefined)
  return {
    from,
    to,
    requests: t.requests,
    tokens: t.total,
    value: t.value,
    unpricedTokens: t.unpricedTokens,
    topModel: topModel ? { model: topModel.key, tokens: topModel.total } : null,
    // Cache hit rate = cached input / all input. Input already counts cache reads and writes for
    // every provider (see tokenCounts), so this is cache reads / (uncached + cache reads + cache writes).
    cacheHitRate: t.input ? t.cached / t.input : null,
    // By auth_index, most tokens first. The browser resolves names, or masks them.
    accounts: s.byCredential
      .filter((c) => c.key && c.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((c) => ({ key: c.key, tokens: c.total })),
    planPrice: readState().planPrice ?? null,
  }
}

share.get('/summary', (c) => {
  const q = c.req.query()
  const to = q.to ? Number(q.to) : Date.now()
  const from = q.from ? Number(q.from) : to - 7 * 86_400_000
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return c.json({ error: 'from and to must be times in ms, from before to' }, 400)
  if (to - from > 35 * 86_400_000) return c.json({ error: 'At most 35 days at a time' }, 400)
  return c.json(shareSummary(from, to))
})

share.get('/plan-price', (c) => c.json({ planPrice: readState().planPrice ?? null }))

share.put('/plan-price', async (c) => {
  const { planPrice } = await c.req.json<{ planPrice?: unknown }>().catch(() => ({ planPrice: undefined }))
  if (planPrice !== null && (typeof planPrice !== 'number' || !Number.isFinite(planPrice) || planPrice <= 0 || planPrice > 100_000)) {
    return c.json({ error: 'Plan price must be a dollar amount above 0, or null to clear it' }, 400)
  }
  updateState({ planPrice: planPrice === null ? undefined : Math.round(planPrice * 100) / 100 })
  return c.json({ planPrice: readState().planPrice ?? null })
})

share.post(
  '/snapshots',
  bodyLimit({ maxSize: MAX_SNAPSHOT, onError: (c) => c.json({ error: 'Snapshots can be at most 2 MB' }, 413) }),
  async (c) => {
    if (c.req.header('content-type')?.split(';')[0].trim() !== 'image/png') return c.json({ error: 'Send the snapshot as image/png' }, 415)
    const png = Buffer.from(await c.req.arrayBuffer())
    if (png.length < PNG_MAGIC.length || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return c.json({ error: 'Not a PNG image' }, 400)
    const file = `${crypto.randomBytes(16).toString('hex')}.png`
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(SNAPSHOT_DIR, file), png, { mode: 0o600 })
    return c.json({ url: `/console/share/${file}` }, 201)
  },
)

/** A stored snapshot, served without auth: anyone with the link can see that image and nothing else. */
export function snapshot(file: string) {
  if (!SNAPSHOT_FILE.test(file)) return
  try {
    return fs.readFileSync(path.join(SNAPSHOT_DIR, file))
  } catch {
    return
  }
}
