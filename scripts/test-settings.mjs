/**
 * Session settings tests (the settings plan, phase 2): the Factory create
 * body, the preferences that carry the lead/worker/advanced choices, the
 * freeze that keeps a running build on the settings it started with, and the
 * setup panel's controls.
 *
 * The Mission probe's recorded calls (scripts/fixtures/factory-session-probe.json)
 * are pinned here too: Factory accepts interactionMode and never reports
 * settings back, so Spriite has to remember what it sent (probe findings 1
 * and 2 in docs/MISSION-PROBE-FINDINGS.md).
 *
 * Usage: npm run test:settings
 */
import { readFileSync } from 'node:fs'
import { INTERACTION_MODES, PrefsVault, parseToolList } from '../src/state/prefs.ts'
import * as fapi from '../src/factory/fapi.ts'
import { parseUtterance } from '../src/voice/intent.ts'
import { mountSetupPanel } from '../src/setup/panel.ts'
import { mountPhoneApp } from '../src/phone/app.ts'
import { IdleEngine } from './lib/idle-engine.mjs'
import { RealOrchestrator } from '../src/factory/real.ts'
import { FeedVault } from '../src/state/feed.ts'
import { KeyVault } from '../src/voice/keys.ts'
import {
  TestKV,
  makeClients,
  makeRuntime,
  makeTally,
  SETTINGS,
  cmd,
  mission,
  snapshotOf,
  drive,
} from './lib/runtime-fake.mjs'
import { phoneDom, makeElement, textOf, phoneFakes } from './lib/phone-dom.mjs'

const { assert, failures } = makeTally()
const section = (name) => console.log(`\n-- ${name}`)
console.log('== Session settings tests (settings plan, phase 2) ==')

/** Structural compare that ignores key order but keeps array order. */
function norm(v) {
  if (Array.isArray(v)) return v.map(norm)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
  }
  return v
}
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b))

const PROBE = JSON.parse(readFileSync(new URL('./fixtures/factory-session-probe.json', import.meta.url), 'utf8'))
const PREFS_KEY = 'spriite.prefs.v1'

