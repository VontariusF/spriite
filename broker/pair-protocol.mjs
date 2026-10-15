/**
 * Spriite pairing and transfer protocol (docs/design/PAIRING-PROTOCOL.md).
 *
 * One rendezvous engine serves both flows:
 *   - pair: `spriite pair` on the Factory computer (host role) hands its
 *     PairingBundle to a phone that types the 6-character code K7Q-2MF;
 *   - move: the old phone (host role) hands a MoveBundle to a new phone that
 *     types the transfer code WREN · 41 · OAK.
 *
 * The key exchange is CPace over ristretto255 (draft-irtf-cfrg-cpace): the
 * code is the password, bound to a fresh session id, so a transcript (what
 * the relay sees) gives an offline attacker nothing to test guesses against.
 * An active relay gets exactly one online guess per code: the host checks the
 * phone's key confirmation before it releases anything, and a failed check
 * burns the session. ISK -> HKDF-SHA256 -> two confirmation keys and one
 * AES-256-GCM key (WebCrypto). A scanned QR adds a 16-byte secret to the
 * password, so a scanned pairing has full strength.
 *
 * Pure ESM, browser and Node 22: globalThis.crypto, fetch, @noble/curves and
 * @noble/hashes (pinned in package.json and cli/package.json). Nothing here
 * logs, and nothing secret is ever part of an error.
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { hkdf } from '@noble/hashes/hkdf.js'

export const PAIR_TTL_MS = 10 * 60 * 1000
/** Largest relay request body the mailbox accepts (relay/pair.mjs). */
export const PAIR_BODY_MAX = 1_000_000
export const PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIR_KINDS = Object.freeze(['pair', 'move'])
export const QR_SECRET_BYTES = 16
/** How many times the host re-rolls a code whose mailbox slot is taken. */
export const MAX_SLOT_ROLLS = 8

/** The 256 transfer words (8 bits each). The first word of a code is its public mailbox slot. */
export const TRANSFER_WORDS = Object.freeze([
  'ACORN', 'ALDER', 'ALOE', 'AMBER', 'ANT', 'APPLE', 'APRIL', 'ARCH', 'ASH', 'ASPEN', 'ATLAS',
  'AZURE', 'BAKER', 'BAMBOO', 'BARN', 'BASIL', 'BASIN', 'BAY', 'BEACH', 'BEAN', 'BEAR', 'BEE',
  'BELL', 'BERRY', 'BIRCH', 'BIRD', 'BISON', 'BLUFF', 'BOAT', 'BOLT', 'BRAVE', 'BREAD', 'BRICK',
  'BROOK', 'BRUSH', 'CABIN', 'CACAO', 'CAMEL', 'CANOE', 'CAPE', 'CARGO', 'CEDAR', 'CHALK', 'CHARM',
  'CHESS', 'CHIME', 'CIDER', 'CLAM', 'CLAY', 'CLIFF', 'CLOUD', 'CLOVE', 'COAST', 'COBALT', 'COCOA',
  'COMET', 'CORAL', 'CORN', 'CRANE', 'CREEK', 'CREST', 'CROW', 'DAISY', 'DAWN', 'DEER', 'DELTA',
  'DIAL', 'DOVE', 'DRIFT', 'DRUM', 'DUNE', 'DUSK', 'EAGLE', 'EARTH', 'ELM', 'EMBER', 'EPOCH',
  'FABLE', 'FALCON', 'FARM', 'FAWN', 'FERN', 'FIELD', 'FIG', 'FINCH', 'FJORD', 'FLAME', 'FLINT',
  'FLUTE', 'FOAM', 'FOREST', 'FORGE', 'FOX', 'FROST', 'GALE', 'GARNET', 'GECKO', 'GLADE', 'GLOBE',
  'GOLD', 'GOOSE', 'GRAIN', 'GRAPE', 'GROVE', 'GULL', 'HALO', 'HARBOR', 'HARP', 'HAWK', 'HAZEL',
  'HEDGE', 'HERON', 'HILL', 'HONEY', 'HOPE', 'HORN', 'INK', 'IRIS', 'ISLE', 'IVORY', 'IVY', 'JADE',
  'JAM', 'JAY', 'JUNE', 'KALE', 'KAYAK', 'KELP', 'KITE', 'KIWI', 'KNOLL', 'KOALA', 'LAKE', 'LARK',
  'LEAF', 'LEMON', 'LILAC', 'LILY', 'LIME', 'LINEN', 'LLAMA', 'LOCH', 'LOTUS', 'LUNAR', 'LYNX',
  'MANGO', 'MAPLE', 'MARSH', 'MEADOW', 'MELON', 'MESA', 'MINT', 'MOLE', 'MOON', 'MOOSE', 'MOSS',
  'MOTH', 'NECTAR', 'NEST', 'NOVA', 'OAK', 'OASIS', 'OCEAN', 'OLIVE', 'ONYX', 'OPAL', 'OPERA',
  'ORBIT', 'ORCA', 'OTTER', 'OWL', 'PALM', 'PANDA', 'PEACH', 'PEAK', 'PEAR', 'PEARL', 'PEBBLE',
  'PINE', 'PIXEL', 'PLUM', 'POLAR', 'POND', 'POPPY', 'PRISM', 'PUFFIN', 'QUAIL', 'QUARTZ', 'QUEST',
  'QUILL', 'RAFT', 'RAIN', 'RAVEN', 'REED', 'REEF', 'RIDGE', 'RIVER', 'ROBIN', 'ROCK', 'ROSE',
  'ROVER', 'RUBY', 'SAGE', 'SALT', 'SAND', 'SCOUT', 'SEAL', 'SHELL', 'SHORE', 'SILK', 'SKY',
  'SLATE', 'SNOW', 'SOLAR', 'SONG', 'SPARK', 'SPRUCE', 'STAR', 'STONE', 'STORM', 'SWAN', 'TEA',
  'TERN', 'THYME', 'TIDE', 'TIGER', 'TOPAZ', 'TORCH', 'TRAIL', 'TULIP', 'TUNDRA', 'TWIG', 'UMBER',
  'VALE', 'VAPOR', 'VELVET', 'VINE', 'VIOLET', 'VISTA', 'WALNUT', 'WAVE', 'WHALE', 'WHARF',
  'WHEAT', 'WILLOW', 'WIND', 'WOLF', 'WREN', 'YACHT', 'YAK', 'YARROW', 'YEW', 'ZEBRA', 'ZENITH',
  'ZEST', 'ZINC',
])
const WORD_SET = new Set(TRANSFER_WORDS)

