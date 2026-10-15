/**
 * The host's one X credential. X rotates the refresh token on every renewal and
 * kills the old pair, so this file has exactly one writer and every rotated
 * pair is durable before anything uses it. Token values never reach a log,
 * an error message or a diagnostic: errors carry codes only.
 *
 * File (0600, owner-only, no symlink, one link):
 *   {version, accessToken, refreshToken, expiresAt, clientId, ownerId, state}
 * `state` is `active`, `renewing` (a refresh request may be on the wire),
 * `rotation_lost` (a renewal's answer was lost; the refresh token is erased and
 * renewal stays refused until a new handoff) or `rejected` (X refused the
 * refresh grant: it is dead, so it is erased and never sent again). A
 * `renewing` file found at load means a crash mid-renewal, which is treated as
 * a lost rotation.
 */
import * as nodeFs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { BrokerError, fail, object } from './validation.mjs'

export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token'
export const X_CREDENTIAL_MAX_BYTES = 16384
const TOKEN = /^[\x21-\x7e]{1,4096}$/
const CLIENT_ID = /^[A-Za-z0-9._~-]{1,256}$/
const OWNER_ID = /^\d{1,20}$/
const STATES = ['active', 'renewing', 'rotation_lost', 'rejected']
// Without a refresh token: renewal stays refused until a new handoff saves one.
const SPENT = ['rotation_lost', 'rejected']
/**
 * Connection failures that prove the token request never left this machine
 * (no name, nothing listening, no connection made): the grant is untouched.
 * Anything else, a reset or a timeout after connecting included, may have
 * delivered it.
 */
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
const neverSent = error => {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 4; e = e.cause, depth++) {
    if (typeof e.code === 'string' && NOT_SENT.has(e.code)) return true
  }
  return false
}
const FIELDS = ['version', 'accessToken', 'refreshToken', 'expiresAt', 'clientId', 'ownerId', 'state']
// X documents two hours; a response without expires_in assumes the same.
const DEFAULT_EXPIRES_IN = 7200

function validRecord(value) {
  object(value, FIELDS)
  if (value.version !== 1 || !STATES.includes(value.state) || !TOKEN.test(value.accessToken) ||
      typeof value.refreshToken !== 'string' || (value.refreshToken !== '' && !TOKEN.test(value.refreshToken)) ||
      (!SPENT.includes(value.state) && !value.refreshToken) || (SPENT.includes(value.state) && value.refreshToken !== '') ||
      typeof value.clientId !== 'string' || !CLIENT_ID.test(value.clientId) ||
      typeof value.ownerId !== 'string' || !OWNER_ID.test(value.ownerId) ||
      typeof value.expiresAt !== 'string' || value.expiresAt.length > 40 ||
      !Number.isFinite(Date.parse(value.expiresAt))) throw new Error()
  return value
}

/** The handoff shape. Refused codes name the field class, never its value. */
function validPair(pair) {
  object(pair, ['accessToken', 'refreshToken', 'expiresAt', 'clientId', 'ownerId'])
  if (typeof pair.accessToken !== 'string' || !TOKEN.test(pair.accessToken) ||
      typeof pair.refreshToken !== 'string' || !TOKEN.test(pair.refreshToken)) fail('x_credential_token_invalid', 400)
  if (typeof pair.clientId !== 'string' || !CLIENT_ID.test(pair.clientId)) fail('x_credential_client_invalid', 400)
  if (typeof pair.ownerId !== 'string' || !OWNER_ID.test(pair.ownerId)) fail('x_credential_owner_invalid', 400)
  if (typeof pair.expiresAt !== 'string' || pair.expiresAt.length > 40 || !Number.isFinite(Date.parse(pair.expiresAt))) {
    fail('x_credential_expiry_invalid', 400)
  }
  return pair
}

/** What callers may see. The refresh token never leaves this module. */
const view = record => record && Object.freeze({
  accessToken: record.accessToken, expiresAt: record.expiresAt, clientId: record.clientId,
  ownerId: record.ownerId, state: record.state,
})

