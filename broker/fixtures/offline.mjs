import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { NativeBroker } from '../broker.mjs'
import { QUALIFICATION_GATES } from '../qualification.mjs'
import { hash, canonical, clone } from '../validation.mjs'
import { scopeOf } from '../store.mjs'

export const OWNER = 'owner-fixture'
export const MACHINE = 'machine-fixture'
export const TOKEN = 'offline-fixture-bearer-not-a-real-secret-000000'
export function makeIntent(missionId = 'mission-1', overrides = {}) {
  return {
    protocolVersion: 1, missionId, ownerId: OWNER, commandId: `prepare-${missionId}`,
    goal: 'Implement the approved empty state without publication.',
    scopeRevision: 1, operation: 'implement',
    destination: { kind: 'existing', account: 'fixture', name: 'fixture-repo', visibility: 'private', initialization: 'empty' },
    workspace: { machineId: MACHINE, cwd: '/offline/fixture-checkout', repository: 'immutable-repo-fixture-id', baseRef: 'trunk', baseSha: 'a'.repeat(40) },
    references: [], acceptanceCriteria: ['The empty state is visible.'],
    restrictions: ['Do not push, open a PR, merge, or deploy.'],
    policy: { autonomy: 'high', allowCreateRepository: false, allowPush: false, allowPr: false, allowMerge: false, allowDeploy: false },
    scopeApproved: true, highAutonomyApproved: true,
    settings: { modelId: 'fixture-orchestrator', workerModel: 'fixture-worker', validationWorkerModel: 'fixture-validator' },
    ...overrides,
  }
}
export function makeCommand(snapshot, kind, extra = {}) {
  return {
    protocolVersion: 1, commandId: `action-${kind}-${snapshot.brokerSeq}`, missionId: snapshot.missionId,
    ownerId: snapshot.ownerId, kind, expectedScopeRevision: snapshot.scopeRevision,
    expectedBrokerSeq: snapshot.brokerSeq, ...extra,
  }
}
export function makeAttention({ requestId = 'rpc-1', sessionId = 'session-mission-1', kind = 'permission', questions = [] } = {}) {
  const raw = {
    kind, sessionId, requestId, toolUseIds: [`tool-${requestId}`],
    details: kind === 'proposal' ? 'Exact native proposal.' : 'Exact request details.',
    questions: questions.map(q => ({ ...clone(q), allowCustom: false })),
  }
  return {
    attention: {
      attentionId: `attention-${requestId}`, requestId, sessionId, machineId: MACHINE,
      toolUseIds: [`tool-${requestId}`], associatedSessionIds: [sessionId], revision: 1,
      payloadHash: hash(raw), kind, title: kind === 'ask_user' ? 'Choose colors' : 'Native confirmation',
      details: raw.details, options: kind === 'ask_user' ? [] : [
        { id: 'approve', label: 'Approve once', value: 'proceed_once' },
        { id: 'cancel', label: 'Decline', value: 'cancel' },
      ],
      questions: clone(questions), state: 'open', openedAt: new Date().toISOString(), resolvedAt: null,
    },
    raw,
  }
}
export function makeAnswer(a, overrides = {}) {
  return {
    attentionId: a.attentionId, requestId: a.requestId, sessionId: a.sessionId,
    machineId: a.machineId, revision: a.revision, payloadHash: a.payloadHash,
    selectedOption: 'proceed_once', ...overrides,
  }
}
export function observation(intent, binding, overrides = {}) {
  return {
    binding: clone(binding), state: 'awaiting_input', features: [], progressLog: [], workerSessionIds: [],
    pending: [], pendingComplete: true, pendingSource: 'authoritative',
    sessionIds: [binding.sessionId], completeness: 'complete',
    effectiveSettings: clone(intent.settings), scopeRevision: intent.scopeRevision,
    scopeHash: hash(scopeOf(intent)), policyHash: hash({ policy: intent.policy, settings: intent.settings }),
    ...overrides,
  }
}
export function fakeTransport(overrides = {}) {
  const transport = {
    version: 'offline-fixture/v1',
    support: { launch: true, rootAttention: true, childAttention: true, recoverAttention: true, readOnlyObservation: true },
    calls: [], observations: new Map(),
    async preflight(intent, ctx) {
      this.calls.push({ method: 'preflight', intent: clone(intent) })
      return {
        workspace: { ...clone(intent.workspace), baseSha: intent.workspace.baseSha ?? null },
        effectiveSettings: clone(intent.settings), scopeHash: ctx.scopeHash, policyHash: ctx.policyHash,
        availableAutonomyLevels: ['high'], readiness: true, policyEnforced: true, budgetEnforced: false, usageReporting: 'next_day_unenforced', destinationVerified: true,
      }
    },
    async launch(intent, ctx) {
      ctx.guard()
      this.calls.push({ method: 'launch', intent: clone(intent) })
      return {
        status: 'confirmed', commandId: ctx.commandId, receiptId: `receipt-${ctx.commandId}`,
        binding: { ...clone(intent.workspace), baseSha: intent.workspace.baseSha ?? null, sessionId: `session-${intent.missionId}` },
        effectiveSettings: clone(intent.settings),
      }
    },
    async answer(answer, ctx) {
      ctx.guard()
      this.calls.push({ method: 'answer', answer: clone(answer) })
      return { status: 'sent', commandId: ctx.commandId }
    },
    async observe(binding, ctx) {
      this.calls.push({ method: 'observe', binding: clone(binding), readOnly: ctx.readOnly })
      const observation = this.observations.get(binding.sessionId)
      if (!observation) throw new Error('Fixture disconnected')
      return clone(observation)
    },
    ...overrides,
  }
  return transport
}
export async function fixtureQualification(directory, transportVersion, now = Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const evidence = Buffer.from('OFFLINE SEAM FIXTURE ONLY. NOT LIVE NATIVE QUALIFICATION.\n')
  const evidencePath = join(directory, 'fixture-evidence.txt')
  await writeFile(evidencePath, evidence, { mode: 0o600 })
  const manifest = {
    version: 1, qualificationId: 'offline-fixture-qualification', ownerId: OWNER,
    machineId: MACHINE, transportVersion,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
    gates: QUALIFICATION_GATES.map(name => ({
      name, evidencePath, sha256: createHash('sha256').update(evidence).digest('hex'),
      verifiedAt: new Date(now).toISOString(),
    })),
    controls: { pause: false, resume: false, cancel: false },
  }
  const qualificationPath = join(directory, 'fixture-qualification.json')
  await writeFile(qualificationPath, JSON.stringify({
    manifest, signature: sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64'),
  }), { mode: 0o600 })
  return {
    qualificationPath,
    qualificationPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    manifest,
  }
}
export async function fixture({ qualified = true, transport = fakeTransport(), timeoutMs = 100, now = Date.now, extra = {} } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'spriite-native-broker-test-')))
  const ledgerDir = join(directory, 'ledger')
  await mkdir(ledgerDir, { mode: 0o700 })
  const qualification = qualified ? await fixtureQualification(directory, transport.version, now()) : {}
  const options = {
    directory: ledgerDir, ownerId: OWNER, machineId: MACHINE, bearerToken: TOKEN,
    transport, timeoutMs, now, ...qualification, ...extra,
  }
  const broker = await NativeBroker.open(options)
  return {
    directory, ledgerDir, options, broker, transport,
    async cleanup() { broker.close(); await rm(directory, { recursive: true, force: true }) },
  }
}
