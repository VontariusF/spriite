/**
 * Phase 0 storage-probe harness (spec §26 phase 0): drives the app under
 * the simulator with ?probe=storage, scrapes the probe's console results,
 * and prints them for docs/PHASE0-CAPABILITY-NOTES.md.
 *
 * Prereqs: npm run dev (5173) + npm run sim:probe (automation on 9902).
 * Usage:   npm run probe:storage
 */
const BASE = 'http://127.0.0.1:9902'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastId = 0
const probeLines = []

async function getJson(path, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal })
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

async function ping() {
  try {
    const res = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(3000) })
    return (await res.text()).trim()
  } catch {
    return null
  }
}

async function poll(action, { timeoutMs = 90000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = await action()
    if (out !== undefined && out !== null && out !== false) return out
    await sleep(intervalMs)
  }
  return null
}

async function consoleEntries() {
  const data = await getJson(`/api/console?since_id=${lastId}`, 5000).catch(() => null)
  if (!data) return []
  const entries = data.entries ?? []
  if (entries.length > 0) lastId = Math.max(lastId, ...entries.map((e) => e.id))
  // Retain every probe line as the cursor advances past it: the entries are
  // only fetchable once, so the full log must be collected while polling.
  for (const e of entries) {
    if (e.message.startsWith('[probe]')) probeLines.push(e.message)
  }
  return entries
}

async function waitLog(fragment, timeoutMs = 90000) {
  return poll(async () => {
    for (const e of await consoleEntries()) {
      if (e.message.includes(fragment)) return e
    }
    return null
  }, { timeoutMs })
}

async function main() {
  console.log('== Phase 0 storage capability probe ==')
  const pong = await poll(() => ping(), { timeoutMs: 60000 })
  if (pong !== 'pong') throw new Error('simulator automation API not reachable on :9902 (npm run sim:probe)')
  const result = await waitLog('[probe] RESULT ', 90000)
  if (!result) {
    console.error('FAIL: probe never produced a RESULT line; check the app console for probe errors')
    process.exitCode = 1
    return
  }
  // Echo the full probe log for the record.
  for (const line of probeLines) console.log(line)
  const json = JSON.parse(result.message.slice('[probe] RESULT '.length))
  console.log('\n== summary ==')
  console.log('size ceiling (set ack + read-back match):')
  let ceiling = 0
  for (const s of json.sizes) {
    const ok = s.setOk && s.match
    if (ok) ceiling = s.chars
    console.log(
      `  ${String(s.chars).padStart(7)} chars  set=${String(s.setOk).padEnd(5)} match=${String(s.match).padEnd(5)} setMs=${s.setMs} getMs=${s.getMs}`,
    )
  }
  console.log(`  largest verified value: ${ceiling} chars`)
  console.log(`key isolation: ${json.isolation}`)
  console.log(`overwrite: ${json.overwrite}`)
  console.log(`missing key returns: ${json.missing}`)
  console.log(`oversized 5MB write: set=${json.oversized.setOk} match=${json.oversized.match}`)
  console.log(`json roundtrip: ${json.jsonRoundtrip}`)
}

await main()
