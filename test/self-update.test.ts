import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

// paths are fixed when env.ts loads, so point the data dir at a scratch dir before importing.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-self-update-test-'))
process.env.CPA_CONSOLE_DATA = data
const { appDirs, installNext, resetProgress, rollback, satisfies, startRollback, startUpdate, swap, updateProgress, versionIn } = await import(
  '../server/self-update.ts'
)
const { launchdPlist, plistNode, systemdUnit, unitNode } = await import('../server/service.ts')
const { DOWN_MS, pollsDown } = await import('../src/lib/update-poll.ts')

const dirs = appDirs(data)
after(() => fs.rmSync(data, { recursive: true, force: true }))

/** Writes a fake console package into an app directory, as npm would. */
function fakePackage(dir: string, version: string, { engines = '>=22.13', reports = version, broken = false } = {}) {
  const pkg = path.join(dir, 'node_modules/cliproxyui')
  fs.mkdirSync(path.join(pkg, 'dist-server'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'cliproxyui', version, engines: { node: engines } }))
  fs.writeFileSync(path.join(pkg, 'dist-server/cli.js'), broken ? 'throw new Error("boom")\n' : `console.log(${JSON.stringify(reports)})\n`)
}

/** An installer that writes a fake package, like `npm install` of that version. */
const installs =
  (opts: Parameters<typeof fakePackage>[2] = {}) =>
  async (dir: string, spec: string) =>
    fakePackage(dir, spec.split('@')[1], opts)

const opts = { data, nodeVersion: '24.0.0' }

beforeEach(() => {
  for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true })
  fakePackage(dirs.app, '0.1.0-nightly.1')
  resetProgress()
})

describe('update', () => {
  test('installs beside the running version, then swaps keeping the old one', async () => {
    await installNext('0.1.0-nightly.2', { ...opts, install: installs() })
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.1', 'the running version is untouched until the swap')
    assert.equal(versionIn(dirs.next), '0.1.0-nightly.2')
    swap(data)
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.2')
    assert.equal(versionIn(dirs.prev), '0.1.0-nightly.1')
    assert.ok(!fs.existsSync(dirs.next))
  })

  test('replaces an older app-prev', async () => {
    fakePackage(dirs.prev, '0.1.0-nightly.0')
    await installNext('0.1.0-nightly.2', { ...opts, install: installs() })
    swap(data)
    assert.equal(versionIn(dirs.prev), '0.1.0-nightly.1')
  })

  test('passes the exact version to the installer', async () => {
    let got = ''
    await installNext('0.1.0-nightly.7', {
      ...opts,
      install: async (dir, spec) => {
        got = spec
        fakePackage(dir, '0.1.0-nightly.7')
      },
    })
    assert.equal(got, 'cliproxyui@0.1.0-nightly.7')
  })

  test('the full update swaps and asks for a restart', async () => {
    let restarted = false
    startUpdate('0.1.0-nightly.2', () => (restarted = true), { ...opts, install: installs() })
    assert.equal(updateProgress()?.phase, 'installing')
    await waitFor(() => restarted || updateProgress()?.phase === 'failed')
    assert.equal(updateProgress()?.phase, 'restarting')
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.2')
    assert.equal(versionIn(dirs.prev), '0.1.0-nightly.1')
  })
})

describe('failure before the swap leaves the running version', () => {
  const cases: [string, Parameters<typeof installNext>[1], RegExp][] = [
    [
      'install fails',
      {
        install: async () => {
          throw Object.assign(new Error('Command failed'), { stderr: 'npm error 404 Not Found' })
        },
      },
      /Could not install cliproxyui@0\.1\.0-nightly\.2: npm error 404/,
    ],
    ['installs another version', { install: async (dir) => fakePackage(dir, '0.1.0-nightly.3') }, /Installed 0\.1\.0-nightly\.3 instead/],
    ['installs nothing', { install: async () => {} }, /not installed/],
    ['needs a newer Node', { install: installs({ engines: '>=99' }) }, /needs Node >=99, but the service runs Node 24\.0\.0/],
    ['does not start', { install: installs({ broken: true }) }, /does not start: .*boom/s],
    ['reports another version', { install: installs({ reports: 'nope' }) }, /reports its version as "nope"/],
  ]
  for (const [name, o, error] of cases) {
    test(name, async () => {
      await assert.rejects(installNext('0.1.0-nightly.2', { ...opts, ...o }), error)
      assert.equal(versionIn(dirs.app), '0.1.0-nightly.1')
      assert.ok(!fs.existsSync(dirs.next), 'app-next is cleaned up')
      assert.ok(!fs.existsSync(dirs.prev))
    })
  }

  test('rejects a malformed version without installing', async () => {
    let called = false
    const install = async () => void (called = true)
    await assert.rejects(installNext('latest', { ...opts, install }), /Invalid version/)
    await assert.rejects(installNext('1.0.0 --registry=x', { ...opts, install }), /Invalid version/)
    assert.ok(!called)
  })

  test('a failed full update reports the error and does not restart', async () => {
    let restarted = false
    startUpdate('0.1.0-nightly.2', () => (restarted = true), { ...opts, install: installs({ engines: '>=99' }) })
    await waitFor(() => updateProgress()?.phase === 'failed')
    assert.match(updateProgress()?.error ?? '', /needs Node >=99/)
    assert.ok(!restarted)
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.1')
  })
})

