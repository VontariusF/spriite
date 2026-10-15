import { execFile } from 'node:child_process'
import { isAbsolute, basename } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { prepareDeliveryGitCheckout, deliveryGitEnvironment } from './native-delivery-git.mjs'
import { fail, object, str, bool, int, one, time, hash, SECRET_PATTERNS } from './validation.mjs'

// Delivery runs in the broker, outside the job sandbox, with the owner's gh login.
// Runner output is only parsed, never copied into returned state or errors, because
// gh/git output can contain credentials.

export const DELIVERY_STEPS = Object.freeze(['held', 'pushed', 'pr_open', 'checks_pending', 'checks_failed', 'merged', 'not_merged'])
export const DELIVERY_RUNNER_TIMEOUT_MS = 120000
export const DELIVERY_RUNNER_MAX_BYTES = 1048576
export const DELIVERY_PR_FOOTER = 'Produced by a Factory Mission started from Spriite.'

const SHA = /^[a-f0-9]{40}$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPO_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/
const MISSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const BRANCH_PART = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const POLICY_KEYS = ['allowCreateRepository', 'allowPush', 'allowPr', 'allowMerge']
const STATE_KEYS = ['step', 'branch', 'headSha', 'prUrl', 'prNumber', 'checks', 'reason', 'updatedAt',
  'missionId', 'workDir', 'repository', 'baseRef', 'baseSha', 'policy', 'title', 'body', 'repositoryIdentity']

export const REASONS = Object.freeze({
  policy: 'Delivery not allowed by policy',
  noCommits: 'No commits to deliver',
  dirty: 'Working tree is not clean',
  notDescendant: 'Commits do not descend from the base commit',
  remoteDiverged: 'Remote branch already exists at a different commit',
  prNotAllowed: 'Pull request not allowed by policy',
  mergeNotAllowed: 'Merge not allowed by policy',
  noChecks: 'No checks configured',
  checksFailed: 'Checks failed',
  checksSkipped: 'Some checks were skipped',
  checksPending: 'Checks still running; resume later',
  headMoved: 'Pull request head moved',
  prClosed: 'Pull request was closed without merging',
  conflicts: 'Pull request has conflicts',
  interrupted: step => `Delivery interrupted during ${step}; resume to retry`,
})

// Pre-push gate: explicit credential patterns only (aligned with validation.mjs
// secretFree), so base64-ish text in legitimate files never matches. The diff
// helper is a quick preliminary gate; scanHistory checks every newly reachable
// commit/tree/blob too. Matched content and filenames never enter delivery state.
const SECRET_SCAN_MAX_FILES = 10

export function secretsInDiff(diff) {
  if (typeof diff !== 'string') return []
  const files = new Set()
  let current = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4)
      current = path === '/dev/null' ? null : path.startsWith('b/') && path.length <= 210 ? path.slice(2) : '(unknown)'
    } else if (line.startsWith('diff --git')) current = null
    if (current && line.startsWith('+') && !line.startsWith('+++') &&
        SECRET_PATTERNS.some(pattern => pattern.test(line))) files.add(current)
    if (files.size >= SECRET_SCAN_MAX_FILES) break
  }
  return [...files]
}

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}

export function validateRepository(value) {
  str(value, 160)
  const parts = value.split('/')
  if (parts.length !== 2 || !OWNER.test(parts[0]) || !validRepoName(parts[1])) fail('native_delivery_repository_invalid', 400)
  return value
}
function validRepoName(name) {
  return REPO_NAME.test(name) && name !== '.' && name !== '..' && !/\.git$/i.test(name)
}
function validateMissionId(value) {
  str(value, 100)
  if (!MISSION.test(value)) fail('native_delivery_mission_invalid', 400)
  return value
}
function validateSha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) fail('native_delivery_sha_invalid', 400)
  return value
}
export function shortBaseRef(value) {
  str(value, 256)
  const short = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
  if (value.startsWith('refs/') && !value.startsWith('refs/heads/')) fail('native_delivery_base_ref_invalid', 400)
  if (!BRANCH_PART.test(short) || short.includes('..') || short.includes('//') || short.endsWith('/') ||
      short.endsWith('.') || short.endsWith('.lock') || short.startsWith('spriite/')) fail('native_delivery_base_ref_invalid', 400)
  return short
}
function validatePolicy(value) {
  object(value, POLICY_KEYS, ['allowPush', 'allowPr', 'allowMerge'])
  for (const key of POLICY_KEYS) if (Object.hasOwn(value, key)) bool(value[key])
  if ((value.allowMerge && !value.allowPr) || (value.allowPr && !value.allowPush)) fail('native_delivery_policy_inconsistent', 400)
  return { allowPush: value.allowPush, allowPr: value.allowPr, allowMerge: value.allowMerge }
}
export function validateRepositoryIdentity(value) {
  object(value, ['repositoryId', 'visibility'])
  if (typeof value.repositoryId !== 'string' || !/^[A-Za-z0-9_+/=-]{1,256}$/.test(value.repositoryId))
    fail('native_delivery_repository_identity_required', 400)
  one(value.visibility, ['PRIVATE', 'PUBLIC'])
  return value
}
const remoteUrl = repository => `https://github.com/${repository}.git`
const branchOf = missionId => `spriite/${missionId}`

