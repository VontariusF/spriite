/**
 * Qualification harness (spec §24-§27).
 *
 * Runs every suite and — when a simulator is already up — every walkthrough,
 * then prints a dated evidence report: what ran, what passed, which spec items
 * those results cover, which items are hardware-gated, and which gaps stay
 * open. It never claims device qualification it did not run (spec §25: "Do not
 * substitute a mocked green test suite for device qualification").
 *
 * The §24 coverage rows are machine-checked: each names candidate keywords,
 * and the row is only reported as verified when one of them appears in the
 * named suites' output. A row that finds nothing says so instead of assuming
 * coverage.
 *
 * Usage:
 *   node scripts/qualify.mjs                     suites only
 *   node scripts/qualify.mjs --sim               suites + walkthroughs (sims must be up)
 *   node scripts/qualify.mjs --sim --out docs/QUALIFICATION-RUN.md
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arch, platform, release } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const wantSim = args.includes('--sim')
const outIdx = args.indexOf('--out')
const outPath = outIdx >= 0 ? resolve(ROOT, args[outIdx + 1]) : null
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

const SUITES = [
  { id: 'store', script: 'test:store', label: 'MissionStore, journal, v1 migration' },
  { id: 'runtime', script: 'test:runtime', label: 'Supervisor, actors, scheduler, outbox, crash matrix' },
  { id: 'briefing', script: 'test:briefing', label: 'Briefings, coverage ledger, phone inbox, honesty' },
  { id: 'sprite', script: 'test:sprite', label: 'Poses, resolver, static mode, coalesced renderer' },
  { id: 'x', script: 'test:x', label: 'Owner X intake, transport, context, receipts' },
  { id: 'real', script: 'test:real', label: 'Real orchestrator, home rows, gates, faults' },
  { id: 'app-engine', script: 'test:app-engine', label: 'App adapter over the durable runtime + launch plan' },
  { id: 'settings', script: 'test:settings', label: 'Saved session settings, freezing, API bodies, and phone controls' },
  { id: 'voice-turn', script: 'test:voice-turn', label: 'Capture ownership, focus changes, settlement, and stale callbacks' },
  { id: 'history', script: 'test:history', label: 'Saved build/activity history, storage outages, acknowledgments, and concurrency' },
  { id: 'followups', script: 'test:followups', label: 'Durable X follow-ups: crash boundaries, FIFO, ambiguity, and owner resolution' },
  { id: 'dev-fake', script: 'test:dev-fake', label: 'Actual dev-provider protocols, failure recovery, branches, and walkthrough reload detection' },
  { id: 'factory-adapter', script: 'test:factory-adapter', label: 'Real Factory HTTP adapter: protocol framing and delivery acknowledgment' },
  { id: 'execution-boundary', script: 'test:execution-boundary', label: 'Production client dispatch, worker questions, upgrade recovery, and evidence-only progress' },
  { id: 'team-real', script: 'test:team-real', label: 'Fresh owner scope, approval races, and uncertain decision/worker delivery' },
  { id: 'team-ui', script: 'test:team-ui', label: 'Unsent voice recovery, local scope feedback, and connected Factory handoff focus' },
  { id: 'team-cancellation', script: 'test:team-cancellation', label: 'Late worker launch cancellation and capacity retention' },
  { id: 'team-delivery-runtime', script: 'test:team-delivery-runtime', label: 'Acknowledged managed receipt state before decision and execution messages' },
  { id: 'team-watch-store', script: 'test:team-watch-store', label: 'Independent watch receipts, reload recovery, persistence races, and corruption holds' },
  { id: 'response-reading', script: 'test:response-reading', label: 'Full response text, pixel-bounded pagination, Unicode, and latest-reply reading' },
  { id: 'native-broker', script: 'test:native-broker', label: 'Durable native broker, authority, exact attention ownership and recovery' },
  { id: 'native-runtime', script: 'test:native-runtime', label: 'Independent native actor, neutral projections, binding and restore' },
  { id: 'native-ui', script: 'test:native-ui', label: 'Native phone consent/question flows and lossless owner intent' },
  { id: 'native-retained', script: 'test:native-retained', label: 'Retained execution authority, provider observation and delivery repairs' },
  { id: 'native-ownership', script: 'test:native-ownership', label: 'Target-bound capture, rendered focus and literal voice drafts' },
  { id: 'native-provider', script: 'test:native-provider', label: 'Injected pinned SDK lifecycle, wire decoding and no-replay registry' },
  { id: 'native-provider-policy', script: 'test:native-provider-policy', label: 'Signed physical workspace/boundary evidence and actual-send permits' },
  { id: 'archive-fixes', script: 'test:archive-fixes', label: 'Relay archive/bridge: rate buckets, restore paging, streamed body cap' },
  { id: 'cursor-fixes', script: 'test:cursor-fixes', label: 'Cursor client request timeouts' },
  { id: 'hud-fixes', script: 'test:hud-fixes', label: 'Chat reader start and surrogate-safe clipping' },
  { id: 'intake-fixes', script: 'test:intake-fixes', label: 'X kill-switch health, single-hop link gathering, repository names' },
  { id: 'phone-fixes', script: 'test:phone-fixes', label: 'Slow phone actions and Factory readiness copy' },
  { id: 'real-fixes', script: 'test:real-fixes', label: 'Cloud orchestrator: restore/reset polling, cursor respawn, PR stage, review queue' },
  { id: 'runtime-fixes', script: 'test:runtime-fixes', label: 'Native actor scheduling and storage-broken backoff' },
  { id: 'wiring-fixes', script: 'test:wiring-fixes', label: 'Bridge sync throws and device status before init' },
  { id: 'host-x-rules', script: 'test:host-x-rules', label: 'Host X rules parity with phone intake' },
  { id: 'host-x-credential', script: 'test:host-x-credential', label: 'Host X credential rotation and read-only client' },
  { id: 'host-x-reader', script: 'test:host-x-reader', label: 'Host X reader: auth, dedupe, checkpoint, crash, routing' },
  { id: 'host-x-launch', script: 'test:host-x-launch', label: 'Host X launcher and broker X routes' },
  { id: 'host-x-phone', script: 'test:host-x-phone', label: 'Phone handoff, polling deferral and host job adoption' },
  { id: 'portable-broker', script: 'test:portable-broker', label: 'Portable broker: tool resolution, daemon PATH, no host-specific defaults' },
  { id: 'portable-host-runtime', script: 'test:portable-host-runtime', label: 'Portable host runtime: process groups, liveness, locale' },
  { id: 'portable-installer', script: 'test:portable-installer', label: 'Portable installer dry runs on Linux and macOS layouts' },
  { id: 'native-x-auto', script: 'test:native-x-auto', label: 'Automatic launch of held X requests through broker admission' },
  { id: 'native-mission-v2-record', script: 'test:native-mission-v2-record', label: 'Factory Mission v2 on-disk record reader and fixtures' },
  { id: 'native-host', script: 'test:native-host', label: 'Host enforcer: scrubbed sandboxed daemon, signed evidence, leases, permits, revocation' },
  { id: 'native-local-seed', script: 'test:native-local-seed', label: 'Real local Git seed uses configured identity without remote or daemon actions' },
  { id: 'native-delivery', script: 'test:native-delivery', label: 'Broker-only branch push, PR, checks gating, squash merge and restart resume' },
  { id: 'native-admission', script: 'test:native-admission', label: 'Read-only broker/client/main admission and partial observation authority' },
  { id: 'native-managed-workspace', script: 'test:native-managed-workspace', label: 'Explicit managed host allocation, exact review binding and legacy profile compatibility' },
  { id: 'native-admission-ui', script: 'test:native-admission-ui', label: 'Actual-DOM prospective settings, consent, expiry and identity races' },
  { id: 'live-x-probe', script: 'test:live-x-probe', label: 'Offline safety checks for the opt-in read-only live X probe' },
  { id: 'phone-redesign', script: 'test:phone-redesign', label: 'Redesigned phone: tokens, Home, Builds, Mission, Ask, Settings' },
  { id: 'setup-flow', script: 'test:setup-flow', label: 'Setup flow: Welcome, Pair, Paired, Repo, Ready, Move screens' },
  { id: 'pairing', script: 'test:pairing', label: 'spriite pair: PAKE bundle, relay mailbox, one-time codes, vault apply, CLI discovery' },
  { id: 'transfer', script: 'test:transfer', label: 'Move to another phone: one-time encrypted transfer of keys, defaults and history' },
  { id: 'host-x-signin', script: 'test:host-x-signin', label: 'Host-run X PKCE sign-in: state check, token exchange, broker routes' },
  { id: 'native-github', script: 'test:native-github', label: 'Host GitHub: exact allowlist, forced-private create, pass-through, cap, capability' },
  { id: 'host-github-phone', script: 'test:host-github-phone', label: 'Host GitHub on the phone: transport parity, selection order, host-created new repo, copy' },
  { id: 'hud-redesign', script: 'test:hud-redesign', label: 'Redesigned glasses HUD scenes, segmented bar and copy' },
]

const WALKTHROUGHS = [
  { id: 'real offline (9899)', port: 9899, argv: ['scripts/walkthrough-real.mjs', '9899', 'offline'], label: 'Real engine offline, flags off' },
  { id: 'runtime (9903)', port: 9903, argv: ['scripts/walkthrough-runtime.mjs', '9903'], label: 'Durable runtime, persistent_runtime_v2 on' },
  { id: 'native fixture (9916)', port: 9916, argv: ['scripts/walkthrough-native.mjs', '9916'], label: 'Independent native actor, offline fixture only' },
]

/**
 * §24 failure behavior. Each row names the suites whose assertions cover it
 * and candidate words that must appear in a PASSING ASSERTION LABEL for the
 * row to count as verified (never incidental prose, never a comment). A row
 * with no match is reported honestly as unverified.
 */
