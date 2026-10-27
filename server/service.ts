import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE, env, paths } from './env.ts'
import { appDirs, rollback } from './self-update.ts'
import { consoleUrls } from './urls.ts'

/** Installs the console as a background service: systemd on Linux, launchd on macOS. */

const NAME = 'cpa-console'
const LABEL = 'com.github.wynn-dev.cliproxyapi-console'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const run = (cmd: string, args: string[], quiet = false) =>
  execFileSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit' })

const isRoot = () => process.getuid?.() === 0
const systemctl = (...args: string[]) => run('systemctl', isRoot() ? args : ['--user', ...args])
const unitPath = () =>
  isRoot() ? `/etc/systemd/system/${NAME}.service` : path.join(os.homedir(), '.config/systemd/user', `${NAME}.service`)
const plistPath = () => path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
const launchdTarget = () => `gui/${process.getuid?.()}`

/**
 * The service runs from its own install in the data directory, never from the npx cache (which is
 * pruned at will). From an installed package, that install is the newest nightly; from a source
 * checkout, it is the local build.
 */
function installedEntry() {
  const { app, next, prev } = appDirs()
  const fromSource = path.basename(path.dirname(paths.root)) !== 'node_modules'
  let spec = `${PACKAGE}@latest`
  let tmp: string | undefined
  if (fromSource) {
    if (!fs.existsSync(path.join(paths.root, 'dist-server/cli.js')) || !fs.existsSync(path.join(paths.root, 'dist'))) {
      throw new Error('Run `pnpm build` before installing the service from a source checkout.')
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-console-pack-'))
    const out = execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', tmp, '--loglevel=error'], { cwd: paths.root, encoding: 'utf8' })
    spec = path.join(tmp, out.trim().split('\n').pop()!)
  }

  console.log(fromSource ? '  Installing this build into the data directory…' : '  Installing the latest nightly into the data directory…')
  fs.rmSync(app, { recursive: true, force: true })
  // A version kept by an earlier in-UI update is not the one this install replaces, so Roll back must not offer it.
  fs.rmSync(prev, { recursive: true, force: true })
  fs.rmSync(next, { recursive: true, force: true })
  fs.mkdirSync(app, { recursive: true })
  fs.writeFileSync(path.join(app, 'package.json'), '{ "private": true }\n')
  try {
    execFileSync(npm, ['install', spec, '--omit=dev', '--prefer-online', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: app,
      stdio: 'inherit',
    })
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }
  return path.join(app, 'node_modules', PACKAGE, 'dist-server/cli.js')
}

function environment(): Record<string, string> {
  const vars: Record<string, string> = { CPA_CONSOLE_DATA: paths.data, PORT: String(env.port), HOST: env.host, CPA_CONSOLE_SERVICE: '1' }
  // Carried into the service, so `CPA_CONSOLE_DISABLE_UPDATE=1 cliproxyui service install` keeps it off.
  if (env.updateDisabled) vars.CPA_CONSOLE_DISABLE_UPDATE = '1'
  return vars
}

export function systemdUnit(entry: string) {
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

export function launchdPlist(entry: string) {
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
    throw new Error('Service install supports Linux (systemd) and macOS (launchd). On other systems, run `cliproxyui start` with your own supervisor.')
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

/** Switches the service back to the console version it ran before its last update, and restarts it. */
export async function rollbackService() {
  assertSupported()
  // Checked against the Node the service runs, not the one running this command (npx's).
  const node = serviceNode()
  let nodeVersion: string | undefined
  if (node) {
    try {
      nodeVersion = execFileSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim()
    } catch {
      throw new Error(`The service's Node (${node}) does not run.`)
    }
  }
  const version = await rollback({ node, nodeVersion })
  console.log(`  Switched the service's install to ${version}.`)
  if (process.platform === 'linux' ? !fs.existsSync(unitPath()) : !fs.existsSync(plistPath())) {
    return console.log('  The service is not installed, so nothing was restarted.')
  }
  if (process.platform === 'linux') systemctl('restart', NAME)
  else run('launchctl', ['kickstart', '-k', `${launchdTarget()}/${LABEL}`])
  console.log(`  Restarted ${NAME}.`)
  await printWhenReady()
}

/** The Node the installed service runs with, if it is installed. */
function serviceNode() {
  try {
    return process.platform === 'linux' ? unitNode(fs.readFileSync(unitPath(), 'utf8')) : plistNode(fs.readFileSync(plistPath(), 'utf8'))
  } catch {
    return undefined
  }
}

/** The program a systemd unit's ExecStart runs, as systemdUnit() writes it. */
export const unitNode = (unit: string) => unit.match(/^ExecStart=(\S+)/m)?.[1]

/** The program a launchd plist runs, as launchdPlist() writes it. */
export const plistNode = (plist: string) =>
  plist
    .match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1]
    ?.replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')

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
  console.warn(`  The service did not respond on port ${env.port} yet. Check \`cliproxyui service status\`.`)
}
