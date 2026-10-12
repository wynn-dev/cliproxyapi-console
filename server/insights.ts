import { Hono } from 'hono'
import { cacheBreakReport } from './insights-cache.ts'
import { digest } from './insights-digest.ts'
import { forecast } from './insights-forecast.ts'

/** Insights read from the console's own history: run-out forecast, lost prompt caches, weekly digest. Mounted behind auth. */
export const insights = new Hono()

insights.get('/forecast', (c) => c.json(forecast()))
insights.get('/cache-breaks', (c) => {
  const days = Math.min(Math.max(Math.round(Number(c.req.query('days') ?? 7)) || 7, 1), 30)
  return c.json(cacheBreakReport(days, Number(c.req.query('tz') ?? 0) || 0))
})
insights.get('/digest', (c) => c.json(digest()))
