// Portable native-broker installer: dry runs under a fake HOME on simulated
// Linux and macOS layouts, with a fake droid/gh and computer.json. Asserts the
// right unit paths, a 0600 key plan, that the key is never printed, and that no
// personal defaults (accounts, hosts, paths, vendor models) leak in.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const installer = join(repo, 'scripts/install-native-broker.sh')
const wrapper = join(repo, 'scripts/deploy-native-broker.sh')
const KEY = 'fk-test-NEVER-PRINT-7f3a9c'
const login = userInfo().username
const sanitized = login.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
let passed = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

function sandbox({ computer = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spriite-install-')))
  const home = join(root, 'home'), bin = join(root, 'bin')
  mkdirSync(join(home, '.factory'), { recursive: true }); mkdirSync(bin)
  if (computer) writeFileSync(join(home, '.factory/computer.json'), JSON.stringify({ computerId: 'computer-fixture-1' }))
  for (const name of ['droid', 'gh']) { writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, name), 0o755) }
  return { root, home, bin }
}

function run(box, env = {}, { script = installer, args = ['--dry-run'] } = {}) {
  const result = spawnSync('bash', [script, ...args], {
    cwd: box.root, encoding: 'utf8',
    env: { HOME: box.home, PATH: `${box.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, MODELS: '["model-fixture"]', ...env },
  })
  return { status: result.status, out: result.stdout + result.stderr }
}

function listTree(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    out.push(path)
    if (entry.isDirectory()) out.push(...listTree(path))
  }
  return out.sort()
}

// Extra owner-specific patterns (comma separated) come from SPRIITE_PERSONAL_PATTERNS, never the source.
const EXTRA = (process.env.SPRIITE_PERSONAL_PATTERNS ?? '').split(',').filter(Boolean).map(s => new RegExp(s, 'i'))
const PERSONAL = [...EXTRA, /gpt-6\.1/, /\.spriite-probe/, /ts\.net/, /\/Users\//, /Downloads/]
function assertGeneric(text, label) {
  // The checkout path, node location and the current login are the runner's own, not defaults.
  let clean = text.split(repo).join('<repo>').split(dirname(process.execPath)).join('<node>')
  if (login) clean = clean.split(login).join('<login>')
  for (const pattern of PERSONAL) assert.doesNotMatch(clean, pattern, `${label} leaks ${pattern}`)
}

test('installer source and wrapper hold no personal defaults', () => {
  for (const file of [installer, wrapper]) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of PERSONAL) assert.doesNotMatch(source, pattern, `${file} contains ${pattern}`)
    assert.doesNotMatch(source, /OWNER:-[^}]/, 'no hardcoded owner id default')
    assert.doesNotMatch(source, /\/opt\/homebrew/, 'no Homebrew-only paths')
  }
  assert.match(readFileSync(installer, 'utf8'), /^set -euo pipefail$/m)
  assert.match(readFileSync(wrapper, 'utf8'), /exec "\$\(dirname "\$0"\)\/install-native-broker\.sh" "\$@"/)
})

test('linux dry run: systemd user unit, XDG base dir, 0600 key plan, key never printed, nothing written', () => {
  const box = sandbox()
  const before = listTree(box.root)
  const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY })
  assert.equal(status, 0, out)
  const base = join(box.home, '.local/share/spriite/native-broker')
  assert.ok(out.includes(`base dir:     ${base}`), out)
  assert.ok(out.includes(join(box.home, '.config/systemd/user/spriite-native-broker.service')))
  assert.match(out, /\[Service\][\s\S]*ExecStart=\/usr\/bin\/env bash ".*\/native-broker\/run\.sh"/)
  assert.match(out, /WantedBy=default\.target/)
  assert.match(out, /loginctl enable-linger/)
  assert.ok(out.includes(`${base}/secrets/factory-api-key`) && /mode 0600/.test(out))
  assert.match(out, /SPRIITE_NATIVE_TRUSTED_HOST='1'/)
  assert.ok(out.includes(`SPRIITE_NATIVE_DROID_PATH='${join(box.bin, 'droid')}'`))
  assert.ok(out.includes(`SPRIITE_NATIVE_GH_PATH='${join(box.bin, 'gh')}'`))
  assert.match(out, /SPRIITE_NATIVE_ALLOWED_MODEL_IDS='\["model-fixture"\]'/)
  assert.match(out, /SPRIITE_NATIVE_MACHINE_ID='computer-fixture-1'/)
  assert.ok(out.includes(`SPRIITE_NATIVE_OWNER_ID='owner-${sanitized}'`), 'owner derived from id -un')
  assert.doesNotMatch(out, /LaunchAgents|launchctl/)
  assert.ok(!out.includes(KEY), 'key printed')
  assertGeneric(out, 'linux dry run')
  assert.deepEqual(listTree(box.root), before, 'dry run changed files')
  rmSync(box.root, { recursive: true, force: true })
})

test('linux honours XDG_DATA_HOME, XDG_CONFIG_HOME and OWNER', () => {
  const box = sandbox()
  const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY,
    XDG_DATA_HOME: join(box.root, 'data'), XDG_CONFIG_HOME: join(box.root, 'cfg'), OWNER: 'owner-someone' })
  assert.equal(status, 0, out)
  assert.ok(out.includes(join(box.root, 'data/spriite/native-broker/broker.env')))
  assert.ok(out.includes(join(box.root, 'cfg/systemd/user/spriite-native-broker.service')))
  assert.match(out, /SPRIITE_NATIVE_OWNER_ID='owner-someone'/)
  rmSync(box.root, { recursive: true, force: true })
})

test('macos dry run: LaunchAgent plist, Application Support base, key file input, droid from ~/.local/bin', () => {
  const box = sandbox()
  // droid is not on PATH here; the installer must find ~/.local/bin/droid.
  rmSync(join(box.bin, 'droid'))
  mkdirSync(join(box.home, '.local/bin'), { recursive: true })
  writeFileSync(join(box.home, '.local/bin/droid'), '#!/bin/sh\nexit 0\n'); chmodSync(join(box.home, '.local/bin/droid'), 0o755)
  const keyFile = join(box.root, 'factory.env')
  writeFileSync(keyFile, `# my env\nexport FACTORY_API_KEY=${KEY}\n`, { mode: 0o600 })
  const before = listTree(box.root)
  const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'macos', FACTORY_KEY_FILE: keyFile })
  assert.equal(status, 0, out)
  const base = join(box.home, 'Library/Application Support/Spriite/native-broker')
  assert.ok(out.includes(`base dir:     ${base}`), out)
  assert.ok(out.includes(join(box.home, 'Library/LaunchAgents/ai.spriite.native-broker.plist')))
  assert.match(out, /<key>Label<\/key><string>ai\.spriite\.native-broker<\/string>/)
  assert.match(out, /<string>\/bin\/bash<\/string><string>.*Application Support\/Spriite\/native-broker\/run\.sh<\/string>/)
  assert.match(out, /launchctl bootstrap gui\/\d+/)
  assert.ok(out.includes(`SPRIITE_NATIVE_DROID_PATH='${join(box.home, '.local/bin/droid')}'`))
  assert.match(out, /from FACTORY_KEY_FILE \(not shown\)[^\n]*mode 0600/)
  assert.doesNotMatch(out, /systemd|loginctl/)
  assert.ok(!out.includes(KEY), 'key printed')
  assertGeneric(out, 'macos dry run')
  assert.deepEqual(listTree(box.root), before, 'dry run changed files')
  rmSync(box.root, { recursive: true, force: true })
})

