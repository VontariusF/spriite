/**
 * The host X reader: polls the bound owner's own posts and launches Missions
 * 2.0 for the ones that tag Spriite, so a request made while the phone app is
 * closed still starts. X stays read-only; launch is injected (x-launch.mjs).
 *
 * Ledger `x-reader.json` (0600, owner-only, no symlink, one link):
 *   {version, binding, checkpoint:{lastSeenPostId, lastSuccessAt, backlog?}, receipts[], rejectedCount, gapCount}
 * Every write is temp + fsync + rename + chmod + directory fsync.
 *
 * Durability rules (restated because they are easy to erode):
 * - every trigger gets a durable receipt before the checkpoint may pass it; a
 *   failed check leaves the checkpoint where it was and the re-read is
 *   absorbed by dedupe, keyed `x:<ownerXUserId>:<logicalPostId>`;
 * - launch is called at most once per dedupe key: a `launching` receipt is
 *   durable before the call, and one found at load is resolved as held for
 *   the owner's review, never relaunched;
 * - holds stay holds: a held, clarify or ignored receipt is never retried;
 * - more posts than one check reads is a backlog, never a skip: the checkpoint
 *   stays and `backlog.untilId` makes the next checks read the older span
 *   before the checkpoint moves past it;
 * - a stopped reader writes nothing more except the outcome of a launch it
 *   already made; stop() resolves only once its in-flight check has drained.
 */
import * as nodeFs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { BrokerError, fail, object } from './validation.mjs'
import { XClientError } from './x-client.mjs'
import * as xRules from './x-rules.mjs'

export const X_READER_LEDGER_MAX_BYTES = 1048576
export const X_READER_MAX_RECEIPTS = 512
export const X_READER_STATUS_RECEIPTS = 50
export const X_LAUNCH_UNKNOWN_REASON = 'The launch outcome is unknown. Check the missions on the phone before posting it again.'
const RECEIPT_STATUSES = ['submitted', 'held', 'clarify', 'ignored', 'launching']
const NUMERIC_ID = /^\d{1,20}$/
const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const DEDUPE_KEY = /^x:\d{1,20}:\d{1,20}$/
const REASON_MAX = 1024
// The broker's intent goal limit (validation.intent): longer is refused, never cut.
const GOAL_MAX = 32768
const NEW_REPOSITORY = /\bnew repo(?:sitory)?\b/i
const MAX_SEEN_POST_IDS = 100

// Every reason says what the owner can actually do: host receipts are plain
// text on the phone, with no confirm or choose button behind them.
const REASONS = Object.freeze({
  control: 'Your Factory host does not run controls from X. Use the mission\u2019s controls on the phone.',
  status: 'Your Factory host does not answer status requests on X. The phone and glasses show each build\u2019s status.',
  empty: 'The post mentioned Spriite but asked for nothing.',
  unclear: 'I could not find a build request in the post.',
  window: 'Older than 24 hours, so it was not started. Post it again to start it.',
  untimed: 'The post time could not be read, so it was not started. Post it again to start it.',
  reference: 'The linked repository is a reference, not a destination. Post again naming the destination repository, or say "new repo".',
  tooLong: 'The request is too long to launch from X. Post a shorter request.',
  badRepository: 'The named repository is not a valid GitHub repository. Post again with github.com/<account>/<name>.',
  discovery: 'Your repositories could not be read, so no destination was chosen. Post again naming the repository, or say "new repo".',
  followup: 'A reply under a launched build is a follow-up for that mission; your Factory host never starts a second one for it. Steer the mission from the phone.',
  phone: 'Read on the phone before your Factory host took over.',
  edited: 'edit recorded as a proposed change',
})

const big = value => BigInt(value)
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
const optional = (value, test) => value === undefined || test(value)
const isTime = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
const isReason = value => typeof value === 'string' && value.length <= REASON_MAX
const bounded = text => String(text).slice(0, REASON_MAX)

