import { spawn } from 'node:child_process'
import { serve } from '@hono/node-server'
import { app, ensureInstalledAndStart, setupToken } from './app.ts'
import { env, paths } from './env.ts'
import { flushLimitHistory } from './limit-history.ts'
import { startLimitRecorder } from './limits.ts'
import { supervisor } from './supervisor.ts'
import { consoleUrls } from './urls.ts'
import { startCollector } from './usage.ts'

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[22m` : s)
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s)
const cyan = (s: string) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[39m` : s)

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

export async function startServer({ open = false } = {}) {
  serve({ fetch: app.fetch, hostname: env.host, port: env.port }, async (info) => {
    const urls = consoleUrls(info.port)
    const suffix = setupToken ? `/setup?token=${setupToken}` : ''
    console.log(`\n  ${bold('CPA Console')} ${dim(`· data in ${paths.data}`)}\n`)
    for (const url of urls) console.log(`  ${cyan(url + suffix)}`)
    if (setupToken) {
      console.log(`\n  ${dim('First run: open the link above to finish setup.')}`)
      if (open && !env.dev) openBrowser(urls[0] + suffix)
    }
    console.log()

    // Only once the port is ours: a second instance must not touch the first one's CPA.
    await supervisor.reapOrphan()
    startCollector()
    startLimitRecorder()
    ensureInstalledAndStart().catch((err) => console.error(`Failed to install CLIProxyAPI: ${err.message}`))
  }).on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${env.port} is already in use (is the console already running?). Try --port <port>.` : err.message)
    process.exit(1)
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      try {
        flushLimitHistory(true)
      } catch (err) {
        console.error(`Could not save limit history: ${err instanceof Error ? err.message : err}`)
      }
      await supervisor.stop()
      process.exit(0)
    })
  }
}
