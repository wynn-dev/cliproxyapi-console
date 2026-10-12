import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { proxy } from 'hono/proxy'
import { accessLog } from './access-log.ts'
import { authenticate, extractKey } from './auth.ts'
import { failInstall, installProgress, installRelease, installedVersion, latestRelease } from './binary.ts'
import { configExists, readCpaConfig, writeInitialConfig } from './cpa-config.ts'
import { PACKAGE, defaults, env, paths } from './env.ts'
import { insights } from './insights.ts'
import { limitHistory } from './limit-history.ts'
import { limitReadings } from './limits.ts'
import { orderStatus, setOrderEnabled, setOwnPriority } from './order.ts'
import { type ReserveLimits, reserveStatus, setHoldExtraUsage, setReserveLimits } from './reserve.ts'
import { readState, updateState } from './state.ts'
import { supervisor } from './supervisor.ts'
import { networkAddresses } from './urls.ts'
import { clearUsage, collector, type UsageFilter, usageFacets, usageRequests, usageSummary } from './usage.ts'

const pkg = JSON.parse(fs.readFileSync(path.join(paths.root, 'package.json'), 'utf8')) as { version: string }

const setupTokenFile = path.join(paths.data, 'setup-token')

/**
 * One-time token required to claim a fresh install over the network. It is printed as part of the
 * setup link and persisted so the link survives restarts (and `service install` can show it).
 */
export const setupToken = configExists() ? undefined : readOrCreateSetupToken()

function readOrCreateSetupToken() {
  try {
    return fs.readFileSync(setupTokenFile, 'utf8').trim()
  } catch {
    const token = crypto.randomBytes(9).toString('base64url')
    fs.mkdirSync(paths.data, { recursive: true })
    fs.writeFileSync(setupTokenFile, token, { mode: 0o600 })
    return token
  }
}

function clientIp(c: Context) {
  const forwarded = env.trustProxy ? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() : undefined
  return forwarded || getConnInfo(c).remote.address || 'unknown'
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

let installing: Promise<void> | undefined

/** Installs the latest CPA release unless one is installed. Concurrent callers share one download. */
function ensureInstalled() {
  if (installedVersion()) return Promise.resolve()
  installing ??= latestRelease()
    .then(({ tag }) => installRelease(tag))
    .catch((err) => {
      failInstall(err)
      throw err
    })
    .finally(() => (installing = undefined))
  return installing
}

/**
 * Installs CPA if needed (already during first-run setup, so the download overlaps with the form),
 * then starts it once a config exists. Safe to call repeatedly.
 */
export async function ensureInstalledAndStart() {
  await ensureInstalled()
  if (configExists() && readState().autostart) supervisor.start()
}

export const app = new Hono()

// The SPA keeps the management key in localStorage, so it must never be framed by another site.
app.use('*', async (c, next) => {
  await next()
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "frame-ancestors 'none'")
  c.header('X-Content-Type-Options', 'nosniff')
})

// --- Public: first-run state and setup -------------------------------------------------------

app.get('/console/api/state', (c) =>
  c.json({ configured: configExists(), installing: installProgress(), consoleVersion: pkg.version }),
)

app.post('/console/api/setup', async (c) => {
  if (configExists()) return c.json({ error: 'Already set up' }, 409)
  const body = await c.req.json<{ setupToken?: string; managementKey?: string; host?: string; port?: number }>()
  // No token means config.yaml vanished while running; require a restart (which prints a new link).
  if (!setupToken) return c.json({ error: 'Restart the console to get a new setup link' }, 403)
  if (!safeEqual(body.setupToken?.trim() ?? '', setupToken)) return c.json({ error: 'Invalid setup token' }, 403)
  const key = body.managementKey?.trim() ?? ''
  if (key.length < 12) return c.json({ error: 'Management key must be at least 12 characters' }, 400)
  const port = Number(body.port ?? 8317)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return c.json({ error: 'Invalid port' }, 400)

  writeInitialConfig({ managementKey: key, host: body.host?.trim() ?? '', port })
  updateState({ managementKey: key, autostart: true })
  fs.rmSync(setupTokenFile, { force: true })
  ensureInstalledAndStart().catch(() => {}) // progress is reported through /status
  return c.json({ status: 'ok' })
})

// --- Public: health check for uptime monitors ------------------------------------------------

/** CPA drops queued usage records after an hour, so warn well before that. */
const USAGE_STALE_MS = 10 * 60_000

/** `ok`, or why not: CPA's process state, `unresponsive`, `not-installed` or `not-set-up`. */
function healthStatus() {
  if (!configExists()) return 'not-set-up'
  if (!installedVersion()) return 'not-installed'
  if (supervisor.state !== 'running') return supervisor.state
  return supervisor.lastCheck?.ok ? 'ok' : 'unresponsive'
}

/**
 * 200 while CPA is running and answered its last liveness check, 503 otherwise. Unauthenticated, so
 * it only reports cached states, times and counts: no keys, paths or account names, and no calls to CPA.
 */