// ---------------------------------------------------------------- bytes
const enc = new TextEncoder()
const dec = new TextDecoder()
export const utf8 = s => enc.encode(String(s))
export function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
export function toB64u(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function fromB64u(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch { return null }
}
export function randomBytes(n) {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}
function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// ---------------------------------------------------------------- codes
/** 'k7q-2mf ' -> 'K7Q2MF' (Crockford: O reads as 0, I and L as 1); null when not a code. */
export function normalizePairCode(input) {
  if (typeof input !== 'string') return null
  const s = input.toUpperCase().replace(/[\s\-·.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{6}$/.test(s) ? s : null
}
/** 'K7Q2MF' -> 'K7Q-2MF'. */
export function formatPairCode(code) {
  const c = normalizePairCode(code) ?? String(code ?? '')
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c
}
export function generatePairCode(random = randomBytes) {
  return [...random(6)].map(b => PAIR_ALPHABET[b & 31]).join('')
}
/** 'wren 41 oak' -> 'WREN-41-OAK'; null when not a transfer code. */
export function normalizeTransferCode(input) {
  if (typeof input !== 'string') return null
  const parts = input.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  if (parts.length === 2 && /^[A-Z]+\d{2}$/.test(parts[0])) parts.splice(0, 1, parts[0].slice(0, -2), parts[0].slice(-2))
  if (parts.length !== 3 || !WORD_SET.has(parts[0]) || !/^\d{2}$/.test(parts[1]) || !WORD_SET.has(parts[2])) return null
  return parts.join('-')
}
/** 'WREN-41-OAK' -> 'WREN · 41 · OAK'. */
export function formatTransferCode(code) {
  const c = normalizeTransferCode(code) ?? String(code ?? '')
  return c.split('-').join(' · ')
}
export function generateTransferCode(random = randomBytes) {
  let nn
  do { nn = random(1)[0] } while (nn >= 200)
  const [a, b] = random(2)
  return `${TRANSFER_WORDS[a]}-${String(nn % 100).padStart(2, '0')}-${TRANSFER_WORDS[b]}`
}
export function normalizeCode(kind, input) {
  return kind === 'pair' ? normalizePairCode(input) : kind === 'move' ? normalizeTransferCode(input) : null
}
export function formatCode(kind, code) {
  return kind === 'pair' ? formatPairCode(code) : formatTransferCode(code)
}
/** The public mailbox slot: the first 2 characters of a pair code, the first word of a transfer code. */
export function slotOf(kind, code) {
  return kind === 'pair' ? code.slice(0, 2) : code.split('-')[0]
}
export const SLOT_PATTERN = Object.freeze({ pair: /^[0-9A-HJKMNP-TV-Z]{2}$/, move: /^[A-Z]{2,6}$/ })

// ---------------------------------------------------------------- QR
/** What the QR encodes: the code, a 16-byte secret and the relay base (no other secret). */
export function encodeQr({ kind, code, secret, relay }) {
  const q = new URLSearchParams({ c: code, s: typeof secret === 'string' ? secret : toB64u(secret) })
  if (relay) q.set('r', relay)
  return `spriite:${kind}?${q}`
}
/** Reads a scanned QR (or a pasted code). null when it is neither. */
export function parseQr(text, expectKind = null) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  const m = /^spriite:(pair|move)\?(.*)$/.exec(t)
  if (!m) {
    for (const kind of expectKind ? [expectKind] : PAIR_KINDS) {
      const code = normalizeCode(kind, t)
      if (code) return { kind, code, secret: null, relay: null }
    }
    return null
  }
  if (expectKind && m[1] !== expectKind) return null
  const q = new URLSearchParams(m[2])
  const code = normalizeCode(m[1], q.get('c') ?? '')
  const secretBytes = q.get('s') === null ? null : fromB64u(q.get('s'))
  if (!code || (q.get('s') !== null && secretBytes?.length !== QR_SECRET_BYTES)) return null
  const relay = q.get('r')
  return { kind: m[1], code, secret: secretBytes ? q.get('s') : null, relay: relay && /^https?:\/\//.test(relay) ? relay : null }
}

// ---------------------------------------------------------------- CPace (ristretto255, SHA-512)
const Point = ristretto255.Point
const ORDER = Point.Fn.ORDER
const DSI = utf8('CPaceRistretto255')
const DSI_ISK = utf8('CPaceRistretto255_ISK')
const S_IN_BYTES = 128

function leb128(n) {
  const out = []
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b) } while (n)
  return Uint8Array.from(out)
}
const prependLen = b => concatBytes(leb128(b.length), b)
export const lvCat = (...parts) => concatBytes(...parts.map(prependLen))

/** The password-related string: the code, plus the QR secret for a scanned code. */
export function passwordFor(kind, code, variant, secret) {
  if (variant === 'qr') {
    const s = typeof secret === 'string' ? fromB64u(secret) : secret
    if (!s || s.length !== QR_SECRET_BYTES) throw new Error('qr_secret_invalid')
    return concatBytes(utf8(`spriite/${kind}/v1/qr:${code}:`), s)
  }
  return utf8(`spriite/${kind}/v1/code:${code}`)
}
/** G.calculate_generator: the session generator from password, channel and session id. */
export function cpaceGenerator(prs, ci, sid) {
  const zpad = new Uint8Array(Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length))
  return ristretto255_hasher.deriveToCurve(sha512(lvCat(DSI, prs, zpad, ci, sid)))
}
function sampleScalar(random = randomBytes) {
  for (;;) {
    const b = random(64)
    let n = 0n
    for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
    const s = n % ORDER
    if (s !== 0n) return s
  }
}
export function cpaceShare(generator, random = randomBytes) {
  const y = sampleScalar(random)
  return { y, Y: generator.multiply(y).toBytes() }
}
/** y * peer; null for a malformed encoding or the identity (the abort the draft requires). */
export function cpaceSecret(y, peer) {
  let P
  try { P = Point.fromBytes(peer) } catch { return null }
  const K = P.multiply(y)
  return K.is0() ? null : K.toBytes()
}
export function cpaceIsk(sid, K, Ya, ADa, Yb, ADb) {
  return sha512(concatBytes(lvCat(DSI_ISK, sid, K), lvCat(Ya, ADa), lvCat(Yb, ADb)))
}
/** ISK -> confirmation keys (A and B) and the AES-256-GCM key. */
export function sessionKeys(isk, sid) {
  const okm = hkdf(sha256, isk, sid, utf8('spriite/pake/v1/keys'), 96)
  return { confA: okm.slice(0, 32), confB: okm.slice(32, 64), aes: okm.slice(64, 96) }
}
const tagB = (keys, t) => hmac(sha256, keys.confB, lvCat(utf8('B'), t.Ya, t.Yb, t.ADb))
const tagA = (keys, t, b) => hmac(sha256, keys.confA, lvCat(utf8('A'), t.Ya, t.Yb, t.ADb, b))
const channel = kind => utf8(`spriite-${kind}`)
const aad = (kind, sid) => lvCat(utf8('spriite/pake/v1/bundle'), utf8(kind), sid)