test('SPRIITE_HOME overrides the base dir on both layouts; the wrapper runs the installer', () => {
  for (const os of ['linux', 'macos']) {
    const box = sandbox()
    const home = join(box.root, 'custom home')
    const { status, out } = run(box, { SPRIITE_INSTALL_OS: os, FACTORY_API_KEY: KEY, SPRIITE_HOME: home }, { script: wrapper })
    assert.equal(status, 0, out)
    assert.ok(out.includes(`base dir:     ${home}`), out)
    assert.ok(out.includes(`B='${home}'`))
    assert.ok(!out.includes(KEY))
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('fails clearly: no computer.json, no MODELS, bad MODELS, no key, no droid, unsupported OS; key never echoed', () => {
  const cases = [
    [{ computer: false }, {}, /run droid once and sign in first/],
    [{}, { MODELS: '' }, /MODELS is required[\s\S]*no default on purpose/i],
    [{}, { MODELS: 'gpt' }, /MODELS must be a nonempty JSON array/],
    [{}, { FACTORY_API_KEY: '' }, /no Factory API key/],
    [{}, { DROID: '/nonexistent/droid', PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, /droid not found/],
    [{}, { SPRIITE_INSTALL_OS: 'windows' }, /Windows is not supported/],
    [{}, { FACTORY_API_KEY: `${KEY} trailing` }, /contains whitespace/],
  ]
  for (const [boxOptions, env, expected] of cases) {
    const box = sandbox(boxOptions)
    const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY, ...env })
    assert.notEqual(status, 0, `expected failure for ${JSON.stringify(env)}`)
    assert.match(out, expected)
    assert.ok(!out.includes(KEY), `key printed for ${JSON.stringify(env)}`)
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('refresh: an installed key file and previous models are reused without re-supplying them', () => {
  const box = sandbox()
  const base = join(box.home, '.local/share/spriite/native-broker')
  mkdirSync(join(base, 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(join(base, 'secrets/factory-api-key'), KEY, { mode: 0o600 })
  writeFileSync(join(base, 'broker.env'), "export SPRIITE_NATIVE_ALLOWED_MODEL_IDS='[\"model-kept\"]'\nexport SPRIITE_NATIVE_OWNER_ID='owner-kept'\n")
  const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', MODELS: '' })
  assert.equal(status, 0, out)
  assert.match(out, /keep the existing Factory API key file/)
  assert.match(out, /SPRIITE_NATIVE_ALLOWED_MODEL_IDS='\["model-kept"\]'/)
  assert.match(out, /SPRIITE_NATIVE_OWNER_ID='owner-kept'/)
  assert.ok(!out.includes(KEY))
  rmSync(box.root, { recursive: true, force: true })
})

test("ORIGINS defaults to '*' (the app's WebView origin is host-defined) and an explicit list is kept", () => {
  const box = sandbox()
  let { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY })
  assert.equal(status, 0, out)
  assert.match(out, /SPRIITE_NATIVE_ALLOWED_ORIGINS='\*'/)
  assert.match(out, /origins: {6}\*/)
  ;({ status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY, ORIGINS: 'https://a.example,null' }))
  assert.equal(status, 0, out)
  assert.match(out, /SPRIITE_NATIVE_ALLOWED_ORIGINS='https:\/\/a\.example,null'/)
  rmSync(box.root, { recursive: true, force: true })
})

test('a trailing-slash XDG_DATA_HOME and a symlinked data dir are written as canonical paths', () => {
  const box = sandbox()
  const real = join(box.root, 'real-data')
  mkdirSync(real)
  symlinkSync(real, join(box.root, 'linked-data'))
  for (const xdg of [`${box.root}/real-data/`, `${box.root}//real-data`, join(box.root, 'linked-data')]) {
    const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY, XDG_DATA_HOME: xdg })
    assert.equal(status, 0, out)
    const base = join(real, 'spriite/native-broker')
    assert.ok(out.includes(`base dir:     ${base}\n`), `${xdg}:\n${out}`)
    assert.ok(out.includes(`SPRIITE_NATIVE_STORE_DIR='${base}/store'`), out)
    assert.doesNotMatch(out, /[^:]\/\/|linked-data/, 'no doubled slash or symlinked path outside URLs')
  }
  const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY, SPRIITE_HOME: `${box.root}/a/../b` })
  assert.notEqual(status, 0); assert.match(out, /must not contain \. or \.\. components/)
  rmSync(box.root, { recursive: true, force: true })
})

test('Node older than 22.18 is refused with the reason; a droid others can write names the exact chmod', () => {
  const box = sandbox()
  const oldNode = join(box.root, 'old-node')
  writeFileSync(oldNode, '#!/bin/sh\n[ "$1" = --version ] && { echo v22.12.0; exit 0; }\nexit 1\n'); chmodSync(oldNode, 0o755)
  let { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY, NODE: oldNode })
  assert.notEqual(status, 0)
  assert.match(out, /Node\.js 22\.18 or newer is required[^\n]*v22\.12\.0/)
  // umask 002 install (0775, own group) is accepted.
  chmodSync(join(box.bin, 'droid'), 0o775)
  ;({ status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY }))
  if (statSync(join(box.bin, 'droid')).gid === process.getgid()) assert.equal(status, 0, out)
  chmodSync(join(box.bin, 'droid'), 0o777)
  ;({ status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY }))
  assert.notEqual(status, 0)
  assert.ok(out.includes(`chmod go-w "${join(box.bin, 'droid')}"`), out)
  assert.doesNotMatch(out, /non-world-writable/)
  assert.ok(!out.includes(KEY))
  rmSync(box.root, { recursive: true, force: true })
})

