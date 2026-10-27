import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CPA_REPO, env, paths } from './env.ts'
import { readState, updateState } from './state.ts'

const run = promisify(execFile)

export interface ReleaseInfo {
  tag: string
  publishedAt: string
  url: string
  notes: string
}

export interface InstallProgress {
  tag: string
  phase: 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
  received: number
  total: number
  error?: string
}

const binaryName = process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'
export const binaryPath = path.join(paths.bin, binaryName)

export function installedVersion() {
  return fs.existsSync(binaryPath) ? readState().cpaVersion : undefined
}

function assetName(tag: string) {
  const osName = ({ darwin: 'darwin', linux: 'linux', win32: 'windows', freebsd: 'freebsd' } as Record<string, string>)[
    process.platform
  ]
  const arch = ({ arm64: 'aarch64', x64: 'amd64' } as Record<string, string>)[process.arch]
  if (!osName || !arch) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`)
  const ext = osName === 'windows' ? 'zip' : 'tar.gz'
  return `CLIProxyAPI_${tag.replace(/^v/, '')}_${osName}_${arch}.${ext}`
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'cpa-console', Accept: 'application/vnd.github+json' }
  if (env.githubToken) h.Authorization = `Bearer ${env.githubToken}`
  return h
}

let latestCache: { at: number; info: ReleaseInfo } | undefined

export async function latestRelease(force = false): Promise<ReleaseInfo> {
  if (!force && latestCache && Date.now() - latestCache.at < 30 * 60_000) return latestCache.info
  let info: ReleaseInfo
  const res = await fetch(`https://api.github.com/repos/${CPA_REPO}/releases/latest`, { headers: githubHeaders() })
  if (res.ok) {
    const json = (await res.json()) as { tag_name: string; published_at: string; html_url: string; body?: string }
    info = { tag: json.tag_name, publishedAt: json.published_at, url: json.html_url, notes: json.body ?? '' }
  } else {
    // The API is rate-limited (60/h unauthenticated, shared on cloud IPs); the release page redirect is not.
    const page = await fetch(`https://github.com/${CPA_REPO}/releases/latest`, { redirect: 'manual' })
    const url = page.headers.get('location') ?? ''
    const tag = url.match(/\/releases\/tag\/([^/?#]+)/)?.[1]
    if (!tag) throw new Error(`Could not determine the latest CLIProxyAPI release (GitHub API returned ${res.status})`)
    info = { tag: decodeURIComponent(tag), publishedAt: '', url, notes: '' }
  }
  latestCache = { at: Date.now(), info }
  return info
}

/** A release tag such as v6.1.2 or v6.1.2-rc.1. It goes into a download URL and a file name, so nothing else passes. */
const TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/

export function validateTag(tag: unknown): asserts tag is string {
  if (typeof tag !== 'string' || !TAG.test(tag)) {
    throw new Error(`Invalid CLIProxyAPI release tag ${JSON.stringify(tag)}; expected a version like v6.1.2`)
  }
}

let progress: InstallProgress | undefined
export const installProgress = () => progress

/** Records a failure that happened before a download started (e.g. resolving the latest release). */
export function failInstall(err: unknown) {
  if (progress?.phase === 'error') return
  progress = { tag: progress?.tag ?? '', phase: 'error', received: 0, total: 0, error: err instanceof Error ? err.message : String(err) }
}

/**
 * Downloads, checksum-verifies and installs a CPA release. `beforeSwap` runs right before the
 * binary is replaced (stop CPA there; Windows cannot overwrite a running executable). The binary it
 * replaces is kept as `<binaryPath>.old`, so a bad release can be rolled back by hand.
 */
export async function installRelease(tag: string, beforeSwap?: () => Promise<void>) {
  if (progress && !['done', 'error'].includes(progress.phase)) throw new Error('An install is already running')
  try {
    validateTag(tag)
  } catch (err) {
    progress = { tag: String(tag), phase: 'error', received: 0, total: 0, error: (err as Error).message }
    throw err
  }
  progress = { tag, phase: 'downloading', received: 0, total: 0 }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-install-'))
  try {
    const asset = assetName(tag)
    const base = `https://github.com/${CPA_REPO}/releases/download/${tag}`

    const res = await fetch(`${base}/${asset}`, { headers: { 'User-Agent': 'cpa-console' } })
    if (!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}`)
    progress.total = Number(res.headers.get('content-length') ?? 0)
    const hash = crypto.createHash('sha256')
    const archive = path.join(work, asset)
    const out = fs.createWriteStream(archive)
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      out.write(chunk)
      progress.received += chunk.byteLength
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))

    progress.phase = 'verifying'
    const sums = await fetch(`${base}/checksums.txt`, { headers: { 'User-Agent': 'cpa-console' } })
    if (!sums.ok) throw new Error(`Could not fetch checksums.txt (HTTP ${sums.status})`)
    const expected = (await sums.text())
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find(([, name]) => name === asset)?.[0]
    if (!expected) throw new Error(`No checksum published for ${asset}`)
    if (expected !== hash.digest('hex')) throw new Error('Checksum mismatch; the download was discarded')

    progress.phase = 'extracting'
    const extractDir = path.join(work, 'x')
    fs.mkdirSync(extractDir)
    // bsdtar (macOS, Windows 10+) also extracts zip archives.
    await run('tar', ['-xf', archive, '-C', extractDir])
    const extracted = path.join(extractDir, binaryName)
    if (!fs.existsSync(extracted)) throw new Error(`${binaryName} not found in ${asset}`)

    fs.mkdirSync(paths.bin, { recursive: true })
    const staged = `${binaryPath}.new`
    fs.copyFileSync(extracted, staged)
    fs.chmodSync(staged, 0o755)
    await beforeSwap?.()
    if (fs.existsSync(binaryPath)) fs.copyFileSync(binaryPath, `${binaryPath}.old`)
    fs.renameSync(staged, binaryPath)
    updateState({ cpaVersion: tag })
    progress.phase = 'done'
  } catch (err) {
    progress.phase = 'error'
    progress.error = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
