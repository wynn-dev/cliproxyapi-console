import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { PACKAGE, env, paths } from './env.ts'

/**
 * Updates the console installed as a service from its own UI. The service runs from <data>/app (see
 * service.ts). A new version is installed beside it into <data>/app-next and verified there, so a
 * failed install or check leaves the running version untouched. Only then are the directories
 * swapped, keeping the old one as <data>/app-prev for a rollback, and the console exits non-zero
 * so the service manager starts it again on the new version.
 */

const run = promisify(execFile)

export interface UpdateProgress {
  version: string
  phase: 'installing' | 'verifying' | 'restarting' | 'failed'
  startedAt: number
  error?: string
}

export interface Options {
  /** The data directory holding app, app-next and app-prev. */
  data?: string
  /** The Node the service is pinned to, and its version. */
  node?: string
  nodeVersion?: string
  /** Installs `spec` into `dir`, which holds a bare package.json. */
  install?: (dir: string, spec: string) => Promise<void>
  onPhase?: (phase: 'installing' | 'verifying') => void
}

export const appDirs = (data = paths.data) => ({
  app: path.join(data, 'app'),
  next: path.join(data, 'app-next'),
  prev: path.join(data, 'app-prev'),
  swap: path.join(data, 'app-swap'),
})

const pkgDir = (dir: string) => path.join(dir, 'node_modules', PACKAGE)

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const isVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v)

function readPackage(dir: string) {
  return JSON.parse(fs.readFileSync(path.join(pkgDir(dir), 'package.json'), 'utf8')) as { version: string; engines?: { node?: string } }
}

/** The version installed in an app directory, if one is. */
export function versionIn(dir: string) {
  try {
    return readPackage(dir).version
  } catch {
    return undefined
  }
}

/** Why the console can't update itself from the UI, or undefined when it can. */
export function unsupportedReason() {
  if (env.updateDisabled) return 'In-UI updates are turned off (CPA_CONSOLE_DISABLE_UPDATE).'
  if (!env.service) return 'The console is not running as a service.'
  const real = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  }
  if (real(paths.root) !== real(pkgDir(appDirs().app))) return 'The console is not running from its service install.'
  return undefined
}

