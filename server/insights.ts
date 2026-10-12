import { Hono } from 'hono'
import { forecast } from './insights-forecast.ts'

/** Insights read from the console's own history. Mounted behind auth. */
export const insights = new Hono()

insights.get('/forecast', (c) => c.json(forecast()))
