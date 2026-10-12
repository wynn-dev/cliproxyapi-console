import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import readline from 'node:readline'
import { binaryPath, installedVersion } from './binary.ts'
import { readCpaConfig } from './cpa-config.ts'
import { paths } from './env.ts'
import { readState, updateState } from './state.ts'

export type ProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface OutputLine {
  seq: number
  ts: number
  stream: 'stdout' | 'stderr' | 'console'
  text: string
}

const MAX_LINES = 2000
const STOP_TIMEOUT_MS = 10_000
/** Liveness checks while running: a hung CPA is restarted after about a minute of silence. */
const CHECK_INTERVAL_MS = 15_000
const CHECK_TIMEOUT_MS = 5_000
const MAX_FAILED_CHECKS = 4

/** Runs CPA as a child process, restarts it on crashes and keeps a ring buffer of its output. */
class Supervisor {
  state: ProcessState = 'stopped'
  pid: number | undefined
  /** Port CPA was started with. CPA does not re-bind on config reloads, so this can differ from config.yaml. */
  port: number | undefined
  startedAt: number | undefined
  restarts = 0
  lastExit: { code: number | null; signal: string | null; at: number } | undefined
  lastError: string | undefined
  /** Last liveness check while running, and since when checks have been failing. */
  lastCheck: { ok: boolean; at: number; failingSince?: number } | undefined
  /** When CPA was last restarted because it stopped answering while its process was still alive. */
  lastHangAt: number | undefined
  /** Whether the current run was started by that restart. */
  startedAfterHang = false

  private child: ChildProcess | undefined
  private lines: OutputLine[] = []
  private seq = 0
  private backoffMs = 1000
  private restartTimer: NodeJS.Timeout | undefined
  private exited: Promise<void> | undefined
  private failedChecks = 0
  private hung = false

  output(after = 0) {
    return { seq: this.seq, lines: this.lines.filter((l) => l.seq > after) }
  }

  private log(stream: OutputLine['stream'], text: string) {
    this.lines.push({ seq: ++this.seq, ts: Date.now(), stream, text })
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
  }