function validBinding(value) {
  if (value === null) return true
  if (!plain(value)) return false
  const keys = ['ownerXUserId', 'ownerHandle', 'spriiteXUserId', 'spriiteHandle', 'boundAt', 'readFrom', 'defaultRepository']
  if (Object.keys(value).some(key => !keys.includes(key))) return false
  return NUMERIC_ID.test(value.ownerXUserId) && NUMERIC_ID.test(value.spriiteXUserId) &&
    typeof value.ownerHandle === 'string' && HANDLE.test(value.ownerHandle) &&
    typeof value.spriiteHandle === 'string' && HANDLE.test(value.spriiteHandle) &&
    isTime(value.boundAt) && optional(value.readFrom, isTime) && optional(value.defaultRepository, validDefaultRepository)
}
function validReceipt(r) {
  if (!plain(r)) return false
  const keys = ['dedupeKey', 'logicalPostId', 'revisionId', 'status', 'reason', 'missionId', 'repository',
    'newRepository', 'at', 'proposedRevisionId', 'launchAttempted']
  if (Object.keys(r).some(key => !keys.includes(key))) return false
  return typeof r.dedupeKey === 'string' && DEDUPE_KEY.test(r.dedupeKey) &&
    NUMERIC_ID.test(r.logicalPostId) && NUMERIC_ID.test(r.revisionId) && RECEIPT_STATUSES.includes(r.status) &&
    optional(r.reason, isReason) && optional(r.missionId, v => typeof v === 'string' && MISSION_ID.test(v)) &&
    optional(r.repository, validDefaultRepository) &&
    optional(r.newRepository, v => typeof v === 'string' && xRules.validRepositoryName(v)) &&
    isTime(r.at) && optional(r.proposedRevisionId, v => typeof v === 'string' && NUMERIC_ID.test(v)) &&
    optional(r.launchAttempted, v => v === true)
}
const isId = v => typeof v === 'string' && NUMERIC_ID.test(v)
/** The older span still to read: posts below `untilId`, then the checkpoint moves to `newestId`. */
const validBacklog = v => plain(v) && Object.keys(v).length === 2 && isId(v.untilId) && isId(v.newestId)
function validLedger(value) {
  object(value, ['version', 'binding', 'checkpoint', 'receipts', 'rejectedCount', 'gapCount'])
  const c = value.checkpoint
  if (value.version !== 1 || !validBinding(value.binding) || !plain(c) ||
      Object.keys(c).some(key => !['lastSeenPostId', 'lastSuccessAt', 'backlog'].includes(key)) ||
      !('lastSeenPostId' in c) || !('lastSuccessAt' in c) || !optional(c.backlog, validBacklog) ||
      !(c.lastSeenPostId === null || (typeof c.lastSeenPostId === 'string' && NUMERIC_ID.test(c.lastSeenPostId))) ||
      !(c.lastSuccessAt === null || isTime(c.lastSuccessAt)) ||
      !Array.isArray(value.receipts) || value.receipts.length > X_READER_MAX_RECEIPTS ||
      !value.receipts.every(validReceipt) ||
      new Set(value.receipts.map(r => r.dedupeKey)).size !== value.receipts.length ||
      !Number.isSafeInteger(value.rejectedCount) || value.rejectedCount < 0 ||
      !Number.isSafeInteger(value.gapCount) || value.gapCount < 0) throw new Error()
  return value
}
/** Only the exact normalized form: `https://github.com/<account>/<name>`. */
function validDefaultRepository(value) {
  if (typeof value !== 'string' || value.length > 512) return false
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(value)
  return !!m && xRules.validGithubAccount(m[1]) && xRules.validRepositoryName(m[2])
}
const emptyLedger = () => ({
  version: 1, binding: null, checkpoint: { lastSeenPostId: null, lastSuccessAt: null },
  receipts: [], rejectedCount: 0, gapCount: 0,
})
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}

