// Portable host runtime: behaviour a broker needs on any Linux or macOS Factory
// host. Group-writable droid under umask 002, the Node version gate, Node on the
// daemon PATH, process-group stop of a daemon's workers, browser origins, and
// startup release of a store lock left by a killed broker.
// Run: node --import ./scripts/ts-resolve.mjs scripts/test-portable-host-runtime.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  executableWritableByOthers, nodeSupportsTypeStripping, productionDaemonPath, productionDeploymentBinding,
} from '../broker/host-production.mjs'
import { createNativeHost } from '../broker/native-host.mjs'
import { startBrokerServer, recoverStaleWriterLock } from '../broker/server.mjs'

let failures = 0, passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok - ${name}`) } catch (error) { failures++; console.error(`not ok - ${name}\n`, error) }
}
const base = realpathSync(mkdtempSync(join(tmpdir(), 'spriite-portable-runtime-')))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
async function waitFor(check, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return true
  return check()
}
const TOKEN = 'portable-runtime-token-0123456789abcdefghijklmnop'

try {
  await test('group-writable droid owned by this user in its own group is accepted; world or foreign group is not', () => {
    const uid = process.getuid(), gid = process.getgid()
    const stat = (mode, owner = uid, group = gid) => ({ mode: 0o100000 | mode, uid: owner, gid: group })
    assert.equal(executableWritableByOthers(stat(0o755)), false)
    assert.equal(executableWritableByOthers(stat(0o775)), false, 'umask 002 install is fine')
    assert.equal(executableWritableByOthers(stat(0o777)), true, 'world-writable is never fine')
    assert.equal(executableWritableByOthers(stat(0o775, uid, gid + 1)), true, 'a shared group could replace it')
    assert.equal(executableWritableByOthers(stat(0o775, uid + 1, gid)), true, 'someone else owns it')
    assert.equal(executableWritableByOthers(stat(0o755, uid + 1, gid + 1)), false, 'root-owned 0755 is fine')

    const dir = join(base, 'umask002')
    mkdirSync(dir)
    const tools = {}
    for (const name of ['droid', 'gh', 'git']) {
      const path = join(dir, name)
      writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, name === 'droid' ? 0o775 : 0o755)
      tools[`${name}Path`] = path
    }
    // A fresh file's group is the directory's group on macOS; only assert when it is ours.
    const ownGroup = statSync(tools.droidPath).gid === process.getgid()
    const config = { root: join(base, 'root'), ownerId: 'owner-one', machineId: 'machine-one',
      factoryApiKeyFile: join(base, 'key'), extensionTokenFile: join(base, 'token'), allowedModelIds: ['m'], allowedToolIds: ['Read'] }
    if (ownGroup) assert.match(productionDeploymentBinding({ ...config, ...tools }).deploymentDigest, /^[0-9a-f]{64}$/)
    chmodSync(tools.droidPath, 0o777)
    assert.throws(() => productionDeploymentBinding({ ...config, ...tools }), error => error.code === 'native_host_binary_unsafe')
  })

  await test('Node gate: type stripping needs 22.18+, 23.6+ or 24+', () => {
    for (const ok of ['22.18.0', 'v22.23.1', '23.6.0', '24.0.0', '25.1.2']) assert.equal(nodeSupportsTypeStripping(ok), true, ok)
    for (const old of ['22.0.0', '22.17.1', '23.5.0', '21.9.0', '20.19.0', 'garbage']) assert.equal(nodeSupportsTypeStripping(old), false, old)
    assert.equal(nodeSupportsTypeStripping(), true, `this test runner (${process.version}) must support it`)
  })

  await test('daemon PATH includes the broker Node directory (nvm-style install)', () => {
    const nvmNode = '/home/someone/.nvm/versions/node/v22.18.0/bin/node'
    const path = productionDaemonPath({ droidPath: '/home/someone/.local/bin/droid', ghPath: '/usr/bin/gh',
      gitPath: '/usr/bin/git', nodePath: nvmNode, exists: () => false }).split(':')
    assert.deepEqual(path.slice(0, 3), ['/home/someone/.local/bin', '/usr/bin', '/home/someone/.nvm/versions/node/v22.18.0/bin'])
    assert(path.includes('/bin') && path.includes('/usr/local/bin'))
    assert(productionDaemonPath({ droidPath: '/a/droid', ghPath: '/a/gh', gitPath: '/a/git' }).split(':').includes(dirname(process.execPath)))
  })

  await test('stopping a daemon also stops a worker that ignores SIGTERM (process group)', async () => {
    const root = join(base, 'host'), missionId = 'mission-group-1'
    const jobDir = join(root, 'jobs', missionId), homeDir = join(jobDir, 'home'), workDir = join(jobDir, 'work')
    mkdirSync(join(homeDir, '.factory'), { recursive: true, mode: 0o700 }); mkdirSync(workDir, { recursive: true })
    const settings = join(homeDir, '.factory', 'settings.json')
    writeFileSync(settings, '{}\n')
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
      missionId, state: 'provisioned', homeDir, workDir, generation: 0,
      settingsSha256: createHash('sha256').update(readFileSync(settings)).digest('hex'),
    }))
    // Stand-in `droid daemon`: one background worker in its process group that
    // ignores SIGTERM, like a dev server or watcher a Mission left running.
    const droidPath = join(base, 'fake-droid')
    writeFileSync(droidPath, [
      '#!/bin/sh',
      "sh -c 'trap \"\" TERM; while :; do sleep 1; done' &",
      'echo $! > "$HOME/worker.pid"',
      "trap 'exit 0' TERM",
      'while :; do sleep 1; done', '',
    ].join('\n'))
    chmodSync(droidPath, 0o755)
    const host = createNativeHost({
      root, hostKey: generateKeyPairSync('ed25519').privateKey, delivery: {}, machineId: 'machine-one',
      deploymentDigest: 'e'.repeat(64), factoryApiKeyFile: join(base, 'unused-key'), droidPath,
      readFactoryCredential: () => 'fixture-key', allocatePort: async () => 40999, trustedHost: true,
      waitForDaemon: async () => waitFor(() => existsSync(join(homeDir, 'worker.pid'))),
    })
    let workerPid
    try {
      await host.startDaemon({ missionId })
      workerPid = Number(readFileSync(join(homeDir, 'worker.pid'), 'utf8'))
      assert(Number.isInteger(workerPid) && alive(workerPid))
      assert.equal(host.job(missionId).daemon.processGroup, true)
      await host.stopDaemon({ missionId })
      assert(await waitFor(() => !alive(workerPid)), `worker ${workerPid} outlived the stopped daemon`)
    } finally {
      // Never leave fixture processes behind if an assertion failed mid-way.
      const pid = (() => { try { return host.job(missionId).daemon?.pid } catch { return null } })()
      if (pid && alive(pid)) try { process.kill(-pid, 'SIGKILL') } catch {}
      if (workerPid && alive(workerPid)) try { process.kill(workerPid, 'SIGKILL') } catch {}
    }
  })

  await test('restart recovery signals the recorded process group of a matching orphan', async () => {
    const root = join(base, 'host-restart'), missionId = 'mission-group-2'
    const jobDir = join(root, 'jobs', missionId), homeDir = join(jobDir, 'home')
    mkdirSync(join(homeDir, '.factory'), { recursive: true })
    const droidPath = '/fixture/bin/droid'
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
      missionId, state: 'running', homeDir, workDir: join(jobDir, 'work'), generation: 1, settingsSha256: null,
      daemon: { pid: 7777, port: 40123, parentPid: 4242, envKeys: [], startedAt: new Date(0).toISOString(), processGroup: true },
      terminationVerified: false,
    }))
    const expected = `${droidPath} daemon --host 127.0.0.1 --port 40123 --parent-pid 4242 --settings ${join(homeDir, '.factory', 'settings.json')}`
    let command = expected
    const signals = []
    const host = createNativeHost({
      root, hostKey: generateKeyPairSync('ed25519').privateKey, delivery: {}, machineId: 'machine-one',
      deploymentDigest: 'e'.repeat(64), factoryApiKeyFile: join(base, 'unused-key'), droidPath, spawn: () => { throw new Error('no spawn') },
      inspectProcess: async () => command, sleep: async () => {},
      signalProcess: (pid, signal) => { signals.push([pid, signal]); command = null },
    })
    assert.deepEqual(await host.recoverAfterRestart(), [missionId])
    assert.deepEqual(signals, [[-7777, 'SIGTERM']])
    assert.equal(host.job(missionId).terminationVerified, true)
  })

  await test("ORIGINS '*' accepts any origin (including the opaque null); a refused origin is logged once with CORS set", async () => {
    const broker = { startObservationLoop() {}, async capabilities() { return { ok: true } } }
    const call = (port, headers, method = 'GET') => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/native/capabilities', method, headers }, res => {
        let body = ''; res.on('data', d => { body += d }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      })
      req.on('error', reject); req.end()
    })
    const auth = { authorization: `Bearer ${TOKEN}` }
    const any = await startBrokerServer({ broker, bearerToken: TOKEN, allowedOrigins: ['*'] })
    try {
      const port = any.address().port
      for (const origin of ['null', 'https://some-webview.example', 'http://192.168.1.5:5173']) {
        const res = await call(port, { ...auth, origin })
        assert.equal(res.status, 200, origin)
        assert.equal(res.headers['access-control-allow-origin'], origin)
      }
      assert.equal((await call(port, { origin: 'null' })).status, 401, 'the bearer token still gates every request')
      assert.equal((await call(port, { origin: 'null', 'access-control-request-method': 'GET' }, 'OPTIONS')).status, 200)
    } finally { any.close() }

    const lines = []
    const strict = await startBrokerServer({ broker, bearerToken: TOKEN, allowedOrigins: ['https://phone.example', 'null'], log: line => lines.push(line) })
    try {
      const port = strict.address().port
      assert.equal((await call(port, { ...auth, origin: 'null' })).status, 200, "'null' may be listed literally")
      const refused = await call(port, { ...auth, origin: 'https://other.example' })
      assert.equal(refused.status, 403)
      assert.equal(JSON.parse(refused.body).error, 'origin_forbidden')
      assert.equal(refused.headers['access-control-allow-origin'], 'https://other.example', 'browser can read the refusal')
      await call(port, { ...auth, origin: 'https://other.example' })
      assert.equal(lines.length, 1, 'logged once per origin')
      assert.match(lines[0], /refused browser origin "https:\/\/other\.example"/)
      assert(!lines[0].includes(TOKEN))
      assert.equal((await call(port, auth)).status, 200, 'curl without Origin passes')
    } finally { strict.close() }
  })

  await test('startup releases a store lock only when its broker process on this host is gone', () => {
    const lockFor = (name, lock) => {
      const directory = join(base, name)
      mkdirSync(join(directory, '.writer'), { recursive: true, mode: 0o700 })
      writeFileSync(join(directory, '.writer', 'owner.json'), JSON.stringify(lock), { mode: 0o600 })
      return directory
    }
    const exited = spawnSync(process.execPath, ['-e', ''])
    assert.equal(exited.status, 0)
    const deadPid = exited.pid
    const dead = lockFor('store-dead', { token: 'tok-dead', pid: deadPid, host: hostname() })
    if (!alive(deadPid)) {
      assert.deepEqual(recoverStaleWriterLock({ directory: dead }), { pid: deadPid, host: hostname() })
      assert(!existsSync(join(dead, '.writer')))
    }
    const live = lockFor('store-live', { token: 'tok-live', pid: process.ppid, host: hostname() })
    assert.equal(recoverStaleWriterLock({ directory: live }), null)
    assert(existsSync(join(live, '.writer', 'owner.json')))
    const remote = lockFor('store-remote', { token: 'tok-remote', pid: deadPid, host: `${hostname()}-elsewhere` })
    assert.equal(recoverStaleWriterLock({ directory: remote }), null)
    assert(existsSync(join(remote, '.writer', 'owner.json')))
    const injected = lockFor('store-injected', { token: 'tok-inj', pid: 999999, host: 'h1' })
    assert.equal(recoverStaleWriterLock({ directory: injected, hostName: 'h1', isAlive: () => true }), null)
    assert.equal(recoverStaleWriterLock({ directory: join(base, 'no-store') }), null)
    assert.equal(recoverStaleWriterLock({ directory: 'relative/store' }), null)
  })

  await test('systemd unit and installer carry crash-loop limits, a tailscale operator fallback and the Node gate', () => {
    const installer = readFileSync(new URL('./install-native-broker.sh', import.meta.url), 'utf8')
    assert.match(installer, /StartLimitBurst=\d+/)
    assert.match(installer, /if \[ "\$use_tailscale" = 1 \] && ! tailscale serve/)
    assert.match(installer, /sudo tailscale set --operator=/)
    assert.match(installer, /minor >= 18/)
  })
} finally {
  rmSync(base, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures} failed`)
if (failures) process.exitCode = 1