section('saved settings survive a legacy cold boot without a panel save')
{
  const prefs = new PrefsVault(gateway(new Map([[PREFS_KEY, JSON.stringify({
    v: 1, leadModel: 'cold-lead', workerModel: 'cold-worker',
    workerInstructions: 'Keep the conventions.', workerDisabledTools: ['Execute'],
  })]])))
  await prefs.load()
  // Exercise the actual constructor configuration expressions from main:
  // importing main itself would start the SDK and its real boot.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert(/settings:\s*engineConfig\(\)\.sessionSettings/.test(main), 'legacy boot explicitly maps saved settings')
  assert(/settings:\s*config\(\)\.sessionSettings/.test(main), 'runtime lobby explicitly maps saved settings')
  const clients = makeClients()
  const engineConfig = () => ({ ...SETTINGS, repoUrl: SETTINGS.repository, sessionSettings: prefs.missionSettings })
  const bootPrefix = main.match(/const legacy = new RealOrchestrator\(onEngineView, \{([\s\S]*?)\n\s*projects:/)?.[1]
  // Execute main's actual configuration prefix, not a second handwritten map.
  // `keys` stands in for main's key vault (the per-idea repository mode).
  const deps = Function('engineConfig', 'keys', `return {${bootPrefix ?? '...engineConfig(),'}}`)(engineConfig, { repoMode: 'one' })
  const engine = new RealOrchestrator(() => {}, { ...deps, clients })
  engine.boot()
  engine.voiceGoal('Deliver the empty-state screen', 3)
  engine.handleAction('start_planning')
  for (let i = 0; i < 100 && engine.snapshot().planLabels.length === 0; i++) {
    engine.tick(Date.now() + i * 5000)
    await new Promise((r) => setTimeout(r, 1))
  }
  engine.handleAction('begin')
  engine.handleAction('use_it')
  for (let i = 0; i < 100 && clients.counts.createSession < 2; i++) {
    engine.tick(Date.now() + i * 5000)
    await new Promise((r) => setTimeout(r, 1))
  }
  const created = clients.createdSettings()
  assert(created[0]?.model === 'cold-lead', 'cold boot lead uses the saved model')
  assert(created[1]?.model === 'cold-worker', 'cold boot worker uses the saved model')
  assert(same(created[1]?.disabledToolIds, ['Execute']), 'cold boot preserves the tool restriction')
  assert(created[1]?.systemPrompt?.append === 'Keep the conventions.', 'cold boot preserves instructions')
}

/** A bridge gateway over one in-memory record, like the phone's own vault. */
function gateway(store = new Map()) {
  return {
    store,
    call: (fn) =>
      fn({
        // A missing key answers '' on a real phone (never null: null is a
        // transport failure the vault must not read as absence).
        getLocalStorage: async (k) => store.get(k) ?? '',
        setLocalStorage: async (k, v) => {
          store.set(k, v)
          return true
        },
      }),
  }
}

/** Walk the DOM shim's tree: it has no getElementById. */
function byId(root, id) {
  let found = null
  const walk = (n) => {
    if (found !== null || n === null || n === undefined || typeof n === 'string') return
    if (n.id === id) {
      found = n
      return
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  return found
}

/** Every setting the owner can choose, in one body (the API's own names). */
const FULL = {
  interactionMode: 'spec',
  specModeModel: 'claude-opus-4-5',
  specModeReasoningEffort: 'high',
  model: 'claude-opus-4-5',
  reasoningEffort: 'high',
  autonomyLevel: 'medium',
  enabledToolIds: ['Read', 'ApplyPatch'],
  disabledToolIds: ['Execute'],
  restrictToolIds: ['Read'],
  systemPrompt: { type: 'preset', preset: 'droid', append: 'Follow the repo conventions.' },
  tags: [{ name: 'spriite', metadata: { missionId: 'm1' } }],
}

// ------------------------------------------------- the create body

section('the create body says exactly what the owner chose')
{
  const real = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    })
    return new Response(JSON.stringify({ sessionId: 'sess-1', status: 'idle' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await fapi.factoryCreateSession('fk', { computerId: 'comp-1', sessionSettings: FULL })
    assert(sent.length === 1 && sent[0].method === 'POST' && sent[0].url.endsWith('/api/v0/sessions'), 'one create call')
    assert(same(sent[0].body.sessionSettings, FULL), 'the create body carries every chosen setting verbatim')
    assert(sent[0].body.computerId === 'comp-1', 'the create still names the computer')

    sent.length = 0
    await fapi.factoryCreateSession('fk', { computerId: 'comp-1', sessionSettings: {} })
    assert(sent[0].body.sessionSettings === undefined, 'no choices means no sessionSettings key at all')

    assert(same(fapi.settingsBody({}), {}), 'an empty body is empty')
    assert(
      same(
        fapi.settingsBody({
          model: '   ',
          reasoningEffort: '',
          interactionMode: '',
          enabledToolIds: [],
          disabledToolIds: [''],
          restrictToolIds: [],
          systemPrompt: '   ',
          tags: [{ name: '' }],
        }),
        {},
      ),
      'blank choices travel as absence, never as empty values',
    )
    assert(fapi.settingsBody({ model: ' claude-opus-4-5 ' }).model === 'claude-opus-4-5', 'a model id is trimmed')
    assert(
      same(fapi.settingsBody({ tags: [{ name: 'spriite' }] }), { tags: [{ name: 'spriite' }] }),
      'a tag without metadata stays a bare name',
    )
    assert(
      same(fapi.settingsBody({ systemPrompt: 'Work carefully.' }), { systemPrompt: 'Work carefully.' }),
      'a plain string instruction is still accepted (the API takes both shapes)',
    )

    // The live probe's own create, re-encoded by Spriite's own encoder.
    const liveCreate = PROBE.calls.find((c) => c.role === 'create')
    assert(
      same(fapi.settingsBody(liveCreate.request.sessionSettings), liveCreate.request.sessionSettings),
      'the encoder reproduces the exact body the live probe sent',
    )

    // The recorded read: Factory echoes no settings, ever.
    const liveRead = PROBE.calls.find((c) => c.role === 'getSession')
    globalThis.fetch = async () =>
      new Response(JSON.stringify(liveRead.response), { status: 200, headers: { 'content-type': 'application/json' } })
    const info = await fapi.factoryGetSession('fk', PROBE.sessionId, PROBE.computerId)
    assert(info.status === 'idle' && info.messageCount === 0, 'a session read maps the fields Spriite uses')
    assert(info.sessionSettings === undefined, 'Factory never echoes settings back (probe finding 1): Spriite remembers what it sent')
  } finally {
    globalThis.fetch = real
  }
}

// ------------------------------------------------------ preferences

section('preferences keep the lead, worker and advanced choices apart')
{
  const gw = gateway()
  const p = new PrefsVault(gw)
  await p.load()
  assert(p.leadModel === '' && p.workerModel === '' && p.workerInstructions === '', 'a fresh record starts empty')
  assert(same(p.workerEnabledTools, []), 'an untouched tool list is empty, not undefined')
  assert(INTERACTION_MODES.length === 2 && INTERACTION_MODES[0] === 'auto' && INTERACTION_MODES[1] === 'spec',
    'the panel offers auto and spec only: the API ignores mission (probe finding 2)')

  await p.setInteractionMode('spec')
  await p.setSpecModel('claude-opus-4-5')
  await p.setSpecReasoningEffort('xhigh')
  await p.setLeadModel('claude-opus-4-5')
  await p.setLeadReasoningEffort('high')
  await p.setAutonomy('medium')
  await p.setWorkerModel('claude-sonnet-4-5')
  await p.setWorkerReasoningEffort('low')
  await p.setWorkerInstructions('  Follow the repo conventions.  ')
  await p.setWorkerEnabledTools('Read, ApplyPatch, ,Read')
  await p.setWorkerDisabledTools('Execute')
  await p.setWorkerRestrictTools('')

  const again = new PrefsVault(gateway(gw.store))
  await again.load()
  assert(again.interactionMode === 'spec' && again.specModel === 'claude-opus-4-5' && again.specReasoningEffort === 'xhigh',
    'the mode and its spec settings survive a relaunch')
  assert(again.leadModel === 'claude-opus-4-5' && again.leadReasoningEffort === 'high' && again.autonomyLevel === 'medium',
    'the lead settings survive a relaunch')
  assert(again.workerModel === 'claude-sonnet-4-5' && again.workerReasoningEffort === 'low',
    'the worker settings survive independently of the lead')
  assert(again.workerInstructions === 'Follow the repo conventions.', 'an instruction is stored trimmed')
  assert(same(again.workerEnabledTools, ['Read', 'ApplyPatch']), 'a typed tool list is split, trimmed and de-duplicated')
  assert(same(again.workerDisabledTools, ['Execute']) && same(again.workerRestrictTools, []),
    'an empty tool list stores as nothing, and reads back as nothing')

  assert(
    same(again.missionSettings, {
      interactionMode: 'spec',
      specModeModel: 'claude-opus-4-5',
      specModeReasoningEffort: 'xhigh',
      leadModel: 'claude-opus-4-5',
      leadReasoningEffort: 'high',
      leadAutonomyLevel: 'medium',
      workerModel: 'claude-sonnet-4-5',
      workerReasoningEffort: 'low',
      workerInstructions: 'Follow the repo conventions.',
      workerEnabledToolIds: ['Read', 'ApplyPatch'],
      workerDisabledToolIds: ['Execute'],
    }),
    'the frozen block carries exactly the set choices and nothing else',
  )

  await again.setInteractionMode('auto')
  assert(
    again.missionSettings.specModeModel === undefined && again.missionSettings.specModeReasoningEffort === undefined,
    'spec-only settings are not sent in another mode',
  )

  assert(same(parseToolList(''), []), 'an empty list parses empty')
  assert(same(parseToolList(' , , '), []), 'separators alone parse empty, never a blank tool id')
  assert(same(parseToolList('Read\nApplyPatch\tExecute'), ['Read', 'ApplyPatch', 'Execute']), 'newlines and tabs separate too')
  assert(same(parseToolList('Read,read'), ['Read', 'read']), 'tool ids are case-sensitive (Factory ids are)')
  assert(parseToolList(Array.from({ length: 80 }, (_, i) => `T${i}`).join(',')).length === 64, 'a tool list is capped at 64 entries')
}

section('a stored record is validated, and the old single model migrates')
{
  const junk = new Map([
    [
      PREFS_KEY,
      JSON.stringify({
        v: 1,
        interactionMode: 'mission',
        leadModel: 42,
        workerModel: '  claude-sonnet-4-5  ',
        workerEnabledTools: 'Read',
        workerDisabledTools: [1, 'Execute'],
        specReasoningEffort: 'nonsense',
        workerInstructions: 'x'.repeat(900),
        autonomyLevel: 'medium',
      }),
    ],
  ])
  const p = new PrefsVault(gateway(junk))
  await p.load()
  assert(p.interactionMode === '', 'a stored mission mode reads as absence: the API ignores it (probe finding 2)')
  assert(p.leadModel === '', 'a non-string model reads as absence, never a value the engine would send')
  assert(p.workerModel === 'claude-sonnet-4-5', 'a stored worker model is trimmed')
  assert(same(p.workerEnabledTools, []), 'a string where a tool list belongs reads as absence')
  assert(same(p.workerDisabledTools, ['Execute']), 'a tool list keeps its usable entries and drops the rest')
  assert(p.specReasoningEffort === '', 'an effort Factory does not accept reads as absence')
  assert(p.workerInstructions.length === 500, 'an instruction is capped, not stored unbounded')
  assert(p.autonomyLevel === 'medium', 'a valid field beside invalid ones still loads')
  assert(p.missionSettings.autonomyLevel === undefined || p.missionSettings.leadAutonomyLevel === 'medium',
    'the frozen block is built from validated values only')

  // Before the split there was one model for every session.
  const legacy = new Map([
    [PREFS_KEY, JSON.stringify({ v: 1, model: 'claude-opus-4-5', reasoningEffort: 'high', autonomyLevel: 'low' })],
  ])
  const p2 = new PrefsVault(gateway(legacy))
  await p2.load()
  assert(p2.leadModel === 'claude-opus-4-5' && p2.workerModel === 'claude-opus-4-5',
    'a saved model from before the split becomes the lead and the worker model')
  assert(p2.leadReasoningEffort === 'high' && p2.workerReasoningEffort === 'high',
    'a saved reasoning effort from before the split applies to both')
  await p2.setAutonomy('high')
  const stored = JSON.parse(legacy.get(PREFS_KEY))
  assert(stored.model === undefined && stored.reasoningEffort === undefined,
    'the next save stops writing the legacy names')
  assert(stored.leadModel === 'claude-opus-4-5' && stored.workerModel === 'claude-opus-4-5',
    'and writes the split names the engine reads')
}

// ------------------------------------------------- the freeze per build

section('a build freezes its settings, and a later save never reaches it')
{
  const FROZEN = {
    interactionMode: 'spec',
    specModeModel: 'claude-opus-4-5',
    specModeReasoningEffort: 'xhigh',
    leadModel: 'claude-opus-4-5',
    leadReasoningEffort: 'high',
    leadAutonomyLevel: 'medium',
    workerModel: 'claude-sonnet-4-5',
    workerReasoningEffort: 'low',
    workerInstructions: 'Follow the repo conventions.',
    workerEnabledToolIds: ['Read', 'ApplyPatch'],
    workerDisabledToolIds: ['Execute'],
    workerRestrictToolIds: [],
  }
  const kv = new TestKV()
  const clients = makeClients()
  const live = { ...SETTINGS, sessionSettings: FROZEN }
  const ctx = makeRuntime(kv, clients, { settings: live })
  await ctx.supervisor.boot()
  const { missionId } = await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 's1'))
  await ctx.supervisor.flush()
  const planned = await drive(ctx, () => (snapshotOf(ctx, missionId)?.planLabels.length ?? 0) > 0, 30000)
  assert(planned, 'the mission plans')
  assert(same(mission(ctx, missionId).config.sessionSettings, FROZEN), 'the build freezes the settings it was created with')

  // The owner saves new settings while this build runs.
  let patched = 0
  clients.updateSession = async () => {
    patched += 1
  }
  live.sessionSettings = { interactionMode: 'auto', leadModel: 'some-other-model', workerModel: 'some-other-model' }

  ctx.supervisor.handleAction(missionId, 'begin')
  ctx.supervisor.handleAction(missionId, 'use_it')
  const built = await drive(ctx, () => clients.counts.createSession >= 2, 30000)
  assert(built, 'the mission builds a lead session and a worker session')

  const created = clients.createdSettings()
  const lead = created[0]
  const worker = created[1]
  assert(
    same(lead, {
      interactionMode: 'spec',
      specModeModel: 'claude-opus-4-5',
      specModeReasoningEffort: 'xhigh',
      model: 'claude-opus-4-5',
      reasoningEffort: 'high',
      autonomyLevel: 'medium',
    }),
    'the lead session is created with the frozen lead settings',
  )
  assert(
    same(worker, {
      interactionMode: 'auto',
      autonomyLevel: 'medium',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'low',
      systemPrompt: { type: 'preset', preset: 'droid', append: 'Follow the repo conventions.' },
      enabledToolIds: ['Read', 'ApplyPatch'],
      disabledToolIds: ['Execute'],
      tags: [{ name: 'spriite', metadata: { missionId } }],
    }),
    'the worker session gets the worker settings, the extra instructions, the tool lists and the build tag',
  )
  assert(worker.systemPrompt.preset === 'droid' && worker.systemPrompt.append !== undefined,
    'extra instructions are APPENDED to the preset prompt, never replacing it')
  assert(worker.interactionMode === 'auto' && worker.autonomyLevel === FROZEN.leadAutonomyLevel,
    'the approved worker executes in auto mode with the chosen frozen autonomy, never an escalation')
  assert(patched === 0, 'a save mid-build PATCHes nothing: the settings are frozen per build')
  assert(clients.counts.createSession === 2, 'a settings change creates no extra session')

  assert(fapi.factoryUpdateSession === undefined, 'the live settings call is gone from fapi entirely')
}

section('a build with no frozen settings keeps the account defaults')
{
  const kv = new TestKV()
  const clients = makeClients()
  const live = { ...SETTINGS }
  const ctx = makeRuntime(kv, clients, { settings: live })
  await ctx.supervisor.boot()
  const { missionId } = await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 's2'))
  await ctx.supervisor.flush()
  assert(mission(ctx, missionId).config.sessionSettings === undefined, 'no choices freeze no block at all')
  await drive(ctx, () => (snapshotOf(ctx, missionId)?.planLabels.length ?? 0) > 0, 30000)

  // A mission created before this release has no frozen block, and a save must
  // not retro-fit one onto it (spec §7: frozen config).
  live.sessionSettings = { leadModel: 'claude-opus-4-5', workerModel: 'claude-opus-4-5' }
  ctx.supervisor.handleAction(missionId, 'begin')
  ctx.supervisor.handleAction(missionId, 'use_it')
  assert(await drive(ctx, () => clients.counts.createSession >= 2, 30000), 'it builds')
  // Execution mode is explicit; absent autonomy/model choices still inherit.
  const tagged = { interactionMode: 'auto', tags: [{ name: 'spriite', metadata: { missionId } }] }
  const created = clients.createdSettings()
  assert(same(created[0], {}), 'the lead session runs the account defaults, with no settings block at all')
  assert(same(created[1], tagged), 'the approved worker uses auto mode and its build tag without inventing autonomy or model choices')
}