describe('rollback', () => {
  test('restores app-prev and keeps the newer one, so it can be undone', async () => {
    await installNext('0.1.0-nightly.2', { ...opts, install: installs() })
    swap(data)
    assert.equal(await rollback(opts), '0.1.0-nightly.1')
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.1')
    assert.equal(versionIn(dirs.prev), '0.1.0-nightly.2')
    assert.ok(!fs.existsSync(dirs.swap))
    assert.equal(await rollback(opts), '0.1.0-nightly.2')
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.2')
  })

  test('refuses without a previous version', async () => {
    await assert.rejects(rollback(opts), /no previous version/)
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.1')
  })

  test('refuses a previous version that no longer starts', async () => {
    fakePackage(dirs.prev, '0.1.0-nightly.0', { broken: true })
    await assert.rejects(rollback(opts), /does not start/)
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.1')
    assert.equal(versionIn(dirs.prev), '0.1.0-nightly.0')
  })

  test('refuses a rollback or an update while a rollback checks app-prev', async () => {
    fakePackage(dirs.prev, '0.1.0-nightly.0')
    let restarts = 0
    const first = startRollback(() => restarts++, opts)
    // The first is still running app-prev's --version.
    await assert.rejects(startRollback(() => restarts++, opts), /already in progress/)
    assert.throws(() => startUpdate('0.1.0-nightly.2', () => restarts++, { ...opts, install: installs() }), /already in progress/)
    assert.equal((await first).phase, 'restarting')
    assert.equal(restarts, 1)
    assert.equal(versionIn(dirs.app), '0.1.0-nightly.0')
    assert.equal(versionIn(dirs.prev), '0.1.0-nightly.1')
  })

  test('a failed rollback leaves the console free to update', async () => {
    fakePackage(dirs.prev, '0.1.0-nightly.0', { broken: true })
    await assert.rejects(startRollback(() => {}, opts), /does not start/)
    assert.equal(startUpdate('0.1.0-nightly.2', () => {}, { ...opts, install: installs() }).phase, 'installing')
    await waitFor(() => updateProgress()?.phase !== 'installing' && updateProgress()?.phase !== 'verifying')
  })
})

describe('service', () => {
  test('reads the Node a systemd unit runs with', () => {
    assert.equal(unitNode(systemdUnit('/data/app/cli.js')), process.execPath)
  })

  test('reads the Node a launchd plist runs with', () => {
    assert.equal(plistNode(launchdPlist('/data/app/cli.js')), process.execPath)
    assert.equal(plistNode(launchdPlist('/data/app/cli.js').replace(process.execPath, '/opt/a&amp;b/node')), '/opt/a&b/node')
  })
})

describe('satisfies', () => {
  const yes: [string, string][] = [
    ['22.13.0', '>=22.13'],
    ['24.1.0', '>=22.13'],
    ['20.5.0', '^18 || ^20'],
    ['20.5.0', '>=18 <21'],
    ['20.5.0', '>= 18 < 21'],
    ['20.5.0', '20.x'],
    ['20.5.0', '20'],
    ['20.5.0', '~20.5'],
    ['20.5.0', '18 - 20'],
    ['20.5.0', '*'],
    ['v20.5.0', '>=20.5.0'],
  ]
  const no: [string, string][] = [
    ['22.12.0', '>=22.13'],
    ['21.0.0', '>=18 <21'],
    ['22.0.0', '^18 || ^20'],
    ['20.6.0', '~20.5'],
    ['21.0.0', '18 - 20'],
    ['20.5.0', '>20'],
    ['20.5.0', 'not a range'],
  ]
  for (const [v, r] of yes) test(`${v} satisfies ${r}`, () => assert.ok(satisfies(v, r)))
  for (const [v, r] of no) test(`${v} does not satisfy ${r}`, () => assert.ok(!satisfies(v, r)))
})

describe('the update dialog takes failing polls as the restart', () => {
  test('after installing or verifying, once they fail for a while', () => {
    assert.equal(pollsDown('installing', true, DOWN_MS, 0), true)
    assert.equal(pollsDown('verifying', true, DOWN_MS, 0), true)
  })

  test('not on a single failed poll', () => {
    assert.equal(pollsDown('installing', true, 1000, 0), false)
    assert.equal(pollsDown('verifying', true, 1000, 0), false)
  })

  test('not once a poll answers again', () => {
    assert.equal(pollsDown('installing', false, DOWN_MS, 0), false)
  })

  test('not after the update failed or before one ran', () => {
    assert.equal(pollsDown('failed', true, DOWN_MS, 0), false)
    assert.equal(pollsDown(undefined, true, DOWN_MS, 0), false)
  })
})

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10))
}