const FAILURE_MATRIX = [
  { item: 'Storage write fails', suites: ['store', 'briefing'], words: ['never success', 'left no trace', 'storage, not as an acknowledgement'] },
  { item: 'Crash after command commit', suites: ['runtime', 'x'], words: ['resumes at boot', 'does not mint a second mission', 'recovers the same mission on redelivery'] },
  { item: 'Crash during launch', suites: ['runtime'], words: ['recorded unknown', 'not retried blindly'] },
  { item: 'Duplicate X event', suites: ['x', 'runtime'], words: ['three deliveries, one mission', 'duplicate source event resolves'] },
  { item: 'Missed stream interval', suites: ['x', 'briefing'], words: ['declared as a delivery gap', 'a gap, never a silent skip'] },
  { item: 'Non-owner trigger', suites: ['x'], words: ['the non-owner trigger is counted', 'screenshot text): refused'] },
  { item: 'Missing context', suites: ['x'], words: ['asks privately', 'missing parent named, not invented'] },
  { item: 'Ambiguous repository', suites: ['x', 'real'], words: ['no repository guess', 'is not a repository', 'steps aside to -2'] },
  { item: 'Expired provider credential', suites: ['runtime', 'real', 'x'], words: ['kind "auth" is recorded rejected', 'classified auth error'] },
  { item: 'Rate limit', suites: ['runtime', 'real', 'x'], words: ['rate limit', 'quota', '429', 'backoff'] },
  { item: 'Malformed review', suites: ['real', 'runtime'], words: ['failed verdict', 'verdict'] },
  { item: 'Commit changes after review', suites: ['store', 'real', 'runtime'], words: ['stale review', 'review invalidated', 'commit changed after'] },
  { item: 'Pause during dispatch', suites: ['runtime'], words: ['queued mission pauses', 'pausing stays available'] },
  { item: 'Cancel unsupported or unconfirmed', suites: ['runtime', 'sprite'], words: ['never claims all work stopped', 'cancellation still in flight is still working'] },
  { item: 'Restart with changed defaults', suites: ['runtime'], words: ['changed global preferences'] },
  { item: 'Two runtimes attempt ownership', suites: ['runtime', 'app-engine'], words: ['each boot takes a new runtime epoch', 'never resumes them'] },
  { item: 'Glasses disappear mid-briefing', suites: ['briefing', 'sprite'], words: ['coalesce onto the same pending briefing', 'link state outranks'] },
  { item: 'New event during briefing', suites: ['briefing'], words: ['later events stay unseen', 'arrived after the fixed target'] },
  { item: 'Animation send is slow', suites: ['sprite'], words: ['held back, not queued', 'exactly one sprite transfer'] },
  { item: 'Relay success but display not seen', suites: ['briefing'], words: ['separately from acknowledgement', 'echo is rejected as stale'] },
  { item: 'Unrelated account sessions', suites: ['real', 'x'], words: ['cloud home lists the session', 'watch still takes messages'] },
  { item: 'Retention limit reached', suites: ['store'], words: ['the ceiling bounds the held window', 'reported, never silent'] },
]