async function seal(key, kind, sid, plaintext) {
  const k = await globalThis.crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const iv = randomBytes(12)
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(kind, sid) }, k, plaintext))
  return { iv: toB64u(iv), ct: toB64u(ct) }
}
async function open(key, kind, sid, ivText, ctText) {
  const iv = fromB64u(ivText), ct = fromB64u(ctText)
  if (!iv || iv.length !== 12 || !ct) return null
  try {
    const k = await globalThis.crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(kind, sid) }, k, ct))
  } catch { return null }
}

// ---------------------------------------------------------------- relay client
export class PairError extends Error {
  constructor(reason) { super(reason); this.reason = reason }
}
const STATUS_REASON = { 400: 'invalid', 401: 'invalid', 403: 'invalid', 404: 'not_found', 409: 'used', 410: 'expired', 413: 'too_large', 429: 'unreachable' }

/**
 * The relay mailbox client: JSON POSTs to <base>/<route> (base ends in
 * /pair/v1). Capability tokens ride in bodies, never in URLs.
 */
export function createRelayClient({ base, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const root = String(base ?? '').replace(/\/+$/, '')
  return {
    base: root,
    async call(route, body, signal) {
      if (signal?.aborted) throw new PairError('cancelled')
      let res
      try {
        res = await fetchImpl(`${root}/${route}`, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body), ...(signal ? { signal } : {}),
        })
      } catch {
        throw new PairError(signal?.aborted ? 'cancelled' : 'unreachable')
      }
      let json = null
      try { json = await res.json() } catch { json = null }
      if (res.ok) {
        if (!json || typeof json !== 'object') throw new PairError('unreachable')
        return json
      }
      if (res.status === 409 && json?.error === 'slot_taken') throw new PairError('slot_taken')
      throw new PairError(STATUS_REASON[res.status] ?? 'unreachable')
    },
  }
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new PairError('cancelled')); return }
  const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
  const onAbort = () => { clearTimeout(t); reject(new PairError('cancelled')) }
  signal?.addEventListener?.('abort', onAbort, { once: true })
})
const reasonOf = error => error instanceof PairError ? error.reason : 'unreachable'
/** Local deadline from the relay's own clock (expiresAt - now): no clock skew between ends. */
const deadlineFrom = (reply, now) => {
  const left = Number(reply?.expiresAt) - Number(reply?.now)
  return now() + (Number.isFinite(left) ? Math.max(0, Math.min(left, PAIR_TTL_MS)) : PAIR_TTL_MS)
}