export function createXCredentialStore({ path, fs = nodeFs, fetch = (...args) => globalThis.fetch(...args), now = Date.now, timeoutMs = 30000 }) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) fail('x_credential_path_invalid', 503)
  const directory = dirname(path)
  let record = null
  // A save or clear during a renewal supersedes it; the late answer is dropped.
  let generation = 0
  let inflight = null

  function checkDirectory() {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) ||
        fs.realpathSync(directory) !== directory) throw new Error()
  }
  function syncDirectory() {
    const fd = fs.openSync(directory, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  /** Rechecked on every read, as readPrivateSecretFile does for host secrets. */
  function read() {
    let fd
    try {
      checkDirectory()
      try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 ||
          stat.size < 1 || stat.size > X_CREDENTIAL_MAX_BYTES || fs.realpathSync(path) !== path) throw new Error()
      const text = fs.readFileSync(fd, 'utf8')
      let value
      try { value = validRecord(JSON.parse(text)) } catch { fail('x_credential_invalid', 503) }
      return value
    } catch (error) {
      if (error instanceof BrokerError) throw error
      fail('x_credential_unsafe', 503)
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  /** Temp + fsync + rename + chmod + directory fsync. A failure leaves the
   * previous file in place and is reported, never retried. */
  function write(next) {
    const bytes = `${JSON.stringify(validRecord(next))}\n`
    const temp = join(directory, `.x-credential-${randomUUID()}.tmp`)
    let created = false
    try {
      checkDirectory()
      try {
        if (fs.lstatSync(path).isSymbolicLink()) throw new Error()
      } catch (error) { if (error?.code !== 'ENOENT') throw error }
      const fd = fs.openSync(temp, 'wx', 0o600)
      created = true
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, path); created = false
      fs.chmodSync(path, 0o600)
      syncDirectory()
    } catch {
      if (created) { try { fs.unlinkSync(temp) } catch { /* the original file is intact */ } }
      fail('x_credential_persist_failed', 503)
    }
  }

  function load() {
    const value = read()
    generation++
    if (value?.state === 'renewing') {
      // A crash while a refresh request may have been sent: the grant may be
      // consumed, so the stored refresh token is quarantined, never replayed.
      record = { ...value, refreshToken: '', state: 'rotation_lost' }
      try { write(record) } catch { /* memory still refuses renewal */ }
    } else record = value
    return view(record)
  }

  function save(pair) {
    validPair(pair)
    const next = { version: 1, ...pair, state: 'active' }
    write(next)
    generation++
    record = next
    return view(record)
  }

  function clear() {
    generation++
    record = null
    try {
      checkDirectory()
      try { fs.unlinkSync(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      syncDirectory()
    } catch { fail('x_credential_persist_failed', 503) }
  }

  async function exchange(refreshToken, clientId) {
    const controller = new AbortController()
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new BrokerError('x_renewal_timeout', 503)) }, timeoutMs)
    })
    const bounded = work => Promise.race([work, deadline])
    try {
      let sent
      try {
        sent = fetch(X_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch { return { code: 'x_renewal_network' } } // Thrown before dispatch: nothing was sent.
      let response
      try { response = await bounded(sent) } catch (error) {
        return neverSent(error) ? { code: 'x_renewal_network' } : { lost: true }
      }
      // X answered: the grant's fate is known. A refused grant is dead; the
      // rest are ordinary refusals that leave it as it was.
      if (response.status === 400 || response.status === 401) return { code: 'x_renewal_rejected', dead: true }
      if (response.status === 402) return { code: 'x_renewal_credits' }
      if (response.status === 403) return { code: 'x_renewal_forbidden' }
      if (response.status === 429) return { code: 'x_renewal_quota' }
      if (!response.ok) return { code: 'x_renewal_service' }
      let body
      try { body = await bounded(response.json()) } catch { return { lost: true } }
      // A 2xx consumed the grant; an answer this cannot read is as lost as none.
      const accessToken = body?.access_token, rotated = body?.refresh_token, expiresIn = body?.expires_in ?? DEFAULT_EXPIRES_IN
      if (typeof accessToken !== 'string' || !TOKEN.test(accessToken) ||
          (rotated !== undefined && (typeof rotated !== 'string' || !TOKEN.test(rotated))) ||
          !Number.isSafeInteger(expiresIn) || expiresIn < 1) return { lost: true }
      return { accessToken, refreshToken: rotated ?? refreshToken, expiresIn }
    } finally { clearTimeout(timer) }
  }

  async function renewOnce() {
    if (!record) fail('x_credential_missing', 503)
    // A refused grant is never sent again: X would only refuse it again.
    if (record.state === 'rejected') fail('x_renewal_rejected', 409)
    if (record.state !== 'active' || !record.refreshToken) fail('x_rotation_lost', 409)
    const started = generation, prior = record
    // Durable intent first: a crash after the request leaves `renewing`, which
    // load() quarantines instead of replaying a possibly consumed grant.
    write({ ...prior, state: 'renewing' })
    record = { ...prior, state: 'renewing' }
    const result = await exchange(prior.refreshToken, prior.clientId)
    if (generation !== started) fail('x_credential_replaced', 409)
    if (result.lost) {
      record = { ...prior, refreshToken: '', state: 'rotation_lost' }
      try { write(record) } catch { /* memory still refuses renewal */ }
      fail('x_renewal_lost', 503)
    }
    if (result.dead) {
      record = { ...prior, refreshToken: '', state: 'rejected' }
      try { write(record) } catch { /* memory still refuses renewal; the file says renewing, which quarantines */ }
      fail(result.code, 503)
    }
    if (result.code) {
      record = prior
      try { write(prior) } catch { /* the file says renewing: a restart quarantines, fail closed */ }
      fail(result.code, 503)
    }
    const next = {
      ...prior, accessToken: result.accessToken, refreshToken: result.refreshToken,
      expiresAt: new Date(now() + result.expiresIn * 1000).toISOString(), state: 'active',
    }
    try { write(next) } catch (error) {
      // The old pair is dead and the new one is not durable: refuse to use it.
      record = { ...prior, refreshToken: '', state: 'rotation_lost' }
      throw error
    }
    record = next
    return view(record)
  }

  return {
    load, save, clear,
    current: () => view(record),
    /** Exactly one token request per call; concurrent callers share it. */
    renew() {
      inflight ??= renewOnce().finally(() => { inflight = null })
      return inflight
    },
  }
}
