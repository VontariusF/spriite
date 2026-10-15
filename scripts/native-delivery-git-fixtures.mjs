import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, access, realpath, rm, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { createNativeDelivery, createProductionRunner } from '../broker/native-delivery.mjs'
import { prepareDeliveryGitCheckout } from '../broker/native-delivery-git.mjs'

/** Synthetic object bytes only. Real Git commands are read-only, isolated from
 * account configuration, and remote commands are intercepted before spawning. */
export async function testTrustedGitBoundary() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'spriite-delivery-config-repro-'))
  try {
    const work = join(root, 'work'), gitDir = join(work, '.git'), marker = join(root, 'OUTSIDE_MARKER'), helper = join(root, 'dummy-helper')
    await mkdir(join(gitDir, 'objects'), { recursive: true })
    await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
    await writeFile(helper, `#!/bin/sh\nprintf harmless > '${marker}'\n`, { mode: 0o700 })
    const put = async (type, body) => {
      const bytes = Buffer.from(body), encoded = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])
      const oid = createHash('sha1').update(encoded).digest('hex')
      await mkdir(join(gitDir, 'objects', oid.slice(0, 2)), { recursive: true })
      await writeFile(join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2)), deflateSync(encoded))
      return oid
    }
    const tree = await put('tree', '')
    const base = await put('commit', `tree ${tree}\nauthor Offline fixture <fixture@example.invalid> 1 +0000\ncommitter Offline fixture <fixture@example.invalid> 1 +0000\n\nbase\n`)
    const head = await put('commit', `tree ${tree}\nparent ${base}\nauthor Offline fixture <fixture@example.invalid> 2 +0000\ncommitter Offline fixture <fixture@example.invalid> 2 +0000\n\nhead\n`)
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${head}\n`)
    await writeFile(join(gitDir, 'config'), `[core]\nrepositoryformatversion=0\nbare=false\nfsmonitor=${helper}\nsshCommand=${helper}\n[credential]\nhelper=!${helper}\n[url "file://${root}/replacement"]\ninsteadOf=https://github.com/\n[diff "outside"]\ncommand=${helper}\ntextconv=${helper}\n[filter "outside"]\nclean=${helper}\nsmudge=${helper}\n`)
    const calls = []
    const actual = createProductionRunner('/usr/bin/git', { env: {
      PATH: '/usr/bin:/bin', HOME: root, GH_TOKEN: 'dummy-credential-only',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: helper,
    } })
    const git = async (args, options) => {
      calls.push({ args, options })
      assert.notEqual(options.gitEnvironment.GIT_DIR, gitDir)
      assert.equal(options.gitEnvironment.GIT_CONFIG_COUNT, '0')
      assert.equal(options.gitEnvironment.GIT_WORK_TREE, work)
      await assert.rejects(access(marker))
      if (args.includes('ls-remote') || args.includes('push')) return { status: null, stdout: '', stderr: '' }
      return actual(args, options)
    }
    const delivery = createNativeDelivery({ git, gh: async args => {
      assert.equal(args.slice(0, 2).join(' '), 'repo view')
      return { status: 0, stdout: '{"id":"R_reviewed","visibility":"PRIVATE"}', stderr: '' }
    }, now: () => new Date().toISOString(), sleep: () => {} })
    const input = { missionId: 'config-repro', workDir: work, repository: 'offline/never-contacted',
      baseRef: 'main', baseSha: base, title: 'Offline', body: '',
      repositoryIdentity: { repositoryId: 'R_reviewed', visibility: 'PRIVATE' },
      policy: { allowPush: true, allowPr: false, allowMerge: false } }
    const held = await delivery.deliver(input)
    assert.equal(held.step, 'held')
    assert.equal(calls[0].args[0], 'status')
    for (const command of ['status', 'rev-parse', 'merge-base', 'diff', 'rev-list', 'cat-file', 'ls-remote'])
      assert(calls.some(row => row.args.includes(command)), `trusted propagation for ${command}`)
    await assert.rejects(access(marker))
    // Source config cannot redirect the trusted snapshot's credential or URL
    // configuration, and every process ignores ambient command-scope config.
    const snapshot = await prepareDeliveryGitCheckout(work)
    try {
      const { deliveryGitEnvironment } = await import('../broker/native-delivery-git.mjs')
      const result = await actual(['config', '--get-regexp', '^(credential|url|filter|diff)\\.'], {
        cwd: work, timeoutMs: 1000, gitEnvironment: deliveryGitEnvironment(snapshot),
      })
      assert.equal(result.status, 1)
    } finally { await snapshot.cleanup() }
    // A nested checkout's config must not be evaluated by status/diff either.
    const subGit = join(work, 'sub', '.git')
    await mkdir(join(subGit, 'refs', 'heads'), { recursive: true })
    await cp(join(gitDir, 'objects'), join(subGit, 'objects'), { recursive: true })
    await writeFile(join(subGit, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(subGit, 'refs', 'heads', 'main'), `${head}\n`)
    await writeFile(join(subGit, 'config'), `[core]\nrepositoryformatversion=0\nbare=false\nfsmonitor=${helper}\n`)
    const subTree = await put('tree', Buffer.concat([Buffer.from('160000 sub\0'), Buffer.from(head, 'hex')]))
    const rootHead = await put('commit', `tree ${subTree}\nparent ${head}\nauthor Offline fixture <fixture@example.invalid> 3 +0000\ncommitter Offline fixture <fixture@example.invalid> 3 +0000\n\nsubmodule fixture\n`)
    await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${rootHead}\n`)
    const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8)
    const entry = Buffer.alloc(72); entry.writeUInt32BE(0o160000, 24); Buffer.from(head, 'hex').copy(entry, 40)
    entry.writeUInt16BE(3, 60); entry.write('sub', 62)
    const index = Buffer.concat([header, entry])
    await writeFile(join(gitDir, 'index'), Buffer.concat([index, createHash('sha1').update(index).digest()]))
    const nestedStart = calls.length
    assert.equal((await delivery.deliver(input)).step, 'held')
    assert(calls.slice(nestedStart).find(row => row.args[0] === 'status').args.includes('--ignore-submodules=all'))
    await assert.rejects(access(marker))
    await writeFile(join(work, '.gitattributes'), '* filter=outside diff=outside\n')
    await mkdir(join(gitDir, 'info'), { recursive: true })
    await writeFile(join(gitDir, 'info', 'attributes'), '* filter=outside diff=outside\n')
    const attributes = await delivery.deliver(input)
    assert.equal(attributes.step, 'held')
    await assert.rejects(access(marker))
    await rm(join(work, '.gitattributes'))
    await mkdir(join(gitDir, 'hooks'), { recursive: true })
    await writeFile(join(gitDir, 'hooks', 'pre-push'), `#!/bin/sh\n'${helper}'\n`, { mode: 0o700 })
    let before = calls.length
    assert.equal((await delivery.deliver(input)).reason, 'Checkout Git metadata is not trusted')
    assert.equal(calls.length, before)
    await rm(join(gitDir, 'hooks', 'pre-push'))
    for (const unsupported of ['commondir', 'config.worktree', 'objects/info/alternates']) {
      const path = join(gitDir, unsupported)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, '/outside/unsupported')
      const before = calls.length
      assert.equal((await delivery.deliver(input)).reason, 'Checkout Git metadata is not trusted')
      assert.equal(calls.length, before)
      await rm(path)
    }
    await writeFile(join(gitDir, 'config'), `[include]\npath=${helper}\n`)
    before = calls.length
    assert.equal((await delivery.deliver(input)).step, 'held')
    assert.equal(calls.length, before)
    await assert.rejects(access(marker))
  } finally { await rm(root, { recursive: true, force: true }) }
}