/**
 * §25.1-26 acceptance tests. Like §24, each row names candidate words that
 * must appear in a passing assertion label, so a row cannot report "pass"
 * merely because its suites exited 0.
 */
const ACCEPTANCE = [
  { item: '§25.1 distinct mission IDs, duplicate events resolve to one command', suites: ['runtime', 'store'], words: ['distinct mission IDs', 'duplicate source event resolves'] },
  { item: '§25.2 more than eight active missions survive save/reload without eviction', suites: ['store'], words: ['12 missions survive save/reload'] },
  { item: '§25.3 crash boundaries around receipt, dispatch, result, cursor', suites: ['runtime'], words: ['previous epoch recovers as'] },
  { item: '§25.4 provider cursors never advance past durably applied work', suites: ['x', 'store'], words: ['checkpoint did not advance past the unsaved request', 'cursor committed with its event'] },
  { item: '§25.5 paused missions stay paused after restart', suites: ['runtime', 'store'], words: ['paused mission stays paused after reload', 'restore their control mode'] },
  { item: '§25.6 changed preferences still restore an existing mission', suites: ['runtime'], words: ['changed global preferences'] },
  { item: '§25.7 view choice changes no scheduling eligibility', suites: ['runtime'], words: ['without being selected', 'no mission is silenced'] },
  { item: '§25.8 fair capacity scheduling', suites: ['runtime'], words: ['arrival order (FIFO)', 'promoted the FIRST waiter'] },
  { item: '§25.9 stale plan revision rejected', suites: ['runtime'], words: ['stale decision revision cannot approve'] },
  { item: '§25.10 narrower policy blocks now-disallowed actions for old missions', suites: ['runtime'], words: ['narrowed policy prevents the launch', 'drops the approval of an older mission'] },
  { item: '§25.11-18 owner X mention, spoof resistance, dedupe, deletes, catch-up, decisions, redirects', suites: ['x'], words: ['three deliveries, one mission', 'an edit after dispatch is recorded as a proposed change', 'bodiless GET'] },
  { item: '§25.19-23 return briefing, coverage, disconnect eligibility, freshness honesty', suites: ['briefing'], words: ['collapses to ONE card', 'coalesce onto the same pending briefing', 'last-known'] },
  { item: '§25.24-26 poses and static equivalents, coalescing, reduced motion', suites: ['sprite'], words: ['twelve poses', 'only the NEWEST pending frame', 'reduce motion keeps each pose'] },
  { item: '§26 rollback retains records and resumes nothing', suites: ['app-engine', 'store'], words: ['legacy engine never resumes them', 'imports no second mission'] },
]

