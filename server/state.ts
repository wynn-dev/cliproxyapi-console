import fs from 'node:fs'
import { paths } from './env.ts'

/** Console-owned state persisted next to the CPA config. Holds secrets, so it is written 0600. */
export interface ConsoleState {
  /** Installed CPA release tag, e.g. "v8.0.23". */
  cpaVersion?: string
  /** Plaintext management key, used by the console itself to talk to CPA (config only keeps a bcrypt hash). */
  managementKey?: string
  /** Whether CPA should be running. Stopping it from the UI persists across console restarts. */
  autostart: boolean
  /** PID of the CPA child, so a console that was killed hard can reap it on the next start. */
  cpaPid?: number
  /** Account reserve: percent of each 5-hour, weekly and Fable limit kept back. 0 turns a window's reserve off. */
  reserve?: { '5h'?: number; weekly?: number; fable?: number }
  /** Hold accounts that start billing their owner for paid extra usage. On unless false. */
  holdExtraUsage?: boolean
  /** Smart account order: the console sets Claude and Codex priorities. On unless turned off. */
  smartOrder?: boolean
  /** Ask each provider's usage endpoint for idle accounts' limits. Opt-in: the endpoints are undocumented. */
  limitChecks?: boolean
  /** When every account of a provider is held back, release the reserved one with the most left. Off unless true. */
  releaseWhenAllHeld?: boolean
  /** What the user pays for their plans, USD per month, for the share card. */
  planPrice?: number
  /** Upstream API keys the console tracks, by keyId (a hash, so the keys stay in config.yaml only). */
  apiKeys?: Record<string, ApiKeyMark>
}

export interface ApiKeyMark {
  /** Its group only takes traffic while no account of its provider can. */
  fallback?: boolean
  /** The provider of its group, so a tick only reads the lists that have a fallback. */
  provider?: string
  /** Credit balance in USD the user entered, and when (ms): what's left is this minus the spend since. */
  balance?: number
  balanceAt?: number
  /** When the user last entered a balance (ms), kept when it is cleared: an earlier out-of-credits answer no longer counts. */
  creditsAt?: number
}

let cached: ConsoleState | undefined

export function readState(): ConsoleState {
  if (cached) return cached
  try {
    cached = { autostart: true, ...JSON.parse(fs.readFileSync(paths.state, 'utf8')) }
  } catch {
    cached = { autostart: true }
  }
  return cached!
}

export function updateState(patch: Partial<ConsoleState>) {
  cached = { ...readState(), ...patch }
  fs.mkdirSync(paths.data, { recursive: true })
  fs.writeFileSync(paths.state, JSON.stringify(cached, null, 2), { mode: 0o600 })
}