test('dry run on linux names the tailscale operator step; the unit stops crash-looping', () => {
  const box = sandbox()
  writeFileSync(join(box.bin, 'tailscale'), '#!/bin/sh\nexit 0\n'); chmodSync(join(box.bin, 'tailscale'), 0o755)
  const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY })
  assert.equal(status, 0, out)
  assert.match(out, /sudo tailscale set --operator=/)
  assert.match(out, /StartLimitIntervalSec=\d+\nStartLimitBurst=\d+/)
  rmSync(box.root, { recursive: true, force: true })
})

test('spriite pair mode: --non-interactive --summary ends with one secret-free SPRIITE_INSTALL_SUMMARY line', () => {
  const box = sandbox()
  writeFileSync(join(box.bin, 'tailscale'), '#!/bin/sh\nexit 0\n'); chmodSync(join(box.bin, 'tailscale'), 0o755)
  const before = listTree(box.root)
  const { status, out } = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY }, { args: ['--dry-run', '--non-interactive', '--summary'] })
  assert.equal(status, 0, out)
  const lines = out.split('\n').filter(l => l.startsWith('SPRIITE_INSTALL_SUMMARY '))
  assert.equal(lines.length, 1, out)
  assert.ok(out.trimEnd().endsWith(lines[0]), 'the summary is the last line')
  const summary = JSON.parse(lines[0].slice('SPRIITE_INSTALL_SUMMARY '.length))
  const base = join(box.home, '.local/share/spriite/native-broker')
  assert.deepEqual(summary, { v: 1, os: 'linux', base, ownerId: `owner-${sanitized}`, machineId: 'computer-fixture-1', port: 47821,
    servePort: 47822, brokerUrl: '', via: 'none', tokenFile: join(base, 'bearer-token'), xReader: true, dryRun: true })
  assert.ok(!out.includes(KEY), 'key printed')
  assert.doesNotMatch(out, /\[y\/N\]/, 'never prompts')
  assert.deepEqual(listTree(box.root), before, 'dry run changed files')
  // Without --summary the output carries no summary line (the human installer is unchanged).
  const plain = run(box, { SPRIITE_INSTALL_OS: 'linux', FACTORY_API_KEY: KEY })
  assert.equal(plain.status, 0, plain.out)
  assert.doesNotMatch(plain.out, /SPRIITE_INSTALL_SUMMARY/)
  assert.match(readFileSync(installer, 'utf8'), /--non-interactive\)/)
  rmSync(box.root, { recursive: true, force: true })
})

test('shellcheck (when installed)', () => {
  const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' })
  if (probe.error) { console.log('  (shellcheck not installed; skipped)'); return }
  const result = spawnSync('shellcheck', ['-x', installer, wrapper], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('bash -n parses both scripts', () => {
  for (const file of [installer, wrapper]) {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  assert.ok(existsSync(installer))
})

for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`ok - ${name}`) } catch (error) { console.error(`not ok - ${name}\n${error.stack}`); process.exitCode = 1 }
}
console.log(`${passed}/${tests.length} portable installer tests passed`)
