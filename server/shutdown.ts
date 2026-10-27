import { flushLimitHistory } from './limit-history.ts'
import { supervisor } from './supervisor.ts'

/** Saves what needs saving and stops CLIProxyAPI, then exits. */
export async function shutdown(code = 0) {
  try {
    flushLimitHistory(true)
  } catch (err) {
    console.error(`Could not save limit history: ${err instanceof Error ? err.message : err}`)
  }
  await supervisor.stop()
  process.exit(code)
}