/** npm next to the pinned Node, which a service's PATH may not include (nvm and the like). */
async function npmInstall(dir: string, spec: string) {
  const bin = path.dirname(process.execPath)
  const npm = fs.existsSync(path.join(bin, 'npm')) ? path.join(bin, 'npm') : 'npm'
  await run(npm, ['install', spec, '--omit=dev', '--prefer-online', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    timeout: 5 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
}

/** The last lines a failed command wrote, for an error message that says what went wrong. */
function failure(what: string, err: unknown) {
  const e = err as Error & { stderr?: string; killed?: boolean }
  // Without stack frames and Node's own version line, which say nothing about the cause.
  const lines = e.stderr?.split('\n').filter((l) => l.trim() && !/^\s+at /.test(l) && !/^Node\.js v/.test(l))
  const detail = e.killed ? 'timed out' : lines?.slice(-5).join('\n') || e.message
  return new Error(`${what}: ${detail}`)
}

/** Checks an installed console: the expected version, Node engines the pinned Node satisfies, and `--version` runs. */
export async function verify(dir: string, version: string, { node = process.execPath, nodeVersion = process.versions.node }: Options = {}) {
  let pkg: ReturnType<typeof readPackage>
  try {
    pkg = readPackage(dir)
  } catch {
    throw new Error(`${PACKAGE} is not installed in ${dir}`)
  }
  if (pkg.version !== version) throw new Error(`Installed ${pkg.version} instead of ${version}`)
  const engines = pkg.engines?.node
  if (engines && !satisfies(nodeVersion, engines)) {
    throw new Error(`${version} needs Node ${engines}, but the service runs Node ${nodeVersion} (${node})`)
  }
  let out: string
  try {
    out = (await run(node, [path.join(pkgDir(dir), 'dist-server/cli.js'), '--version'], { timeout: 30_000 })).stdout.trim()
  } catch (err) {
    throw failure(`${version} does not start`, err)
  }
  if (out !== version) throw new Error(`${version} reports its version as "${out}"`)
}

/** Installs and verifies a version in app-next. On any failure app-next is removed and app is untouched. */
export async function installNext(version: string, opts: Options = {}) {
  if (!isVersion(version)) throw new Error(`Invalid version "${version}"`)
  const { next } = appDirs(opts.data)
  fs.rmSync(next, { recursive: true, force: true })
  try {
    fs.mkdirSync(next, { recursive: true })
    fs.writeFileSync(path.join(next, 'package.json'), '{ "private": true }\n')
    opts.onPhase?.('installing')
    try {
      await (opts.install ?? npmInstall)(next, `${PACKAGE}@${version}`)
    } catch (err) {
      throw failure(`Could not install ${PACKAGE}@${version}`, err)
    }
    opts.onPhase?.('verifying')
    await verify(next, version, opts)
  } catch (err) {
    fs.rmSync(next, { recursive: true, force: true })
    throw err
  }
}

/** Moves app-next into place, keeping the current app as app-prev. Restores app if the move fails. */
export function swap(data?: string) {
  const { app, next, prev } = appDirs(data)
  if (!fs.existsSync(next)) throw new Error('Nothing installed to switch to')
  fs.rmSync(prev, { recursive: true, force: true })
  fs.renameSync(app, prev)
  try {
    fs.renameSync(next, app)
  } catch (err) {
    fs.renameSync(prev, app)
    throw err
  }
}

/**
 * Switches app and app-prev, after checking app-prev still runs. Swapping rather than deleting keeps
 * the rollback itself undoable. Returns the version now in app.
 */
export async function rollback(opts: Options = {}) {
  const { app, prev, swap } = appDirs(opts.data)
  const version = versionIn(prev)
  if (!version) throw new Error('There is no previous version to roll back to')
  await verify(prev, version, opts)
  fs.rmSync(swap, { recursive: true, force: true })
  fs.renameSync(app, swap)
  try {
    fs.renameSync(prev, app)
  } catch (err) {
    fs.renameSync(swap, app)
    throw err
  }
  fs.renameSync(swap, prev)
  return version
}

// --- The update the running console is doing ----------------------------------------------------

let progress: UpdateProgress | undefined

export const updateProgress = () => progress

/** Forgets the last update, as a restart does. */
export const resetProgress = () => void (progress = undefined)

const busy = () => progress && progress.phase !== 'failed'

/**
 * Starts installing a version in the background; `restart` runs once it is in place. Progress and
 * any error are reported by updateProgress().
 */
export function startUpdate(version: string, restart: () => void, opts: Options = {}) {
  if (busy()) throw new Error('An update is already in progress')
  const p: UpdateProgress = { version, phase: 'installing', startedAt: Date.now() }
  progress = p
  void (async () => {
    try {
      await installNext(version, { ...opts, onPhase: (phase) => (p.phase = phase) })
      swap(opts.data)
      p.phase = 'restarting'
      console.log(`Updated the console to ${version}; restarting.`)
      restart()
    } catch (err) {
      p.phase = 'failed'
      p.error = (err as Error).message
      console.error(`Console update to ${version} failed: ${p.error}`)
    }
  })()
  return p
}

/** Rolls back to app-prev, then runs `restart`. */
export async function startRollback(restart: () => void, opts: Options = {}) {
  if (busy()) throw new Error('An update is already in progress')
  const version = await rollback(opts)
  progress = { version, phase: 'restarting', startedAt: Date.now() }
  console.log(`Rolled the console back to ${version}; restarting.`)
  restart()
  return progress
}

// --- Node engines ranges ------------------------------------------------------------------------

type Triple = [number, number, number]

const cmp = (a: Triple, b: Triple) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * Whether a Node version satisfies a package's `engines.node` range: npm's comparators (`>=`, `<`,
 * `^`, `~`, x-ranges, hyphen ranges, `||`). A range it can't read is not satisfied.
 */
export function satisfies(version: string, range: string) {
  const m = version.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const v: Triple = [Number(m[1]), Number(m[2]), Number(m[3])]
  return range.split('||').some((set) => {
    const hyphen = set.trim().match(/^(\S+)\s+-\s+(\S+)$/)
    const parts = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : set.trim().replace(/([<>=~^]+)\s+/g, '$1').split(/\s+/).filter(Boolean)
    return parts.every((c) => comparator(v, c))
  })
}

function comparator(v: Triple, c: string) {
  const m = c.match(/^(<=|>=|<|>|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/)
  if (!m) return false
  const op = m[1] ?? '='
  // Given parts, up to the first wildcard or missing one.
  const given: number[] = []
  for (const p of [m[2], m[3], m[4]]) {
    if (p === undefined || /[xX*]/.test(p)) break
    given.push(Number(p))
  }
  const low: Triple = [given[0] ?? 0, given[1] ?? 0, given[2] ?? 0]
  // Just past the given parts: 1.2 -> 1.3.0, 1 -> 2.0.0.
  const bump = (n: number): Triple => (n === 0 ? [Infinity, 0, 0] : ([...given.slice(0, n - 1), given[n - 1] + 1, 0, 0].slice(0, 3) as Triple))
  const full = given.length === 3
  const high = bump(given.length)
  switch (op) {
    case '>=':
      return cmp(v, low) >= 0
    case '>':
      return full ? cmp(v, low) > 0 : cmp(v, high) >= 0
    case '<':
      return cmp(v, low) < 0
    case '<=':
      return full ? cmp(v, low) <= 0 : cmp(v, high) < 0
    case '~':
      return cmp(v, low) >= 0 && cmp(v, bump(Math.min(given.length, 2))) < 0
    case '^': {
      // Up to the next change of the first non-zero part given (or the last part given, if all are zero).
      const first = given.findIndex((n) => n !== 0)
      const upto = first === -1 ? given.length : first + 1
      return cmp(v, low) >= 0 && cmp(v, bump(upto)) < 0
    }
    default:
      return full ? cmp(v, low) === 0 : cmp(v, low) >= 0 && cmp(v, high) < 0
  }
}