// ------------------------------------------------------------- the panel

section('the setup panel exposes the choices and saves them')
{
  phoneDom()
  const gw = gateway()
  const prefs = new PrefsVault(gw)
  await prefs.load()
  await prefs.setLeadModel('claude-opus-4-5')
  await prefs.setInteractionMode('spec')
  const keys = new KeyVault(gw)
  let saved = 0
  const root = makeElement('div')
  mountSetupPanel(root, keys, prefs, { onSaved: () => { saved += 1 } })

  const lead = byId(root, 'pref-lead-model')
  const mode = byId(root, 'pref-mode')
  const worker = byId(root, 'pref-worker-model')
  const tools = byId(root, 'pref-worker-enabled-tools')
  const instructions = byId(root, 'pref-worker-instructions')
  assert(lead !== null && mode !== null && worker !== null && tools !== null && instructions !== null,
    'the panel builds the lead, mode, worker, tool and instruction controls')
  assert(lead.value === 'claude-opus-4-5', 'the lead model field prefills from the saved preference')
  assert(byId(root, 'pref-status') !== null, 'the panel builds the preferences status line')

  const modeValues = mode.children.map((o) => o.value)
  assert(!modeValues.includes('mission'), 'the mode control does not offer mission: the API ignores it (probe finding 2)')
  assert(modeValues.includes('auto') && modeValues.includes('spec'), 'the mode control offers auto and spec')

  const scope = byId(root, 'pref-scope')
  assert(scope !== null && /next build/i.test(textOf(scope)), 'the panel says these settings apply to the next build')

  worker.value = 'claude-sonnet-4-5'
  await worker.onchange()
  assert(prefs.workerModel === 'claude-sonnet-4-5', 'saving the worker model stores it')
  tools.value = 'Read, ApplyPatch'
  await tools.onchange()
  assert(same(prefs.workerEnabledTools, ['Read', 'ApplyPatch']), 'saving a tool list stores its ids')
  instructions.value = 'Follow the repo conventions.'
  await instructions.onchange()
  assert(prefs.workerInstructions === 'Follow the repo conventions.', 'saving extra instructions stores them')
  assert(saved > 0, 'every save reconfigures the app so the next build follows it')

  const stored = JSON.parse(gw.store.get(PREFS_KEY))
  assert(stored.workerModel === 'claude-sonnet-4-5' && same(stored.workerEnabledTools, ['Read', 'ApplyPatch']),
    'the choices are durable, not just in memory')
}

