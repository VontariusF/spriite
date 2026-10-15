/**
 * Offline REAL-DOM admission tests, separate from the lightweight phone shim.
 * node scripts/test-native-admission-ui.mjs
 *
 * Uses the installed agent-browser and Vite; no added packages, provider SDK,
 * broker HTTP, saved credentials or qualification claims. Fixtures are synthetic.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { build } from 'vite'

async function browserChecks(mountNativePhone, PrefsVault, KeyVault) {
  const checks = []
  const check = (ok, label) => {
    if (!ok) throw new Error(label)
    checks.push(label)
  }
  const same = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label)
  const settings = {
    modelId: 'fixture-root', reasoningEffort: 'high', workerModel: 'fixture-worker',
    workerReasoningEffort: 'medium', validationWorkerModel: 'fixture-validator',
    validationWorkerReasoningEffort: 'high',
    restrictToolIds: ['Read', 'Edit'], skipScrutiny: false, skipUserTesting: false,
  }
  const modelSettings = Object.fromEntries(Object.entries(settings).filter(([, value]) => typeof value === 'string'))
  const profile = { brokerUrl: 'https://broker.invalid/native', ownerId: 'fixture-owner',
    machineId: 'fixture-machine', cwd: '/fixture/canonical-checkout', baseRef: 'fixture-branch' }
  const cap = {
    protocolVersion: 1, qualificationId: 'synthetic-offline-not-deployment-proof',
    transportVersion: 'fixture-only', qualified: true, launch: true,
    rootAttention: true, childAttention: true, recoverAttention: true,
    pause: false, resume: false, cancel: false,
  }
  let sequence = 0
  const previewOf = (request, overrides = {}) => ({
    protocolVersion: 1, missionId: `fixture-reserved-${++sequence}`, ownerId: request.ownerId,
    draftHash: sequence.toString(16).padStart(64, '0'),
    workspace: { ...request.workspace, baseSha: 'b'.repeat(40) },
    prospectiveSettings: structuredClone(request.settings), observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 59_000).toISOString(), launchEligible: true, holds: [], ...overrides,
  })
  let forbiddenNetworkCalls = 0
  window.fetch = async () => { forbiddenNetworkCalls++; throw new Error('Network forbidden') }
  window.XMLHttpRequest = class { constructor() { forbiddenNetworkCalls++; throw new Error('XHR forbidden') } }
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const mounted = []
  async function fixture(options = {}) {
    const storage = new Map()
    const gateway = { call: fn => fn({
      getLocalStorage: async key => storage.get(key) ?? '',
      setLocalStorage: async (key, value) => { storage.set(key, value); return true },
    }) }
    const prefs = new PrefsVault(gateway), keys = new KeyVault(gateway)
    await prefs.load(); await keys.load()
    await prefs.setNativeLaunchProfile(profile)
    await keys.setNativeBroker('synthetic-token-never-a-live-secret', profile.brokerUrl)
    const root = document.createElement('section'), attention = document.createElement('section')
    document.body.append(root, attention)
    const state = { cap, inspections: [], launches: [], response: null }
    const deps = {
      keys, prefs, engine: () => ({}), onSaved: () => {}, nativeCapabilities: () => state.cap,
      onNativeAdmission: async request => {
        state.inspections.push(request)
        const response = options.inspect ? await options.inspect(request) : previewOf(request)
        state.response = response
        return response
      },
      onNativeLaunch: async request => {
        state.launches.push(request)
        if (options.unknown) throw new Error('synthetic response lost after invocation')
        return { status: 'saved' }
      },
    }
    if (options.noAdmission) delete deps.onNativeAdmission
    const phone = mountNativePhone(root, attention, deps)
    const id = name => {
      const input = root.querySelector(`#native-${name}`)
      if (!input) throw new Error(`Missing actual DOM node ${name}`)
      return input
    }
    const edit = (name, value, event = 'input') => {
      const input = id(name)
      input.value = value
      input.dispatchEvent(new Event(event, { bubbles: true }))
    }
    const tick = name => { if (!id(name).checked) id(name).click() }
    const inspect = async () => { id('inspect-admission').click(); await flush() }
    const consent = () => { tick('high-consent'); tick('scope-consent') }
    const ready = () => {
      for (const [name, value] of Object.entries({
        goal: 'Build offline fixture without publication', criteria: 'Pass offline tests',
        restrictions: 'No live actions', references: 'https://reference.invalid/evidence',
        account: 'fixture-owner', repository: 'exact-fixture-repo', ...modelSettings,
        restrictToolIds: settings.restrictToolIds.join('\n'),
      })) edit(name, value)
      tick('opt-in')
    }
    const result = { root, storage, phone, keys, prefs, state, id, edit, tick, inspect, consent, ready }
    mounted.push(result)
    return result
  }

  const missing = await fixture({ noAdmission: true }); missing.ready(); missing.consent()
  check(missing.id('inspect-admission').disabled && missing.id('launch').disabled,
    'qualified fixture without inspection callback cannot inspect or launch')
  same(missing.state.launches, [], 'no callback proof means zero prepares')

  const f = await fixture()
  check(Object.keys(modelSettings).every(key => f.id(key).value === ''),
    'all six native model/effort controls start empty rather than inheriting models')
  check(f.id('restrictToolIds').tagName === 'TEXTAREA' && f.id('restrictToolIds').value === '',
    'deployment-defined tool-ID textarea starts empty with no inferred/default allowlist')
  check(f.id('validation-required').textContent.includes('skipScrutiny: false') &&
    f.id('validation-required').textContent.includes('skipUserTesting: false') &&
    !f.root.querySelector('#native-skipScrutiny') && !f.root.querySelector('#native-skipUserTesting'),
    'mandatory scrutiny and user testing are visible fixed constraints without optional skip controls')
  check(f.root.textContent.includes('restrictToolIds list alone does not enforce') &&
    f.root.textContent.includes('credential or publication boundaries') &&
    f.root.textContent.includes('Usage reporting is informational, not an enforced limit'),
    'tool list does not masquerade as enforcement proof; usage is informational')
  check(!f.root.querySelector('#native-budget-unit') && !f.root.querySelector('#native-budget-cap'),
    'no budget fields: the owner decided against a limit and the host refuses budgeted intents')
  check(f.root.textContent.includes('No hard spending limit; usage reported next day when available'),
    'the form reflects the owner decision and does not promise enforced or always available usage')
  f.ready()
  check(f.id('launch').disabled && f.id('high-consent').disabled && f.id('scope-consent').disabled,
    'actual disabled controls prevent consent before inspection')
  f.consent()
  check(!f.id('high-consent').checked && !f.id('scope-consent').checked,
    'clicking disabled consent does not record owner approval')
  for (const invalid of ['', ' \n ', 'Read\nRead', 'Read\n Read ', 'bad tool', 'Read/Edit',
    '-bad', 'constructor', 'prototype', 'x'.repeat(161),
    Array.from({ length: 129 }, (_, i) => `Tool${i}`).join('\n')]) {
    f.edit('restrictToolIds', invalid)
    check(f.id('inspect-admission').disabled,
      `empty/duplicate/invalid/oversized tool allowlist ${JSON.stringify(invalid).slice(0, 80)} blocks inspection`)
  }
  f.edit('restrictToolIds', settings.restrictToolIds.join('\n'))
  same(f.state.inspections, [], 'editing/reviewing controls does not make any inspection request')
  await f.inspect()
  check(f.state.inspections.length === 1 && f.state.launches.length === 0,
    'explicit Inspect makes one read-only callback, never prepare or automatic launch')
  check(!('scopeApproved' in f.state.inspections[0]) && !('highAutonomyApproved' in f.state.inspections[0]) &&
    !('missionId' in f.state.inspections[0]) && !('commandId' in f.state.inspections[0]),
    'pre-consent request has no approvals and leaves reserved mission/command IDs to main')
  check(!JSON.stringify(f.state.inspections).includes('synthetic-token'),
    'vault credential never enters callback admission draft')
  same(f.state.inspections[0].settings, settings,
    'read-only admission emits exactly nine fields: explicit tools/models and two false validation skip flags')
  check(!f.id('high-consent').checked && !f.id('scope-consent').checked && f.id('launch').disabled,
    'successful inspection still requires both explicit fresh owner consents')
  const review = f.id('admission-preview').textContent
  check(review.includes('/fixture/canonical-checkout') && review.includes('b'.repeat(40)) &&
    review.includes('Prospective settings (not initialized/effective settings)') &&
    review.includes('Observed:') && review.includes('expires:') && review.includes('Holds: none'),
    'real DOM shows canonical workspace, immutable SHA, prospective settings and observation/expiry/holds')
  check(review.includes('No hard spending limit; usage reported next day when available.') &&
    !review.includes('created only after approval'),
    'review states no hard limit and next-day usage when available; existing repositories are not created')
  check(review.includes('restrictToolIds: ["Read","Edit"]') && review.includes('skipScrutiny: false') &&
    review.includes('skipUserTesting: false') && review.includes('Validation mandatory'),
    'prospective review displays exact tool IDs and both mandatory false skip flags before consent')
  f.tick('high-consent')
  check(f.id('launch').disabled, 'High consent alone does not authorize the job')
  f.tick('scope-consent')
  check(!f.id('launch').disabled, 'fresh exact preview plus both explicit consents permits prepare')
  f.state.cap = { ...cap, qualified: false }; f.phone.refresh()
  check(f.id('launch').disabled && f.id('goal').value.includes('offline fixture') &&
    f.id('admission-preview').textContent === review,
    'runtime qualification loss disables launch without erasing the inspected owner draft')
  f.state.cap = cap; f.phone.refresh()
  check(!f.id('launch').disabled && f.state.inspections.length === 1,
    'qualification restoration never retries inspection or prepare automatically')
  // Changing a callback-owned response after display must not modify approved data.
  f.state.response.workspace.baseSha = 'c'.repeat(40)
  f.state.response.prospectiveSettings.workerModel = 'silently-swapped-model'
  f.state.response.prospectiveSettings.restrictToolIds.push('UnrequestedTool')
  f.state.response.prospectiveSettings.skipScrutiny = true
  f.state.response.prospectiveSettings.skipUserTesting = true
  f.id('launch').click(); await flush()
  const launch = f.state.launches[0]
  check(f.state.launches.length === 1 && launch.workspace.baseSha === 'b'.repeat(40) &&
    launch.workspace.cwd === '/fixture/canonical-checkout' &&
    launch.settings.workerModel === 'fixture-worker' && launch.admission.workspace.baseSha === 'b'.repeat(40),
    'prepare freezes inspected canonical workspace/SHA/settings against late callback object mutation')
  same(launch.settings, settings, 'launch retains all nine exact inspected settings against late tool/validation mutation')
  check(!('budget' in launch.policy), 'the launch policy carries no budget; the host refuses budgeted intents')
  check(launch.scopeApproved && launch.highAutonomyApproved && Object.isFrozen(launch) &&
    Object.isFrozen(launch.workspace) && Object.isFrozen(launch.settings) && Object.isFrozen(launch.settings.restrictToolIds),
    'approved exact launch request and nested settings/workspace are frozen')
  f.id('launch').click(); await flush()
  check(f.state.launches.length === 1, 'actual repeated prepare tap cannot duplicate a saved job')

  const blocked = await fixture({ inspect: request => previewOf(request, {
    launchEligible: false, holds: ['Deployment policy budget proof absent'],
  }) })
  blocked.ready(); await blocked.inspect(); blocked.consent()
  check(blocked.id('admission-preview').textContent.includes('Deployment policy budget proof absent') &&
    blocked.id('high-consent').disabled && blocked.id('scope-consent').disabled && blocked.id('launch').disabled,
    'held admission displays exact holds and never admits a qualified fixture')
  check(blocked.state.inspections.length === 1 && blocked.state.launches.length === 0,
    'held inspection has no automatic retry or launch')

  for (const kind of ['expired', 'owner', 'machine', 'cwd', 'repository', 'baseRef', 'settings',
    'extra-settings', 'six-settings', 'tool-allowlist', 'tool-order', 'skip-scrutiny', 'skip-user-testing',
    'missing-validation', 'sha', 'draft-hash', 'validity-window', 'future-observation']) {
    const mismatched = await fixture({ inspect: request => {
      const p = previewOf(request)
      if (kind === 'expired') p.expiresAt = new Date(Date.now() - 1).toISOString()
      if (kind === 'owner') p.ownerId = 'wrong-owner'
      if (['machine', 'cwd', 'repository', 'baseRef'].includes(kind)) {
        p.workspace[kind === 'machine' ? 'machineId' : kind] = 'wrong-binding'
      }
      if (kind === 'settings') p.prospectiveSettings.reasoningEffort = 'swapped-effort'
      if (kind === 'extra-settings') p.prospectiveSettings.hiddenDefault = 'unrequested'
      if (kind === 'six-settings') {
        delete p.prospectiveSettings.restrictToolIds
        delete p.prospectiveSettings.skipScrutiny
        delete p.prospectiveSettings.skipUserTesting
      }
      if (kind === 'tool-allowlist') p.prospectiveSettings.restrictToolIds = ['Read', 'UnrequestedTool']
      if (kind === 'tool-order') p.prospectiveSettings.restrictToolIds = ['Edit', 'Read']
      if (kind === 'skip-scrutiny') p.prospectiveSettings.skipScrutiny = true
      if (kind === 'skip-user-testing') p.prospectiveSettings.skipUserTesting = true
      if (kind === 'missing-validation') {
        delete p.prospectiveSettings.skipScrutiny
        p.prospectiveSettings.unrequestedReplacement = false
      }
      if (kind === 'sha') p.workspace.baseSha = 'main'
      if (kind === 'draft-hash') p.draftHash = 'not-an-immutable-hash'
      if (kind === 'validity-window') p.expiresAt = new Date(Date.now() + 120_000).toISOString()
      if (kind === 'future-observation') p.observedAt = new Date(Date.now() + 10_000).toISOString()
      return p
    } })
    mismatched.ready(); await mismatched.inspect(); mismatched.consent()
    check(mismatched.id('launch').disabled && !mismatched.id('high-consent').checked &&
      mismatched.id('admission-status').textContent.includes('Admission rejected'),
      `${kind} mismatch/expiry is refused without silently rewriting owner fields`)
  }

  const expiring = await fixture({ inspect: request => previewOf(request, {
    expiresAt: new Date(Date.now() + 150).toISOString(),
  }) })
  expiring.ready(); await expiring.inspect(); expiring.consent()
  check(!expiring.id('launch').disabled, 'unexpired exact inspection accepts explicit post-inspection consent')
  await sleep(200)
  check(expiring.id('launch').disabled && !expiring.id('high-consent').checked &&
    !expiring.id('scope-consent').checked && expiring.id('admission-status').textContent.includes('expired'),
    'expiry timer revokes launch and both consents without user input or refresh')
  check(expiring.state.inspections.length === 1 && expiring.state.launches.length === 0,
    'expiry never automatically reinspects or launches')

  const edited = await fixture(); edited.ready()
  const edits = {
    goal: 'Edited owner goal', criteria: 'Edited criterion', restrictions: 'Edited restriction',
    references: 'https://reference.invalid/new', ownerId: 'fixture-owner-2',
    machineId: 'fixture-machine-2', cwd: '/fixture/edited', baseRef: 'other-branch',
    brokerUrl: 'https://broker.invalid/native-v2', account: 'fixture-owner-2',
    repository: 'renamed-fixture', source: 'https://source.invalid/repo',
    ...Object.fromEntries(Object.keys(modelSettings).map(key => [key, `explicit-${key}-edited`])),
    restrictToolIds: 'Read\nSearch',
    credential: 'unsaved-fixture-token',
  }
  for (const [name, value] of Object.entries(edits)) {
    await edited.inspect(); edited.consent()
    const previous = edited.id(name).value
    edited.edit(name, value)
    check(edited.id('launch').disabled && !edited.id('high-consent').checked &&
      !edited.id('scope-consent').checked && edited.id('admission-preview').textContent === '',
      `${name} raw input edit invalidates preview and both consents`)
    edited.edit(name, previous)
    check(edited.id('launch').disabled, `${name} edit-and-revert cannot resurrect an approval`)
  }
  for (const [name, next] of [['operation', 'integrate'], ['destination', 'new_repository'],
    ['visibility', 'public'], ['initialization', 'scaffold']]) {
    await edited.inspect(); edited.consent()
    const previous = edited.id(name).value
    edited.edit(name, next, 'change')
    check(edited.id('launch').disabled && !edited.id('scope-consent').checked,
      `${name} selection change invalidates admission`)
    edited.edit(name, previous, 'change')
  }
  check(!edited.root.querySelector('[id^="native-allow-"]'), 'no per-job consequence checkboxes remain')
  for (const name of ['default-create', 'default-push', 'default-pr', 'default-merge', 'opt-in']) {
    await edited.inspect(); edited.consent(); edited.id(name).click()
    check(edited.id('launch').disabled && !edited.id('high-consent').checked && !edited.id('scope-consent').checked,
      `${name} choice change invalidates admission and both consents`)
    await flush()
    edited.id(name).click()
    await flush()
  }
  await edited.inspect(); edited.consent()
  edited.edit('goal', `${edited.id('goal').value} `)
  check(edited.id('launch').disabled, 'even semantically equivalent whitespace edits revoke the raw-input binding')

  const late = deferred()
  const pending = await fixture({ inspect: request => late.promise.then(() => previewOf(request)) })
  pending.ready(); pending.id('inspect-admission').click(); await flush()
  pending.edit('goal', 'New owner scope while inspection is pending')
  late.resolve(); await flush()
  check(pending.id('admission-preview').textContent === '' && pending.id('launch').disabled &&
    !pending.id('high-consent').checked && pending.state.launches.length === 0,
    'late inspection after an edit is ignored, with no automatic launch')
  const toolLate = deferred()
  const pendingTools = await fixture({ inspect: request => toolLate.promise.then(() => previewOf(request)) })
  pendingTools.ready(); pendingTools.id('inspect-admission').click(); await flush()
  pendingTools.edit('restrictToolIds', 'Read\nSearch')
  toolLate.resolve(); await flush()
  check(pendingTools.id('admission-preview').textContent === '' && pendingTools.id('launch').disabled &&
    pendingTools.state.inspections.length === 1 && pendingTools.state.launches.length === 0,
    'tool-ID edit during pending inspection ignores the late result without retry or launch')

  const expiresDuring = deferred()
  const lateExpiry = await fixture({ inspect: request => {
    const response = previewOf(request, { expiresAt: new Date(Date.now() + 25).toISOString() })
    return expiresDuring.promise.then(() => response)
  } })
  lateExpiry.ready(); lateExpiry.id('inspect-admission').click(); await flush(); await sleep(40)
  expiresDuring.resolve(); await flush()
  check(lateExpiry.id('launch').disabled && lateExpiry.id('admission-status').textContent.includes('Admission rejected'),
    'preview expiring while inspection is awaiting response cannot become current')

  const renewed = await fixture(); renewed.ready(); await renewed.inspect(); renewed.consent()
  await renewed.keys.setNativeBroker('rotated-synthetic-token', profile.brokerUrl); renewed.phone.refresh()
  check(renewed.id('launch').disabled && !renewed.id('scope-consent').checked &&
    !renewed.id('high-consent').checked && renewed.id('admission-preview').textContent === '',
    'externally rotated saved credential invalidates current admission on refresh')
  await renewed.inspect(); renewed.consent()
  await renewed.prefs.setNativeLaunchProfile({ ...profile, baseRef: 'external-profile-update' }); renewed.phone.refresh()
  check(renewed.id('launch').disabled && !renewed.id('scope-consent').checked &&
    renewed.id('goal').value.includes('offline fixture'),
    'external saved-profile refresh invalidates admission without replacing owner draft')
  await renewed.inspect(); renewed.consent()
  renewed.edit('credential', 'new-synthetic-saved-token')
  renewed.id('save-profile').click(); await flush()
  check(renewed.id('credential').value === '' && renewed.id('launch').disabled &&
    !renewed.id('high-consent').checked && renewed.id('admission-preview').textContent === '',
    'saving credential renewal revokes inspection rather than transferring old consent')
  await renewed.inspect(); renewed.consent(); renewed.id('clear-credential').click(); await flush()
  check(renewed.id('launch').disabled && renewed.id('inspect-admission').disabled &&
    !renewed.id('scope-consent').checked, 'credential removal disables inspection and launch')

  const credentialLate = deferred()
  const rotatingPending = await fixture({ inspect: request => credentialLate.promise.then(() => previewOf(request)) })
  rotatingPending.ready(); rotatingPending.id('inspect-admission').click(); await flush()
  await rotatingPending.keys.setNativeBroker('rotation-during-await', profile.brokerUrl)
  credentialLate.resolve(); await flush()
  check(rotatingPending.id('admission-preview').textContent === '' && rotatingPending.id('launch').disabled,
    'vault rotation during await refuses late preview even without an intervening refresh')

  const unknown = await fixture({ unknown: true }); unknown.ready(); await unknown.inspect(); unknown.consent()
  unknown.id('launch').click(); await flush()
  check(unknown.state.launches.length === 1 && unknown.id('launch-result').textContent.includes('Prepare outcome unknown'),
    'prepare response loss remains uncertain rather than fake success or safe retry')
  unknown.edit('goal', 'Edited uncertain prepare'); unknown.state.cap = { ...cap, launch: false }; unknown.phone.refresh()
  unknown.state.cap = cap; unknown.phone.refresh(); unknown.consent()
  unknown.id('inspect-admission').click(); unknown.id('launch').click(); await flush()
  check(unknown.id('launch').disabled && unknown.id('inspect-admission').disabled &&
    unknown.state.inspections.length === 1 && unknown.state.launches.length === 1,
    'edit/qualification refresh cannot clear unknown prepare or automatically retry either callback')
  // Held X / saved requests: review, promote, cancel, dismiss.
  const heldGoal = '  Build the X-requested widget\n\twith  odd   spacing  '
  const heldIntents = [
    { missionId: 'held-x-1', origin: 'x', goal: heldGoal, references: ['https://x.invalid/post/1', 'https://ref.invalid/a'],
      repository: 'https://github.com/fixture-owner/exact-fixture-repo', createdAt: '2026-01-02T03:04:05.000Z' },
    { missionId: 'held-generic-2', origin: 'generic', goal: 'A'.repeat(400), references: [],
      repository: 'https://github.com/fixture-owner/other', createdAt: '2026-01-01T00:00:00.000Z' },
  ]
  async function heldMount(options = {}) {
    const storage = new Map()
    const gateway = { call: fn => fn({
      getLocalStorage: async key => storage.get(key) ?? '',
      setLocalStorage: async (key, value) => { storage.set(key, value); return true },
    }) }
    const prefs = new PrefsVault(gateway), keys = new KeyVault(gateway)
    await prefs.load(); await keys.load()
    await prefs.setNativeLaunchProfile(profile)
    await keys.setNativeBroker('synthetic-token-never-a-live-secret', profile.brokerUrl)
    const root = document.createElement('section'), attention = document.createElement('section')
    document.body.append(root, attention)
    const state = { held: structuredClone(heldIntents), launches: [], promotes: [], dismisses: [], inspections: [] }
    const phone = mountNativePhone(root, attention, {
      keys, prefs, engine: () => ({}), onSaved: () => {}, nativeCapabilities: () => cap,
      onNativeAdmission: async request => { state.inspections.push(request); return previewOf(request) },
      onNativeLaunch: async request => { state.launches.push(request); return { status: 'saved' } },
      heldNativeIntents: () => state.held,
      onPromoteHeld: async (id, request) => { state.promotes.push([id, request]); return { status: 'saved' } },
      onDismissHeld: async id => {
        state.dismisses.push(id)
        if (options.dismissThrows) throw new Error('synthetic lost dismiss')
        state.held = state.held.filter(h => h.missionId !== id)
        return true
      },
    })
    const id = name => root.querySelector(`#native-${name}`)
    const edit = (name, value) => { const input = id(name); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }
    const tick = name => { if (!id(name).checked) id(name).click() }
    const rows = () => [...root.querySelectorAll('.native-held-row')]
    const button = (row, text) => [...row.querySelectorAll('button')].find(b => b.textContent === text)
    const fill = () => {
      for (const [name, value] of Object.entries({ criteria: 'Pass offline tests', restrictions: 'No live actions',
        ...modelSettings, restrictToolIds: settings.restrictToolIds.join('\n') })) edit(name, value)
      tick('opt-in')
    }
    const result = { root, phone, state, id, edit, tick, rows, button, fill }
    mounted.push({ ...result, edit: (n, v) => { if (n === 'goal' && id('goal').readOnly) return; edit(n, v) } })
    return result
  }

  const hm = await heldMount()
  check(hm.rows().length === 2 && hm.rows()[0].textContent.includes('From X') &&
    hm.rows()[1].textContent.includes('Saved request'), 'held requests list with origin badges')
  check(hm.rows()[0].querySelector('.native-held-goal').textContent === heldGoal &&
    hm.rows()[0].querySelector('.native-held-goal').style.whiteSpace === 'pre-wrap' &&
    hm.rows()[0].textContent.includes('https://x.invalid/post/1') &&
    hm.rows()[0].textContent.includes('exact-fixture-repo') && hm.rows()[0].textContent.includes('2026-01-02T03:04:05.000Z'),
    'held row shows exact goal (wrapped), references, repository and time')
  check(hm.root.textContent.includes('Nothing runs until you review and approve on this phone') &&
    !/\b(running|started)\b/i.test(hm.id('held-section').textContent), 'held copy never implies anything runs')
  const firstRow = hm.rows()[0]
  hm.phone.refresh()
  check(hm.rows()[0] === firstRow, 'refresh keeps existing held row nodes')
  hm.fill(); hm.edit('goal', 'Earlier plain job'); hm.edit('account', 'fixture-owner'); hm.edit('repository', 'exact-fixture-repo')
  hm.id('inspect-admission').click(); await flush(); hm.tick('high-consent'); hm.tick('scope-consent')
  check(hm.id('high-consent').checked, 'precondition: prior consent given')
  hm.button(hm.rows()[0], 'Review as native job').click(); await flush()
  check(hm.id('goal').value === heldGoal && hm.id('goal').readOnly &&
    hm.id('references').value === 'https://x.invalid/post/1\nhttps://ref.invalid/a',
    'review pre-fills exact untrimmed goal (locked) and references')
  check(hm.id('promote-banner').textContent.includes('From X post — reference only, not permission') &&
    hm.id('promote-banner').textContent.includes('Promoting held-x-1'), 'promote mode is clearly labeled')
  check(!hm.id('high-consent').checked && !hm.id('scope-consent').checked && hm.id('launch').disabled &&
    hm.id('admission-preview').childElementCount === 0, 'review revokes prior admission and consents')
  hm.id('inspect-admission').click(); await flush()
  check(hm.id('launch').disabled, 'promotion still requires both consents after inspection')
  hm.tick('high-consent'); hm.tick('scope-consent')
  check(!hm.id('launch').disabled, 'promotion enabled only after inspect plus both consents')
  hm.id('launch').click(); await flush()
  check(hm.state.promotes.length === 1 && hm.state.launches.length === 0 &&
    hm.state.promotes[0][0] === 'held-x-1' && hm.state.promotes[0][1].goal === heldGoal &&
    hm.state.inspections.at(-1).goal === heldGoal &&
    JSON.stringify(hm.state.promotes[0][1].references.slice(0, 2)) === JSON.stringify(heldIntents[0].references) &&
    hm.state.promotes[0][1].scopeApproved === true && hm.state.promotes[0][1].highAutonomyApproved === true,
    'launch in promote mode calls onPromoteHeld with exact goal and references, never onNativeLaunch')
  check(hm.id('promote-banner').style.display === 'none' && !hm.id('goal').readOnly &&
    hm.rows()[0].textContent.includes('Approved on this phone'), 'successful promotion leaves review mode with honest note')

  const hc = await heldMount()
  hc.button(hc.rows()[1], 'Review as native job').click(); await flush()
  check(hc.id('goal').value === 'A'.repeat(400) && hc.id('goal').readOnly, 'second held row loads its own goal')
  hc.id('cancel-review').click(); await flush()
  check(!hc.id('goal').readOnly && hc.id('goal').value === '' && hc.id('promote-banner').style.display === 'none' &&
    hc.state.promotes.length === 0 && hc.rows().length === 2, 'cancel review leaves mode without promoting or dismissing')
  hc.fill(); hc.edit('goal', 'Plain new job'); hc.edit('account', 'fixture-owner'); hc.edit('repository', 'exact-fixture-repo')
  hc.id('inspect-admission').click(); await flush(); hc.tick('high-consent'); hc.tick('scope-consent'); hc.id('launch').click(); await flush()
  check(hc.state.launches.length === 1 && hc.state.promotes.length === 0, 'after cancel, launch uses ordinary onNativeLaunch')

  const hr = await heldMount()
  hr.button(hr.rows()[0], 'Review as native job').click(); await flush()
  check(hr.id('destination-notice').style.display === 'none', 'no destination notice when review matches held repository')
  hr.fill(); hr.edit('repository', 'different-repo')
  check(hr.id('destination-notice').style.display === '' &&
    hr.id('destination-notice').textContent.includes('Destination changed from https://github.com/fixture-owner/exact-fixture-repo') &&
    hr.id('destination-notice').nextElementSibling?.nextElementSibling === hr.id('launch'),
    'changed destination shows persistent notice beside launch')
  hr.id('inspect-admission').click(); await flush(); hr.tick('high-consent'); hr.tick('scope-consent')
  check(!hr.id('launch').disabled && hr.id('destination-notice').style.display === '',
    'changed destination does not block launch and notice persists after consent')
  hr.id('launch').click(); await flush()
  check(hr.state.promotes.length === 1 && hr.state.promotes[0][1].workspace.repository.endsWith('/different-repo'),
    'promotion sends the owner-reviewed destination')

  const hg = await heldMount()
  hg.button(hg.rows()[0], 'Review as native job').click(); await flush()
  hg.fill(); hg.edit('account', 'fixture-owner'); hg.edit('repository', 'exact-fixture-repo')
  hg.id('inspect-admission').click(); await flush(); hg.tick('high-consent'); hg.tick('scope-consent')
  check(!hg.id('launch').disabled && hg.id('held-gone').style.display === 'none', 'precondition: held review launchable')
  hg.state.held = hg.state.held.filter(h => h.missionId !== 'held-x-1'); hg.phone.refresh()
  hg.id('launch').click(); await flush()
  check(hg.id('held-gone').style.display === '' &&
    hg.id('held-gone').textContent.includes('no longer held (approved or dismissed elsewhere). Cancel review.') &&
    hg.id('launch').disabled && hg.state.promotes.length === 0 && hg.state.launches.length === 0,
    'vanished held request shows notice and disables launch in promoting mode')
  hg.id('cancel-review').click(); await flush()
  check(hg.id('held-gone').style.display === 'none', 'cancel review clears the vanished-request notice')

  const hd = await heldMount()
  hd.button(hd.rows()[1], 'Dismiss').click(); await flush()
  check(hd.state.dismisses.length === 0 && hd.rows()[1].textContent.includes('Dismiss this held request?'), 'dismiss asks for confirmation first')
  hd.button(hd.rows()[1], 'Keep held').click(); await flush()
  check(hd.state.dismisses.length === 0 && !hd.rows()[1].textContent.includes('Confirm dismiss'), 'keep held cancels dismiss')
  hd.button(hd.rows()[1], 'Dismiss').click(); hd.button(hd.rows()[1], 'Confirm dismiss').click(); await flush()
  hd.phone.refresh()
  check(hd.state.dismisses.length === 1 && hd.state.dismisses[0] === 'held-generic-2' &&
    hd.rows()[1].textContent.includes('Dismissed. This request will not run.') &&
    hd.button(hd.rows()[1], 'Review as native job').disabled, 'confirmed dismiss calls onDismissHeld and shows honest result')

  const hu = await heldMount({ dismissThrows: true })
  hu.button(hu.rows()[0], 'Dismiss').click(); hu.button(hu.rows()[0], 'Confirm dismiss').click(); await flush()
  hu.phone.refresh(); await sleep(20); hu.phone.refresh()
  hu.button(hu.rows()[0], 'Dismiss').click(); await flush()
  check(hu.state.dismisses.length === 1 && hu.rows().length === 2 &&
    hu.rows()[0].textContent.includes('Dismiss outcome unknown') && hu.button(hu.rows()[0], 'Dismiss').disabled &&
    !hu.rows()[0].textContent.includes('Confirm dismiss'), 'unknown dismiss stays visible with no automatic retry')

  // A held X request for a new private repository picks up current delivery defaults at review.
  const hn = await heldMount()
  hn.state.held = [{ missionId: 'held-new-repo', origin: 'x', goal: 'build a habit log in a new repo called habit-log',
    references: [], repository: 'https://github.com/fixture-owner/habit-log', createdAt: '2026-10-13T00:00:00.000Z',
    destination: { kind: 'new_repository', account: 'fixture-owner', name: 'habit-log', visibility: 'private', initialization: 'empty' } }]
  hn.phone.refresh()
  for (const name of ['default-create', 'default-pr']) { hn.id(name).click(); await flush() }
  check(hn.id('default-push').checked && hn.id('default-pr').checked && !hn.id('default-merge').checked,
    'turning on PR in settings also turns on push (dependency rule)')
  hn.button(hn.rows()[0], 'Review as native job').click(); await flush()
  same([hn.id('destination').value, hn.id('account').value, hn.id('repository').value, hn.id('visibility').value, hn.id('initialization').value],
    ['new_repository', 'fixture-owner', 'habit-log', 'private', 'empty'], 'review pre-fills the held private, empty new-repository destination')
  hn.fill()
  hn.id('inspect-admission').click(); await flush()
  check(hn.id('admission-preview').textContent.includes('created only after approval, during prepare, not admission') &&
    hn.id('admission-preview').textContent.includes('deterministic empty base') &&
    hn.id('admission-preview').textContent.includes('Prospective workspace (not provisioned)') &&
    hn.id('admission-preview').textContent.includes('Prospective empty base SHA'),
    'new-repository prospective inspection never claims creation before approval and prepare')
  check(hn.state.inspections.at(-1).workspace.baseSha === undefined,
    'a new-repository draft carries no fixed base SHA; the broker previews an empty base')
  check(/^This job will: create the private repository fixture-owner\/habit-log, push branch spriite\/fixture-reserved-\d+, open a PR\. It never deploys\.$/
    .test(hn.id('delivery-summary').textContent), 'held review shows creation, push and PR read-only from current defaults')
  hn.tick('high-consent'); hn.tick('scope-consent')
  hn.id('launch').click(); await flush()
  const promotedNew = hn.state.promotes[0]?.[1]
  same(promotedNew && [promotedNew.destination.kind, promotedNew.destination.visibility, promotedNew.destination.initialization,
    promotedNew.policy.allowCreateRepository, promotedNew.policy.allowPush, promotedNew.policy.allowPr,
    promotedNew.policy.allowMerge, promotedNew.policy.allowDeploy],
  ['new_repository', 'private', 'empty', true, true, true, false, false], 'promoted new-repository intent carries the current defaults')
  const hoff = await heldMount()
  hoff.state.held = structuredClone(hn.state.held); hoff.phone.refresh()
  hoff.button(hoff.rows()[0], 'Review as native job').click(); await flush()
  hoff.fill()
  check(hoff.id('inspect-admission').disabled && hoff.id('delivery-summary').textContent.includes('Create private repositories'),
    'with creation off, a held new-repository request cannot be inspected and says why')

  const managedPreview = request => {
    const p = previewOf(request)
    p.workspace.cwd = `${request.workspace.cwd}/jobs/${p.missionId}/work`
    if (request.destination.kind === 'new_repository') {
      p.workspace.repository = `${request.destination.account}/${request.destination.name}`
      p.launchEligible = false
      p.holds = ['native_new_repository_initialization_unqualified', 'native_prospective_workspace_only']
    }
    return p
  }
  const managed = await fixture({ inspect: managedPreview })
  same(managed.id('workspace-mode').value, 'static', 'old profile stays explicitly static, never inferred host-managed')
  check(managed.id('host-root').disabled && managed.id('host-root').value === '' &&
    managed.id('cwd').value === profile.cwd, 'legacy cwd remains untouched and is not copied into the host-root field')
  managed.edit('workspace-mode', 'host_managed', 'change')
  managed.ready()
  check(managed.id('cwd').disabled && !managed.id('host-root').disabled && managed.id('inspect-admission').disabled,
    'explicit managed opt-in retains/disables static cwd and requires a separately entered canonical root')
  for (const root of ['/', '/fixture//native', '/fixture/a/../native', '/fixture/native/', ' /fixture/native']) {
    managed.edit('host-root', root)
    check(managed.id('inspect-admission').disabled, `unsafe managed root ${JSON.stringify(root)} cannot inspect`)
  }
  managed.edit('host-root', '/fixture/native')
  same(managed.prefs.nativeLaunchProfile, profile, 'mode/root editing does not silently change saved static profile')
  managed.id('save-profile').click(); await flush()
  same(managed.prefs.nativeLaunchProfile, { ...profile, workspaceMode: 'host_managed', hostRoot: '/fixture/native' },
    'explicit save persists managed mode/root separately, preserving the old static cwd')
  managed.ready()
  await managed.inspect()
  same(managed.state.inspections[0].workspace.cwd, '/fixture/native',
    'phone preallocation request identifies root, leaving mission-ID allocation to main')
  const managedResponse = managed.state.response
  check(managed.id('admission-preview').textContent.includes('Host root: /fixture/native') &&
    managed.id('admission-preview').textContent.includes(`Job checkout: /fixture/native/jobs/${managedResponse.missionId}/work`) &&
    managed.id('admission-preview').textContent.includes('bound into the inspected draft hash'),
    'review distinguishes explicit root from exact reserved checkout and its draft-hash binding')
  managed.consent()
  check(!managed.id('launch').disabled, 'derived managed allocation still requires both fresh consents')
  managed.edit('host-root', '/changed/native')
  check(managed.id('launch').disabled && !managed.id('scope-consent').checked && !managed.id('high-consent').checked,
    'root edit revokes admission and both consents')
  managed.edit('host-root', '/fixture/native'); await managed.inspect(); managed.consent()
  managed.edit('workspace-mode', 'static', 'change')
  check(managed.id('launch').disabled && !managed.id('scope-consent').checked && managed.id('cwd').value === profile.cwd,
    'mode change revokes admission without rewriting the retained static workspace')
  managed.edit('workspace-mode', 'host_managed', 'change'); await managed.inspect(); managed.consent()
  managed.id('launch').click(); await flush()
  same(managed.state.launches[0].workspace.cwd, `/fixture/native/jobs/${managed.state.response.missionId}/work`,
    'approved managed callback carries the reviewed checkout, never the root')

  const sibling = await fixture({ inspect: request => {
    const p = managedPreview(request); p.workspace.cwd = `${request.workspace.cwd}/jobs/sibling/work`; return p
  } })
  sibling.edit('workspace-mode', 'host_managed', 'change'); sibling.edit('host-root', '/fixture/native')
  sibling.id('save-profile').click(); await flush(); sibling.ready(); await sibling.inspect()
  check(sibling.id('launch').disabled && sibling.id('admission-status').textContent.includes('rejected'),
    'phone rejects arbitrary sibling checkout even from an otherwise eligible preview')

  const prospective = await fixture({ inspect: managedPreview })
  prospective.edit('workspace-mode', 'host_managed', 'change'); prospective.edit('host-root', '/fixture/native')
  prospective.id('save-profile').click(); await flush(); prospective.ready()
  prospective.id('default-create').click(); await flush()
  prospective.edit('destination', 'new_repository', 'change')
  await prospective.inspect()
  check(prospective.id('admission-preview').textContent.includes('native_new_repository_initialization_unqualified') &&
    prospective.id('admission-preview').textContent.includes('native_prospective_workspace_only') &&
    prospective.id('admission-preview').textContent.includes('Repository: fixture-owner/exact-fixture-repo') &&
    prospective.id('scope-consent').disabled && prospective.id('high-consent').disabled && prospective.id('launch').disabled,
    'managed new-repo slug preview preserves actual initialization/prospective holds without granting consent or launch')

  check(forbiddenNetworkCalls === 0, 'all real-DOM checks use zero network/SDK/live broker calls')
  // Revoke fixture timers; preserve the unknown prepare fence.
  for (const row of mounted) row.edit('goal', `${row.id('goal').value} [test complete]`)
  return checks
}

const root = fileURLToPath(new URL('../', import.meta.url))
const entry = '\0native-admission-ui-tests'
const bundle = await build({
  configFile: false, root, logLevel: 'silent',
  plugins: [{
    name: 'offline-native-admission-entry',
    resolveId: id => id === 'native-admission-ui-tests' ? entry : null,
    load: id => id === entry ? [
      `import { mountNativePhone } from ${JSON.stringify(resolve(root, 'src/phone/native.ts'))};`,
      `import { PrefsVault } from ${JSON.stringify(resolve(root, 'src/state/prefs.ts'))};`,
      `import { KeyVault } from ${JSON.stringify(resolve(root, 'src/voice/keys.ts'))};`,
      `(${browserChecks.toString()})(mountNativePhone, PrefsVault, KeyVault)`,
      `.then(checks => { window.nativeAdmissionTestResult = { ok: true, checks }; })`,
      `.catch(error => { window.nativeAdmissionTestResult = { ok: false, error: error.stack || String(error) }; });`,
    ].join('\n') : null,
  }],
  build: { write: false, minify: false, target: 'esnext',
    rollupOptions: { input: 'native-admission-ui-tests', output: { format: 'iife' } } },
})
const output = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(part => part.type === 'chunk')
assert.ok(output, 'Vite must emit the offline test entry')
const temporary = await mkdtemp('/tmp/spriite-native-admission-ui-')
const html = resolve(temporary, 'index.html')
await writeFile(html, `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'">
<title>Offline native admission DOM checks</title><body><h1>Offline native admission DOM checks</h1>
<script>${output.code.replaceAll('</script', '<\\/script')}</script></body>`)

const desktop = Boolean(process.env.FACTORY_DESKTOP_CDP_PORT)
const args = desktop ? ['--cdp', process.env.AGENT_BROWSER_CDP, '--no-pin-tab'] : []
assert.ok(!desktop || process.env.AGENT_BROWSER_CDP, 'Desktop browser requires its assigned endpoint')
const env = { ...process.env, AGENT_BROWSER_SESSION: process.env.AGENT_BROWSER_SESSION || `native-admission-ui-${process.pid}` }
const run = (command, input) => {
  const result = spawnSync('agent-browser', [...args, ...command], {
    encoding: 'utf8', env, input, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`agent-browser ${command[0]} failed: ${result.error?.message || result.stderr || result.stdout}`)
  }
  return result.stdout
}
try {
  run(['open', pathToFileURL(html).href])
  run(['wait', '--fn', 'Boolean(window.nativeAdmissionTestResult)'])
  const raw = run(['eval', '--stdin', '--json'], 'JSON.stringify(window.nativeAdmissionTestResult)')
  const envelope = JSON.parse(raw)
  const result = typeof envelope.data?.result === 'string'
    ? JSON.parse(envelope.data.result) : envelope.data?.result
  assert.ok(result, `Missing browser test result: ${raw}`)
  assert.ok(result.ok, result.error)
  for (const check of result.checks) console.log(`  PASS: ${check}`)
  console.log(`All ${result.checks.length} offline actual-DOM admission checks passed.`)
} finally {
  // Never close the user-owned desktop browser. Headless sessions are ours.
  if (!desktop) run(['close'])
}
