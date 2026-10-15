/**
 * Phase 0 capability probe (spec §26 phase 0): measure what THIS host's SDK
 * storage actually guarantees before the runtime trusts it — write ack,
 * read-after-write, value-size ceiling, key isolation, overwrite, missing-
 * key behavior, oversized-input behavior. Dev-only (`?probe=storage`); the
 * probe writes only spriite.probe.* keys and clears them afterwards (the
 * SDK has no delete: an empty string is the tombstone).
 *
 * Observed results are recorded in docs/PHASE0-CAPABILITY-NOTES.md via
 * scripts/probe-storage.mjs. The probe is evidence about the host it ran
 * on — the simulator here — not proof of hardware persistence; that gate
 * stays open until qualified on the phone (spec §27).
 */
import type { BridgeGateway } from '../bridge/bridge'

const NS = 'spriite.probe.storage.v1'
const SIZES = [1_000, 8_000, 32_000, 64_000, 128_000, 256_000, 512_000, 1_048_576]
const OVERSIZED = 5_000_000
const SET_TIMEOUT_MS = 30_000
const GET_TIMEOUT_MS = 30_000

interface SizeResult {
  chars: number
  setOk: boolean
  setMs: number
  read: 'ok' | 'missing' | 'failed'
  match: boolean
  getMs: number
}

/** Distinct head/tail markers make truncation detectable, not just length;
 *  the padding shrinks so the total is exactly `chars`. */
function payload(chars: number): string {
  const head = `spriite-probe:${chars}:`
  const tail = `:${chars}`
  return head + 'x'.repeat(Math.max(0, chars - head.length - tail.length)) + tail
}

export async function runStorageProbe(gateway: BridgeGateway): Promise<void> {
  console.log('[probe] storage capability probe starting')
  const sizes: SizeResult[] = []
  for (const chars of SIZES) {
    const value = payload(chars)
    const key = `${NS}.size.${chars}`
    const t0 = Date.now()
    const setOk =
      (await gateway.call((b) => b.setLocalStorage(key, value), `probe.set.${chars}`, SET_TIMEOUT_MS)) === true
    const setMs = Date.now() - t0
    const t1 = Date.now()
    const raw = await gateway.call((b) => b.getLocalStorage(key), `probe.get.${chars}`, GET_TIMEOUT_MS)
    const getMs = Date.now() - t1
    const read = raw === null ? 'failed' : raw === '' ? 'missing' : 'ok'
    const match = raw === value
    sizes.push({ chars, setOk, setMs, read, match, getMs })
    console.log(`[probe] size=${chars} set=${setOk} setMs=${setMs} read=${read} match=${match} getMs=${getMs}`)
  }

  // Key isolation: one write must not disturb another key.
  const isoA = payload(2_000)
  const isoB = payload(3_000)
  await gateway.call((b) => b.setLocalStorage(`${NS}.iso.a`, isoA), 'probe.iso.a', SET_TIMEOUT_MS)
  await gateway.call((b) => b.setLocalStorage(`${NS}.iso.b`, isoB), 'probe.iso.b', SET_TIMEOUT_MS)
  const isoBack = await gateway.call((b) => b.getLocalStorage(`${NS}.iso.a`), 'probe.iso.a.get', GET_TIMEOUT_MS)
  const isolation = isoBack === isoA
  console.log(`[probe] isolation=${isolation}`)

  // Overwrite: the second value fully replaces the first.
  await gateway.call((b) => b.setLocalStorage(`${NS}.iso.a`, isoB), 'probe.iso.a2', SET_TIMEOUT_MS)
  const overBack = await gateway.call((b) => b.getLocalStorage(`${NS}.iso.a`), 'probe.iso.a2.get', GET_TIMEOUT_MS)
  const overwrite = overBack === isoB
  console.log(`[probe] overwrite=${overwrite}`)

  // Missing key: what does the host answer for a never-set key?
  const missRaw = await gateway.call((b) => b.getLocalStorage(`${NS}.never.set`), 'probe.miss', GET_TIMEOUT_MS)
  const missing = missRaw === '' ? 'empty-string' : missRaw === null ? 'failed' : 'unexpected-value'
  console.log(`[probe] missing=${missing}`)

  // Oversized write: does the host refuse, truncate, or accept?
  const big = payload(OVERSIZED)
  const bigSetOk =
    (await gateway.call((b) => b.setLocalStorage(`${NS}.big`, big), 'probe.set.big', SET_TIMEOUT_MS)) === true
  const bigRaw = await gateway.call((b) => b.getLocalStorage(`${NS}.big`), 'probe.get.big', GET_TIMEOUT_MS)
  const bigMatch = bigRaw === big
  console.log(`[probe] oversized=${OVERSIZED} set=${bigSetOk} match=${bigMatch} readLen=${bigRaw?.length ?? -1}`)

  // A realistic envelope near the store's chunk size round-trips as JSON.
  const envJson = JSON.stringify({ v: 2, seq: 42, createdAt: new Date().toISOString(), text: payload(39_500) })
  const envSetOk =
    (await gateway.call((b) => b.setLocalStorage(`${NS}.json`, envJson), 'probe.set.json', SET_TIMEOUT_MS)) === true
  let jsonRoundtrip = false
  try {
    const envBack = await gateway.call((b) => b.getLocalStorage(`${NS}.json`), 'probe.get.json', GET_TIMEOUT_MS)
    jsonRoundtrip = envBack !== null && envBack !== '' && JSON.parse(envBack).text === JSON.parse(envJson).text
  } catch {
    jsonRoundtrip = false
  }
  console.log(`[probe] jsonRoundtrip=${jsonRoundtrip} setOk=${envSetOk}`)

  // Cleanup: empty string is the only tombstone the SDK offers.
  const used = [...SIZES.map((c) => `${NS}.size.${c}`), `${NS}.iso.a`, `${NS}.iso.b`, `${NS}.big`, `${NS}.json`]
  for (const k of used) {
    await gateway.call((b) => b.setLocalStorage(k, ''), `probe.clear.${k}`, SET_TIMEOUT_MS)
  }

  const result = { sizes, isolation, overwrite, missing, oversized: { setOk: bigSetOk, match: bigMatch }, jsonRoundtrip }
  console.log(`[probe] RESULT ${JSON.stringify(result)}`)
  console.log('[probe] storage probe complete')
}
