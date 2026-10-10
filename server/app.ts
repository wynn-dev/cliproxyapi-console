import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { proxy } from 'hono/proxy'
import { authenticate, extractKey } from './auth.ts'
import { failInstall, installProgress, installRelease, installedVersion, latestRelease } from './binary.ts'
import { configExists, readCpaConfig, writeInitialConfig } from './cpa-config.ts'
import { NIGHTLY_URL, env, paths } from './env.ts'
import { readState, updateState } from './state.ts'
import { supervisor } from './supervisor.ts'
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
    config: cfg ? { host: cfg.host, port: cfg.port, clientKeys: cfg.clientKeys } : null,
    collector: { lastPollAt: collector.lastPollAt || null, lastError: collector.lastError ?? null },
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

app.get('/console/api/process/output', (c) => c.json(supervisor.output(Number(c.req.query('after') ?? 0))))

let consoleLatest: { at: number; version: string } | undefined

/** Newest console nightly, from the version.txt published next to the nightly tarball. */
app.get('/console/api/console/latest', async (c) => {
  if (!consoleLatest || Date.now() - consoleLatest.at > 30 * 60_000) {
    try {
      const res = await fetch(NIGHTLY_URL.replace('cliproxyapi-console.tgz', 'version.txt'))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      consoleLatest = { at: Date.now(), version: (await res.text()).trim() }
    } catch (err) {
      return c.json({ error: `Could not check for console updates: ${(err as Error).message}` }, 502)
    }
  }
  return c.json({ current: pkg.version, latest: consoleLatest.version, service: env.service, nightlyUrl: NIGHTLY_URL })
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
    status: q.status === 'ok' || q.status === 'failed' ? q.status : undefined,
  }
}

app.get('/console/api/usage/summary', (c) => c.json(usageSummary(usageFilter(c), Number(c.req.query('tz') ?? 0))))
app.get('/console/api/usage/requests', (c) =>
  c.json(usageRequests(usageFilter(c), Math.min(Number(c.req.query('limit') ?? 100), 500), Number(c.req.query('before')) || undefined)),
)
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
