import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

// paths.bin is fixed when env.ts loads, so point the data dir at a scratch dir before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-binary-test-'))
process.env.CPA_CONSOLE_DATA = data
const { binaryPath, installProgress, installRelease, validateTag } = await import('../server/binary.ts')

describe('validateTag', () => {
  for (const tag of ['v6.1.2', '6.1.2', 'v10.20.30', 'v6.1.2-rc.1', 'v6.1.2-beta-2']) {
    test(`accepts ${tag}`, () => validateTag(tag))
  }
  for (const tag of [
    '',
    'v6',
    'v6.1',
    'latest',
    'v6.1.2/../../x',
    '../v6.1.2',
    'v6.1.2/',
    'v6.1.2-',
    'v6.1.2-..',
    'v6.1.2-rc..1',
    'v6.1.2?x=1',
    'v6.1.2#x',
    'v6.1.2 ',
    'v6.1.2\n',
    'v6.1.2-a/b',
    'v6.1.2-a\\b',
    'v6.1.2-%2e%2e',
  ]) {
    test(`rejects ${JSON.stringify(tag)}`, () => assert.throws(() => validateTag(tag), /Invalid CLIProxyAPI release tag/))
  }
  test('rejects a non-string', () => assert.throws(() => validateTag(undefined), /Invalid/))
})

describe('installRelease', () => {
  const realFetch = globalThis.fetch
  const binaryName = path.basename(binaryPath)
  const requested: string[] = []
  /** Release assets by tag: the archive name and bytes, served by the mocked fetch. */
  const releases = new Map<string, { asset: string; archive: Buffer }>()

  function release(tag: string, content: string) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-release-'))
    fs.writeFileSync(path.join(src, binaryName), content)
    const osName = process.platform === 'win32' ? 'windows' : process.platform
    const arch = process.arch === 'arm64' ? 'aarch64' : 'amd64'
    const ext = osName === 'windows' ? 'zip' : 'tar.gz'
    const asset = `CLIProxyAPI_${tag.replace(/^v/, '')}_${osName}_${arch}.${ext}`
    const archivePath = path.join(src, asset)
    execFileSync('tar', ['-czf', archivePath, '-C', src, binaryName])
    releases.set(tag, { asset, archive: fs.readFileSync(archivePath) })
    fs.rmSync(src, { recursive: true, force: true })
  }

  before(() => {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      requested.push(url)
      const m = url.match(/\/releases\/download\/([^/]+)\/(.+)$/)
      const rel = m && releases.get(m[1])
      if (!m || !rel) return new Response('not found', { status: 404 })
      if (m[2] === 'checksums.txt') {
        const sum = crypto.createHash('sha256').update(rel.archive).digest('hex')
        return new Response(`${sum}  ${rel.asset}\n`)
      }
      if (m[2] === rel.asset) return new Response(new Uint8Array(rel.archive))
      return new Response('not found', { status: 404 })
    }) as typeof fetch
  })

  after(() => {
    globalThis.fetch = realFetch
    fs.rmSync(data, { recursive: true, force: true })
  })

  test('rejects a malformed tag before downloading anything', async () => {
    requested.length = 0
    await assert.rejects(installRelease('v6.1.2/../../evil'), /Invalid CLIProxyAPI release tag/)
    assert.deepEqual(requested, [])
    assert.equal(installProgress()?.phase, 'error')
    assert.match(installProgress()?.error ?? '', /Invalid CLIProxyAPI release tag/)
  })

  test('a first install leaves no .old file', async () => {
    release('v1.0.0', 'first')
    await installRelease('v1.0.0')
    assert.equal(fs.readFileSync(binaryPath, 'utf8'), 'first')
    assert.equal(fs.existsSync(`${binaryPath}.old`), false)
  })

  test('an update keeps the previous binary as .old', async () => {
    release('v1.1.0', 'second')
    let swapped = false
    await installRelease('v1.1.0', async () => {
      swapped = true
    })
    assert.ok(swapped)
    assert.equal(fs.readFileSync(binaryPath, 'utf8'), 'second')
    assert.equal(fs.readFileSync(`${binaryPath}.old`, 'utf8'), 'first')
    assert.equal(installProgress()?.phase, 'done')
  })

  test('a failed download leaves the binary and .old untouched', async () => {
    await assert.rejects(installRelease('v9.9.9'), /Download failed/)
    assert.equal(fs.readFileSync(binaryPath, 'utf8'), 'second')
    assert.equal(fs.readFileSync(`${binaryPath}.old`, 'utf8'), 'first')
  })
})
