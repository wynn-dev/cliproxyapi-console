import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env, paths } from './env.ts'
import { consoleUrls } from './urls.ts'

/** Installs the console as a background service: systemd on Linux, launchd on macOS. */

const NAME = 'cpa-console'
const LABEL = 'com.github.wynn-dev.cliproxyapi-console'

const run = (cmd: string, args: string[], quiet = false) =>
  execFileSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit' })

const isRoot = () => process.getuid?.() === 0
const systemctl = (...args: string[]) => run('systemctl', isRoot() ? args : ['--user', ...args])
const unitPath = () =>
  isRoot() ? `/etc/systemd/system/${NAME}.service` : path.join(os.homedir(), '.config/systemd/user', `${NAME}.service`)
const plistPath = () => path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
const launchdTarget = () => `gui/${process.getuid?.()}`

/**
 * The service must not depend on where this copy runs from (the npx cache can be pruned at any time;
 * pnpm and global installs use layouts that don't copy well). Install a self-contained copy of the
 * built package into the data directory instead, with its production dependencies.
 */
function installedEntry() {
  const app = path.join(paths.data, 'app')
  const entry = path.join(app, 'dist-server/cli.js')
  if (path.resolve(paths.root) === path.resolve(app)) return entry // re-installing from the copy itself

  if (!fs.existsSync(path.join(paths.root, 'dist-server/cli.js')) || !fs.existsSync(path.join(paths.root, 'dist'))) {
    throw new Error('Run `pnpm build` before installing the service from a source checkout.')
  }
  fs.rmSync(app, { recursive: true, force: true })
  fs.mkdirSync(app, { recursive: true })
  for (const item of ['package.json', 'dist', 'dist-server']) {
    fs.cpSync(path.join(paths.root, item), path.join(app, item), { recursive: true, dereference: true })
  }
  console.log('  Installing the console into the data directory…')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: app,
    stdio: 'inherit',
  })
  return entry
}

function environment() {
  return { CPA_CONSOLE_DATA: paths.data, PORT: String(env.port), HOST: env.host }
}

function systemdUnit(entry: string) {
  const vars = Object.entries(environment())
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n')
  return `[Unit]
Description=CPA Console (CLIProxyAPI)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${process.execPath} ${entry} start --no-open
${vars}
Restart=on-failure
RestartSec=3
# Let the console stop CLIProxyAPI itself before anything is killed.
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=${isRoot() ? 'multi-user.target' : 'default.target'}
`
}

function launchdPlist(entry: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const vars = Object.entries(environment())
    .map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`)
    .join('\n')
  const log = esc(path.join(paths.data, 'console.log'))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(entry)}</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`
}

function assertSupported() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('Service install supports Linux (systemd) and macOS (launchd). On other systems, run `cpa-console start` with your own supervisor.')
  }
}

export async function installService() {
  assertSupported()
  uninstallService(true)
  fs.mkdirSync(paths.data, { recursive: true })
  const entry = installedEntry()

  if (process.platform === 'linux') {
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true })
    fs.writeFileSync(unitPath(), systemdUnit(entry))
    systemctl('daemon-reload')
    systemctl('enable', '--now', NAME)
    if (!isRoot()) {
      // Keep user services running after logout and start them at boot.
      try {
        run('loginctl', ['enable-linger', os.userInfo().username], true)
      } catch {
        console.warn(`Could not enable lingering. Run \`sudo loginctl enable-linger ${os.userInfo().username}\` so the service starts at boot.`)
      }
    }
  } else {
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true })
    fs.writeFileSync(plistPath(), launchdPlist(entry))
    run('launchctl', ['bootstrap', launchdTarget(), plistPath()])
  }

  console.log(`\n  Installed ${NAME} as a ${process.platform === 'linux' ? 'systemd' : 'launchd'} service.`)
  await printWhenReady()
}

export function uninstallService(quiet = false) {
  assertSupported()
  if (process.platform === 'linux') {
    if (!fs.existsSync(unitPath())) return quiet || console.log('Service is not installed.')
    try {
      systemctl('disable', '--now', NAME)
    } catch {
      /* already stopped */
    }
    fs.rmSync(unitPath())
    systemctl('daemon-reload')
  } else {
    if (!fs.existsSync(plistPath())) return quiet || console.log('Service is not installed.')
    try {
      run('launchctl', ['bootout', `${launchdTarget()}/${LABEL}`], true)
    } catch {
      /* not loaded */
    }
    fs.rmSync(plistPath())
  }
  if (!quiet) console.log(`Removed the ${NAME} service. Your data in ${paths.data} was kept.`)
}

export function serviceStatus() {
  assertSupported()
  try {
    if (process.platform === 'linux') systemctl('status', NAME, '--no-pager')
    else run('launchctl', ['print', `${launchdTarget()}/${LABEL}`])
  } catch {
    process.exitCode = 1
  }
}

async function printWhenReady() {
  const base = `http://127.0.0.1:${env.port}`
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/console/api/state`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        let token = ''
        try {
          token = fs.readFileSync(path.join(paths.data, 'setup-token'), 'utf8').trim()
        } catch {
          /* already set up */
        }
        console.log(`  Running at:\n`)
        for (const url of consoleUrls(env.port)) console.log(`    ${url}${token ? `/setup?token=${token}` : ''}`)
        console.log()
        return
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn(`  The service did not respond on port ${env.port} yet. Check \`cpa-console service status\`.`)
}
