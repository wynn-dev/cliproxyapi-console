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

  private child: ChildProcess | undefined
  private lines: OutputLine[] = []
  private seq = 0
  private backoffMs = 1000
  private restartTimer: NodeJS.Timeout | undefined
  private exited: Promise<void> | undefined

  output(after = 0) {
    return { seq: this.seq, lines: this.lines.filter((l) => l.seq > after) }
  }

  private log(stream: OutputLine['stream'], text: string) {
    this.lines.push({ seq: ++this.seq, ts: Date.now(), stream, text })
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
  }

  start() {
    clearTimeout(this.restartTimer)
    if (this.child) return
    if (!installedVersion()) {
      this.lastError = 'CPA is not installed yet'
      return
    }
    this.state = 'starting'
    this.lastError = undefined
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
          // Reset backoff after a healthy run; otherwise back off up to 30s.
          if (this.startedAt && Date.now() - this.startedAt > 60_000) this.backoffMs = 1000
          this.log('console', `Restarting in ${this.backoffMs / 1000}s`)
          this.restartTimer = setTimeout(() => {
            this.restarts++
            this.start()
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
        if (this.child === child && this.state === 'starting') this.state = 'running'
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  private async ping() {
    if (!this.port) return false
    try {
      await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) })
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
    }
  }
}

export const supervisor = new Supervisor()