const HARDWARE_GATES = [
  { item: '§25.27 8-hour locked/backgrounded run, glasses disconnected', method: 'Safe test mission on each supported OS; record runtime behavior, battery, reconnect timing, missed intake' },
  { item: '§25.28 force-quit and reboot during a worker run', method: 'On device: kill the app mid-build, restart, verify one run reconciled with no duplicate dispatch' },
  { item: '§25.29 airplane mode / relay / provider outage', method: 'On device: toggle each, verify scoped recovery and truthful freshness labels' },
  { item: '§25.30 owner X build while glasses are absent', method: 'On device with a live owner X account; verify private return briefing' },
  { item: '§25.31 zero X write calls', method: 'Unit-tested (test:x); confirm again against a live account with request logging' },
  { item: '§25.32 display fit, contrast, gestures, image delivery, acknowledgement', method: 'Real G2 hardware: readable green contrast, gesture access, serial image delivery' },
  { item: '§27 SDK storage commit truth', method: 'Write a large envelope, force-quit mid-cycle, restart, verify the newest valid envelope is adopted' },
  { item: '§27 one-runtime lifecycle ownership', method: 'Drive the host protocol (headless re-entry, double __restoreState) and assert a single writer' },
  { item: '§27 continuous operation on the mobile matrix', method: 'Long-running device soak with intake enabled' },
  { item: '§27 X entitlement and reconnect coverage', method: 'Live owner X account: sign in on the paired computer (host PKCE), let the 2-hour access token expire, verify a check renews and persists the rotated pair, then check reconnect and entitlement limits' },
  { item: '§27 secure credential storage', method: 'Device review of where provider keys live and how they are cleared' },
  { item: '§27 provider unknown-launch resolution', method: 'Force a launch whose answer never arrives on device; verify the unresolved dispatch path' },
  { item: '§27 cancellation semantics per provider', method: 'On device: cancel a Factory and a Cursor run; verify what the card claims' },
  { item: '§27 streamed transport behavior', method: 'On device: measure HUD image delivery on the BLE link under load' },
]

