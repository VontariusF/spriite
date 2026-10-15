/**
 * Setup flow tests (redesign package `setup`): Welcome, Pair, Paired, Repo
 * (paired, key-only, pasted URL), Ready, the Move sender and receiver, and
 * the reusable repo chooser — against the boards in docs/design/redesign
 * (Main, Pair, Paired, Repo, Ready, Move). Real KeyVault/PrefsVault over an
 * in-memory gateway; the pairing client, GitHub and the Factory key check
 * are fakes.
 *
 * Usage: npm run test:setup-flow
 */
import {
  setupDom, walk, byClass, firstByClass, byAction, byTag, byText, visibleText, fire, click, typeInto,
  flush, memoryGateway, setNavigator, textOf, hasClass,
} from './lib/setup-dom.mjs'

setupDom()

const { KeyVault } = await import('../src/voice/keys.ts')
const { PrefsVault } = await import('../src/state/prefs.ts')
const { isSetupComplete } = await import('../src/state/setup-state.ts')
const flow = await import('../src/setup/flow/index.ts')
const { COPY, PAIR_FAILURE, TRANSFER_FAILURE } = await import('../src/setup/flow/copy.ts')
const { mountSetupFlow, mountMoveScreen, mountRepoChooser, parseGithubUrl, repoMeta, countdown, SETUP_CSS } = flow

let failures = 0
const assert = (ok, label) => {
  if (ok) console.log('  PASS:', label)
  else {
    failures++
    console.log('  FAIL:', label)
  }
}
const section = (name) => console.log(`\n-- ${name}`)
console.log('== Setup flow tests (redesign: Welcome, Pair, Paired, Repo, Ready, Move) ==')

const DAY = 86_400_000

// ---------------------------------------------------------------- fakes
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const BUNDLE = (over = {}) => ({
  v: 1, kind: 'pair', createdAt: Date.now(),
  host: { label: 'studio', machineId: 'machine-example', ownerId: 'owner-example', brokerUrl: 'https://broker.example.com', via: 'tailscale', os: 'linux', online: true, ...(over.host ?? {}) },
  factory: { apiKey: 'fk-test-paired-0001', computerId: 'cmp-1', computerName: 'studio', computerOnline: true, ...(over.factory ?? {}) },
  github: { token: 'gh-test-token', login: 'owner-example', repoCount: 12, ...(over.github ?? {}) },
  broker: { bearerToken: 'bearer-test', ...(over.broker ?? {}) },
  voice: { elevenLabsKey: null, ...(over.voice ?? {}) },
  x: { hostSignIn: true },
  native: { brokerUrl: 'https://broker.example.com', ownerId: 'owner-example', machineId: 'machine-example', cwd: '~/work', baseRef: 'main' },
})

function fakePairing(keys, prefs) {
  const calls = { claim: [], apply: [], receive: [], applyMove: [], offers: [] }
  const p = {
    calls,
    claimResult: null, // set per test: () => Promise<PairOutcome>
    receiveResult: null,
    offerResult: null,
    normalizePairCode(input) {
      const s = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
      return /^[0-9A-HJKMNP-TV-Z]{6}$/.test(s) ? s : null
    },
    formatPairCode: (c) => `${c.slice(0, 3)}-${c.slice(3)}`,
    parsePairQr(text) {
      const m = /^spriite-pair:([A-Z0-9]{6})#(.+)$/.exec(text)
      return m ? { code: m[1], secret: m[2] } : null
    },
    async claimPairing(code, opts) {
      calls.claim.push({ code, opts })
      return p.claimResult ? p.claimResult(opts) : { ok: true, bundle: BUNDLE() }
    },
    async applyPairingBundle(bundle, opts) {
      calls.apply.push({ bundle, opts })
      const applied = []
      if (bundle.factory.apiKey && await keys.setFactory(bundle.factory.apiKey)) applied.push('factory')
      if (bundle.github.token && await keys.setGithub(bundle.github.token)) applied.push('github')
      await prefs.setPairedHost({ label: bundle.host.label, machineId: bundle.host.machineId, ownerId: bundle.host.ownerId, brokerUrl: bundle.host.brokerUrl, via: bundle.host.via, os: bundle.host.os, pairedAt: Date.now() })
      await prefs.setRunOn(opts.runOn)
      await prefs.setSetupPath('paired')
      applied.push('pairedHost', 'runOn')
      return { ok: true, applied, failed: [] }
    },
    normalizeTransferCode(input) {
      const m = /^\s*([A-Za-z]+)[\s\-·.]*(\d{2})[\s\-·.]*([A-Za-z]+)\s*$/.exec(String(input))
      return m ? `${m[1].toUpperCase()}-${m[2]}-${m[3].toUpperCase()}` : null
    },
    formatTransferCode: (c) => c.split('-').join(' · '),
    parseTransferQr(text) {
      calls.parseTransfer = (calls.parseTransfer ?? 0) + 1
      const m = /^spriite:move\?c=([A-Z0-9-]+)&s=([^&]+)/.exec(text)
      return m ? { code: m[1], secret: decodeURIComponent(m[2]) } : null
    },
    async offerTransfer(opts) {
      calls.offers.push(opts)
      return p.offerResult ? p.offerResult() : { ok: false, reason: 'unreachable' }
    },
    async receiveTransfer(code, opts) {
      calls.receive.push({ code, opts })
      return p.receiveResult ? p.receiveResult() : { ok: false, reason: 'not_found' }
    },
    async applyMoveBundle(bundle) {
      calls.applyMove.push(bundle)
      for (const [k, v] of Object.entries(bundle.keys)) if (k === 'factory') await keys.setFactory(v)
      return { ok: true, applied: Object.keys(bundle.keys), failed: [] }
    },
    qrMatrix(text) {
      const n = 21
      return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => ((x * 7 + y * 3 + text.length) % 5) < 2))
    },
    hostXSignIn: { available: () => false, start: async () => ({ state: 'idle' }), status: async () => ({ state: 'idle' }) },
  }
  return p
}