// ---------------------------------------------------------------- host role
/**
 * Opens a session: a fresh code (re-rolled while its slot is taken), a QR
 * secret, a session id and one CPace share per variant (typed code, scanned
 * QR). Returns what to show plus finish(payload), which waits for the phone,
 * checks its key confirmation (a failure burns the session: 'wrong_code'),
 * then seals the payload for it.
 */
export async function openHostSession({
  kind, relay, relayLabel = '', random = randomBytes, now = Date.now, sleep = defaultSleep,
  pollMs = 1000, signal, code: fixedCode = null, maxBytes = PAIR_BODY_MAX, onClaimed,
}) {
  if (!PAIR_KINDS.includes(kind)) throw new PairError('invalid')
  const gen = kind === 'pair' ? generatePairCode : generateTransferCode
  for (let roll = 0; roll < MAX_SLOT_ROLLS; roll++) {
    const code = fixedCode ?? gen(random)
    const secret = random(QR_SECRET_BYTES)
    const sid = random(16)
    const ci = channel(kind)
    const shares = {
      code: cpaceShare(cpaceGenerator(passwordFor(kind, code, 'code'), ci, sid), random),
      qr: cpaceShare(cpaceGenerator(passwordFor(kind, code, 'qr', secret), ci, sid), random),
    }
    const slot = slotOf(kind, code)
    let opened
    try {
      opened = await relay.call('open', { kind, slot, sid: toB64u(sid), ya: { code: toB64u(shares.code.Y), qr: toB64u(shares.qr.Y) } }, signal)
    } catch (error) {
      if (reasonOf(error) === 'slot_taken' && fixedCode === null) continue
      throw new PairError(reasonOf(error) === 'slot_taken' ? 'used' : reasonOf(error))
    }
    if (typeof opened.hostToken !== 'string') throw new PairError('unreachable')
    const deadline = deadlineFrom(opened, now)
    const ref = { kind, slot, sid: toB64u(sid), token: opened.hostToken }
    let settled = false
    const close = async reason => {
      if (settled) return
      settled = true
      try { await relay.call('close', { ...ref, reason }) } catch { /* the mailbox expires on its own */ }
    }
    const session = {
      code, display: formatCode(kind, code), secret: toB64u(secret),
      qrText: encodeQr({ kind, code, secret, relay: relayLabel }),
      expiresAt: deadline,
      cancel: () => close('cancelled'),
      async finish(payload) {
        try {
          let b = null, claimedSeen = false
          for (;;) {
            if (now() >= deadline) { await close('expired'); return { ok: false, reason: 'expired' } }
            const polled = await relay.call('poll', ref, signal)
            if (polled.closed) { settled = true; return { ok: false, reason: polled.closed === 'cancelled' ? 'cancelled' : polled.closed === 'expired' ? 'expired' : 'used' } }
            if (polled.claimed && !claimedSeen) { claimedSeen = true; try { onClaimed?.() } catch {} }
            if (polled.msg) { b = polled.msg; break }
            await sleep(pollMs, signal)
          }
          const variant = b?.variant === 'qr' ? 'qr' : b?.variant === 'code' ? 'code' : null
          const Yb = fromB64u(b?.y), tag = fromB64u(b?.tag)
          const share = variant ? shares[variant] : null
          const K = share && Yb ? cpaceSecret(share.y, Yb) : null
          const t = { Ya: share?.Y, Yb, ADb: utf8(variant ?? '') }
          const keys = K ? sessionKeys(cpaceIsk(sid, K, share.Y, utf8(kind), Yb, t.ADb), sid) : null
          if (!keys || !equalBytes(tagB(keys, t), tag)) {
            // One online guess per code: a wrong confirmation burns the session.
            try { await relay.call('put', { ...ref, role: 'a', msg: { error: 'wrong_code' } }) } catch {}
            await close('burned')
            return { ok: false, reason: 'wrong_code' }
          }
          const body = await payload()
          const plaintext = utf8(JSON.stringify(body))
          // base64 grows 4/3; the envelope adds a little around it.
          if (Math.ceil((plaintext.length + 16) * 4 / 3) + 1024 > maxBytes) {
            try { await relay.call('put', { ...ref, role: 'a', msg: { error: 'too_large' } }) } catch {}
            await close('cancelled')
            return { ok: false, reason: 'too_large' }
          }
          const sealed = await seal(keys.aes, kind, sid, plaintext)
          await relay.call('put', { ...ref, role: 'a', msg: { tag: toB64u(tagA(keys, t, tag)), ...sealed } }, signal)
          // Wait for the phone to confirm it opened the bundle. A phone that
          // fetched it but could not say so before the deadline still has it.
          let delivered = false
          for (;;) {
            if (now() >= deadline) { await close(delivered ? 'done' : 'expired'); return delivered ? { ok: true } : { ok: false, reason: 'expired' } }
            const polled = await relay.call('poll', ref, signal)
            if (polled.delivered) delivered = true
            if (polled.closed) { settled = true; return polled.closed === 'done' ? { ok: true } : { ok: false, reason: polled.closed === 'cancelled' ? 'cancelled' : 'invalid' } }
            await sleep(pollMs, signal)
          }
        } catch (error) {
          const reason = reasonOf(error)
          await close(reason === 'cancelled' ? 'cancelled' : 'expired')
          return { ok: false, reason: reason === 'slot_taken' ? 'used' : reason }
        }
      },
    }
    return session
  }
  throw new PairError('used')
}