function health(c: Context) {
  const p = supervisor
  const status = healthStatus()
  // Nothing to collect while CPA is down; otherwise count from the later of the last sync and CPA's start.
  const syncedOrStarted = Math.max(collector.lastPollAt, (p.state === 'running' && p.startedAt) || 0)
  const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null)
  c.header('Cache-Control', 'no-store')
  return c.json(
    {
      status,
      consoleVersion: pkg.version,
      cpa: {
        state: p.state,
        uptimeSeconds: p.state === 'running' && p.startedAt ? Math.round((Date.now() - p.startedAt) / 1000) : null,
        restarts: p.restarts,
        lastCheck: p.lastCheck ? { ok: p.lastCheck.ok, at: iso(p.lastCheck.at) } : null,
        lastUnresponsiveRestartAt: iso(p.lastHangAt),
      },
      usage: {
        lastSyncAt: iso(collector.lastPollAt),
        stale: p.state === 'running' && Date.now() - syncedOrStarted > USAGE_STALE_MS,
      },
    },
    status === 'ok' ? 200 : 503,
  )
}

// Also with a trailing slash, which would otherwise get the SPA's 200 and keep a monitor green.
app.get('/console/health', health)
app.get('/console/health/', health)

// --- Authenticated --------------------------------------------------------------------------

app.use('/console/api/*', async (c, next) => {
  const result = authenticate(clientIp(c), extractKey(c.req.raw.headers))
  if (!result.ok) return c.json({ error: result.error }, result.status)
  await next()
})

app.get('/console/api/status', (c) => {
  const cfg = readCpaConfig()
  return c.json({
    consoleVersion: pkg.version,
    dataDir: paths.data,
    process: supervisor.snapshot(),
    cpa: { version: installedVersion() ?? null, install: installProgress() ?? null },
    config: cfg ? { host: cfg.host, port: cfg.port, tls: cfg.tls, clientKeys: cfg.clientKeys } : null,
    addresses: networkAddresses(),
    service: env.service,
    serviceCommand: consoleCommand(true),
    collector: { lastPollAt: collector.lastPollAt || null, lastError: collector.lastError ?? null, accessLogError: accessLog.lastError ?? null },
  })
})

app.post('/console/api/process/:action', async (c) => {
  const action = c.req.param('action')
  if (action === 'start') {
    updateState({ autostart: true })
    supervisor.start()
  } else if (action === 'stop') {
    updateState({ autostart: false })
    await supervisor.stop()
  } else if (action === 'restart') {
    updateState({ autostart: true })
    await supervisor.restart()
  } else {
    return c.json({ error: 'Unknown action' }, 404)
  }
  return c.json(supervisor.snapshot())
})

app.get('/console/api/limits', (c) => c.json(limitReadings()))
app.get('/console/api/limits/history', (c) => {
  const q = c.req.query()
  const to = q.to ? Number(q.to) : Date.now()
  const from = q.from ? Number(q.from) : to - 7 * 86_400_000
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return c.json({ error: 'from and to must be times in ms, from before to' }, 400)
  if (to - from > 35 * 86_400_000) return c.json({ error: 'At most 35 days at a time' }, 400)
  return c.json(limitHistory(from, to, q.name || undefined, { previous: q.previous === '1' || q.previous === 'true' }))
})

app.route('/console/api/insights', insights)

app.get('/console/api/reserve', (c) => c.json(reserveStatus()))

app.put('/console/api/reserve', async (c) => {
  const body: Partial<Record<keyof ReserveLimits | 'extraUsage', unknown>> = await c.req.json().catch(() => ({}))
  const patch: Partial<ReserveLimits> = {}
  for (const id of ['5h', 'weekly'] as const) {
    const v = body[id]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 90) return c.json({ error: 'Reserve must be a whole percent from 0 to 90' }, 400)
    patch[id] = v
  }
  if (body.extraUsage !== undefined && typeof body.extraUsage !== 'boolean') return c.json({ error: 'extraUsage must be true or false' }, 400)
  setReserveLimits(patch)
  if (body.extraUsage !== undefined) setHoldExtraUsage(body.extraUsage)
  return c.json(reserveStatus())
})

app.get('/console/api/order', (c) => c.json(orderStatus()))

app.put('/console/api/order', async (c) => {
  const { enabled } = await c.req.json<{ enabled?: unknown }>().catch(() => ({ enabled: undefined }))
  if (typeof enabled !== 'boolean') return c.json({ error: 'enabled must be true or false' }, 400)
  setOrderEnabled(enabled)
  return c.json(orderStatus())
})

// While the console sets priorities, an edit in the UI is the account's own priority.
app.put('/console/api/order/own', async (c) => {
  const { name, priority } = await c.req.json<{ name?: unknown; priority?: unknown }>().catch(() => ({ name: undefined, priority: undefined }))
  if (typeof name !== 'string' || !name) return c.json({ error: 'name is required' }, 400)
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) return c.json({ error: 'Priority must be a whole number' }, 400)
  if (!orderStatus().active) return c.json({ error: 'Smart account order is not managing priorities' }, 409)
  setOwnPriority(name, priority)
  return c.json(orderStatus())
})

app.get('/console/api/process/output', (c) => c.json(supervisor.output(Number(c.req.query('after') ?? 0))))

