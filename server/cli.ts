#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const HELP = `CPA Console — run and manage CLIProxyAPI from a web UI

Usage:
  cliproxyui [start]            Start the console (and CLIProxyAPI) in the foreground
  cliproxyui service install    Install and start as a background service (systemd / launchd)
  cliproxyui service uninstall  Remove the background service (keeps your data)
  cliproxyui service status     Show service status
  cliproxyui service rollback   Switch the service back to the console version before its last update

Options:
  -p, --port <port>   Console port (default 8320, env PORT)
      --host <host>   Bind address (default 0.0.0.0, env HOST)
  -d, --data <dir>    Data directory (default ~/.cpa-console, env CPA_CONSOLE_DATA)
      --no-open       Don't open a browser on first run
  -v, --version       Print the version
  -h, --help          Show this help
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    data: { type: 'string', short: 'd' },
    'no-open': { type: 'boolean' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(HELP)
  process.exit(0)
}
if (values.version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')) as { version: string }
  console.log(pkg.version)
  process.exit(0)
}

// env.ts reads these at import time, so set them before loading the rest of the server.
if (values.port) process.env.PORT = values.port
if (values.host) process.env.HOST = values.host
if (values.data) process.env.CPA_CONSOLE_DATA = path.resolve(values.data)

const [command = 'start', sub] = positionals

try {
  if (command === 'start') {
    const { startServer } = await import('./index.ts')
    await startServer({ open: !values['no-open'] && process.stdout.isTTY })
  } else if (command === 'service') {
    const service = await import('./service.ts')
    if (sub === 'install') await service.installService()
    else if (sub === 'uninstall') service.uninstallService()
    else if (sub === 'status') service.serviceStatus()
    else if (sub === 'rollback') await service.rollbackService()
    else throw new Error(`Unknown service command "${sub ?? ''}". Use install, uninstall, status or rollback.`)
  } else {
    throw new Error(`Unknown command "${command}".\n\n${HELP}`)
  }
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