// ------------------------------------------------- the new-build options row

section('the Models sheet names what the next build freezes (Settings › Models)')
{
  phoneDom()
  const gw = gateway()
  const keys = new KeyVault(gw)
  const prefs = new PrefsVault(gw)
  const feed = new FeedVault(gw)
  await keys.load()
  await prefs.load()
  await feed.load()
  await prefs.setInteractionMode('spec')
  await prefs.setLeadModel('claude-opus-4-5')
  await prefs.setLeadReasoningEffort('high')
  await prefs.setWorkerEnabledTools('Read, ApplyPatch')
  const root = makeElement('div')
  mountPhoneApp(root, { ...phoneFakes(),
    keys,
    prefs,
    feed,
    engine: () => new IdleEngine(() => {}),
    runAction: () => {},
    onSaved: () => {},
  })
  const row = byId(root, 'new-build-options')
  assert(row !== null, 'the Models sheet shows the Options line for the next build')
  const text = textOf(row)
  assert(/Plan first/.test(text), 'the row names the mode the next build will use')
  assert(/lead claude-opus-4-5 \(high\)/.test(text), 'the row names the lead model and its effort')
  assert(/workers account model/.test(text), 'an unset worker model reads as the account model, never a value nobody chose')
  assert(/2 tools/.test(text), 'the row counts the tool policy that travels with the workers')
  assert(/keeps what it started with/.test(text), 'the row says a build keeps the settings it started with')
}

// ----------------------------------------------------------- the voice

section('the voice autonomy command is gone')
{
  assert(parseUtterance('Hey Spriite, set autonomy to full').command === null,
    '"set autonomy to full" is free text now, not a command')
  assert(parseUtterance('Spriite, full autonomy').command === null, '"full autonomy" is free text now')
  assert(parseUtterance('Hey Spriite, pause the build').command === 'pause', 'the other voice commands still parse')
  assert(parseUtterance('Hey Spriite, status').command === 'status', 'status still parses')
}

console.log(failures() === 0 ? '\nAll session settings tests passed.' : `\n${failures()} session settings test(s) FAILED.`)
process.exit(failures() === 0 ? 0 : 1)