let consoleLatest: { at: number; version: string } | undefined

/** Runs, or installs as a service, the latest nightly with this console's options. */
function consoleCommand(service = env.service) {
  const args = ['npx', '-y', PACKAGE]
  if (service) args.push('service', 'install')
  if (paths.data !== defaults.data) args.push('--data', paths.data)
  if (env.port !== defaults.port) args.push('--port', String(env.port))
  if (env.host !== defaults.host) args.push('--host', env.host)
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/** Newest console nightly: the npm package's `latest` tag. */
app.get('/console/api/console/latest', async (c) => {
  if (!consoleLatest || Date.now() - consoleLatest.at > 30 * 60_000) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      consoleLatest = { at: Date.now(), version: ((await res.json()) as { version: string }).version }
    } catch (err) {
      return c.json({ error: `Could not check for console updates: ${(err as Error).message}` }, 502)
    }
  }
  return c.json({ current: pkg.version, latest: consoleLatest.version, service: env.service, command: consoleCommand() })
})

app.get('/console/api/release/latest', async (c) => {
  try {
    return c.json(await latestRelease(c.req.query('force') === '1'))
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502)
  }
})

app.post('/console/api/release/install', async (c) => {
  const { tag } = await c.req.json<{ tag?: string }>().catch(() => ({ tag: undefined }))
  let target = tag
  try {
    target ??= (await latestRelease(true)).tag
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502)
  }
  const wasRunning = supervisor.state !== 'stopped'
  // Also covers retrying a failed first install: start afterwards unless the user stopped CPA.
  const restart = () => (wasRunning || readState().autostart) && configExists() && supervisor.start()
  installRelease(target, async () => {
    if (wasRunning) await supervisor.stop()
  }).then(restart, restart)
  return c.json({ status: 'installing', tag: target }, 202)
})

function usageFilter(c: Context): UsageFilter {
  const q = c.req.query()
  return {
    from: Number(q.from ?? Date.now() - 86_400_000),
    to: Number(q.to ?? Date.now()),
    model: q.model,
    provider: q.provider,
    authIndex: q.authIndex,
    apiKey: q.apiKey,
    status: q.status === 'ok' || q.status === 'failed' || q.status === 'turned_away' ? q.status : undefined,
  }
}

app.get('/console/api/usage/summary', (c) => c.json(usageSummary(usageFilter(c), Number(c.req.query('tz') ?? 0))))
app.get('/console/api/usage/requests', (c) => {
  // `before` is the last row's "ts:id": turned-away requests sit between attempts by time, not id.
  const [ts, id] = (c.req.query('before') ?? '').split(':').map(Number)
  const before = Number.isFinite(ts) && Number.isFinite(id) ? { ts, id } : undefined
  return c.json(usageRequests(usageFilter(c), Math.min(Number(c.req.query('limit') ?? 100), 500), before))
})
app.get('/console/api/usage/facets', (c) => {
  const f = usageFilter(c)
  return c.json(usageFacets(f.from, f.to))
})
app.delete('/console/api/usage', (c) => {
  clearUsage()
  return c.json({ status: 'ok' })
})

const cpaBase = () => (supervisor.state === 'running' && supervisor.port ? `http://127.0.0.1:${supervisor.port}` : undefined)
const notRunning = (c: Context) => c.json({ error: 'CLIProxyAPI is not running' }, 503)

/**
 * Headers forwarded to CPA: the browser's own, minus anything CPA could use to treat the request as
 * remote (forwarding headers) and with exactly one canonical credential.
 */
function upstreamHeaders(c: Context, authorization: string | undefined) {
  const headers = new Headers(c.req.raw.headers)
  for (const h of ['host', 'authorization', 'x-management-key', 'forwarded', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) {
    headers.delete(h)
  }
  if (authorization) headers.set('authorization', authorization)
  return headers
}

// Playground: call the OpenAI-compatible API with the first client key, so the browser never needs one.
app.all('/console/api/v1/*', (c) => {
  const base = cpaBase()
  if (!base) return notRunning(c)
  const url = new URL(c.req.url)
  const key = readCpaConfig()?.clientKeys[0]
  return proxy(`${base}${url.pathname.replace('/console/api', '')}${url.search}`, {
    ...c.req,
    headers: upstreamHeaders(c, key ? `Bearer ${key}` : undefined),
  })
})

// Management API: verified here first so wrong keys never trip CPA's localhost lockout.
app.all('/v8/management/*', (c) => {
  const key = extractKey(c.req.raw.headers)
  const result = authenticate(clientIp(c), key)
  if (!result.ok) return c.json({ error: result.error }, result.status)
  const base = cpaBase()
  if (!base) return notRunning(c)
  const url = new URL(c.req.url)
  return proxy(`${base}${url.pathname}${url.search}`, { ...c.req, headers: upstreamHeaders(c, `Bearer ${key}`) })
})

// --- Static SPA -----------------------------------------------------------------------------

if (!env.dev) {
  const root = path.relative(process.cwd(), paths.dist)
  app.use('/*', serveStatic({ root }))
  app.get('*', serveStatic({ root, path: 'index.html' }))
}