const OPEN_GAPS = [
  'Factory-native execution remains disabled. Injected low-level SDK lifecycle, passive partial reads, durable substeps and host evidence/send-permit source are tested offline. Complete passive pending recovery, qualified child answers, an actual host consequence sandbox and complete billing interception are unavailable. These require external enforcement and a separately authorized canary; offline qualification cannot enable native execution.',
  'Successful live X qualification is outstanding: the restricted direct-API probe failed authentication; owner binding, entitlement, post visibility, and deployed relay parity remain unverified (see FEATURE-CHECK-PLAN.md).',
  'One authorized live refresh was rejected by X; successful renewal, rotation, revocation, and offline.access behavior still need the §27 live pass.',
  'Client/server clock skew between phone and relay is not exercised.',
  'Phase 4 hardware display test (all twelve poses on real glasses) is outstanding.',
  'The desktop simulator keeps no storage across process launches, so cross-launch durability is covered by an in-process reload of the runtime walkthrough plus the store crash matrix; on-device restart behavior stays a §27 gate.',
  'App-UI wiring is exercised by app-engine tests; unit and simulator evidence does not qualify live X, device lifecycle, or physical display behavior.',
  'Unattended X intake stays disabled until the §27 gates pass.',
  'Full spec §15 structured criteria/evidence review validation remains unimplemented. The retained path now independently checks repository/base/head identity and invalidates moved-base approvals, but these guards do not make a provider VERDICT an independently verified structured review.',
  'A save on the phone now reaches every live mission actor (credentials, computer id, and an unassigned repository), but the runtime-actor configure path is only unit-tested, not exercised on device.',
]

function run(cmd, argv, timeoutMs = 900000) {
  const started = Date.now()
  const res = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  return { out, ms: Date.now() - started, status: res.status ?? 1 }
}

function countLines(out, needle) {
  const marker = needle === 'PASS:' ? /^\s*(?:PASS(?::|\s)|ok\s+\d+\s+-\s)/ : /^\s*(?:FAIL(?::|\s)|not ok\s+\d+\s+-\s)/
  return out.split('\n').filter((l) => marker.test(l)).length
}

async function pingPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) })
    return (await res.text()).trim() === 'pong'
  } catch {
    return false
  }
}

const results = []
const outputs = new Map()
const missingSuites = Object.keys(pkg.scripts).filter((script) =>
  script.startsWith('test:') && !SUITES.some((suite) => suite.script === script),
)
if (missingSuites.length > 0) {
  throw new Error(`Qualification is missing registered suites: ${missingSuites.join(', ')}`)
}
console.log('== Spriite qualification run ==')
console.log(`${SUITES.length} suites, ${WALKTHROUGHS.length} walkthroughs (walkthroughs ${wantSim ? 'requested' : 'skipped; pass --sim'})`)
console.log('')