export function createXReader({
  ledgerPath, client, rules = xRules, launch, now = Date.now, intervalMs = 60000, backoffMs = 300000,
  autoLaunchWindowMs = 86400000, maxPages = 5, log = () => {}, fs = nodeFs,
  // The owner's repository full names (`account/name`), or null when they
  // could not be read; absent, a word in a post never names a repository.
  repositories = null,
  // Whether a launched mission is still live; unknown reads as live, so a
  // reply under it is held as a follow-up rather than launched.
  missionLive = () => true,
  timers = { setTimeout: (...a) => globalThis.setTimeout(...a), clearTimeout: (...a) => globalThis.clearTimeout(...a) },
}) {
  if (typeof ledgerPath !== 'string' || !ledgerPath.startsWith('/') || ledgerPath.includes('\0')) fail('x_reader_path_invalid', 503)
  if (!client || typeof client.me !== 'function' || typeof client.userPosts !== 'function' ||
      typeof launch !== 'function' || !rules || typeof rules.authorizeTrigger !== 'function' ||
      (repositories !== null && typeof repositories !== 'function') || typeof missionLive !== 'function') {
    fail('x_reader_configuration_required', 503)
  }
  for (const ms of [intervalMs, backoffMs, autoLaunchWindowMs]) if (!Number.isSafeInteger(ms) || ms < 1) fail('x_reader_configuration_required', 503)
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) fail('x_reader_configuration_required', 503)
  const directory = dirname(ledgerPath)
  const iso = (ms = now()) => new Date(ms).toISOString()
  const say = (event, fields = {}) => { try { log(event, fields) } catch { /* a log sink never stops the reader */ } }

  // ------------------------------------------------------------- ledger

  function checkDirectory() {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) ||
        fs.realpathSync(directory) !== directory) throw new Error()
  }
  function syncDirectory() {
    const fd = fs.openSync(directory, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  /** Rechecked on every read, as the credential store does. */
  function read() {
    let fd
    try {
      checkDirectory()
      try { fd = fs.openSync(ledgerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 ||
          stat.size < 1 || stat.size > X_READER_LEDGER_MAX_BYTES || fs.realpathSync(ledgerPath) !== ledgerPath) throw new Error()
      const text = fs.readFileSync(fd, 'utf8')
      let value
      try { value = validLedger(JSON.parse(text)) } catch { fail('x_reader_ledger_invalid', 503) }
      return value
    } catch (error) {
      if (error instanceof BrokerError) throw error
      fail('x_reader_ledger_unsafe', 503)
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  /** A failure leaves the previous file in place and is reported, never retried. */
  function write(next) {
    let bytes
    try { bytes = `${JSON.stringify(validLedger(next))}\n` } catch { fail('x_reader_ledger_invalid', 503) }
    if (Buffer.byteLength(bytes) > X_READER_LEDGER_MAX_BYTES) fail('x_reader_ledger_too_large', 503)
    const temp = join(directory, `.x-reader-${randomUUID()}.tmp`)
    let created = false
    try {
      checkDirectory()
      try {
        if (fs.lstatSync(ledgerPath).isSymbolicLink()) throw new Error()
      } catch (error) { if (error?.code !== 'ENOENT') throw error }
      const fd = fs.openSync(temp, 'wx', 0o600)
      created = true
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, ledgerPath); created = false
      fs.chmodSync(ledgerPath, 0o600)
      syncDirectory()
    } catch {
      if (created) { try { fs.unlinkSync(temp) } catch { /* the original file is intact */ } }
      fail('x_reader_persist_failed', 503)
    }
  }

  let ledger = read() ?? emptyLedger()
  /** Durable first, then memory: what the reader acts on is what a restart sees. */
  function commit(next) {
    write(next)
    ledger = next
  }
  // A launch marker left by a crash: the launch may or may not have happened,
  // so it becomes a hold for the owner and is never called again.
  if (ledger.receipts.some(r => r.status === 'launching')) {
    const resolved = {
      ...ledger,
      receipts: ledger.receipts.map(r => r.status === 'launching'
        ? { ...r, status: 'held', reason: X_LAUNCH_UNKNOWN_REASON, at: iso(), launchAttempted: true } : r),
    }
    try { commit(resolved) } catch {
      // Memory still refuses a relaunch; the next durable write carries it.
      ledger = resolved
    }
    say('x_reader_launch_unknown_resolved')
  }

  /** Insert or replace by dedupe key; oldest first out past the bound. */
  function withReceipt(base, receipt) {
    const at = base.receipts.findIndex(r => r.dedupeKey === receipt.dedupeKey)
    const receipts = at >= 0
      ? base.receipts.map((r, i) => (i === at ? receipt : r))
      : [...base.receipts, receipt]
    while (receipts.length > X_READER_MAX_RECEIPTS) receipts.shift()
    return { ...base, receipts }
  }

  // ------------------------------------------------------------- runtime

  let queue = Promise.resolve()
  const serial = work => {
    const run = queue.then(work, work)
    queue = run.catch(() => {})
    return run
  }
  let running = false
  // Bumped by stop(): a check that started before it launches nothing more.
  let epoch = 0
  let timer = null
  let lastCheckedAt = null, lastError = null, lastErrorKind = null, backoffUntil = null, nextCheckAt = null

  function schedule(delay) {
    if (timer !== null) timers.clearTimeout(timer)
    nextCheckAt = iso(now() + delay)
    timer = timers.setTimeout(() => {
      timer = null
      nextCheckAt = null
      checkNow().catch(() => {}).finally(() => {
        if (!running || timer !== null) return
        const wait = backoffUntil !== null ? Math.max(0, Date.parse(backoffUntil) - now()) : intervalMs
        schedule(wait || intervalMs)
      })
    }, delay)
    timer?.unref?.()
  }

  // ------------------------------------------------------------- binding

  /**
   * `fresh` (a handoff) starts a new ownership period even for the same owner:
   * the checkpoint is dropped and the first read starts at `startAt` (the
   * phone's last successful check, clamped to the auto-launch window), with
   * `seenPostIds` (posts the phone already handled) receipted as done. Without
   * it (a resume) the same owner keeps the checkpoint.
   */
  function bind(input) {
    return serial(async () => {
      object(input, ['spriiteHandle', 'ownerId', 'spriiteUserId', 'defaultRepository', 'fresh', 'startAt', 'seenPostIds'],
        ['spriiteHandle', 'ownerId'])
      if (input.fresh !== undefined && typeof input.fresh !== 'boolean') fail('x_bind_invalid', 400)
      if (input.startAt !== undefined && input.startAt !== null && !isTime(input.startAt)) fail('x_bind_invalid', 400)
      if (input.seenPostIds !== undefined && (!Array.isArray(input.seenPostIds) || input.seenPostIds.length > MAX_SEEN_POST_IDS ||
          !input.seenPostIds.every(isId))) fail('x_bind_invalid', 400)
      const handle = typeof input.spriiteHandle === 'string' ? input.spriiteHandle.replace(/^@/, '') : ''
      if (!HANDLE.test(handle)) fail('x_spriite_handle_invalid', 400)
      if (typeof input.ownerId !== 'string' || !NUMERIC_ID.test(input.ownerId)) fail('x_owner_invalid', 400)
      if (input.spriiteUserId !== undefined && (typeof input.spriiteUserId !== 'string' || !NUMERIC_ID.test(input.spriiteUserId))) {
        fail('x_spriite_id_invalid', 400)
      }
      if (input.defaultRepository !== undefined && !validDefaultRepository(input.defaultRepository)) {
        fail('x_default_repository_invalid', 400)
      }
      // Only the credential's own /2/users/me makes the owner id verified.
      const me = await client.me()
      if (me.id !== input.ownerId) fail('x_owner_mismatch', 409)
      if (me.protected === true) fail('x_protected_owner_unsupported', 409)
      if (!HANDLE.test(me.username)) fail('x_owner_handle_invalid', 503)
      let spriite
      if (input.spriiteUserId !== undefined) spriite = { id: input.spriiteUserId, username: handle }
      else if (typeof client.userByUsername === 'function') spriite = await client.userByUsername(handle)
      else fail('x_spriite_lookup_unavailable', 503)
      if (!plain(spriite) || typeof spriite.id !== 'string' || !NUMERIC_ID.test(spriite.id) ||
          typeof spriite.username !== 'string' || !HANDLE.test(spriite.username)) fail('x_spriite_unresolved', 503)
      if (spriite.id === me.id) fail('x_same_account', 409)
      if (spriite.username.toLowerCase() !== handle.toLowerCase()) fail('x_spriite_unresolved', 503)
      const prior = ledger.binding
      const fresh = input.fresh === true
      const keep = !fresh && prior?.ownerXUserId === me.id
      const boundMs = now()
      // Never earlier than the auto-launch window: an older post is held anyway.
      const readFrom = fresh && input.startAt
        ? Math.min(boundMs, Math.max(Date.parse(input.startAt), boundMs - autoLaunchWindowMs)) : null
      const binding = {
        ownerXUserId: me.id, ownerHandle: me.username, spriiteXUserId: spriite.id, spriiteHandle: spriite.username,
        boundAt: keep ? prior.boundAt : iso(boundMs),
        ...(keep && prior.readFrom !== undefined ? { readFrom: prior.readFrom } : {}),
        ...(readFrom !== null && readFrom < boundMs ? { readFrom: iso(readFrom) } : {}),
        ...(input.defaultRepository !== undefined ? { defaultRepository: input.defaultRepository } : {}),
      }
      // A different owner, or a handoff, starts a fresh checkpoint: nothing
      // read under another ownership period resumes here (the phone read X
      // between them, under its own mission ids).
      let next = keep ? { ...ledger, binding }
        : { ...ledger, binding, checkpoint: { lastSeenPostId: null, lastSuccessAt: null } }
      for (const id of fresh ? input.seenPostIds ?? [] : []) {
        const dedupeKey = `x:${me.id}:${id}`
        if (next.receipts.some(r => r.dedupeKey === dedupeKey)) continue
        // launchAttempted: an edit of it is a proposed change, never a launch here.
        next = withReceipt(next, { dedupeKey, logicalPostId: id, revisionId: id, status: 'ignored', reason: REASONS.phone,
          at: iso(boundMs), launchAttempted: true })
      }
      commit(next)
      say('x_reader_bound', { sameOwner: prior?.ownerXUserId === me.id, fresh })
      return deepFreeze(structuredClone(binding))
    })
  }

  // ------------------------------------------------------------- routing

  /**
   * The destination: the repository the post names, else the designated X
   * default, else a new repository of its own. A linked product that is not
   * a destination is a reference; with a default designated it is held for
   * the owner's choice rather than silently landing in the default.
   */
  function route(instruction, logicalId, binding) {
    const named = rules.destinationRepositoryFrom(instruction)
    // The rules' URL pattern is looser than GitHub's names (`me-/app`,
    // `x.git.git`): such a destination is held, never written to a receipt
    // the ledger would then refuse forever.
    if (named !== null) return validDefaultRepository(named) ? { kind: 'existing', repository: named } : { hold: REASONS.badRepository }
    // A word naming one of the owner's repositories is asked about, never
    // guessed (the phone's projectCandidates): only the default is assumed.
    if (repositories !== null) {
      let names
      try { names = repositories() } catch { names = null }
      if (!Array.isArray(names)) return { hold: REASONS.discovery }
      const candidates = rules.projectCandidates(instruction, names
        .filter(n => typeof n === 'string' && /^[^/]+\/[^/]+$/.test(n)).map(n => ({ fullName: n, url: `https://github.com/${n}` })))
      if (candidates !== null) {
        if (binding.defaultRepository !== undefined && candidates.urls.includes(binding.defaultRepository)) {
          return { kind: 'existing', repository: binding.defaultRepository }
        }
        return { hold: `Is ${candidates.projectName} a new repository or an existing one? Post again naming it as ` +
          `github.com/<account>/${candidates.projectName}, or say "new repo".` }
      }
    }
    const asksNew = NEW_REPOSITORY.test(instruction)
    const linked = rules.repositoryFrom(instruction) !== null
    if (!asksNew && linked && binding.defaultRepository !== undefined) return { hold: REASONS.reference }
    if (!asksNew && !linked && binding.defaultRepository !== undefined) {
      return { kind: 'existing', repository: binding.defaultRepository }
    }
    return { kind: 'new_repository', name: rules.newRepositoryNameFrom(instruction) ?? rules.derivedRepositoryName(instruction, logicalId) }
  }

  // -------------------------------------------------------------- ingest

  /** One post. Returns the outcome; throws only when a receipt could not be made durable. */
  async function ingest(post, binding, checkEpoch) {
    // stop() landed mid-check: nothing more is written; the span is re-read later.
    if (checkEpoch !== epoch) fail('x_reader_stopped', 409)
    const verdict = rules.authorizeTrigger(post, binding)
    if (!verdict.ok) {
      if (verdict.reason === 'not_owner') return { postId: post.id, status: 'rejected', reason: 'not_owner' }
      return { postId: post.id, status: 'ignored', reason: verdict.reason }
    }
    const logicalId = rules.logicalPostId(post)
    const dedupeKey = `x:${binding.ownerXUserId}:${logicalId}`
    const existing = ledger.receipts.find(r => r.dedupeKey === dedupeKey)
    if (existing !== undefined) {
      // Same or older revision: the original receipt stands.
      if (big(post.id) <= big(existing.revisionId)) return { postId: post.id, status: 'duplicate', dedupeKey, missionId: existing.missionId }
      if (existing.launchAttempted) {
        // An edit after launch is a proposed change, never a second launch.
        if (existing.proposedRevisionId !== undefined && big(post.id) <= big(existing.proposedRevisionId)) {
          return { postId: post.id, status: 'duplicate', dedupeKey, missionId: existing.missionId }
        }
        commit(withReceipt(ledger, { ...existing, proposedRevisionId: post.id }))
        return { postId: post.id, status: 'duplicate', dedupeKey, reason: REASONS.edited, missionId: existing.missionId }
      }
      // Held, unclear or ignored and never launched: the edit replaces it.
    }
    const instruction = verdict.instruction
    const base = { dedupeKey, logicalPostId: logicalId, revisionId: post.id, at: iso() }
    const settle = receipt => {
      commit(withReceipt(ledger, receipt))
      return { postId: post.id, status: receipt.status, dedupeKey, reason: receipt.reason,
        ...(receipt.missionId ? { missionId: receipt.missionId } : {}) }
    }
    // Controls and status come from the owner's own words only; neither launches.
    const intent = rules.classifyIntent(instruction)
    if (intent === 'control') return settle({ ...base, status: 'held', reason: REASONS.control })
    if (intent === 'status') return settle({ ...base, status: 'ignored', reason: REASONS.status })
    if (intent === 'empty') return settle({ ...base, status: 'clarify', reason: REASONS.empty })
    // An unreadable post time fails closed: the window is a product default, not a guess.
    const age = typeof post.created_at === 'string' ? now() - Date.parse(post.created_at) : NaN
    if (!Number.isFinite(age)) return settle({ ...base, status: 'held', reason: REASONS.untimed })
    if (age > autoLaunchWindowMs) return settle({ ...base, status: 'held', reason: REASONS.window })
    // A direct reply to a request this reader launched, while its mission is
    // live, is a follow-up for it (src/intake/x.ts), never a second mission;
    // without substance it is a clarify, as on the phone.
    const repliedTo = (post.referenced_tweets ?? []).find(r => plain(r) && r.type === 'replied_to')?.id
    if (typeof repliedTo === 'string') {
      const parent = ledger.receipts.find(r => (r.revisionId === repliedTo || r.logicalPostId === repliedTo) &&
        r.dedupeKey !== dedupeKey && r.dedupeKey.startsWith(`x:${binding.ownerXUserId}:`) &&
        r.launchAttempted === true && r.reason !== REASONS.phone)
      let live = true
      if (parent?.missionId !== undefined) { try { live = missionLive(parent.missionId) !== false } catch { live = true } }
      if (parent && live) {
        const steers = intent === 'build' || rules.hasRequestSubstance(instruction, [])
        return settle(steers
          ? { ...base, status: 'held', reason: REASONS.followup }
          : { ...base, status: 'clarify', reason: REASONS.unclear })
      }
    }
    if (intent !== 'build' && !rules.hasRequestSubstance(instruction, [])) {
      return settle({ ...base, status: 'clarify', reason: REASONS.unclear })
    }
    if (instruction.length > GOAL_MAX) return settle({ ...base, status: 'clarify', reason: REASONS.tooLong })
    const destination = route(instruction, logicalId, binding)
    if (destination.hold) return settle({ ...base, status: 'held', reason: destination.hold })
    const where = destination.kind === 'existing' ? { repository: destination.repository } : { newRepository: destination.name }
    // stop() landed mid-check: nothing more launches; the span is re-read later.
    if (checkEpoch !== epoch) fail('x_reader_stopped', 409)
    // The marker is durable before the call: a crash past this line can
    // never launch the same request again.
    commit(withReceipt(ledger, { ...base, ...where, status: 'launching', launchAttempted: true }))
    const request = deepFreeze({
      origin: 'x', dedupeKey, logicalPostId: logicalId, revisionId: post.id, postId: post.id,
      ownerXUserId: binding.ownerXUserId, postUrl: `https://x.com/i/status/${post.id}`,
      postedAt: post.created_at, instruction, destination: structuredClone(destination),
    })
    let outcome
    try { outcome = await launch(request) } catch (error) {
      say('x_reader_launch_threw', { code: error instanceof BrokerError ? error.code : 'launch_failed' })
      outcome = null
    }
    let final
    if (plain(outcome) && outcome.status === 'submitted' && typeof outcome.missionId === 'string' && MISSION_ID.test(outcome.missionId)) {
      final = { ...base, ...where, status: 'submitted', missionId: outcome.missionId, launchAttempted: true, at: iso() }
    } else if (plain(outcome) && outcome.status === 'held' && typeof outcome.reason === 'string' && outcome.reason !== '') {
      final = { ...base, ...where, status: 'held', reason: bounded(outcome.reason), launchAttempted: true, at: iso() }
    } else {
      final = { ...base, ...where, status: 'held', reason: X_LAUNCH_UNKNOWN_REASON, launchAttempted: true, at: iso() }
    }
    const next = withReceipt(ledger, final)
    try { commit(next) } catch (error) {
      // The disk still says `launching`, which a restart resolves as held.
      // Memory takes the known outcome so this process never relaunches.
      ledger = next
      throw error
    }
    say('x_reader_launched', { status: final.status })
    return { postId: post.id, status: final.status, dedupeKey, reason: final.reason,
      ...(final.missionId ? { missionId: final.missionId } : {}) }
  }

  // --------------------------------------------------------------- check

  async function checkOnce() {
    const binding = ledger.binding
    if (binding === null) return { ok: false, checked: 0, outcomes: [], error: 'x_reader_unbound' }
    const checkEpoch = epoch
    const startedAt = now()
    lastCheckedAt = iso(startedAt)
    const sinceId = ledger.checkpoint.lastSeenPostId
    const backlog = ledger.checkpoint.backlog ?? null
    const readFrom = binding.readFrom ?? binding.boundAt
    const posts = []
    let token = null, pages = 0
    try {
      do {
        const page = await client.userPosts(binding.ownerXUserId, {
          ...(sinceId ? { sinceId } : { startTime: readFrom }),
          ...(backlog ? { untilId: backlog.untilId } : {}),
          paginationToken: token,
        })
        posts.push(...page.posts)
        token = page.nextToken
        pages++
      } while (token !== null && pages < maxPages)
    } catch (error) {
      const kind = error instanceof XClientError ? error.kind : 'service'
      lastError = error instanceof BrokerError ? error.code : 'x_service'
      lastErrorKind = kind
      // Quota and credits have their own clock; polling sooner only spends
      // them. An auth failure (a refused or lost grant) needs a new handoff, so
      // it is not re-sent to X every minute either.
      if (kind === 'quota' || kind === 'credits' || kind === 'auth') backoffUntil = iso(now() + backoffMs)
      say('x_reader_read_failed', { kind, reason: error instanceof XClientError ? error.reason : lastError })
      return { ok: false, checked: 0, outcomes: [], error: lastError, errorKind: kind }
    }
    backoffUntil = null

    // Malformed ids cannot be ordered or deduped; the rules refuse their text.
    const usable = posts.filter(p => plain(p) && typeof p.id === 'string' && NUMERIC_ID.test(p.id) &&
      optional(p.edit_history_tweet_ids, v => Array.isArray(v) && v.length > 0 && v.every(id => typeof id === 'string' && NUMERIC_ID.test(id))))
    let rejected = posts.length - usable.length
    const seenAlready = sinceId === null ? null : big(sinceId)
    const below = backlog === null ? null : big(backlog.untilId)
    const firstFrom = Date.parse(readFrom)
    const span = usable
      .filter(p => (seenAlready === null || big(p.id) > seenAlready) && (below === null || big(p.id) < below))
      // A first read covers only what the owner posted after binding (or the
      // phone's last check, for a handoff).
      .filter(p => sinceId !== null || !isTime(p.created_at) || Date.parse(p.created_at) >= firstFrom)
      .sort((a, b) => (big(a.id) < big(b.id) ? -1 : big(a.id) > big(b.id) ? 1 : 0))
    const outcomes = []
    for (const post of span) {
      try {
        const outcome = await ingest(post, binding, checkEpoch)
        if (outcome.status === 'rejected') rejected++
        outcomes.push(outcome)
      } catch (error) {
        // Not durably receipted: the checkpoint stays, the span is re-read.
        const stopped = error instanceof BrokerError && error.code === 'x_reader_stopped'
        if (stopped) return { ok: false, checked: span.length, outcomes, error: 'x_reader_stopped', errorKind: 'stopped' }
        lastError = error instanceof BrokerError ? error.code : 'x_reader_persist_failed'
        lastErrorKind = 'storage'
        say('x_reader_receipt_failed', { code: lastError })
        return { ok: false, checked: span.length, outcomes, error: lastError, errorKind: 'storage' }
      }
    }
    if (checkEpoch !== epoch) return { ok: false, checked: span.length, outcomes, error: 'x_reader_stopped', errorKind: 'stopped' }
    // The newest id covered (a backlog keeps the newest id of the read that
    // opened it); only every receipt above is durable.
    let seen = backlog?.newestId ?? sinceId, oldest = null
    for (const p of usable) {
      if ((seenAlready !== null && big(p.id) <= seenAlready) || (below !== null && big(p.id) >= below)) continue
      if (seen === null || big(p.id) > big(seen)) seen = p.id
      if (oldest === null || big(p.id) < big(oldest)) oldest = p.id
    }
    // More posts than one check reads: the checkpoint stays and the next
    // check reads the older span below what this one reached.
    const gap = token !== null && oldest !== null
    const checkpoint = gap
      ? { lastSeenPostId: sinceId, lastSuccessAt: ledger.checkpoint.lastSuccessAt, backlog: { untilId: oldest, newestId: seen } }
      : { lastSeenPostId: seen, lastSuccessAt: iso(startedAt) }
    try {
      commit({
        ...ledger,
        checkpoint,
        rejectedCount: ledger.rejectedCount + rejected,
        gapCount: ledger.gapCount + (gap && backlog === null ? 1 : 0),
      })
    } catch (error) {
      lastError = error instanceof BrokerError ? error.code : 'x_reader_persist_failed'
      lastErrorKind = 'storage'
      return { ok: false, checked: span.length, outcomes, error: lastError, errorKind: 'storage' }
    }
    lastError = null
    lastErrorKind = null
    if (gap) say('x_reader_backlog')
    return { ok: true, checked: span.length, outcomes, gap }
  }

  function checkNow() { return serial(checkOnce) }

  return {
    bind,
    checkNow,
    start() {
      if (ledger.binding === null) fail('x_reader_unbound', 409)
      if (running) return
      running = true
      schedule(0)
      say('x_reader_started')
    },
    /** Resolves once the check in flight (a launch included) has drained. */
    stop() {
      running = false
      epoch++
      if (timer !== null) timers.clearTimeout(timer)
      timer = null
      nextCheckAt = null
      say('x_reader_stopped')
      return serial(() => {})
    },
    /** An immediate read, unless X's quota clock says to wait. */
    wake() {
      if (!running) return false
      if (backoffUntil !== null && Date.parse(backoffUntil) > now()) return false
      schedule(0)
      return true
    },
    /** Health and the latest receipts; no token, no post text. */
    status() {
      const b = ledger.binding
      return deepFreeze(structuredClone({
        running, bound: b !== null,
        binding: b && { ownerXUserId: b.ownerXUserId, ownerHandle: b.ownerHandle, spriiteXUserId: b.spriiteXUserId,
          spriiteHandle: b.spriiteHandle, boundAt: b.boundAt, ...(b.readFrom ? { readFrom: b.readFrom } : {}),
          ...(b.defaultRepository ? { defaultRepository: b.defaultRepository } : {}) },
        checkpoint: ledger.checkpoint, lastCheckedAt, lastError, lastErrorKind, backoffUntil, nextCheckAt,
        rejectedCount: ledger.rejectedCount, gapCount: ledger.gapCount,
        receipts: ledger.receipts.slice(-X_READER_STATUS_RECEIPTS).reverse(),
      }))
    },
  }
}