// The credential exists only for the duration of one git invocation: the inline
// helper resets any configured helpers and asks gh. Nothing is written to config.
const CREDENTIAL_ARGS = Object.freeze(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'])

class Interrupted extends Error {}
class RepositoryUnverified extends Interrupted {}
const ok = result => result && typeof result === 'object' && result.status === 0
function parseJson(result, expect) {
  if (!result || typeof result.stdout !== 'string') throw new Interrupted()
  try {
    const value = JSON.parse(result.stdout)
    if (expect === 'array' ? !Array.isArray(value) : (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error()
    return value
  } catch { throw new Interrupted() }
}

export function createNativeDelivery({ gh, git, now, sleep, verifyPushSafety, prepareGitCheckout = prepareDeliveryGitCheckout, timeoutMs = DELIVERY_RUNNER_TIMEOUT_MS, pollAttempts = 20, pollIntervalMs = 30000 }) {
  if (typeof gh !== 'function' || typeof git !== 'function' || typeof now !== 'function' || typeof sleep !== 'function') fail('native_delivery_ports_invalid')
  int(timeoutMs, 1); int(pollAttempts, 1); int(pollIntervalMs, 0)

  const checkout = new AsyncLocalStorage()
  async function withCheckout(workDir, action) {
    const prepared = await prepareGitCheckout(workDir)
    try { return await checkout.run(deliveryGitEnvironment(prepared), action) }
    finally { await prepared.cleanup?.() }
  }
  async function call(runner, args, cwd) {
    try {
      const gitEnvironment = runner === git ? checkout.getStore() : undefined
      if (runner === git && (!gitEnvironment || gitEnvironment.GIT_WORK_TREE !== cwd)) throw new Interrupted()
      const result = await runner(args, { cwd, timeoutMs, ...(gitEnvironment ? { gitEnvironment } : {}) })
      if (!result || typeof result !== 'object' || (result.status !== null && !Number.isSafeInteger(result.status))) throw new Interrupted()
      if (typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) > DELIVERY_RUNNER_MAX_BYTES) throw new Interrupted()
      return result
    } catch { throw new Interrupted() }
  }
  async function safePush(cwd) {
    if (verifyPushSafety) {
      if (await verifyPushSafety(cwd) !== true) throw new Interrupted()
      return
    }
    if (!checkout.getStore()) throw new Interrupted()
  }
  const stamp = () => {
    const at = now()
    const value = at instanceof Date ? at.toISOString() : at
    time(value)
    return value
  }
  const emit = (ctx, step, extra = {}) => {
    const state = { ...ctx.base, step, headSha: ctx.headSha, updatedAt: stamp() }
    for (const key of ['prUrl', 'prNumber', 'checks', 'reason']) {
      const value = Object.hasOwn(extra, key) ? extra[key] : ctx[key]
      if (value !== undefined) state[key] = value
    }
    return deepFreeze(state)
  }

  // An intent means dispatch MAY have happened. Even a crash immediately after
  // saving intent must reconcile, not replay. Receipts contain evidence only.
  async function effect(ctx, kind, identity, dispatch, reconcile) {
    const journal = ctx.journal
    if (!journal) {
      await dispatch()
      const receipt = await reconcile()
      if (!receipt) throw new Interrupted()
      return receipt
    }
    const binding = { ...journal.identity, ...identity, kind }
    const effectId = hash(binding)
    let prior
    try { prior = await journal.read(effectId) } catch { throw new Interrupted() }
    if (prior && (prior.effectId !== effectId || hash(prior.identity) !== hash(binding))) throw new Interrupted()
    if (!prior) {
      const intent = deepFreeze({ effectId, identity: binding, state: 'intent', updatedAt: stamp() })
      try { await journal.save(intent, ctx.base && !ctx.provisioning ? emit(ctx, ctx.prNumber ? 'pr_open' : ctx.pushed ? 'pushed' : 'held',
        { reason: REASONS.interrupted(kind) }) : undefined) } catch { throw new Interrupted() }
      // Saving MUST complete durably before the remote command is invoked.
      try { await dispatch() } catch (error) {
        if (error instanceof RepositoryUnverified) throw error
        if (!(error instanceof Interrupted)) throw error
      }
    }
    let receipt
    try {
      if (ctx.repositoryIdentity) await verifyRepository(ctx)
      receipt = await reconcile(prior)
      if (ctx.repositoryIdentity) await verifyRepository(ctx)
    }
    catch (error) { if (error instanceof RepositoryUnverified) throw error; throw new Interrupted() }
    if (!receipt) throw new Interrupted()
    try {
      await journal.save(deepFreeze({ effectId, identity: binding, state: 'confirmed', receipt, updatedAt: stamp() }),
        ctx.base && !ctx.provisioning ? emit(ctx, ctx.prNumber ? 'pr_open' : ctx.pushed ? 'pushed' : 'held',
          { reason: REASONS.interrupted(kind) }) : undefined)
    } catch { throw new Interrupted() }
    return receipt
  }

  const deliveryIdentity = ctx => ({
    missionId: ctx.base.missionId, repository: ctx.base.repository, baseRef: shortBaseRef(ctx.base.baseRef),
    baseSha: ctx.base.baseSha, headSha: ctx.headSha, branch: ctx.base.branch, policy: ctx.base.policy,
    repositoryId: ctx.repositoryIdentity.repositoryId, visibility: ctx.repositoryIdentity.visibility,
  })

  async function bindRepository(ctx) {
    const creation = ctx.journal && (await ctx.journal.list()).find(row => row.identity.kind === 'create_repository' &&
      row.identity.repository === ctx.base.repository && row.state === 'confirmed' && row.receipt?.created === true)
    ctx.repositoryIdentity = creation
      ? { repositoryId: creation.receipt.repositoryId, visibility: 'PRIVATE' } : ctx.base.repositoryIdentity
    try { validateRepositoryIdentity(ctx.repositoryIdentity) } catch { throw new RepositoryUnverified() }
    if (creation && ctx.base.repositoryIdentity && hash(ctx.repositoryIdentity) !== hash(ctx.base.repositoryIdentity))
      throw new RepositoryUnverified()
    await verifyRepository(ctx)
  }
  async function verifyRepository(ctx) {
    try {
      validateRepositoryIdentity(ctx.repositoryIdentity)
      const result = await call(gh, ['repo', 'view', ctx.base.repository, '--json', 'id,visibility'])
      if (!ok(result)) throw new Error()
      const value = parseJson(result, 'object')
      if (value.id !== ctx.repositoryIdentity.repositoryId || value.visibility !== ctx.repositoryIdentity.visibility) throw new Error()
    } catch { throw new RepositoryUnverified() }
  }

  async function createPrivateRepository(input, { journal } = {}) {
    object(input, ['account', 'name'])
    if (typeof input.account !== 'string' || !OWNER.test(input.account) ||
        typeof input.name !== 'string' || !validRepoName(input.name)) fail('native_delivery_repository_invalid', 400)
    const repository = `${input.account}/${input.name}`
    const view = async () => {
      let result
      try { result = await call(gh, ['repo', 'view', repository, '--json', 'id,visibility,isEmpty']) } catch { fail('native_delivery_repository_unavailable', 503) }
      if (ok(result)) {
        let value
        try { value = parseJson(result, 'object') } catch { fail('native_delivery_repository_unavailable', 503) }
        return { exists: true, private: value.visibility === 'PRIVATE', empty: value.isEmpty === true,
          repositoryId: typeof value.id === 'string' && /^[A-Za-z0-9_+/=-]{1,256}$/.test(value.id) ? value.id : null }
      }
      if (result.status !== null && /could not resolve to a repository/i.test(String(result.stderr ?? ''))) return { exists: false }
      fail('native_delivery_repository_unavailable', 503)
    }
    const identity = { repository, baseRef: journal?.identity?.baseRef ?? 'main',
      baseSha: journal?.identity?.baseSha ?? '', headSha: journal?.identity?.baseSha ?? '' }
    // Do not adopt after an ambiguous create: existence cannot prove who created
    // a repository. Hold for owner reconciliation instead of seeding it.
    if (journal) {
      const binding = { ...journal.identity, ...identity, kind: 'create_repository' }, effectId = hash(binding)
      const prior = await journal.read(effectId)
      if (prior) {
        const seen = await view()
        if (prior.effectId !== effectId || hash(prior.identity) !== hash(binding) ||
            prior.state !== 'confirmed' || prior.receipt?.created !== true) fail('native_delivery_repository_creation_unknown', 503)
        if (!seen.exists || !seen.private || seen.repositoryId !== prior.receipt.repositoryId)
          fail('native_delivery_repository_unverified', 503)
        return deepFreeze({ repositoryUrl: `https://github.com/${repository}`, created: true })
      }
    }
    const before = await view()
    if (before.exists) {
      if (!before.private || !before.empty) fail('native_delivery_repository_exists', 409)
      return deepFreeze({ repositoryUrl: `https://github.com/${repository}`, created: false })
    }
    let acknowledged = false
    try {
      await effect({ journal }, 'create_repository', identity, async () => {
        journal?.guard?.()
        const created = await call(gh, ['repo', 'create', repository, '--private'])
        acknowledged = ok(created)
      }, async () => {
        const after = await view()
        // A successful create response plus a private-empty read is attribution
        // evidence; mere existence after a lost response is not.
        if (!acknowledged || !after.exists || !after.private || !after.empty || (journal && !after.repositoryId)) return null
        return { created: true, ...(after.repositoryId ? { repositoryId: after.repositoryId } : {}) }
      })
    } catch { fail('native_delivery_repository_creation_unknown', 503) }
    return deepFreeze({ repositoryUrl: `https://github.com/${repository}`, created: true })
  }

  async function remoteBranchSha(ctx) {
    await verifyRepository(ctx)
    const ref = `refs/heads/${ctx.base.branch}`
    const result = await call(git, [...CREDENTIAL_ARGS, 'ls-remote', '--', remoteUrl(ctx.base.repository), ref], ctx.base.workDir)
    if (!ok(result) || typeof result.stdout !== 'string') throw new Interrupted()
    await verifyRepository(ctx)
    const lines = result.stdout.split('\n').filter(Boolean)
    for (const line of lines) {
      const [sha, name] = line.split('\t')
      if (name === ref && SHA.test(sha)) return sha
    }
    if (lines.length) throw new Interrupted()
    return null
  }

  async function localChecks(ctx) {
    const cwd = ctx.base.workDir
    const status = await call(git, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'], cwd)
    if (!ok(status) || typeof status.stdout !== 'string') throw new Interrupted()
    if (status.stdout.trim()) return REASONS.dirty
    const head = await call(git, ['rev-parse', '--verify', 'HEAD^{commit}'], cwd)
    const sha = ok(head) && typeof head.stdout === 'string' ? head.stdout.trim() : ''
    if (!SHA.test(sha)) throw new Interrupted()
    if (ctx.headSha && ctx.headSha !== sha) return REASONS.headMoved
    ctx.headSha = sha
    if (sha === ctx.base.baseSha) return REASONS.noCommits
    const ancestor = await call(git, ['merge-base', '--is-ancestor', ctx.base.baseSha, sha], cwd)
    if (ancestor.status === 1) return REASONS.notDescendant
    if (!ok(ancestor)) throw new Interrupted()
    const diff = await call(git, ['diff', '--no-color', '--no-ext-diff', `${ctx.base.baseSha}..${sha}`, '--no-textconv', '--ignore-submodules=all', '--'], cwd)
    if (!ok(diff) || typeof diff.stdout !== 'string') throw new Interrupted()
    const leaked = secretsInDiff(diff.stdout)
    if (leaked.length) return 'Credential-shaped content in delivered history'
    const history = await scanHistory(cwd, `${ctx.base.baseSha}..${sha}`)
    if (history) return history
    return null
  }

  async function scanHistory(cwd, range) {
    const result = await call(git, ['rev-list', '--objects', '--no-object-names', range, '--'], cwd)
    if (!ok(result) || typeof result.stdout !== 'string') throw new Interrupted()
    const objects = [...new Set(result.stdout.trim().split('\n').filter(Boolean))]
    if (!objects.length || objects.length > 2048 || objects.some(oid => !SHA.test(oid))) return 'Delivered history cannot be safely scanned'
    for (const oid of objects) {
      const type = await call(git, ['cat-file', '-t', oid], cwd)
      if (!ok(type) || !['commit', 'tree', 'blob'].includes(type.stdout?.trim())) throw new Interrupted()
      const content = await call(git, ['cat-file', '-p', oid], cwd)
      if (!ok(content) || typeof content.stdout !== 'string') throw new Interrupted()
      if (/[\0\uFFFD]/.test(content.stdout) || Buffer.byteLength(content.stdout) > DELIVERY_RUNNER_MAX_BYTES)
        return 'Delivered history contains binary or unscannable content'
      if (SECRET_PATTERNS.some(pattern => pattern.test(content.stdout))) return 'Credential-shaped content in delivered history'
    }
    return null
  }

  function exactPr(ctx, pr) {
    return pr && Number.isSafeInteger(pr.number) && pr.number > 0 &&
      pr.url === `https://github.com/${ctx.base.repository}/pull/${pr.number}` &&
      pr.headRefName === ctx.base.branch && pr.baseRefName === shortBaseRef(ctx.base.baseRef) &&
      pr.headRefOid === ctx.headSha &&
      (ctx.prNumber === undefined || ctx.prNumber === pr.number)
  }

  async function findPr(ctx) {
    await verifyRepository(ctx)
    const result = await call(gh, ['pr', 'list', '--repo', ctx.base.repository, '--head', ctx.base.branch,
      '--state', 'all', '--json', 'number,url,state,headRefOid,headRefName,baseRefName'])
    if (!ok(result)) throw new Interrupted()
    await verifyRepository(ctx)
    const list = parseJson(result, 'array')
    const valid = list.filter(pr => pr && Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.url === 'string' &&
      /^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/.test(pr.url) && ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state))
    if (valid.length !== list.length) throw new Interrupted()
    // A lone PR is returned as-is so exactPr can refuse a foreign one outright.
    if (valid.length <= 1) return valid[0] ?? null
    // GitHub keeps every PR ever opened from the delivery branch, and other
    // actors can open more from it. Narrow to the recorded PR number once known
    // (else to our base branch); any remaining ambiguity still fails closed.
    const ours = valid.filter(pr => ctx.prNumber !== undefined ? pr.number === ctx.prNumber :
      pr.baseRefName === shortBaseRef(ctx.base.baseRef))
    if (ours.length > 1 || (ctx.prNumber !== undefined && !ours.length)) throw new Interrupted()
    return ours[0] ?? null
  }

  async function readChecks(ctx) {
    await verifyRepository(ctx)
    const result = await call(gh, ['pr', 'checks', String(ctx.prNumber), '--repo', ctx.base.repository, '--json', 'name,state,bucket'])
    // gh exits 1 for failing checks and 8 for pending ones while still printing JSON.
    if (![0, 1, 8].includes(result.status)) throw new Interrupted()
    await verifyRepository(ctx)
    const out = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    if (!out) {
      if (result.status !== 0 && /no checks reported/i.test(String(result.stderr ?? ''))) return { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 }
      throw new Interrupted()
    }
    const list = parseJson(result, 'array')
    const counts = { total: list.length, passed: 0, failed: 0, pending: 0, skipped: 0 }
    for (const check of list) {
      const bucket = check && check.bucket
      if (bucket === 'pass') counts.passed++
      else if (bucket === 'fail' || bucket === 'cancel') counts.failed++
      else if (bucket === 'pending') counts.pending++
      else if (bucket === 'skipping') counts.skipped++
      else throw new Interrupted()
    }
    return counts
  }

  async function viewPr(ctx) {
    await verifyRepository(ctx)
    const result = await call(gh, ['pr', 'view', String(ctx.prNumber), '--repo', ctx.base.repository,
      '--json', 'number,url,headRefOid,headRefName,baseRefName,state,mergeable'])
    if (!ok(result)) throw new Interrupted()
    await verifyRepository(ctx)
    return parseJson(result, 'object')
  }

  async function run(ctx, fromStep) {
    let phase = 'verification'
    const lastStep = () => (ctx.prNumber ? 'pr_open' : ctx.pushed ? 'pushed' : 'held')
    try {
      const policy = ctx.base.policy
      if (fromStep === 'held') {
        const held = await localChecks(ctx)
        if (held) return emit(ctx, 'held', { reason: held })
        if (!policy.allowPush) return emit(ctx, 'held', { reason: REASONS.policy })
      }
      await bindRepository(ctx)
      phase = 'pull request lookup'
      let pr = policy.allowPr || fromStep !== 'held' ? await findPr(ctx) : null
      if (pr && !exactPr(ctx, pr)) return emit(ctx, 'not_merged', { reason: REASONS.headMoved })
      if (pr && pr.state === 'MERGED') {
        ctx.prNumber = pr.number; ctx.prUrl = pr.url
        if (ctx.journal) {
          // A merged, exact-head PR also proves the pushed head and PR creation,
          // even when GitHub deleted the delivery branch after the merge.
          await effect(ctx, 'branch_push', deliveryIdentity(ctx), async () => {},
            async () => ({ headSha: ctx.headSha }))
          await effect(ctx, 'pr_create', deliveryIdentity(ctx), async () => {},
            async () => ({ prNumber: ctx.prNumber, prUrl: ctx.prUrl, headSha: ctx.headSha }))
          await effect(ctx, 'pr_merge', { ...deliveryIdentity(ctx), prNumber: ctx.prNumber, prUrl: ctx.prUrl },
          async () => {}, async () => {
            const found = await viewPr(ctx)
            return exactPr(ctx, found) && found.state === 'MERGED' ? { prNumber: ctx.prNumber, prUrl: ctx.prUrl, headSha: ctx.headSha } : null
          })
        }
        return emit(ctx, 'merged', { reason: undefined })
      }
      if (pr && pr.state === 'OPEN' && pr.headRefOid !== ctx.headSha) {
        ctx.prNumber = pr.number; ctx.prUrl = pr.url
        return emit(ctx, 'not_merged', { reason: REASONS.headMoved })
      }
      if (!pr || pr.state !== 'OPEN') {
        phase = 'push'
        const remote = await remoteBranchSha(ctx)
        if (remote && remote !== ctx.headSha) return emit(ctx, ctx.pushed ? 'not_merged' : 'held', { reason: REASONS.remoteDiverged })
        if (!remote || ctx.journal) {
          await effect(ctx, 'branch_push', deliveryIdentity(ctx), async () => {
            if (remote) return
            await safePush(ctx.base.workDir)
            await verifyRepository(ctx)
            ctx.journal?.guard?.()
            const pushed = await call(git, [...CREDENTIAL_ARGS, 'push', '--porcelain', '--',
              remoteUrl(ctx.base.repository), `${ctx.headSha}:refs/heads/${ctx.base.branch}`], ctx.base.workDir)
            if (!ok(pushed)) throw new Interrupted()
          }, async () => await remoteBranchSha(ctx) === ctx.headSha ? { headSha: ctx.headSha } : null)
        }
        ctx.pushed = true
        if (pr && pr.state === 'CLOSED') {
          ctx.prNumber = pr.number; ctx.prUrl = pr.url
          return emit(ctx, 'not_merged', { reason: REASONS.prClosed })
        }
        if (!policy.allowPr) return emit(ctx, 'pushed', { reason: REASONS.prNotAllowed })
        phase = 'pull request creation'
        await effect(ctx, 'pr_create', deliveryIdentity(ctx), async () => {
          await verifyRepository(ctx)
          ctx.journal?.guard?.()
          await call(gh, ['pr', 'create', '--repo', ctx.base.repository, '--base', shortBaseRef(ctx.base.baseRef),
            '--head', ctx.base.branch, '--title', ctx.base.title, '--body', `${ctx.base.body}\n\n${DELIVERY_PR_FOOTER}`])
        }, async () => {
          const found = await findPr(ctx)
          return exactPr(ctx, found) && found.state === 'OPEN' ? { prNumber: found.number, prUrl: found.url, headSha: ctx.headSha } : null
        })
        pr = await findPr(ctx)
        if (!pr || pr.state !== 'OPEN' || pr.headRefOid !== ctx.headSha) throw new Interrupted()
      }
      ctx.pushed = true
      ctx.prNumber = pr.number; ctx.prUrl = pr.url
      if (ctx.journal) {
        await effect(ctx, 'branch_push', deliveryIdentity(ctx), async () => {},
          async () => await remoteBranchSha(ctx) === ctx.headSha ? { headSha: ctx.headSha } : null)
        await effect(ctx, 'pr_create', deliveryIdentity(ctx), async () => {},
          async () => {
            const found = await findPr(ctx)
            return exactPr(ctx, found) && found.state === 'OPEN' ?
              { prNumber: found.number, prUrl: found.url, headSha: ctx.headSha } : null
          })
      }
      if (!policy.allowPr) return emit(ctx, 'pr_open', { reason: REASONS.prNotAllowed })

      phase = 'checks'
      let checks
      for (let attempt = 0; ; attempt++) {
        checks = await readChecks(ctx)
        const projection = { total: checks.total, passed: checks.passed, failed: checks.failed, pending: checks.pending }
        ctx.checks = projection
        if (checks.total === 0) return emit(ctx, 'not_merged', { reason: REASONS.noChecks })
        if (checks.failed > 0) return emit(ctx, 'checks_failed', { reason: REASONS.checksFailed })
        if (checks.pending === 0) break
        if (attempt + 1 >= pollAttempts) return emit(ctx, 'checks_pending', { reason: REASONS.checksPending })
        await sleep(pollIntervalMs)
      }
      if (checks.skipped > 0) return emit(ctx, 'not_merged', { reason: REASONS.checksSkipped })
      if (!policy.allowMerge) return emit(ctx, 'pr_open', { reason: REASONS.mergeNotAllowed })

      phase = 'merge'
      const view = await viewPr(ctx)
      if (!exactPr(ctx, view)) return emit(ctx, 'not_merged', { reason: REASONS.headMoved })
      if (view.state === 'MERGED') return emit(ctx, 'merged', { reason: undefined })
      if (view.state !== 'OPEN') return emit(ctx, 'not_merged', { reason: REASONS.prClosed })
      if (view.headRefOid !== ctx.headSha) return emit(ctx, 'not_merged', { reason: REASONS.headMoved })
      if (view.mergeable === 'CONFLICTING') return emit(ctx, 'not_merged', { reason: REASONS.conflicts })
      await effect(ctx, 'pr_merge', { ...deliveryIdentity(ctx), prNumber: ctx.prNumber, prUrl: ctx.prUrl }, async () => {
        await verifyRepository(ctx)
        ctx.journal?.guard?.()
        await call(gh, ['pr', 'merge', String(ctx.prNumber), '--repo', ctx.base.repository, '--squash', '--match-head-commit', ctx.headSha])
      }, async () => {
        const found = await viewPr(ctx)
        if (!exactPr(ctx, found)) ctx.mergeWrongHead = true
        return exactPr(ctx, found) && found.state === 'MERGED' ? { prNumber: ctx.prNumber, prUrl: ctx.prUrl, headSha: ctx.headSha } : null
      })
      const after = await viewPr(ctx)
      if (exactPr(ctx, after) && after.state === 'MERGED') return emit(ctx, 'merged', { reason: undefined })
      if (after.headRefOid !== ctx.headSha) return emit(ctx, 'not_merged', { reason: REASONS.headMoved })
      throw new Interrupted()
    } catch (error) {
      if (!(error instanceof Interrupted)) throw error
      if (error instanceof RepositoryUnverified) return emit(ctx, 'held', { reason: 'Repository identity or visibility cannot be verified' })
      if (ctx.mergeWrongHead) return emit(ctx, 'not_merged', { reason: REASONS.headMoved })
      const step = phase === 'checks' || phase === 'merge' ? (ctx.checks && ctx.checks.pending === 0 ? 'pr_open' : 'checks_pending') : lastStep()
      return emit(ctx, step, { reason: REASONS.interrupted(phase) })
    }
  }

  async function deliver(input, { journal } = {}) {
    object(input, ['missionId', 'workDir', 'repository', 'baseRef', 'baseSha', 'policy', 'title', 'body', 'repositoryIdentity'],
      ['missionId', 'workDir', 'repository', 'baseRef', 'baseSha', 'policy', 'title', 'body'])
    validateMissionId(input.missionId)
    str(input.workDir, 4096)
    if (!isAbsolute(input.workDir)) fail('native_delivery_workdir_invalid', 400)
    validateRepository(input.repository)
    shortBaseRef(input.baseRef)
    validateSha(input.baseSha)
    const policy = validatePolicy(input.policy)
    str(input.title, 256); str(input.body, 60000, true)
    if (/[\r\n]/.test(input.title)) fail('native_delivery_title_invalid', 400)
    if (input.repositoryIdentity) validateRepositoryIdentity(input.repositoryIdentity)
    const base = deepFreeze({
      missionId: input.missionId, workDir: input.workDir, repository: input.repository, baseRef: input.baseRef,
      baseSha: input.baseSha, policy, title: input.title, body: input.body, branch: branchOf(input.missionId),
      ...(input.repositoryIdentity ? { repositoryIdentity: input.repositoryIdentity } : {}),
    })
    const ctx = { base, headSha: '', journal }
    try { return await withCheckout(input.workDir, () => run(ctx, 'held')) }
    catch { return emit(ctx, 'held', { reason: 'Checkout Git metadata is not trusted' }) }
  }

  async function resume(state, { journal } = {}) {
    object(state, STATE_KEYS, ['step', 'branch', 'headSha', 'updatedAt', 'missionId', 'workDir', 'repository', 'baseRef', 'baseSha', 'policy', 'title', 'body'])
    one(state.step, DELIVERY_STEPS)
    validateMissionId(state.missionId)
    if (state.branch !== branchOf(state.missionId)) fail('native_delivery_state_invalid', 400)
    str(state.workDir, 4096)
    if (!isAbsolute(state.workDir)) fail('native_delivery_workdir_invalid', 400)
    validateRepository(state.repository); shortBaseRef(state.baseRef); validateSha(state.baseSha)
    const policy = validatePolicy(state.policy)
    str(state.title, 256); str(state.body, 60000, true); time(state.updatedAt)
    if (state.step !== 'held' || state.headSha !== '') validateSha(state.headSha)
    if (state.prNumber !== undefined) int(state.prNumber, 1)
    if (state.prUrl !== undefined) str(state.prUrl, 512)
    if (['pr_open', 'checks_pending', 'checks_failed', 'merged'].includes(state.step) &&
        (state.prNumber === undefined || state.prUrl === undefined)) fail('native_delivery_state_invalid', 400)
    if (state.step === 'not_merged') return deepFreeze(structuredClone(state))
    const base = deepFreeze({
      missionId: state.missionId, workDir: state.workDir, repository: state.repository, baseRef: state.baseRef,
      baseSha: state.baseSha, policy, title: state.title, body: state.body, branch: state.branch,
      ...(state.repositoryIdentity ? { repositoryIdentity: state.repositoryIdentity } : {}),
    })
    const ctx = { base, headSha: state.headSha, prNumber: state.prNumber, prUrl: state.prUrl, pushed: state.step !== 'held', journal }
    try { return await withCheckout(state.workDir, () => run(ctx, state.step)) }
    catch { return emit(ctx, 'held', { reason: 'Checkout Git metadata is not trusted' }) }
  }

  async function pushInitialSeed(input, { journal } = {}) {
    object(input, ['missionId', 'workDir', 'repository', 'baseRef', 'baseSha'])
    validateMissionId(input.missionId); validateRepository(input.repository); validateSha(input.baseSha)
    str(input.workDir, 4096)
    if (!isAbsolute(input.workDir) || !journal) fail('native_delivery_seed_journal_required', 503)
    const branch = shortBaseRef(input.baseRef)
    const records = await journal.list()
    const creation = records.find(row => row.identity.kind === 'create_repository' && row.identity.repository === input.repository &&
        row.state === 'confirmed' && row.receipt?.created === true)
    if (!creation) fail('native_delivery_seed_not_created', 409)
    const ctx = { journal, base: { ...input, branch }, headSha: input.baseSha,
      repositoryIdentity: { repositoryId: creation.receipt.repositoryId, visibility: 'PRIVATE' } }
    try { return await withCheckout(input.workDir, async () => {
    const held = await scanHistory(input.workDir, input.baseSha)
    if (held) fail('native_delivery_seed_history_unsafe', 409)
    const remote = await remoteBranchSha(ctx)
    if (remote && remote !== input.baseSha) fail('native_delivery_seed_remote_diverged', 409)
    const repository = await call(gh, ['repo', 'view', input.repository, '--json', 'id,visibility,isEmpty'])
    if (!ok(repository)) throw new Interrupted()
    const remoteRepository = parseJson(repository, 'object')
    if (remoteRepository.id !== creation.receipt.repositoryId ||
        remoteRepository.visibility !== 'PRIVATE' || (!remote && remoteRepository.isEmpty !== true))
      fail('native_delivery_seed_remote_not_empty_private', 409)
    // Provisioning checkpoint is not a delivery state; only journal records apply.
    await effect({ ...ctx, provisioning: true }, 'initial_seed_push', { missionId: input.missionId, repository: input.repository,
      baseRef: branch, baseSha: input.baseSha, headSha: input.baseSha, branch,
      repositoryId: creation.receipt.repositoryId, visibility: 'PRIVATE' }, async () => {
      if (remote) return
      await safePush(input.workDir)
      await verifyRepository(ctx)
      journal.guard?.()
      const result = await call(git, [...CREDENTIAL_ARGS, 'push', '--porcelain', '--', remoteUrl(input.repository),
        `${input.baseSha}:refs/heads/${branch}`], input.workDir)
      if (!ok(result)) throw new Interrupted()
    }, async () => await remoteBranchSha(ctx) === input.baseSha ? { headSha: input.baseSha } : null)
    return deepFreeze({ repository: input.repository, baseSha: input.baseSha, seeded: true })
    }) } catch (error) {
      if (error instanceof RepositoryUnverified) fail('native_delivery_repository_unverified', 503)
      throw error
    }
  }

  return Object.freeze({ createPrivateRepository, pushInitialSeed, deliver, resume })
}

export function projectDeliveryState(state) {
  const out = { step: state.step, branch: state.branch, headSha: state.headSha, updatedAt: state.updatedAt }
  for (const key of ['prUrl', 'prNumber', 'checks', 'reason']) if (state[key] !== undefined) out[key] = state[key]
  return deepFreeze(out)
}

/**
 * Production runner for `gh` or `git`. No shell; bounded output; timeout kills the
 * child. Environment passthrough is limited to:
 *  - PATH and HOME (gh reads its login from HOME/.config/gh; git needs gh on PATH
 *    for the inline credential helper),
 *  - GH_CONFIG_DIR, GH_HOST, GH_TOKEN, GH_ENTERPRISE_TOKEN (gh authentication),
 * plus fixed non-interactive settings. Every Git process requires the validated
 * gitEnvironment from the trusted metadata snapshot, never checkout discovery
 * or ambient/local/global/system Git configuration.
 * `input`, when given, is written to the child's stdin and closed.
 * Timeouts and spawn failures resolve to `{ status: null }`.
 */
export function createProductionRunner(bin, { maxBytes = DELIVERY_RUNNER_MAX_BYTES, execFilePort = execFile, env = process.env } = {}) {
  str(bin, 4096)
  if (!isAbsolute(bin)) fail('native_delivery_runner_invalid')
  int(maxBytes, 1)
  const passthrough = {}
  for (const key of ['PATH', 'HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
    if (typeof env[key] === 'string') passthrough[key] = env[key]
  }
  const childEnv = Object.freeze({
    ...passthrough, LANG: 'C', LC_ALL: 'C', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
  })
  return (args, { cwd, timeoutMs = DELIVERY_RUNNER_TIMEOUT_MS, gitEnvironment, input } = {}) => new Promise(resolve => {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
        (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) ||
        (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input) > maxBytes)) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DELIVERY_RUNNER_TIMEOUT_MS) {
      resolve({ status: null, stdout: '', stderr: '' }); return
    }
    try {
      let trustedEnvironment
      if (gitEnvironment) {
        trustedEnvironment = deliveryGitEnvironment({ gitDir: gitEnvironment.GIT_DIR, workTree: gitEnvironment.GIT_WORK_TREE })
        if (hash(trustedEnvironment) !== hash(gitEnvironment) || trustedEnvironment.GIT_WORK_TREE !== cwd) throw new Error()
      } else if (basename(bin) === 'git') throw new Error()
      const child = execFilePort(bin, args, {
        shell: false, cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: maxBytes, encoding: 'utf8',
        windowsHide: true, env: Object.freeze({ ...childEnv, ...trustedEnvironment }),
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.signal || typeof error.code !== 'number')) resolve({ status: null, stdout: '', stderr: '' })
        else resolve({ status: error ? error.code : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
      // Optional stdin (gh api --input -); a child that exits first must not crash the broker.
      if (input !== undefined) { child?.stdin?.on?.('error', () => {}); child?.stdin?.end?.(input) }
    } catch { resolve({ status: null, stdout: '', stderr: '' }) }
  })
}
