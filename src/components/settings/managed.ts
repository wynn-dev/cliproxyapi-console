import { getPath } from './form-state'

/**
 * config.yaml settings the console depends on. It writes them at setup (server/cpa-config.ts) and
 * shows them read-only, since turning one off quietly breaks the Usage or Logs page.
 * `legacy` is the pre-v8 top-level key CPA still reads when the new path is absent.
 */
export const MANAGED_SETTINGS = [
  {
    path: 'observability.logs.logging-to-file',
    legacy: 'logging-to-file',
    value: true,
    label: 'Log to file',
    reason: 'The Logs page reads these files.',
  },
  {
    path: 'observability.usage.usage-statistics-enabled',
    legacy: 'usage-statistics-enabled',
    value: true,
    label: 'Usage statistics',
    reason: 'The Usage page and each account’s request history are built from them.',
  },
  {
    path: 'observability.usage.redis-usage-queue-retention-seconds',
    legacy: 'redis-usage-queue-retention-seconds',
    value: 3600,
    label: 'Usage queue retention',
    reason: 'Records wait this long for the console, so none are lost while it restarts.',
  },
] as const

export type ManagedSetting = (typeof MANAGED_SETTINGS)[number]

/** The value CPA uses: the v8 path, else the legacy key. */
export const managedValue = (config: unknown, s: ManagedSetting) => getPath(config, s.path) ?? getPath(config, s.legacy)

/** How a value reads in the UI, e.g. "On", "1 hour", "600 s" or "Not set". */
export function showValue(v: unknown) {
  if (v === undefined || v === null) return 'Not set'
  if (typeof v === 'boolean') return v ? 'On' : 'Off'
  if (typeof v === 'number' && v > 0 && v % 3600 === 0) return v === 3600 ? '1 hour' : `${v / 3600} hours`
  return typeof v === 'number' ? `${v} s` : String(v)
}

/** Managed settings a save would move away from the console's value (fixing one is not a change worth a warning). */
export const changedSettings = (before: unknown, after: unknown) =>
  MANAGED_SETTINGS.filter((s) => {
    const next = managedValue(after, s)
    return next !== managedValue(before, s) && next !== s.value
  })