const REPOS = () => [
  { fullName: 'your-org/shop-site', url: 'https://github.com/your-org/shop-site', private: true, pushedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
  { fullName: 'your-org/api', url: 'https://github.com/your-org/api', private: true, pushedAt: new Date(Date.now() - 3 * DAY).toISOString() },
  { fullName: 'your-org/docs', url: 'https://github.com/your-org/docs', private: false, pushedAt: new Date(Date.now() - 40 * DAY).toISOString() },
]

function harness(opts = {}) {
  const gw = memoryGateway()
  const keys = new KeyVault(gw)
  const prefs = new PrefsVault(gw)
  const pairing = fakePairing(keys, prefs)
  const log = { saved: 0, done: 0, extras: [], keyTests: [], githubCalls: [] }
  const root = globalThis.document.createElement('div')
  const deps = {
    keys, prefs, pairing,
    github: { repos: async (t) => { log.githubCalls.push(t); return opts.repos ? opts.repos() : REPOS() } },
    testFactoryKey: async (k) => {
      log.keyTests.push(k)
      return opts.keyOk === false ? { ok: false, message: 'Factory rejected the key' } : { ok: true }
    },
    context: opts.context,
    entry: opts.entry,
    onExtra: async (kind) => {
      log.extras.push(kind)
      if (kind === 'voice') await keys.setElevenLabs('el-test-key')
      if (kind === 'x' && opts.xNote) return opts.xNote
    },
    onSaved: () => { log.saved++ },
    onDone: () => { log.done++ },
    ...(opts.extraHealth ? { extraHealth: opts.extraHealth } : {}),
  }
  const handle = mountSetupFlow(root, deps)
  return { gw, keys, prefs, pairing, log, root, handle, deps }
}

const screenEl = (root) => walk(root).find((n) => hasClass(n, 'sf-screen'))
const textHas = (root, s) => textOf(root).includes(s)
const codeBoxes = (root) => byClass(root, 'sf-codebox')
const stepLabel = (root) => textOf(firstByClass(root, 'sf-steplabel'))
const stepsOn = (root) => byClass(root, 'sf-step').map((s) => hasClass(s, 'sf-step--on'))
const errorText = (root) => byClass(root, 'sf-error').filter((e) => !e.hidden).map(textOf).join(' ')

// ---------------------------------------------------------------- styles
section('board values in the sf- stylesheet (C1 tokens only)')
{
  const css = SETUP_CSS
  assert(css.includes('.sf-screen--welcome{padding:28px 22px 26px;gap:22px}'), 'Welcome padding 28/22/26, gap 22')
  assert(css.includes('.sf-screen--pair{padding:18px 22px 26px;gap:20px}'), 'Pair padding 18/22/26, gap 20')
  assert(css.includes('.sf-screen--paired,.sf-screen--repo{padding:18px 22px 26px;gap:18px}'), 'Paired and Repo padding 18/22/26, gap 18')
  assert(css.includes('.sf-screen--ready{padding:34px 22px 26px;gap:22px}'), 'Ready padding 34/22/26, gap 22')
  assert(css.includes('.sf-screen--move{padding:14px 22px 26px;gap:20px}'), 'Move padding 14/22/26, gap 20')
  assert(/\.sf-back\{[^}]*width:44px;height:44px/.test(css), 'back buttons are 44 px')
  assert(/\.sf-step\{flex:1;height:4px;border-radius:2px;background:var\(--sp-line/.test(css) && /\.sf-step--on\{background:var\(--sp-accent/.test(css), 'step bar: 4 px, radius 2, accent vs line')
  assert(/\.sf-primary\{[^}]*min-height:52px;border-radius:14px;[^}]*background:var\(--sp-accent/.test(css), 'primary buttons 52 px, radius 14, accent')
  assert(/\.sf-icontile\{width:40px;height:40px;flex:0 0 40px;border-radius:12px/.test(css), 'option icon tiles 40 px radius 12')
  assert(/\.sf-option\{[^}]*border-radius:16px;padding:16px/.test(css) && /\.sf-option--best\{background:var\(--sp-selected[^}]*border:1\.5px solid var\(--sp-accent/.test(css), 'option cards radius 16; Best card 1.5px accent on selected')
  assert(/\.sf-codecard\{[^}]*border-radius:18px;padding:18px/.test(css), 'code card radius 18, padding 18')
  assert(/\.sf-codebox\{width:42px;height:54px;[^}]*font:600 22px var\(--sp-font-mono[^}]*border:1px solid var\(--sp-line[^}]*border-radius:10px/.test(css), 'code boxes 42x54, mono 600 22, 1px line, radius 10')
  assert(/\.sf-codebox--filled\{border:1\.5px solid var\(--sp-accent/.test(css) && /\.sf-codebox--next\{border:1\.5px solid var\(--sp-muted/.test(css), 'filled box 1.5px accent, next empty 1.5px muted')
  assert(/\.sf-movecode\{font-family:var\(--sp-font-mono[^}]*font-size:26px;[^}]*letter-spacing:0\.08em/.test(css), 'transfer code 26px mono, letter-spacing .08em')
  assert(/\.sf-qr\{[^}]*width:200px;height:200px;border-radius:14px;background:var\(--sp-text/.test(css), 'QR tile 200 px on text colour, radius 14')
  assert(/\.sf-movecard\{[^}]*border-radius:20px;padding:22px/.test(css), 'Move card radius 20, padding 22')
  const stripped = css.replace(/var\(--sp-[a-z-]+, #[0-9A-Fa-f]{6}\)/g, '')
  assert(!/#[0-9A-Fa-f]{3,6}\b/.test(stripped), 'every colour is a C1 token (hex only as var() fallbacks)')
  const tokens = [...css.matchAll(/var\((--sp-[a-z-]+)/g)].map((m) => m[1])
  const allowed = new Set(['--sp-ground', '--sp-surface', '--sp-raised', '--sp-selected', '--sp-line', '--sp-line-strong', '--sp-text', '--sp-muted', '--sp-body-soft', '--sp-accent', '--sp-accent-hover', '--sp-accent-ink', '--sp-amber', '--sp-factory', '--sp-cursor', '--sp-danger', '--sp-placeholder', '--sp-radio-off', '--sp-dash', '--sp-font-display', '--sp-font-ui', '--sp-font-mono'])
  assert(tokens.length > 0 && tokens.every((t) => allowed.has(t)), 'only C1 variable names are used')
  const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
  assert(classes.every((c) => c.startsWith('sf-') || c === 'spr'), 'every class is sf- prefixed')
}

// ---------------------------------------------------------------- welcome
section('Welcome (Main.dc.html)')
{
  const h = harness()
  const W = COPY.welcome
  assert(h.handle.screen === 'welcome', 'first run opens on Welcome')
  for (const s of [W.brand, W.title, W.lead, W.pairTitle, W.pairBadge, W.pairDesc, W.keyTitle, W.keyDesc, W.moveTitle, W.moveDesc, W.lock]) {
    assert(textHas(h.root, s), `Welcome shows "${s}"`)
  }
  assert(W.title === 'Let’s get your glasses building.' && W.lock === 'Secrets are encrypted end to end. The relay never sees them.', 'Welcome copy is the board’s, curly apostrophe included')
  assert(hasClass(screenEl(h.root), 'sf-screen--welcome'), 'Welcome uses its board padding class')
  const circle = firstByClass(h.root, 'sf-circle--168')
  const spr = walk(circle).find((n) => n['aria-label'] === 'Spriite, idle')
  assert(Boolean(spr), 'idle sprite inside the 168 px circle')
  assert(spr?.style?.width === '128px', 'Welcome sprite is px 4 (128 px)')
  const best = firstByClass(h.root, 'sf-option--best')
  assert(textHas(best, W.pairTitle) && textHas(best, 'Best') && Boolean(firstByClass(best, 'sf-icontile--accent')), 'Pair card is the Best card with the accent icon tile')
  const icons = walk(h.root).filter((n) => n.tagName === 'SVG').map((n) => n['data-icon'])
  assert(['computer', 'key', 'phones', 'lock'].every((i) => icons.includes(i)), 'board icons: computer, key, two phones, lock')
  const keySvg = walk(h.root).find((n) => n['data-icon'] === 'key')
  assert(keySvg?.children?.[1]?.d === 'M11 12l9-9M17 6l3 3M15 8l2 2', 'key icon path copied from the board')

  const welcomeActions = walk(screenEl(h.root)).map((n) => n['data-action']).filter(Boolean)
  assert(welcomeActions.join(',') === 'pair,key_only,move', 'Welcome offers exactly pair, key only and move from another phone')
  click(byAction(h.root, 'pair'))
  assert(h.handle.screen === 'pair', 'Pair with my Factory computer opens Pair')
  h.handle.show('welcome')
  click(byAction(h.root, 'key_only'))
  assert(h.handle.screen === 'repo' && Boolean(walk(h.root).find((n) => n.id === 'fkey')), 'Use my Factory key only opens Repo with the key field')
  h.handle.show('welcome')
  click(byAction(h.root, 'move'))
  assert(h.handle.screen === 'move_receive', 'Move from another phone opens the move receiver')
  h.handle.destroy()
}

// ---------------------------------------------------------------- pair
section('Pair (Pair.dc.html): copy, step bar, command, code entry')
{
  const copied = []
  setNavigator({ clipboard: { writeText: async (t) => { copied.push(t) } } })
  const h = harness({ entry: 'pair' })
  const P = COPY.pair
  assert(stepLabel(h.root) === '1 of 3' && JSON.stringify(stepsOn(h.root)) === '[true,false,false]', 'step bar 1 of 3 (one accent segment)')
  for (const s of [P.title, P.lead, P.command, P.copy, P.noNode, P.installer, P.codeLabel, P.scan, P.listening, P.listeningSub, P.connect, P.keyOnly]) {
    assert(textHas(h.root, s), `Pair shows "${s}"`)
  }
  const link = byTag(h.root, 'a').find((a) => textOf(a) === P.installer)
  assert(link?.href === 'https://nodejs.org/en/download' && link?.target === '_blank', 'No Node? links to the official Node.js download page')
  const listen = firstByClass(h.root, 'sf-listen')
  assert(walk(listen).find((n) => n['aria-label'] === 'Spriite, listening')?.style?.width === '64px', 'listening sprite (px 2) beside the two lines')
  click(byAction(h.root, 'copy'))
  await flush()
  assert(copied[0] === 'npx spriite pair' && textHas(byAction(h.root, 'copy'), 'Copied'), 'Copy writes the command to the clipboard')

  const boxes = codeBoxes(h.root)
  assert(boxes.length === 6, 'six single-character boxes')
  const row = firstByClass(h.root, 'sf-coderow')
  assert(hasClass(row.children[3], 'sf-codedash'), 'the dash sits after the third box')
  assert(boxes.every((b, i) => b['aria-label'] === `Code character ${i + 1}`), 'boxes are labeled Code character 1-6')
  assert(hasClass(boxes[0], 'sf-codebox--next') && !hasClass(boxes[1], 'sf-codebox--next'), 'empty: the first box is the next (muted) one')

  typeInto(boxes[0], 'k')
  assert(boxes[0].value === 'K', 'typing uppercases')
  assert(hasClass(boxes[0], 'sf-codebox--filled') && hasClass(boxes[1], 'sf-codebox--next') && !hasClass(boxes[2], 'sf-codebox--filled') && !hasClass(boxes[2], 'sf-codebox--next'), 'filled = accent, next empty = muted, later empty = line')
  typeInto(boxes[1], '7')
  const bs = fire(boxes[2], 'keydown', { key: 'Backspace' })
  assert(boxes[1].value === '' && bs.defaultPrevented, 'backspace in an empty box clears the previous one')
  fire(boxes[0], 'paste', { clipboardData: { getData: () => 'k7q-2mf ' } })
  assert(boxes.map((b) => b.value).join('') === 'K7Q2MF', 'pasting "k7q-2mf " spreads K7Q2MF across the boxes')
  for (const b of boxes) b.value = ''
  typeInto(boxes[0], 'K7Q2MF')
  assert(boxes.map((b) => b.value).join('') === 'K7Q2MF', 'an autofilled whole code in the first box spreads too')
  for (const b of boxes) b.value = ''
  typeInto(boxes[0], 'ko')
  assert(boxes[0].value === 'K' && boxes[1].value === 'O', 'two quick characters land in two boxes')

  for (const b of boxes) b.value = ''
  fire(boxes[0], 'input')
  click(byAction(h.root, 'connect'))
  await flush()
  assert(errorText(h.root) === P.incomplete && h.pairing.calls.claim.length === 0, 'Connect with an incomplete code asks for all six')

  const scan = byAction(h.root, 'scan')
  click(scan)
  assert(visibleText(h.root).includes(P.scanUnavailable), 'no BarcodeDetector: an inline note says to type the code')

  click(byAction(h.root, 'key_only'))
  assert(h.handle.screen === 'repo' && Boolean(walk(h.root).find((n) => n.id === 'fkey')), 'I only have a Factory key opens Repo key-only')
  h.handle.destroy()
}

section('Pair: Connect, busy state, Abort on back, every failure')
{
  const h = harness({ entry: 'pair' })
  const d = deferred()
  h.pairing.claimResult = () => d.promise
  fire(codeBoxes(h.root)[0], 'paste', { clipboardData: { getData: () => 'K7Q-2MF' } })
  click(byAction(h.root, 'connect'))
  await flush()
  const btn = byAction(h.root, 'connect')
  assert(h.pairing.calls.claim[0]?.code === 'K7Q2MF', 'Connect claims the normalized code through the client')
  assert(btn.disabled === true && textOf(btn) === COPY.pair.connecting && btn['aria-busy'] === 'true', 'busy while the claim is pending')
  const signal = h.pairing.calls.claim[0].opts.signal
  click(walk(h.root).find((n) => n['aria-label'] === 'Back'))
  assert(signal.aborted === true, 'Back aborts the pending claim')
  assert(h.handle.screen === 'welcome', 'Back from Pair returns to Welcome')
  d.resolve({ ok: false, reason: 'cancelled' })
  await flush()
  assert(h.handle.screen === 'welcome', 'a claim that settles after Back changes nothing')
  h.handle.destroy()

  for (const reason of Object.keys(PAIR_FAILURE)) {
    const f = harness({ entry: 'pair' })
    f.pairing.claimResult = async () => ({ ok: false, reason })
    fire(codeBoxes(f.root)[0], 'paste', { clipboardData: { getData: () => 'K7Q2MF' } })
    click(byAction(f.root, 'connect'))
    await flush()
    const err = byClass(f.root, 'sf-error').find((e) => !e.hidden)
    const card = firstByClass(f.root, 'sf-codecard')
    const idxRow = card.children.indexOf(firstByClass(card, 'sf-coderow'))
    assert(f.handle.screen === 'pair' && textOf(err) === PAIR_FAILURE[reason] && card.children.indexOf(err) === idxRow + 1,
      `${reason}: "${PAIR_FAILURE[reason]}" in danger under the code`)
    assert(byAction(f.root, 'connect').disabled === false, `${reason}: Connect is usable again`)
    f.handle.destroy()
  }
}

section('Pair: scanning a QR passes its secret')
{
  const prevBD = globalThis.BarcodeDetector
  globalThis.BarcodeDetector = class { async detect() { return [{ rawValue: 'spriite-pair:K7Q2MF#qr-secret-1' }] } }
  const stopped = []
  setNavigator({ mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push(1) }] }) } })
  const h = harness({ entry: 'pair' })
  click(byAction(h.root, 'scan'))
  await flush(12)
  assert(h.pairing.calls.claim[0]?.code === 'K7Q2MF' && h.pairing.calls.claim[0]?.opts.qrSecret === 'qr-secret-1', 'the scanned code claims with parsePairQr(...).secret as qrSecret')
  assert(stopped.length === 1, 'the camera stops after a read')
  assert(h.handle.screen === 'paired', 'a scanned pairing lands on Paired')
  h.handle.destroy()
  globalThis.BarcodeDetector = prevBD
  setNavigator({})
}

// ---------------------------------------------------------------- paired
section('Paired (Paired.dc.html): review rows and where builds run')
{
  const h = harness({ entry: 'pair' })
  fire(codeBoxes(h.root)[0], 'paste', { clipboardData: { getData: () => 'K7Q2MF' } })
  click(byAction(h.root, 'connect'))
  await flush()
  const P = COPY.paired
  assert(h.handle.screen === 'paired', 'a successful claim opens Paired')
  assert(stepLabel(h.root) === '2 of 3' && JSON.stringify(stepsOn(h.root)) === '[true,true,false]', 'step bar 2 of 3')
  assert(textHas(h.root, 'Paired with “studio”') && textHas(h.root, P.sub), 'heading "Paired with “studio”" and the sub line')
  assert(walk(firstByClass(h.root, 'sf-circle--72')).find((n) => n['aria-label'] === 'Spriite, celebrate')?.style?.width === '64px', 'celebrate sprite (px 2) in the 72 px circle')
  const rows = byClass(h.root, 'sf-review-row').map((r) => ({
    mono: textOf(firstByClass(r, 'sf-mono-tile')),
    tint: firstByClass(r, 'sf-mono-tile').className.split(' ').find((c) => c.startsWith('sf-tint--')),
    name: textOf(firstByClass(r, 'sf-row-name')),
    detail: textOf(firstByClass(r, 'sf-row-detail')),
    right: textOf(firstByClass(r, 'sf-found') ?? firstByClass(r, 'sf-later')),
  }))
  const want = [
    ['F', 'sf-tint--factory', 'Factory account', 'Signed in on studio', 'Found'],
    ['D', 'sf-tint--factory', 'Droid computer', 'studio · online', 'Found'],
    ['S', 'sf-tint--accent', 'Spriite host', 'Private link over Tailscale', 'Found'],
    ['G', 'sf-tint--text', 'GitHub', 'From the GitHub CLI · 12 repos', 'Found'],
    ['V', 'sf-tint--amber', 'Voice replies', 'No ElevenLabs key found', 'Later'],
    ['X', 'sf-tint--text', 'X requests', 'Connect from your computer later', 'Later'],
  ]
  assert(rows.length === 6, 'six review rows')
  want.forEach((w, i) => {
    const r = rows[i] ?? {}
    assert(r.mono === w[0] && r.tint === w[1] && r.name === w[2] && r.detail === w[3] && r.right === w[4], `row ${w[0]}: ${w[2]} — ${w[3]} — ${w[4]}`)
  })
  const opts = walk(h.root).filter((n) => n.role === 'radio')
  assert(textOf(opts[0]) === 'On “studio”Your machine, your tools' && textOf(opts[1]) === 'Factory cloudRuns while studio is off', 'run-on cards: On “studio” / Factory cloud')
  assert(opts[0]['aria-checked'] === 'true' && opts[1]['aria-checked'] === 'false', 'a found computer defaults builds to the host')
  assert(textHas(h.root, P.footnote) && textHas(h.root, P.runTitle), 'Where should builds run? and the footnote, verbatim')
  click(opts[1])
  assert(opts[1]['aria-checked'] === 'true' && opts[0]['aria-checked'] === 'false', 'tapping Factory cloud selects it')
  const savedBefore = h.log.saved
  click(byAction(h.root, 'confirm'))
  await flush()
  assert(h.pairing.calls.apply.length === 1 && h.pairing.calls.apply[0].opts.runOn === 'cloud' && h.pairing.calls.apply[0].bundle.host.label === 'studio', 'Looks right applies the bundle with the chosen runOn')
  assert(h.log.saved > savedBefore, 'Looks right calls onSaved')
  assert(h.handle.screen === 'repo', 'first run continues to Repo')
  assert(h.keys.factory === 'fk-test-paired-0001' && h.prefs.runOn === 'cloud', 'the bundle landed in the vaults')
  h.handle.destroy()
}

section('Paired: missing items are Later with honest details; no computer defaults to cloud')
{
  const h = harness({ entry: 'pair' })
  h.pairing.claimResult = async () => ({ ok: true, bundle: BUNDLE({ factory: { computerId: null, computerName: null, computerOnline: false }, host: { via: 'https' }, github: { token: null, repoCount: null }, voice: { elevenLabsKey: 'el-1' } }) })
  fire(codeBoxes(h.root)[0], 'paste', { clipboardData: { getData: () => 'K7Q2MF' } })
  click(byAction(h.root, 'connect'))
  await flush()
  const rows = byClass(h.root, 'sf-review-row')
  const detail = (i) => textOf(firstByClass(rows[i], 'sf-row-detail'))
  const right = (i) => textOf(firstByClass(rows[i], 'sf-found') ?? firstByClass(rows[i], 'sf-later'))
  assert(detail(1) === 'No Droid computer found' && right(1) === 'Later', 'no computer: Droid computer is Later')
  assert(detail(2) === 'Private link over HTTPS', 'an HTTPS host link reads "Private link over HTTPS"')
  assert(detail(3) === 'No GitHub CLI login found' && right(3) === 'Later', 'no GitHub token: GitHub is Later')
  assert(right(4) === 'Found', 'an ElevenLabs key from the host is Found')
  const opts = walk(h.root).filter((n) => n.role === 'radio')
  assert(opts[1]['aria-checked'] === 'true', 'no computer: builds default to Factory cloud')
  h.handle.destroy()
}

section('Settings context: Pair › Paired › done (no Repo, no Ready)')
{
  const h = harness({ context: 'settings' })
  assert(h.handle.screen === 'pair', 'settings context opens on Pair')
  fire(codeBoxes(h.root)[0], 'paste', { clipboardData: { getData: () => 'K7Q2MF' } })
  click(byAction(h.root, 'connect'))
  await flush()
  click(byAction(h.root, 'confirm'))
  await flush()
  assert(h.log.done === 1 && h.pairing.calls.apply.length === 1, 'Looks right ends the settings flow with onDone')
  assert(h.prefs.setupCompletedAt === 0, 'pairing from Settings does not stamp setup completion')
  h.handle.destroy()
  const b = harness({ context: 'settings' })
  click(walk(b.root).find((n) => n['aria-label'] === 'Back'))
  assert(b.log.done === 1, 'Back from Pair in settings returns to Settings (onDone)')
  b.handle.destroy()
}

// ---------------------------------------------------------------- repo
async function toRepoPaired(opts) {
  const h = harness({ entry: 'pair', ...opts })
  fire(codeBoxes(h.root)[0], 'paste', { clipboardData: { getData: () => 'K7Q2MF' } })
  click(byAction(h.root, 'connect'))
  await flush()
  click(byAction(h.root, 'confirm'))
  await flush()
  return h
}

section('Repo (Repo.dc.html, paired variant)')
{
  const h = await toRepoPaired()
  const R = COPY.repo
  assert(h.handle.screen === 'repo' && stepLabel(h.root) === '3 of 3' && JSON.stringify(stepsOn(h.root)) === '[true,true,true]', 'step bar 3 of 3')
  assert(!walk(h.root).find((n) => n.id === 'fkey'), 'paired variant has no Factory key field')
  for (const s of [R.title, R.lead, R.perIdea, R.perIdeaDesc, R.one, R.oneDesc, R.searchLabel, R.finish]) assert(textHas(h.root, s), `Repo shows "${s}"`)
  const search = walk(h.root).find((n) => n.id === 'sf-repoSearch')
  assert(search?.placeholder === 'Search, or paste github.com/…', 'search placeholder verbatim')
  assert(Boolean(walk(firstByClass(h.root, 'sf-search-wrap')).find((n) => n['data-icon'] === 'search')), 'search icon in the field')
  const radios = byClass(h.root, 'sf-radio')
  assert(radios[0]['aria-checked'] === 'true' && radios[1]['aria-checked'] === 'false', 'default is "A new private repo for each idea"')
  await flush()
  assert(h.log.githubCalls[0] === 'gh-test-token', 'the repo list uses the GitHub token from the vault')
  const rowText = byClass(h.root, 'sf-repo-row').map((r) => `${textOf(firstByClass(r, 'sf-repo-name'))}|${textOf(firstByClass(r, 'sf-repo-meta'))}`)
  assert(JSON.stringify(rowText) === JSON.stringify(['your-org/shop-site|Private · updated today', 'your-org/api|Private · updated this week', 'your-org/docs|Public · updated last month']), 'rows: owner/name with "Private · updated today" meta')
  typeInto(search, 'API')
  assert(byClass(h.root, 'sf-repo-row').length === 1 && textHas(h.root, 'your-org/api'), 'search filters the list (case-insensitive)')
  typeInto(search, '')
  click(byClass(h.root, 'sf-repo-row')[2])
  assert(radios[1]['aria-checked'] === 'true' && radios[0]['aria-checked'] === 'false', 'choosing a row switches to "One repo I choose"')
  assert(byClass(h.root, 'sf-repo-row')[2]['aria-pressed'] === 'true', 'the chosen row is marked')
  assert(byAction(h.root, 'finish').disabled === false, 'Finish setup is enabled (the step is never blocked)')
  const savedBefore = h.log.saved
  const t0 = Date.now()
  click(byAction(h.root, 'finish'))
  await flush()
  assert(h.keys.repoMode === 'one' && h.keys.repoUrl === 'https://github.com/your-org/docs', 'Finish saves mode "one" and the chosen repo')
  assert(h.prefs.setupCompletedAt >= t0, 'Finish setup writes setupCompletedAt')
  assert(isSetupComplete(h.keys, h.prefs), 'isSetupComplete is true after Finish')
  assert(h.log.saved > savedBefore && h.handle.screen === 'ready', 'Finish calls onSaved and shows Ready')
  h.handle.destroy()
}

section('Repo: the default per-idea finish')
{
  const h = await toRepoPaired()
  click(byAction(h.root, 'finish'))
  await flush()
  assert(h.keys.repoMode === 'per_idea' && h.keys.repoUrl === '', 'per-idea: repoMode per_idea, no repo stored')
  assert(h.handle.screen === 'ready' && h.prefs.setupCompletedAt > 0, 'per-idea finish completes setup')
  h.handle.destroy()
}

section('Repo: pasted GitHub URLs work with no GitHub or Cursor key')
{
  for (const [input, want] of [
    ['github.com/your-org/shop-site', 'https://github.com/your-org/shop-site'],
    ['https://github.com/your-org/shop-site.git', 'https://github.com/your-org/shop-site'],
    ['https://www.github.com/your-org/shop-site/', 'https://github.com/your-org/shop-site'],
    ['http://github.com/your-org/shop-site/tree/main', 'https://github.com/your-org/shop-site'],
    ['git@github.com:your-org/shop-site.git', 'https://github.com/your-org/shop-site'],
    ['your-org/shop-site', null],
    ['https://gitlab.com/your-org/shop-site', null],
  ]) assert(parseGithubUrl(input) === want, `parseGithubUrl("${input}") -> ${want}`)
  assert(repoMeta({ private: true, pushedAt: new Date(Date.now() - 100 * DAY).toISOString() }, Date.now()) === 'Private · updated 3 months ago', 'older pushes read "N months ago"')

  const h = harness({ entry: 'key_only' })
  assert(h.keys.github === '' && h.keys.cursor === '', 'no GitHub or Cursor key in this vault')
  assert(byClass(h.root, 'sf-list').every((l) => l.hidden), 'no token and nothing typed: no list')
  const search = walk(h.root).find((n) => n.id === 'sf-repoSearch')
  typeInto(search, 'github.com/your-org/shop-site.git/')
  const rows = byClass(h.root, 'sf-repo-row')
  assert(rows.length === 1 && textOf(firstByClass(rows[0], 'sf-repo-name')) === 'your-org/shop-site', 'a pasted link yields a selectable row')
  assert(rows[0]['aria-pressed'] === 'true' && byClass(h.root, 'sf-radio')[1]['aria-checked'] === 'true' &&
    rows[0].children.some((c) => c['data-icon'] === 'check'),
  'a valid pasted link selects itself: "One repo I choose" with the row’s accent check, no extra tap')
  typeInto(walk(h.root).find((n) => n.id === 'fkey'), 'fk-test-key-only')
  click(byAction(h.root, 'finish'))
  await flush()
  assert(h.keys.repoUrl === 'https://github.com/your-org/shop-site' && h.keys.repoMode === 'one', 'the pasted repo is saved without any GitHub call')
  assert(h.log.githubCalls.length === 0, 'GitHub was never called')
  h.handle.destroy()
}

section('Repo: "One repo I choose" with no repo does not finish silently')
{
  const h = await toRepoPaired()
  click(byClass(h.root, 'sf-radio')[1])
  click(byAction(h.root, 'finish'))
  await flush()
  assert(h.handle.screen === 'repo' && h.prefs.setupCompletedAt === 0, 'Finish with mode "one" and no repo stays on Repo and saves nothing')
  assert(errorText(h.root) === COPY.repo.pickRepo, 'it says to pick a repo or paste a link')
  const search = walk(h.root).find((n) => n.id === 'sf-repoSearch')
  typeInto(search, 'https://github.com/example-org/sample-app')
  assert(errorText(h.root) === '', 'a pasted link clears the message')
  click(byAction(h.root, 'finish'))
  await flush()
  assert(h.keys.repoMode === 'one' && h.keys.repoUrl === 'https://github.com/example-org/sample-app' && h.handle.screen === 'ready',
    'Finish then saves the pasted repo')
  h.handle.destroy()
}

section('Repo (key-only variant): Factory key, cloud builds, failure stays')
{
  const R = COPY.repo
  const pasted = []
  setNavigator({ clipboard: { readText: async () => { pasted.push(1); return '  fk-from-clipboard  ' } } })
  const h = harness({ entry: 'key_only', keyOk: false })
  const key = walk(h.root).find((n) => n.id === 'fkey')
  assert(key?.type === 'password' && key?.placeholder === 'fk-…', 'password field with placeholder "fk-…"')
  for (const s of [R.keyLabel, R.paste, R.keyLink]) assert(textHas(h.root, s), `key-only shows "${s}"`)
  const link = byTag(h.root, 'a').find((a) => textOf(a) === R.keyLink)
  assert(link?.href === 'https://app.factory.ai/settings/api-keys', 'key link opens Factory API keys')
  assert(stepLabel(h.root) === '3 of 3', 'key-only is still step 3 of 3')
  assert(byAction(h.root, 'finish').disabled === true, 'Finish setup is disabled only while the key is empty')
  click(byAction(h.root, 'paste'))
  await flush()
  assert(key.value === 'fk-from-clipboard' && byAction(h.root, 'finish').disabled === false, 'Paste reads the clipboard into the key field')
  click(byAction(h.root, 'finish'))
  await flush()
  assert(h.log.keyTests[0] === 'fk-from-clipboard', 'Finish tests the key first')
  assert(errorText(h.root) === 'Factory rejected the key' && h.handle.screen === 'repo', 'a rejected key shows the inline danger message and stays')
  assert(h.keys.factory === '' && h.prefs.setupCompletedAt === 0, 'a rejected key saves nothing and does not complete setup')
  h.handle.destroy()

  const ok = harness({ entry: 'key_only' })
  typeInto(walk(ok.root).find((n) => n.id === 'fkey'), ' fk-good-key ')
  click(byAction(ok.root, 'finish'))
  await flush()
  assert(ok.keys.factory === 'fk-good-key', 'key-only success stores the Factory key')
  assert(ok.prefs.runOn === 'cloud' && ok.prefs.setupPath === 'key_only', 'key-only sets builds to Factory cloud and setupPath key_only')
  assert(ok.keys.repoMode === 'per_idea' && ok.prefs.setupCompletedAt > 0 && ok.handle.screen === 'ready', 'key-only finish completes setup and shows Ready')
  ok.handle.destroy()
  setNavigator({})
}

// ---------------------------------------------------------------- ready
section('Ready (Ready.dc.html): copy, extras, Open Spriite')
{
  const h = await toRepoPaired()
  click(byAction(h.root, 'finish'))
  await flush()
  const R = COPY.ready
  for (const s of [R.title, R.lead, R.extras, R.voice, R.voiceDesc, R.x, R.cursor, R.cursorDesc, R.open]) assert(textHas(h.root, s), `Ready shows "${s}"`)
  assert(textHas(h.root, 'Tag your Spriite account. Sign-in opens on studio.'), 'X extra names the paired host')
  assert(walk(firstByClass(h.root, 'sf-circle--176')).find((n) => n['aria-label'] === 'Spriite, celebrate')?.style?.width === '128px', 'celebrate sprite (px 4) in the 176 px circle')
  const ctas = byClass(h.root, 'sf-extra-cta').map((b) => `${b['data-extra']}:${textOf(b)}`)
  assert(JSON.stringify(ctas) === JSON.stringify(['voice:Add key', 'x:Connect', 'cursor:Add key']), 'CTAs Add key / Connect / Add key')
  click(byClass(h.root, 'sf-extra-cta')[1])
  click(byClass(h.root, 'sf-extra-cta')[2])
  click(byClass(h.root, 'sf-extra-cta')[0])
  await flush()
  assert(JSON.stringify(h.log.extras) === JSON.stringify(['x', 'cursor', 'voice']), 'each CTA calls onExtra with its kind')
  const voice = walk(h.root).find((n) => n['data-extra'] === 'voice')
  assert(hasClass(voice, 'sf-found') && textOf(voice) === R.added, 'a configured extra reads "Added" on return')
  click(byAction(h.root, 'open'))
  assert(h.log.done === 1, 'Open Spriite calls onDone')
  h.handle.destroy()
  const k = harness({ entry: 'key_only' })
  typeInto(walk(k.root).find((n) => n.id === 'fkey'), 'fk-x')
  click(byAction(k.root, 'finish'))
  await flush()
  assert(textHas(k.root, 'Sign-in opens on your computer.'), 'with no paired host the X extra says "your computer"')
  k.handle.destroy()
  const xs = harness({ entry: 'key_only', xNote: { text: 'X sign-in did not finish (denied).', tone: 'err' } })
  typeInto(walk(xs.root).find((n) => n.id === 'fkey'), 'fk-x')
  click(byAction(xs.root, 'finish'))
  await flush()
  click(walk(xs.root).find((n) => n['data-extra'] === 'x'))
  await flush()
  assert(xs.handle.screen === 'ready' && errorText(xs.root) === 'X sign-in did not finish (denied).', 'the X outcome shows on the Ready screen')
  xs.handle.destroy()
}

// ---------------------------------------------------------------- move sender
section('Move sender (Move.dc.html): code, QR, countdown, what moves')
{
  assert(countdown(582_000) === '9:42' && countdown(600_000) === '10:00' && countdown(0) === '0:00', 'countdown m:ss')
  const gw = memoryGateway()
  const keys = new KeyVault(gw)
  const prefs = new PrefsVault(gw)
  const pairing = fakePairing(keys, prefs)
  let cancelled = 0
  const done = deferred()
  pairing.offerResult = () => ({ ok: true, offer: { code: 'WREN-41-OAK', display: 'WREN · 41 · OAK', qrText: 'spriite-move:WREN-41-OAK#s', expiresAt: Date.now() + 582_000, done: done.promise, cancel: () => { cancelled++ } } })
  const root = globalThis.document.createElement('div')
  let backs = 0
  const m = mountMoveScreen(root, { pairing, hostLabel: () => 'studio', onBack: () => { backs++ } })
  await flush()
  const C = COPY.move
  for (const s of [C.title, C.lead, C.or, C.whatMoves, 'Every key and the link to studio', C.moveDefaults, C.moveHistory, C.lock]) assert(textHas(root, s), `Move shows "${s}"`)
  assert(C.lead === 'On the new phone, open Spriite and choose “Move from another phone”.', 'Move lead verbatim')
  assert(textOf(firstByClass(root, 'sf-movecode')) === 'WREN · 41 · OAK', 'the code shows as "WREN · 41 · OAK"')
  assert(textOf(firstByClass(root, 'sf-expiry')) === 'Works once · expires in 9:42', 'amber "Works once · expires in 9:42"')
  const qr = firstByClass(root, 'sf-qr')
  const svg = walk(qr).find((n) => n.tagName === 'SVG')
  assert(Boolean(svg) && svg.viewBox === '0 0 21 21' && /^M\d+ \d+h1v1h-1z/.test(svg.children[0].d), 'QR drawn from pairing.qrMatrix as an SVG')
  assert(!textHas(root, '[QR CODE]'), 'no QR placeholder text')
  assert(walk(root).filter((n) => n['data-icon'] === 'check').length === 3, 'three check icons in What moves')
  click(walk(root).find((n) => n['aria-label'] === 'Back to settings'))
  assert(backs === 1, 'back calls onBack')
  done.resolve({ ok: true })
  await flush()
  assert(textOf(firstByClass(root, 'sf-expiry')) === C.moved, 'a finished move says so')
  m.destroy()
  assert(cancelled === 0, 'destroy after a finished move cancels nothing')

  const live = deferred()
  let cancelled2 = 0
  pairing.offerResult = () => ({ ok: true, offer: { code: 'WREN-41-OAK', display: 'WREN · 41 · OAK', qrText: 'q', expiresAt: Date.now() + 60_000, done: live.promise, cancel: () => { cancelled2++ } } })
  const root2 = globalThis.document.createElement('div')
  const m2 = mountMoveScreen(root2, { pairing, hostLabel: () => null, onBack: () => {} })
  await flush()
  assert(textHas(root2, 'Every key and the link to your computer'), 'no paired host: "the link to your computer"')
  m2.destroy()
  assert(cancelled2 === 1, 'destroy cancels the live offer')

  let cancelled3 = 0
  pairing.offerResult = () => ({ ok: true, offer: { code: 'WREN-41-OAK', display: 'WREN · 41 · OAK', qrText: 'q', expiresAt: Date.now() + 900, done: new Promise(() => {}), cancel: () => { cancelled3++ } } })
  const root3 = globalThis.document.createElement('div')
  const m3 = mountMoveScreen(root3, { pairing, hostLabel: () => 'studio', onBack: () => {} })
  await flush()
  assert(textOf(firstByClass(root3, 'sf-expiry')) === 'Works once · expires in 0:01', 'the countdown is live')
  await new Promise((r) => setTimeout(r, 1300))
  assert(textOf(firstByClass(root3, 'sf-expiry')) === C.expired && cancelled3 === 1, 'at zero the code expires and the offer is cancelled')
  const retry = byText(root3, C.newCode)
  assert(retry && !retry.hidden, 'an expired code offers "Make a new code"')
  m3.destroy()

  pairing.offerResult = () => ({ ok: false, reason: 'unreachable' })
  const root4 = globalThis.document.createElement('div')
  const m4 = mountMoveScreen(root4, { pairing, hostLabel: () => 'studio', onBack: () => {} })
  await flush()
  assert(textOf(firstByClass(root4, 'sf-expiry')) === TRANSFER_FAILURE.unreachable, 'a failed offer says why')
  m4.destroy()
}

// ---------------------------------------------------------------- move receiver
section('Move receiver (undrawn, composed from Pair)')
{
  const h = harness()
  click(byAction(h.root, 'move'))
  const R = COPY.receive
  assert(h.handle.screen === 'move_receive' && textHas(h.root, R.title) && textHas(h.root, R.codeLabel), 'receiver uses the Pair layout')
  const boxes = codeBoxes(h.root)
  assert(boxes.length === 3 && byClass(h.root, 'sf-codedash').length === 2, 'three-part code entry WORD-NN-WORD')
  fire(boxes[0], 'paste', { clipboardData: { getData: () => 'wren 41 oak' } })
  assert(boxes.map((b) => b.value).join('-') === 'WREN-41-OAK', 'pasting "wren 41 oak" fills the three parts')
  h.pairing.receiveResult = async () => ({ ok: false, reason: 'expired' })
  click(byAction(h.root, 'connect'))
  await flush()
  assert(errorText(h.root) === TRANSFER_FAILURE.expired && h.handle.screen === 'move_receive', 'a failed receive shows its message')
  const bundle = { v: 1, kind: 'move', createdAt: Date.now(), keys: { factory: 'fk-moved' }, prefs: {}, feed: [], history: null, summary: { hostLabel: 'studio', buildCount: 2, keyCount: 1 } }
  h.pairing.receiveResult = async () => ({ ok: true, bundle })
  click(byAction(h.root, 'connect'))
  await flush()
  assert(h.pairing.calls.receive.at(-1).code === 'WREN-41-OAK', 'receiveTransfer gets the normalized code')
  assert(h.pairing.calls.applyMove[0] === bundle && h.keys.factory === 'fk-moved', 'applyMoveBundle applies what came over')
  assert(h.prefs.setupPath === 'moved' && h.prefs.setupCompletedAt > 0, 'a move marks setupPath moved and completes setup')
  assert(h.handle.screen === 'ready' && h.log.saved > 0, 'then Ready, with onSaved')
  h.handle.destroy()
}

section('Move receiver: a scanned transfer QR passes code and secret')
{
  const prevBD = globalThis.BarcodeDetector
  globalThis.BarcodeDetector = class { async detect() { return [{ rawValue: 'spriite:move?c=WREN-41-OAK&s=qr-move-secret&r=https%3A%2F%2Frelay.example.com' }] } }
  setNavigator({ mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
  const h = harness({ entry: 'move_receive' })
  h.pairing.receiveResult = async () => ({ ok: false, reason: 'used' })
  click(byAction(h.root, 'scan'))
  await flush(12)
  const call = h.pairing.calls.receive[0]
  assert(call?.code === 'WREN-41-OAK' && call?.opts.qrSecret === 'qr-move-secret', 'the scanned transfer QR claims with its code and secret')
  assert((h.pairing.calls.parseTransfer ?? 0) > 0, 'the Move receiver reads the scanned QR with the pairing client\u2019s parseTransferQr')
  assert(errorText(h.root) === TRANSFER_FAILURE.used, 'a used transfer code says so')
  h.handle.destroy()
  globalThis.BarcodeDetector = prevBD
  setNavigator({})
}

// ---------------------------------------------------------------- chooser
section('mountRepoChooser (Settings)')
{
  const gw = memoryGateway()
  const keys = new KeyVault(gw)
  const prefs = new PrefsVault(gw)
  await keys.setGithub('gh-chooser')
  const root = globalThis.document.createElement('div')
  const seen = []
  let saved = 0
  const c = mountRepoChooser(root, { keys, prefs, github: { repos: async () => REPOS() }, onSaved: () => { saved++ }, onChange: (m, u) => seen.push([m, u]) })
  await flush()
  const radios = byClass(root, 'sf-radio')
  assert(radios.length === 2 && byClass(root, 'sf-repo-row').length === 3, 'chooser shows the radio group, search and list')
  click(byClass(root, 'sf-repo-row')[0])
  await flush()
  assert(keys.repoMode === 'one' && keys.repoUrl === 'https://github.com/your-org/shop-site' && saved === 1, 'choosing a repo saves at once')
  click(radios[0])
  await flush()
  assert(keys.repoMode === 'per_idea' && saved === 2 && seen.at(-1)[0] === 'per_idea', 'switching to per idea saves the mode')
  c.refresh()
  await flush()
  assert(byClass(root, 'sf-radio')[0]['aria-checked'] === 'true', 'refresh re-reads the vault')
  c.destroy()
}

section('redesign test round 1: setup findings')
{
  // (ready-added-rejected) A key the service rejected is not "Added".
  const k = harness({ entry: 'key_only', extraHealth: (kind) => (kind === 'cursor' ? 'failed' : 'saved') })
  await k.keys.setCursor('key_qa_fake_000')
  typeInto(walk(k.root).find((n) => n.id === 'fkey'), 'fk-x')
  click(byAction(k.root, 'finish'))
  await flush()
  const cursor = walk(k.root).find((n) => n['data-extra'] === 'cursor')
  assert(cursor && hasClass(cursor, 'sf-extra-cta') && textOf(cursor) === COPY.ready.checkKey, 'a rejected Cursor key offers Check key, not Added')
  k.handle.destroy()
  // (repo-one-no-repo-settings) One repo with no repo is not saved; an edited-away link clears its selection.
  const gw = memoryGateway()
  const keys = new KeyVault(gw)
  const prefs = new PrefsVault(gw)
  await keys.setRepoMode('per_idea')
  const root = globalThis.document.createElement('div')
  const seen = []
  const c = mountRepoChooser(root, { keys, prefs, github: { repos: async () => [] }, onSaved: () => {}, onChange: (m, u) => seen.push([m, u]) })
  await flush()
  click(byClass(root, 'sf-radio')[1])
  await flush()
  assert(keys.repoMode === 'per_idea' && errorText(root) === COPY.repo.pickRepo, 'One repo I choose with no repo is not saved and says why')
  const search = walk(root).find((n) => n.tagName === 'INPUT')
  typeInto(search, 'https://github.com/acme/widgets')
  await flush()
  assert(keys.repoMode === 'one' && keys.repoUrl === 'https://github.com/acme/widgets' && errorText(root) === '', 'a pasted GitHub link chooses itself')
  typeInto(search, 'https://gitlab.com/acme/widgets')
  await flush()
  assert(errorText(root) === COPY.repo.pickRepo, 'editing the link away drops its selection (no hidden stale repo)')
  c.destroy()
  assert(/\.sf-movecode\{[^}]*white-space:nowrap/.test(SETUP_CSS), 'the move code never wraps')
  assert(/\.sf-codebox\{width:42px;height:54px;flex:0 1 42px;min-width:0/.test(SETUP_CSS), 'pair code boxes shrink inside the card on narrow phones')
  assert(/\.sf-screen \.sf-hint a,\.sf-screen a\.sf-keylink\{text-decoration:underline\}/.test(SETUP_CSS), 'setup links keep the boards\' underline')
}

console.log(failures === 0 ? '\nAll setup flow checks passed.' : `\n${failures} setup flow check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
