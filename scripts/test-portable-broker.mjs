// Portability checks for the native broker: it must run on any POSIX Factory
// host (Linux or macOS) where droid is installed, with no macOS-only defaults.
// Run: node --import ./scripts/ts-resolve.mjs scripts/test-portable-broker.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHostTool, resolveHostTools, productionDeploymentBinding, HOST_TOOL_ENV } from '../broker/host-production.mjs'
import { composeDaemonPath, containmentProbeScript, DAEMON_SYSTEM_PATH_DIRS } from '../broker/native-host.mjs'

let failures = 0, passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok - ${name}`) } catch (error) { failures++; console.error(`not ok - ${name}\n`, error) }
}
const code = expected => error => { assert.equal(error?.code, expected); return true }

const base = realpathSync(mkdtempSync(join(tmpdir(), 'spriite-portable-')))
const tool = (dir, name, mode = 0o755) => {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, mode)
  return path
}

try {
  await test('env override wins over PATH for each tool', () => {
    const custom = tool(join(base, 'custom'), 'gh')
    tool(join(base, 'onpath'), 'gh')
    assert.equal(resolveHostTool('gh', { PATH: join(base, 'onpath'), [HOST_TOOL_ENV.gh]: custom }), custom)
    assert.deepEqual(Object.keys(HOST_TOOL_ENV).sort(), ['droid', 'gh', 'git'])
    assert.equal(HOST_TOOL_ENV.droid, 'SPRIITE_NATIVE_DROID_PATH')
  })

  await test('an override that is relative or missing fails clearly', () => {
    assert.throws(() => resolveHostTool('git', { SPRIITE_NATIVE_GIT_PATH: 'bin/git' }), code('native_host_configuration_required'))
    assert.throws(() => resolveHostTool('git', { SPRIITE_NATIVE_GIT_PATH: join(base, 'nowhere', 'git') }),
      code('native_host_binary_missing:git'))
  })

  await test('PATH search takes the first absolute executable and skips relative or non-executable entries', () => {
    tool(join(base, 'first'), 'git', 0o644) // present but not executable
    const second = tool(join(base, 'second'), 'git')
    tool(join(base, 'third'), 'git')
    const PATH = ['', '.', 'relative/bin', join(base, 'empty'), join(base, 'first'), join(base, 'second'), join(base, 'third')].join(':')
    assert.equal(resolveHostTool('git', { PATH }), second)
  })

  await test('a tool missing from PATH fails with native_host_binary_missing:<tool>', () => {
    mkdirSync(join(base, 'empty'), { recursive: true })
    assert.throws(() => resolveHostTool('droid', { PATH: join(base, 'empty') }), code('native_host_binary_missing:droid'))
    assert.throws(() => resolveHostTool('droid', {}), code('native_host_binary_missing:droid'))
    assert.throws(() => resolveHostTool('curl', { PATH: '/usr/bin' }), code('native_host_configuration_required'))
  })

  await test('a simulated Linux layout resolves droid from ~/.local/bin and gh/git from system dirs', () => {
    const home = join(base, 'home', 'someone')
    const droid = tool(join(home, '.local', 'bin'), 'droid')
    const usrBin = join(base, 'usr', 'bin')
    const gh = tool(usrBin, 'gh'), git = tool(usrBin, 'git')
    const tools = resolveHostTools({ PATH: [join(home, '.local', 'bin'), join(base, 'usr', 'local', 'bin'), usrBin].join(':') })
    assert.deepEqual(tools, { droidPath: droid, ghPath: gh, gitPath: git })
  })

  await test('daemon PATH on a Linux layout: tool dirs, then system dirs, no Homebrew unless present', () => {
    const toolPaths = ['/home/someone/.local/bin/droid', '/usr/bin/gh', '/usr/bin/git']
    assert.equal(composeDaemonPath({ toolPaths, exists: () => false }),
      '/home/someone/.local/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin')
    const withLinuxbrew = composeDaemonPath({ toolPaths, exists: dir => dir === '/home/linuxbrew/.linuxbrew/bin' })
    assert(withLinuxbrew.split(':').includes('/home/linuxbrew/.linuxbrew/bin'))
    assert(!withLinuxbrew.includes('/opt/homebrew'))
    for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) assert(withLinuxbrew.split(':').includes(dir))
  })

  await test('daemon PATH on a macOS layout adds /opt/homebrew/bin only when it exists', () => {
    const path = composeDaemonPath({ toolPaths: ['/opt/homebrew/bin/gh', '/usr/bin/git'], exists: dir => dir === '/opt/homebrew/bin' })
    assert.equal(path, '/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin')
    assert.equal(composeDaemonPath({ exists: () => false }), DAEMON_SYSTEM_PATH_DIRS.join(':'))
  })

  await test('daemon PATH drops relative and colon-containing tool directories', () => {
    const path = composeDaemonPath({ toolPaths: ['droid', 'bin/gh', '/odd:dir/git', undefined], exists: () => false })
    assert.equal(path, DAEMON_SYSTEM_PATH_DIRS.join(':'))
  })

  await test('deployment digest binds the resolved absolute tool paths', () => {
    const dir = join(base, 'bound')
    const paths = { droidPath: tool(dir, 'droid'), ghPath: tool(dir, 'gh'), gitPath: tool(dir, 'git') }
    const config = { root: join(base, 'root'), ownerId: 'owner-one', machineId: 'machine-one',
      factoryApiKeyFile: join(base, 'key'), extensionTokenFile: join(base, 'token'), allowedModelIds: ['m'], allowedToolIds: ['Read'] }
    const explicit = productionDeploymentBinding({ ...config, ...paths })
    assert.equal(explicit.binding.binaries.ghPath.path, paths.ghPath)
    assert.equal(explicit.binding.binaries.gitPath.path, paths.gitPath)
    assert.equal(explicit.binding.binaries.droidPath.path, paths.droidPath)
    const previous = process.env.PATH
    try {
      process.env.PATH = dir
      const resolved = productionDeploymentBinding(config)
      assert.equal(resolved.deploymentDigest, explicit.deploymentDigest, 'PATH resolution yields the same digest')
      process.env.PATH = join(base, 'empty')
      assert.throws(() => productionDeploymentBinding(config), code('native_host_binary_missing:droid'))
    } finally { process.env.PATH = previous }
    const other = tool(join(base, 'other'), 'gh')
    assert.notEqual(productionDeploymentBinding({ ...config, ...paths, ghPath: other }).deploymentDigest, explicit.deploymentDigest)
  })

  await test('containment probe finds curl on the daemon PATH and fails without it', () => {
    const script = containmentProbeScript({ workDir: '/w', ownerHome: '/h', nonce: 'n1' })
    assert(!script.includes('/usr/bin/curl'))
    assert(script.includes('command -v curl') && script.includes('n=2'))
  })

  await test('broker sources carry no macOS-only defaults, personal paths or Mac copy', () => {
    const dir = new URL('../broker/', import.meta.url)
    const files = readdirSync(dir).filter(name => /\.(mjs|ts|d\.mts)$/.test(name))
    assert(files.includes('host-production.mjs') && files.includes('native-host.mjs'))
    for (const name of files) {
      const source = readFileSync(new URL(name, dir), 'utf8')
      for (const banned of ['/opt/homebrew/bin/gh', "'/usr/bin/git'", '/Users/', '/private/tmp', "'/tmp", 'Library/Application Support']) {
        assert(!source.includes(banned), `${name} contains ${banned}`)
      }
      assert(!/\b(the|your|my) Mac\b/i.test(source), `${name} refers to the host as a Mac`)
      // Homebrew may only appear as an optional, existence-checked daemon PATH dir.
      for (const line of source.split('\n').filter(text => text.includes('/opt/homebrew'))) {
        assert(name === 'native-host.mjs' && line.includes('DAEMON_OPTIONAL_PATH_DIRS'), `${name}: ${line.trim()}`)
      }
    }
    const readme = readFileSync(new URL('README.md', dir), 'utf8')
    assert(!readme.includes('/Users/') && !/\b(the|your|my) Mac\b/i.test(readme))
    assert(readme.includes('NATIVE-BROKER-SETUP.md') && /Windows\s+is not supported/.test(readme))
  })
  await test('src/, scripts/ and fixtures name no developer accounts, tailnet hosts or home paths', () => {
    // Owner-specific words come from SPRIITE_PERSONAL_PATTERNS (comma separated), never the
    // source; the generic checks catch a real home path or a real tailnet host.
    const banned = (process.env.SPRIITE_PERSONAL_PATTERNS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    const generic = [/(?<![0-9a-z])\/users\/(?!(owner|someone)\b)[a-z][a-z0-9._-]+\//, /(?<![0-9a-z])\/home\/(?!(user|me|someone|linuxbrew)\b)[a-z][a-z0-9._-]+\//, /\btail(?!0{4}\b)[0-9a-f]{6}\.ts\.net\b/]
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
      return /\.(ts|mts|mjs|js|json|jsonl|md|sh)$/.test(entry.name) ? [path] : []
    })
    const repo = new URL('../', import.meta.url).pathname
    const files = ['src', 'scripts', 'broker', 'cli', 'relay'].flatMap(dir => walk(join(repo, dir)))
      .filter(path => !/scripts\/test-portable-[^/]+\.mjs$/.test(path))
    assert(files.some(path => path.endsWith('src/main.ts')) && files.some(path => path.includes('scripts/fixtures/')))
    for (const path of files) {
      const text = readFileSync(path, 'utf8').toLowerCase()
      for (const word of banned) assert(!text.includes(word), `${path.slice(repo.length)} contains a developer-specific name`)
      for (const re of generic) assert(!re.test(text), `${path.slice(repo.length)} contains a home path or tailnet host`)
    }
  })
  await test('the spriite bin finds the broker and installer packed (./broker) and in a checkout (../broker)', async () => {
    const { resolveAssets } = await import('../cli/lib/assets.mjs')
    const repo = new URL('../', import.meta.url).pathname.replace(/\/$/, '')
    const checkout = resolveAssets(join(repo, 'cli'))
    assert(checkout.packed === false && checkout.broker === join(repo, 'broker') && checkout.installer === join(repo, 'scripts/install-native-broker.sh'))
    const packedRoot = join(base, 'packed-spriite')
    const present = new Set([join(packedRoot, 'broker/pair-protocol.mjs'), join(packedRoot, 'scripts/install-native-broker.sh')])
    const packed = resolveAssets(packedRoot, path => present.has(path))
    assert(packed.packed === true && packed.broker === join(packedRoot, 'broker'))
    const pkg = JSON.parse(readFileSync(join(repo, 'cli/package.json'), 'utf8'))
    assert(pkg.name === 'spriite' && pkg.bin.spriite === 'bin/spriite.mjs' && pkg.engines.node === '>=22')
    assert(pkg.files.includes('broker/') && pkg.files.includes('scripts/install-native-broker.sh') && /prepack/.test(pkg.scripts.prepack))
    const rootPkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    for (const dep of ['@noble/curves', '@noble/hashes']) {
      assert(/^\d+\.\d+\.\d+$/.test(pkg.dependencies[dep]) && pkg.dependencies[dep] === rootPkg.dependencies[dep], `${dep} pinned to one exact version`)
    }
  })
} finally {
  rmSync(base, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures} failed`)
if (failures) process.exitCode = 1