for (const s of SUITES) {
  const { out, ms, status } = run('npm', ['run', s.script])
  const pass = countLines(out, 'PASS:')
  const fail = countLines(out, 'FAIL:')
  outputs.set(s.id, out)
  results.push({ ...s, pass, fail, status, ms, ok: status === 0 && fail === 0 })
  console.log(`${status === 0 && fail === 0 ? 'PASS' : 'FAIL'}  ${s.script.padEnd(18)} ${String(pass).padStart(4)} labeled checks, ${fail} failures, ${(ms / 1000).toFixed(1)}s`)
  if (status !== 0 || fail !== 0) {
    const failedLabels = out.split('\n').filter((line) => line.includes('FAIL:'))
    console.log((failedLabels.length ? failedLabels : out.split('\n').slice(-20)).join('\n'))
  }
}

const walks = []
if (wantSim) {
  for (const w of WALKTHROUGHS) {
    if (!(await pingPort(w.port))) {
      walks.push({ ...w, ok: false, skipped: true, pass: 0, fail: 0, out: '' })
      console.log(`SKIP  ${w.id.padEnd(18)} no simulator on ${w.port} (start it with the matching npm script)`)
      continue
    }
    const { out, ms, status } = run('node', w.argv)
    const pass = countLines(out, 'PASS:')
    const fail = countLines(out, 'FAIL:')
    const verdict = (out.match(/(?:\w+ )?WALKTHROUGH (PASSED|FAILED)/) ?? [])[1] ?? ''
    const ok = status === 0 && fail === 0 && verdict === 'PASSED'
    walks.push({ ...w, ok, skipped: false, pass, fail, out })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${w.id.padEnd(18)} ${String(pass).padStart(4)} labeled checks, ${fail} failures, ${(ms / 1000).toFixed(1)}s`)
  }
}

// ---------------------------------------------------------------- report
const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const branch = execFileSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''

const totalPass = results.reduce((n, r) => n + r.pass, 0) + walks.reduce((n, w) => n + w.pass, 0)
const totalFail = results.reduce((n, r) => n + r.fail, 0) + walks.reduce((n, w) => n + w.fail, 0)
const suiteFailures = results.filter((r) => !r.ok).length + walks.filter((w) => !w.ok && !w.skipped).length

const lines = []
lines.push(`# Spriite qualification run — ${new Date().toISOString().slice(0, 19)}Z`)
lines.push('')
lines.push(`- Revision: \`${commit}\` on \`${branch}\`${dirty ? ' (working tree dirty)' : ''}`)
lines.push(`- Host: ${platform()} ${release()} ${arch()}, node ${process.version}`)
lines.push(`- Versions: spriite ${pkg.version}, Even Hub SDK ${pkg.dependencies['@evenrealities/even_hub_sdk']}, simulator ${pkg.devDependencies['@evenrealities/evenhub-simulator']}`)
lines.push(`- Totals: ${totalPass} labeled checks passed, ${totalFail} failed, ${suiteFailures} suite/walkthrough failures`)
lines.push('- Counts are passing labels (including grouped broker cases and runtime journeys), not an instrumented count of every underlying assertion.')
lines.push('')
lines.push(`## Suites`)
lines.push('')
lines.push('| Suite | Covers | Labeled checks | Failures | Result |')
lines.push('|---|---|---|---|---|')
for (const r of results) lines.push(`| \`${r.script}\` | ${r.label} | ${r.pass} | ${r.fail} | ${r.ok ? 'pass' : 'FAIL'} |`)
lines.push('')
lines.push(`## Simulator walkthroughs`)
lines.push('')
lines.push('| Walkthrough | Scope | Labeled checks | Failures | Result |')
lines.push('|---|---|---|---|---|')
for (const w of walks) {
  lines.push(`| ${w.id} | ${w.label} | ${w.pass} | ${w.fail} | ${w.skipped ? 'not run (no simulator)' : w.ok ? 'pass' : 'FAIL'} |`)
}
if (!wantSim) lines.push('| — | walkthroughs were not requested (run with `--sim`) | — | — | not run |')
lines.push('')
lines.push('## Spec §24 failure behavior — coverage')
lines.push('')
lines.push('| Failure | Evidence | Verified |')
lines.push('|---|---|---|')
let unverified = 0
for (const row of FAILURE_MATRIX) {
  // Only assertion labels count, never incidental prose or comments: a §24 row
  // is "verified" when a passing assertion names the area, not when the word
  // happens to appear somewhere in the output.
  const hay = row.suites
    .map((id) => (outputs.get(id) ?? '').split('\n').filter((l) => /^\s*PASS(?::|\s)/.test(l)).join('\n'))
    .join('\n')
  const hit = row.words.find((w) => hay.toLowerCase().includes(w.toLowerCase()))
  if (!hit) unverified++
  lines.push(`| ${row.item} | ${row.suites.map((s) => `\`${s}\``).join(', ')} | ${hit ? `yes ('${hit}')` : 'no matching assertion'} |`)
}
lines.push('')
lines.push('## Spec §25.1-26 acceptance tests — coverage')
lines.push('')
lines.push('| Item | Suites | Result |')
lines.push('|---|---|---|')
for (const row of ACCEPTANCE) {
  const hay = row.suites
    .map((id) => (outputs.get(id) ?? '').split('\n').filter((l) => /^\s*PASS(?::|\s)/.test(l)).join('\n'))
    .join('\n')
  const hit = row.words.find((w) => hay.toLowerCase().includes(w.toLowerCase()))
  const suitesOk = row.suites.every((id) => results.find((r) => r.id === id)?.ok)
  if (!hit) unverified++
  lines.push(
    `| ${row.item} | ${row.suites.map((s) => `\`${s}\``).join(', ')} | ${
      !suitesOk ? 'FAIL (suite)' : hit ? `pass ('${hit}')` : 'no matching assertion'
    } |`,
  )
}
lines.push('')
lines.push('## Hardware gates (§25.27-32, §27) — not qualified')
lines.push('')
lines.push('These require a real phone and glasses. They are listed so a green suite run is never read as device qualification (spec §25).')
lines.push('')
lines.push('| Gate | Method |')
lines.push('|---|---|')
for (const g of HARDWARE_GATES) lines.push(`| ${g.item} | ${g.method} |`)
lines.push('')
lines.push('## Rollback (§26)')
lines.push('')
lines.push('- `planBoot` matrix (flag on/off x boot ok/failed x durable records x fresh) passes in `test:app-engine`.')
lines.push('- Flag off with durable records: the legacy engine resumes nothing and hides the migrated vault.')
lines.push('- The runtime never writes the legacy `sprite.factory.v1` snapshot while it holds authority, and the v1 migration skips a record whose lead session the durable state already owns (`test:store`).')
lines.push('')
lines.push('## Open gaps and carried risks')
lines.push('')
for (const g of OPEN_GAPS) lines.push(`- ${g}`)
lines.push('')
lines.push('## Verdict')
lines.push('')
lines.push(
  suiteFailures === 0
    ? `Automated qualification passes: ${totalPass} labeled checks, no failures. Device qualification (§25.27-32) has not been run and unattended X intake stays disabled.`
    : `Automated qualification FAILED: ${suiteFailures} suite/walkthrough failure(s).`,
)
if (unverified > 0) lines.push(`- ${unverified} §24/§25 row(s) found no matching assertion in their named suites; treat those responses as unverified.`)
lines.push('')

const report = lines.join('\n')
if (outPath) {
  writeFileSync(outPath, report)
  console.log(`\nReport written to ${outPath}`)
}
console.log('')
console.log(report.split('\n').slice(0, 12).join('\n'))
console.log(`... (${report.split('\n').length} lines total)`)
process.exit(suiteFailures === 0 ? 0 : 1)
