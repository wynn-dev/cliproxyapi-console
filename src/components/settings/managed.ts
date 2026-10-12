import { getPath } from './form-state'

/**
 * config.yaml settings the console depends on. It writes them at setup (server/cpa-config.ts) and
 * shows them read-only, since turning one off quietly breaks the Usage or Logs page.
 */
export const MANAGED_SETTINGS = [
  {
    path: 'observability.logs.logging-to-file',
    value: true,
    label: 'Log to file',
    shown: 'On',
    reason: 'The Logs page reads these files.',
  },
  {
    path: 'observability.usage.usage-statistics-enabled',
    value: true,
    label: 'Usage statistics',
    shown: 'On',
    reason: 'The Usage page and each account’s request history are built from them.',
  },
  {
    path: 'observability.usage.redis-usage-queue-retention-seconds',
    value: 3600,
    label: 'Usage queue retention',
    shown: '1 hour',
    reason: 'Records wait this long for the console, so none are lost while it restarts.',
  },
] as const

export type ManagedSetting = (typeof MANAGED_SETTINGS)[number]

/** Managed settings whose value differs between two parsed configs. */
export const changedSettings = (before: unknown, after: unknown) => MANAGED_SETTINGS.filter((s) => getPath(before, s.path) !== getPath(after, s.path))