// ---------------------------------------------------------------- phone role
/**
 * Claims the session for a typed (or scanned) code, sends the CPace share and
 * key confirmation, and opens the host's sealed payload once the host's own
 * confirmation checks. Resolves { ok, payload } or { ok: false, reason }.
 */
export async function joinSession({
  kind, relay, code: input, qrSecret = null, random = randomBytes, now = Date.now,
  sleep = defaultSleep, pollMs = 800, signal,
}) {
  const code = normalizeCode(kind, input)
  if (!code) return { ok: false, reason: 'invalid' }
  const slot = slotOf(kind, code)
  let claimed
  try { claimed = await relay.call('claim', { kind, slot }, signal) } catch (error) { return { ok: false, reason: reasonOf(error) } }
  const sid = fromB64u(claimed.sid)
  const Ya = fromB64u(qrSecret ? claimed.ya?.qr : claimed.ya?.code)
  if (!sid || sid.length !== 16 || !Ya || typeof claimed.claimToken !== 'string') return { ok: false, reason: 'invalid' }
  const deadline = deadlineFrom(claimed, now)
  const ref = { kind, slot, sid: claimed.sid, token: claimed.claimToken }
  const variant = qrSecret ? 'qr' : 'code'
  let prs
  try { prs = passwordFor(kind, code, variant, qrSecret) } catch { return { ok: false, reason: 'invalid' } }
  const share = cpaceShare(cpaceGenerator(prs, channel(kind), sid), random)
  const K = cpaceSecret(share.y, Ya)
  const close = async reason => { try { await relay.call('close', { ...ref, reason }) } catch {} }
  if (!K) { await close('burned'); return { ok: false, reason: 'invalid' } }
  const t = { Ya, Yb: share.Y, ADb: utf8(variant) }
  const keys = sessionKeys(cpaceIsk(sid, K, Ya, utf8(kind), share.Y, t.ADb), sid)
  const myTag = tagB(keys, t)
  try {
    await relay.call('put', { ...ref, role: 'b', msg: { y: toB64u(share.Y), variant, tag: toB64u(myTag) } }, signal)
    for (;;) {
      if (now() >= deadline) { await close('expired'); return { ok: false, reason: 'expired' } }
      const got = await relay.call('get', ref, signal)
      if (got.msg) {
        const a = got.msg
        if (a.error === 'wrong_code') return { ok: false, reason: 'wrong_code' }
        if (a.error === 'too_large') return { ok: false, reason: 'too_large' }
        if (!equalBytes(tagA(keys, t, myTag), fromB64u(a.tag))) { await close('burned'); return { ok: false, reason: 'wrong_code' } }
        const plain = await open(keys.aes, kind, sid, a.iv, a.ct)
        if (!plain) { await close('burned'); return { ok: false, reason: 'invalid' } }
        let payload
        try { payload = JSON.parse(dec.decode(plain)) } catch { await close('burned'); return { ok: false, reason: 'invalid' } }
        await close('done')
        return { ok: true, payload }
      }
      if (got.closed) return { ok: false, reason: got.closed === 'burned' ? 'wrong_code' : got.closed === 'expired' ? 'expired' : got.closed === 'cancelled' ? 'cancelled' : 'used' }
      await sleep(pollMs, signal)
    }
  } catch (error) {
    const reason = reasonOf(error)
    if (reason === 'cancelled') await close('cancelled')
    return { ok: false, reason }
  }
}