  start(afterHang = false) {
    clearTimeout(this.restartTimer)
    if (this.child) return
    if (!installedVersion()) {
      this.lastError = 'CPA is not installed yet'
      return
    }
    this.state = 'starting'
    this.lastError = undefined
    this.lastCheck = undefined
    this.failedChecks = 0
    this.hung = false
    this.startedAfterHang = afterHang
    this.port = readCpaConfig()?.port
    this.log('console', `Starting CLIProxyAPI ${installedVersion()}`)

    const child = spawn(binaryPath, ['-config', paths.config], { cwd: paths.data, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.pid = child.pid
    this.startedAt = Date.now()
    if (child.pid) updateState({ cpaPid: child.pid })
    for (const stream of ['stdout', 'stderr'] as const) {
      readline.createInterface({ input: child[stream]! }).on('line', (line) => {
        this.log(stream, line)
        if (/address already in use/i.test(line)) this.lastError = line
      })
    }
    // Spawn failures emit 'error' + 'close' but never 'exit', so clean up on 'close'.
    child.once('error', (err) => {
      this.lastError = `Failed to start: ${err.message}`
      this.log('console', this.lastError)
    })
    this.exited = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        const intentional = this.state === 'stopping'
        this.child = undefined
        this.pid = undefined
        updateState({ cpaPid: undefined })
        this.lastExit = { code, signal, at: Date.now() }
        this.log('console', `CLIProxyAPI exited (${signal ?? `code ${code}`})`)
        if (intentional) {
          this.state = 'stopped'
        } else {
          this.state = 'crashed'
          this.lastError ??= `Exited unexpectedly with ${signal ?? `code ${code}`}`
          // Reset backoff after a healthy run; otherwise back off up to 30s. A hang is never healthy.
          if (!this.hung && this.startedAt && Date.now() - this.startedAt > 60_000) this.backoffMs = 1000
          this.log('console', `Restarting in ${this.backoffMs / 1000}s`)
          const afterHang = this.hung
          this.restartTimer = setTimeout(() => {
            this.restarts++
            this.start(afterHang)
          }, this.backoffMs)
          this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
        }
        resolve()
      })
    })
    void this.waitUntilReady(child)
  }

  /**
   * Stops a CPA left behind by a console process that died without cleaning up. Only orphans
   * (re-parented to init/launchd) qualify, so a CPA owned by another live console is left alone.
   */
  async reapOrphan() {
    const pid = readState().cpaPid
    if (!pid || process.platform === 'win32') return
    let ps: string
    try {
      ps = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=,comm='], { encoding: 'utf8' }).trim()
    } catch {
      return updateState({ cpaPid: undefined }) // no longer running
    }
    const [ppid, command] = ps.split(/\s+/, 2)
    if (ppid !== '1' || !command?.includes('cli-proxy-api')) return
    try {
      process.kill(pid, 'SIGTERM')
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100))
        process.kill(pid, 0) // throws once the process is gone
      }
      process.kill(pid, 'SIGKILL')
    } catch {
      // Exited.
    }
    updateState({ cpaPid: undefined })
  }

  private async waitUntilReady(child: ChildProcess) {
    const deadline = Date.now() + 30_000
    while (this.child === child && Date.now() < deadline) {
      if (await this.ping()) {
        if (this.child === child && this.state === 'starting') {
          this.state = 'running'
          this.lastCheck = { ok: true, at: Date.now() }
          void this.watch(child)
        }
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  /**
   * Restarts CPA when its process is alive but has stopped answering HTTP, which exit-based
   * restarts never catch. Checks pause outside `running` (an update stops CPA before swapping it).
   */
  private async watch(child: ChildProcess) {
    let next = Date.now()
    while (this.child === child) {
      // Fixed cadence, so slow checks don't stretch the time to a restart (but no catch-up burst after a sleep).
      next = Math.max(next + CHECK_INTERVAL_MS, Date.now())
      await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())).unref())
      if (this.child !== child || this.state !== 'running') continue
      const ok = await this.ping(CHECK_TIMEOUT_MS)
      if (this.child !== child || this.state !== 'running') continue
      const at = Date.now()
      this.lastCheck = { ok, at, failingSince: ok ? undefined : (this.lastCheck?.failingSince ?? at) }
      if (ok) {
        if (this.failedChecks) this.log('console', 'CLIProxyAPI is answering again')
        this.failedChecks = 0
        continue
      }
      if (++this.failedChecks === 1) this.log('console', 'CLIProxyAPI did not answer a health check')
      if (this.failedChecks < MAX_FAILED_CHECKS) continue
      const silentFor = Math.round((MAX_FAILED_CHECKS * CHECK_INTERVAL_MS) / 1000)
      this.log('console', `CLIProxyAPI has not answered for about ${silentFor}s; restarting it`)
      this.hung = true
      this.lastHangAt = Date.now()
      this.lastError = 'Stopped answering health checks'
      // Handled like a crash on exit: same backoff and restart count. SIGKILL also ends a stopped (SIGSTOP) process.
      child.kill('SIGTERM')
      setTimeout(() => this.child === child && child.kill('SIGKILL'), STOP_TIMEOUT_MS).unref()
      return
    }
  }

  /** Any HTTP answer counts, including a 404 from a CPA without /healthz. CPA does not log successful /healthz hits. */
  private async ping(timeoutMs = 1000) {
    if (!this.port) return false
    try {
      await fetch(`http://127.0.0.1:${this.port}/healthz`, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
      return true
    } catch {
      return false
    }
  }

  async stop() {
    clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) {
      this.state = 'stopped'
      return
    }
    this.state = 'stopping'
    child.kill('SIGTERM')
    const killer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
    await this.exited
    clearTimeout(killer)
  }

  async restart() {
    await this.stop()
    this.backoffMs = 1000
    this.start()
  }

  snapshot() {
    return {
      state: this.state,
      pid: this.pid,
      port: this.port,
      startedAt: this.state === 'running' ? this.startedAt : undefined,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastError: this.lastError,
      lastCheck: this.lastCheck,
      lastHangAt: this.lastHangAt,
      startedAfterHang: this.startedAfterHang,
    }
  }
}

export const supervisor = new Supervisor()
