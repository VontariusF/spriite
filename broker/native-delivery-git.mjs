import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, lstat, realpath, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_FILES = 20000, MAX_BYTES = 256 * 1024 * 1024
const sha = /^[a-f0-9]{40}$/

/** Never ask Git to discover/parse the worker's repository configuration.
 * A stopped checkout must be an ordinary, physically owned .git directory.
 * Only its index, refs and object bytes enter a private trusted Git directory.
 * Unsupported shared/worktree/alternate repositories fail closed.
 */
export async function prepareDeliveryGitCheckout(workDir) {
  if (!isAbsolute(workDir) || await realpath(workDir) !== workDir) throw new Error('unsafe checkout')
  const source = join(workDir, '.git')
  if (!(await lstat(source)).isDirectory() || await realpath(source) !== source) throw new Error('unsafe git directory')
  const exists = async path => {
    try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  for (const path of ['commondir', 'config.worktree', 'objects/info/alternates', 'objects/info/http-alternates',
    'info/grafts', 'refs/replace', 'shallow']) {
    if (await exists(join(source, path))) throw new Error('unsupported metadata')
  }
  // Reject guard hooks rather than silently bypassing them. This is only a
  // conservative refusal; isolation below, not text matching, is the boundary.
  const configPath = join(source, 'config')
  if (await exists(configPath)) {
    if (!(await lstat(configPath)).isFile()) throw new Error('unsafe configuration')
    const fd = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await fd.stat()
      if (!stat.isFile() || stat.size > 65536) throw new Error('unsafe configuration')
      const read = await fd.read(Buffer.alloc(65537), 0, 65537, null)
      if (read.bytesRead !== stat.size) throw new Error('configuration changed')
      const text = read.buffer.subarray(0, read.bytesRead).toString('utf8')
      if (/hook|include/i.test(text) || /[\0\uFFFD]/.test(text)) throw new Error('unsupported configuration')
    } finally { await fd.close() }
  }
  const hooks = join(source, 'hooks')
  if (await exists(hooks)) {
    if (!(await lstat(hooks)).isDirectory() || await realpath(hooks) !== hooks ||
        (await readdir(hooks)).some(name => !name.endsWith('.sample'))) throw new Error('unsafe hooks')
  }
  const gitDir = await mkdtemp(join(await realpath(tmpdir()), 'spriite-delivery-git-'))
  let files = 0, bytes = 0
  const copy = async (relative, optional = false) => {
    const path = join(source, relative)
    if (optional && !await exists(path)) return
    if (++files > MAX_FILES || relative.split('/').length > 32) throw new Error('metadata limit')
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('unsafe metadata path')
    if (stat.isDirectory()) {
      await mkdir(join(gitDir, relative), { recursive: true, mode: 0o700 })
      for (const name of await readdir(path)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('unsafe metadata name')
        await copy(join(relative, name))
      }
      return
    }
    if (!stat.isFile() || (bytes += stat.size) > MAX_BYTES) throw new Error('metadata limit')
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const actual = await fd.stat()
      if (!actual.isFile() || actual.size !== stat.size || actual.ino !== stat.ino) throw new Error('metadata changed')
      const buffer = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await fd.read(buffer, length, buffer.length - length, null)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length !== stat.size) throw new Error('metadata changed')
      const data = buffer.subarray(0, length)
      if (relative.startsWith('refs/')) {
        const ref = data.toString('utf8').trim()
        if (!sha.test(ref) && (!/^ref: refs\/(?:heads|remotes|tags)\/[A-Za-z0-9_./-]+$/.test(ref) ||
            ref.includes('..') || ref.includes('//') || ref.endsWith('.lock'))) throw new Error('unsafe ref')
      }
      await writeFile(join(gitDir, relative), data, { mode: 0o600, flag: 'wx' })
    } finally { await fd.close() }
  }
  try {
    await copy('objects')
    await copy('refs', true)
    await copy('HEAD')
    await copy('index', true)
    await copy('packed-refs', true)
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    if (!sha.test(head) && !/^ref: refs\/heads\/[A-Za-z0-9_./-]+$/.test(head)) throw new Error('unsafe head')
    if (await exists(join(gitDir, 'packed-refs'))) {
      const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8')
      if (packed.includes('refs/replace/') || packed.split('\n').some(line => line &&
          !line.startsWith('#') && !/^\^[a-f0-9]{40}$/.test(line) &&
          !/^[a-f0-9]{40} refs\/(?:heads|remotes|tags)\/[A-Za-z0-9_./-]+$/.test(line))) throw new Error('unsafe packed refs')
    }
    await writeFile(join(gitDir, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\nattributesFile = /dev/null\n', { mode: 0o600, flag: 'wx' })
    return { gitDir, workTree: workDir, cleanup: () => rm(gitDir, { recursive: true, force: true }) }
  } catch (error) {
    await rm(gitDir, { recursive: true, force: true })
    throw error
  }
}

export function deliveryGitEnvironment({ gitDir, workTree }) {
  if (![gitDir, workTree].every(value => typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value)) ||
      gitDir === join(workTree, '.git')) throw new Error('unsafe trusted snapshot')
  return Object.freeze({
    GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir, GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: join(gitDir, 'index'), GIT_OBJECT_DIRECTORY: join(gitDir, 'objects'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  })
}