// ---------------------------------------------------------------- QR code (byte mode, ECC level M)
// A small QR Model 2 encoder (ISO/IEC 18004): byte mode, error correction M,
// versions 1-40, the mask with the lowest penalty. Shared by the terminal
// (`spriite pair`) and the phone (Move screen) so both draw the same symbol.
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
  25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
const FORMAT_BITS_M = 0

function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}
const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver]
function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}
function rsDivisor(degree) {
  const out = new Array(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root)
      if (j + 1 < degree) out[j] ^= out[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return out
}
function rsRemainder(data, divisor) {
  const out = new Array(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ out.shift()
    out.push(0)
    divisor.forEach((d, i) => { out[i] ^= gfMul(d, factor) })
  }
  return out
}
function alignmentPositions(ver) {
  if (ver === 1) return []
  const size = ver * 4 + 17
  const count = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2
  const out = [6]
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos)
  return out
}
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
]

/** QR modules for `text`, row-major; true = dark module. Throws past version 40. */
export function qrMatrix(text) {
  const bytes = utf8(text)
  let ver = 1
  for (; ver <= 40; ver++) {
    const countBits = ver <= 9 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break
  }
  if (ver > 40) throw new Error('qr_too_long')
  const capacity = dataCodewords(ver) * 8
  const bits = []
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  push(0b0100, 4)
  push(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  // Blocks, error correction, interleaving.
  const numBlocks = BLOCKS_M[ver], eccLen = ECC_PER_BLOCK_M[ver]
  const raw = Math.floor(rawModules(ver) / 8)
  const shortBlocks = numBlocks - (raw % numBlocks), shortLen = Math.floor(raw / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const chunk = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1))
    k += chunk.length
    const block = [...chunk, ...rsRemainder(chunk, divisor)]
    if (i < shortBlocks) block.splice(shortLen - eccLen, 0, 0)
    blocks.push(block)
  }
  const codewords = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) codewords.push(block[i]) })
  }

  // Function patterns.
  const size = ver * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true }
  for (let i = 0; i < size; i++) { fn(6, i, i % 2 === 0); fn(i, 6, i % 2 === 0) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy
      if (x >= 0 && x < size && y >= 0 && y < size) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        fn(x, y, d !== 2 && d !== 4)
      }
    }
  }
  const align = alignmentPositions(ver), last = align.length - 1
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  const drawFormat = mask => {
    const d = (FORMAT_BITS_M << 3) | mask
    let rem = d
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const f = ((d << 10) | rem) ^ 0x5412
    const bit = i => ((f >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) fn(8, i, bit(i))
    fn(8, 7, bit(6)); fn(8, 8, bit(7)); fn(7, 8, bit(8))
    for (let i = 9; i < 15; i++) fn(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) fn(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) fn(8, size - 15 + i, bit(i))
    fn(8, size - 8, true)
  }
  drawFormat(0)
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const v = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3)
      fn(a, b, dark); fn(b, a, dark)
    }
  }

  // Codewords in the zigzag.
  let k = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (!isFn[y][x] && k < codewords.length * 8) {
          modules[y][x] = ((codewords[k >>> 3] >>> (7 - (k & 7))) & 1) === 1
          k++
        }
      }
    }
  }

  // Mask with the lowest penalty (runs, 2x2 blocks, finder-like runs, balance).
  const applyMask = m => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x]
  }
  const penalty = () => {
    let p = 0, dark = 0
    const line = get => {
      let run = 1
      const seq = []
      for (let i = 0; i < size; i++) seq.push(get(i))
      for (let i = 1; i <= size; i++) {
        if (i < size && seq[i] === seq[i - 1]) run++
        else { if (run >= 5) p += 3 + run - 5; run = 1 }
      }
      const s = seq.map(b => (b ? 1 : 0)).join('')
      for (const pat of ['10111010000', '00001011101']) for (let i = s.indexOf(pat); i >= 0; i = s.indexOf(pat, i + 1)) p += 40
    }
    for (let y = 0; y < size; y++) line(x => modules[y][x])
    for (let x = 0; x < size; x++) line(y => modules[y][x])
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x]
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) p += 3
    }
    for (const row of modules) for (const c of row) if (c) dark++
    const total = size * size
    p += Math.ceil(Math.abs(dark * 20 - total * 10) / total - 1) * 10
    return p
  }
  let best = 0, bestScore = Infinity
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m)
    const score = penalty()
    if (score < bestScore) { best = m; bestScore = score }
    applyMask(m)
  }
  applyMask(best); drawFormat(best)
  return modules
}
