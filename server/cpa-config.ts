import crypto from 'node:crypto'
import fs from 'node:fs'
import YAML from 'yaml'
import { paths } from './env.ts'

export interface CpaConfigSummary {
  host: string
  port: number
  tls: boolean
  secretKey: string
  clientKeys: string[]
  /** routing.strategy, normalized like CPA. */
  strategy: 'round-robin' | 'weighted-round-robin' | 'fill-first'
  sessionAffinity: boolean
}

/** CPA's own reading of routing.strategy (sdk/cliproxy/service_config.go). */
function strategyOf(raw: unknown): CpaConfigSummary['strategy'] {
  const s = String(raw ?? '').trim().toLowerCase()
  if (['weighted-round-robin', 'weightedroundrobin', 'wrr'].includes(s)) return 'weighted-round-robin'
  if (['fill-first', 'fillfirst', 'ff'].includes(s)) return 'fill-first'
  return 'round-robin'
}

let cache: { mtimeMs: number; summary: CpaConfigSummary } | undefined

export function configExists() {
  return fs.existsSync(paths.config)
}

/** Reads the handful of config.yaml fields the console needs, cached by mtime. */
export function readCpaConfig(): CpaConfigSummary | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(paths.config)
  } catch {
    return undefined
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.summary
  try {
    const doc = YAML.parse(fs.readFileSync(paths.config, 'utf8')) ?? {}
    const summary: CpaConfigSummary = {
      host: doc.server?.host ?? '',
      port: Number(doc.server?.port ?? 8317),
      tls: doc.server?.tls?.enable === true,
      secretKey: String(doc.management?.['secret-key'] ?? ''),
      clientKeys: (doc.access?.['api-keys'] ?? []).filter((k: unknown) => typeof k === 'string'),
      strategy: strategyOf(doc.routing?.strategy),
      sessionAffinity: doc.routing?.['session-affinity'] === true,
    }
    cache = { mtimeMs: stat.mtimeMs, summary }
    return summary
  } catch {
    // Mid-write or invalid YAML: keep serving the last good summary.
    return cache?.summary
  }
}

export function generateClientKey() {
  return `sk-${crypto.randomBytes(24).toString('base64url')}`
}

export function writeInitialConfig(opts: { managementKey: string; host: string; port: number }) {
  const q = (s: string) => JSON.stringify(s)
  const yaml = `# Managed by CPA Console. Edit from the console or by hand; CPA hot-reloads changes.
config-version: 8
server:
  host: ${q(opts.host)}
  port: ${opts.port}
management:
  # The console reaches CPA over localhost, so remote management stays off.
  allow-remote: false
  secret-key: ${q(opts.managementKey)}
  disable-control-panel: true
access:
  api-keys:
    - ${q(generateClientKey())}
oauth:
  auth-dir: ${q(paths.auths)}
routing:
  # Prompt caches belong to one account: stay on an account until it runs out, and keep each
  # session where it started.
  strategy: "fill-first"
  session-affinity: true
  # A server error or overload moves only that request to another account, not the whole session.
  session-affinity-rebind-on: "quota"
  cooldown:
    # Remember exhausted accounts across restarts.
    save-cooldown-status: true
observability:
  logs:
    logging-to-file: true
    request-log: false
  usage:
    # Required for the console's usage analytics.
    usage-statistics-enabled: true
    redis-usage-queue-retention-seconds: 3600
`
  fs.mkdirSync(paths.auths, { recursive: true })
  fs.writeFileSync(paths.config, yaml, { mode: 0o600 })
}
