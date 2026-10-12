import { Hono } from 'hono'
import { cacheBreakReport } from './insights-cache.ts'
import { forecast } from './insights-forecast.ts'

/** Insights read from the console's own history. Mounted behind auth. */
export const insights = new Hono()

insights.get('/forecast', (c) => c.json(forecast()))
insights.get('/cache-breaks', (c) => {
  const days = Math.min(Math.max(Math.round(Number(c.req.query('days') ?? 7)) || 7, 1), 30)
  return c.json(cacheBreakReport(days, Number(c.req.query('tz') ?? 0) || 0))
})
