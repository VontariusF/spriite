import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMissionV2RecordReader } from '../broker/mission-v2-record.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures', 'mission-v2', 'ac657282')
const finalDir = join(fixtureDir, 'final')
const snapshots = JSON.parse(await readFile(join(fixtureDir, 'snapshots.json'), 'utf8'))
const SESSION_ID = snapshots.approval.sessionId
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const finalMission = await readFile(join(finalDir, 'mission.md'))
const finalChecks = await readFile(join(finalDir, 'checks.json'))
const finalEvents = await readFile(join(finalDir, 'events.jsonl'))
const approvalChecks = await readFile(join(fixtureDir, 'approval-checks.json'))
const realEvent = JSON.parse(finalEvents.toString('utf8').trim())

const tempRoots = []
let passed = 0

async function makeRecord({ mission = finalMission, checks = finalChecks, events = finalEvents, sessionId = SESSION_ID } = {}) {
  const factoryDir = await mkdtemp(join(tmpdir(), 'mission-v2-record-'))
  tempRoots.push(factoryDir)
  const dir = join(factoryDir, 'missionsV2', sessionId)
  await mkdir(dir, { recursive: true })
  if (mission !== null) await writeFile(join(dir, 'mission.md'), mission)
  if (checks !== null) await writeFile(join(dir, 'checks.json'), checks)
  if (events !== null) await writeFile(join(dir, 'events.jsonl'), events)
  return { factoryDir, dir }
}

const snapshotFor = (base, overrides = {}) => ({ ...base, checkCounts: { ...base.checkCounts }, ...overrides })

function event(eventNumber, evaluations, extra = {}) {
  return {
    type: 'checks_evaluated',
    data: { evaluations: evaluations.map(([checkId, outcome]) => ({ checkId, outcome, summary: `${checkId} ${outcome}` })) },
    eventNumber,
    recordedAt: `2026-10-13T15:00:0${eventNumber % 10}.000Z`,
    ...extra,
  }
}

const jsonl = (events) => events.map((value) => `${typeof value === 'string' ? value : JSON.stringify(value)}\n`).join('')

const LOCAL_MACHINE = 'machine-local'

async function read(record, snapshot, options = {}) {
  const { machineId = LOCAL_MACHINE, ...readerOptions } = options
  const reader = createMissionV2RecordReader({ factoryDir: record.factoryDir, localMachineId: LOCAL_MACHINE, ...readerOptions })
  return reader.read({ machineId, sessionId: snapshot.sessionId, snapshot })
}

async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

const expectFailure = (result, reason) => assert.deepEqual(result, { verified: false, reason })

try {
  await test('fixture hashes match observed snapshot definitions', async () => {
    assert.equal(sha256(finalMission), snapshots.approval.planHash)
    assert.equal(sha256(approvalChecks), snapshots.approval.checksHash)
    assert.equal(sha256(finalChecks), snapshots.final.checksHash)
  })

  await test('approval snapshot verifies against approval-time record with no events', async () => {
    const record = await makeRecord({ checks: approvalChecks, events: '' })
    const result = await read(record, snapshots.approval)
    assert.equal(result.verified, true)
    assert.equal(result.title, 'Add and test greeting')
    assert.equal(result.latestEventNumber, 0)
    assert.deepEqual(result.counts, { total: 3, met: 0, unmet: 0, waived: 0 })
    assert.deepEqual(result.evaluations, {})
    assert.deepEqual(result.events, [])
    assert.deepEqual(result.checks.map((check) => check.id), ['feature-shape', 'npm-test-passes', 'local-commit-complete'])
    assert.deepEqual(result.artifacts.map((artifact) => artifact.id), ['contract', 'deliverable'])
  })

  await test('final record with event 1 verifies with every check met', async () => {
    const record = await makeRecord()
    const result = await read(record, snapshots.final)
    assert.equal(result.verified, true)
    assert.equal(result.planHash, snapshots.final.planHash)
    assert.equal(result.checksHash, snapshots.final.checksHash)
    assert.deepEqual(result.counts, { total: 3, met: 3, unmet: 0, waived: 0 })
    assert.equal(result.latestEventNumber, 1)
    for (const id of ['feature-shape', 'npm-test-passes', 'local-commit-complete']) {
      assert.equal(result.evaluations[id].outcome, 'met')
      assert.equal(result.evaluations[id].eventNumber, 1)
      assert.equal(result.evaluations[id].recordedAt, '2026-10-13T14:56:21.716Z')
    }
    assert.deepEqual(result.events, [{
      eventNumber: 1,
      recordedAt: '2026-10-13T14:56:21.716Z',
      type: 'checks_evaluated',
      checkIds: ['feature-shape', 'npm-test-passes', 'local-commit-complete'],
    }])
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.checks[0]) && Object.isFrozen(result.evaluations))
  })

  await test('reading never modifies the record', async () => {
    const record = await makeRecord()
    const before = await Promise.all(['mission.md', 'checks.json', 'events.jsonl'].map(async (name) => {
      const path = join(record.dir, name)
      return [name, sha256(await readFile(path)), (await stat(path)).mtimeMs]
    }))
    await read(record, snapshots.final)
    const after = await Promise.all(['mission.md', 'checks.json', 'events.jsonl'].map(async (name) => {
      const path = join(record.dir, name)
      return [name, sha256(await readFile(path)), (await stat(path)).mtimeMs]
    }))
    assert.deepEqual(after, before)
    assert.deepEqual((await readdir(record.dir)).sort(), ['checks.json', 'events.jsonl', 'mission.md'])
  })

  await test('approval snapshot against the later record is not verified', async () => {
    expectFailure(await read(await makeRecord(), snapshots.approval), 'checks_hash_mismatch')
    const ahead = await makeRecord({ checks: approvalChecks })
    expectFailure(await read(ahead, snapshots.approval), 'record_snapshot_mismatch')
  })

  await test('tampered mission.md fails the plan hash', async () => {
    const record = await makeRecord({ mission: Buffer.concat([finalMission, Buffer.from(' ')]) })
    expectFailure(await read(record, snapshots.final), 'plan_hash_mismatch')
  })

  await test('empty mission.md is refused', async () => {
    const mission = Buffer.from('  \n')
    const record = await makeRecord({ mission })
    expectFailure(await read(record, snapshotFor(snapshots.final, { planHash: sha256(mission) })), 'empty_plan')
  })

  await test('tampered checks.json fails the checks hash', async () => {
    const tampered = Buffer.from(finalChecks.toString('utf8').replace('Feature correctness', 'Feature correctnesS'))
    const record = await makeRecord({ checks: tampered })
    expectFailure(await read(record, snapshots.final), 'checks_hash_mismatch')
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(finalChecks.toString('utf8'))))
    expectFailure(await read(await makeRecord({ checks: reformatted }), snapshots.final), 'checks_hash_mismatch')
  })

  await test('structurally invalid checks.json with a matching hash is refused', async () => {
    const doc = JSON.parse(finalChecks.toString('utf8'))
    const cases = [
      { ...doc, checks: [...doc.checks, doc.checks[0]] },
      { ...doc, checks: [] },
      { ...doc, extra: true },
      { ...doc, checks: [{ ...doc.checks[0], kind: 'opinion' }] },
      { ...doc, checks: [{ ...doc.checks[0], about: 'nowhere' }] },
      { ...doc, checks: [{ ...doc.checks[0], how: undefined }] },
      { ...doc, artifacts: [...doc.artifacts, doc.artifacts[0]] },
      { ...doc, artifacts: [{ ...doc.artifacts[0], id: '-bad' }, doc.artifacts[1]] },
    ]
    for (const value of cases) {
      const checks = Buffer.from(JSON.stringify(value, null, 2))
      const record = await makeRecord({ checks, events: '' })
      const snapshot = snapshotFor(snapshots.approval, { checksHash: sha256(checks) })
      expectFailure(await read(record, snapshot), 'invalid_checks')
    }
    const notJson = Buffer.from('{"checks": [')
    expectFailure(await read(await makeRecord({ checks: notJson, events: '' }), snapshotFor(snapshots.approval, { checksHash: sha256(notJson) })), 'invalid_checks')
  })

  await test('snapshot behind or ahead of events is not verified', async () => {
    const record = await makeRecord()
    expectFailure(await read(record, snapshotFor(snapshots.final, { latestEventNumber: 0 })), 'record_snapshot_mismatch')
    expectFailure(await read(record, snapshotFor(snapshots.final, { latestEventNumber: 2 })), 'record_snapshot_mismatch')
  })

  await test('event number gaps, duplicates and wrong starts are refused', async () => {
    const all = ['feature-shape', 'met']
    for (const numbers of [[1, 3], [2], [1, 1], [0]]) {
      const events = jsonl(numbers.map((n) => event(n, [all])))
      const record = await makeRecord({ events })
      const snapshot = snapshotFor(snapshots.final, { latestEventNumber: numbers.length, checkCounts: { total: 3, met: 1, unmet: 0, waived: 0 } })
      const result = await read(record, snapshot)
      assert.equal(result.verified, false)
      assert.ok(['event_sequence_invalid', 'invalid_event'].includes(result.reason), `${numbers}: ${result.reason}`)
    }
    const gap = await makeRecord({ events: jsonl([event(1, [all]), event(3, [all])]) })
    expectFailure(await read(gap, snapshotFor(snapshots.final, { latestEventNumber: 2 })), 'event_sequence_invalid')
  })

  await test('evaluation of an unknown check id is refused', async () => {
    const record = await makeRecord({ events: jsonl([event(1, [['not-a-check', 'met']])]) })
    expectFailure(await read(record, snapshotFor(snapshots.final, { checkCounts: { total: 3, met: 0, unmet: 0, waived: 0 } })), 'unknown_check_id')
  })

  await test('unknown event type fails closed', async () => {
    const record = await makeRecord({ events: jsonl([realEvent, { ...event(2, [['feature-shape', 'met']]), type: 'check_waived' }]) })
    expectFailure(await read(record, snapshotFor(snapshots.final, { latestEventNumber: 2 })), 'unknown_event_type')
    const untyped = await makeRecord({ events: jsonl([{ data: realEvent.data, eventNumber: 1, recordedAt: realEvent.recordedAt }]) })
    expectFailure(await read(untyped, snapshots.final), 'unknown_event_type')
  })

  await test('schema violations inside known events are refused', async () => {
    const bad = [
      { ...event(1, [['feature-shape', 'passed']]) },
      { ...event(1, [['feature-shape', 'met']]), extra: 1 },
      { ...event(1, [['feature-shape', 'met']]), recordedAt: '2026-10-13 14:56:21' },
      { ...event(1, [['feature-shape', 'met']]), recordedAt: '2026-02-30T00:00:00.000Z' },
      { ...event(1, []) },
      { type: 'checks_evaluated', data: { evaluations: [{ checkId: 'feature-shape', outcome: 'met', summary: '' }] }, eventNumber: 1, recordedAt: realEvent.recordedAt },
      { type: 'checks_evaluated', data: { evaluations: [{ checkId: 'feature-shape', outcome: 'met', summary: 's', evidence: [{ kind: 'url', url: 'x' }] }] }, eventNumber: 1, recordedAt: realEvent.recordedAt },
      '[1,2,3]',
    ]
    for (const value of bad) {
      const record = await makeRecord({ events: jsonl([value]) })
      const result = await read(record, snapshotFor(snapshots.final, { checkCounts: { total: 3, met: 1, unmet: 0, waived: 0 } }))
      expectFailure(result, 'invalid_event')
    }
  })

  await test('symlinked files and directories are refused', async () => {
    for (const name of ['mission.md', 'checks.json', 'events.jsonl']) {
      const record = await makeRecord({ [name === 'mission.md' ? 'mission' : name === 'checks.json' ? 'checks' : 'events']: null })
      await copyFile(join(finalDir, name), join(record.factoryDir, `real-${name}`))
      await symlink(join(record.factoryDir, `real-${name}`), join(record.dir, name))
      expectFailure(await read(record, snapshots.final), 'symlink_refused')
    }
    const record = await makeRecord({ sessionId: 'elsewhere' })
    await writeFile(join(record.dir, 'mission.md'), finalMission)
    await writeFile(join(record.dir, 'checks.json'), finalChecks)
    await writeFile(join(record.dir, 'events.jsonl'), finalEvents)
    await symlink(record.dir, join(record.factoryDir, 'missionsV2', SESSION_ID))
    expectFailure(await read(record, snapshots.final), 'symlink_refused')
    const linkedRoot = await mkdtemp(join(tmpdir(), 'mission-v2-record-'))
    tempRoots.push(linkedRoot)
    await symlink(join(record.factoryDir, 'missionsV2'), join(linkedRoot, 'missionsV2'))
    expectFailure(await read({ factoryDir: linkedRoot }, snapshots.final), 'symlink_refused')
  })

  await test('non-regular files and missing files are refused', async () => {
    const record = await makeRecord({ events: null })
    expectFailure(await read(record, snapshots.final), 'missing_file')
    await mkdir(join(record.dir, 'events.jsonl'))
    expectFailure(await read(record, snapshots.final), 'not_regular_file')
    const empty = await mkdtemp(join(tmpdir(), 'mission-v2-record-'))
    tempRoots.push(empty)
    expectFailure(await read({ factoryDir: empty }, snapshots.final), 'missing_record')
  })

  await test('oversize files are refused', async () => {
    const record = await makeRecord()
    expectFailure(await read(record, snapshots.final, { maxFileBytes: 4096 }), 'file_too_large')
    assert.equal((await read(record, snapshots.final, { maxFileBytes: 8192 })).verified, true)
    const longLine = { ...event(1, [['feature-shape', 'met']]) }
    longLine.data.evaluations[0].summary = 'x'.repeat(262_200)
    const big = await makeRecord({ events: jsonl([longLine]) })
    expectFailure(await read(big, snapshotFor(snapshots.final, { checkCounts: { total: 3, met: 1, unmet: 0, waived: 0 } })), 'event_too_large')
  })

  await test('too many events are refused', async () => {
    const events = jsonl([1, 2, 3].map((n) => event(n, [['feature-shape', 'met']])))
    const record = await makeRecord({ events })
    const snapshot = snapshotFor(snapshots.final, { latestEventNumber: 3, checkCounts: { total: 3, met: 1, unmet: 0, waived: 0 } })
    expectFailure(await read(record, snapshot, { maxEvents: 2 }), 'too_many_events')
    assert.equal((await read(record, snapshot, { maxEvents: 3 })).verified, true)
  })

  await test('malformed JSON lines are refused; a torn final line is ignored like droid', async () => {
    const malformed = await makeRecord({ events: `{"type":\n${JSON.stringify(realEvent)}\n` })
    expectFailure(await read(malformed, snapshotFor(snapshots.final, { latestEventNumber: 2 })), 'invalid_event_json')
    const terminated = await makeRecord({ events: `${JSON.stringify(realEvent)}\n{"type":"checks_ev\n` })
    expectFailure(await read(terminated, snapshotFor(snapshots.final, { latestEventNumber: 2 })), 'invalid_event_json')
    const blank = await makeRecord({ events: `${JSON.stringify(realEvent)}\n\n` })
    expectFailure(await read(blank, snapshots.final), 'invalid_event_json')
    const torn = await makeRecord({ events: `${JSON.stringify(realEvent)}\n{"type":"checks_ev` })
    assert.equal((await read(torn, snapshots.final)).verified, true)
    const unterminated = await makeRecord({ events: JSON.stringify(realEvent) })
    assert.equal((await read(unterminated, snapshots.final)).verified, true)
    const badUtf8 = await makeRecord({ events: Buffer.concat([finalEvents, Buffer.from([0xff, 0x0a])]) })
    expectFailure(await read(badUtf8, snapshots.final), 'invalid_utf8')
  })

  await test('session id traversal and mismatch are refused', async () => {
    const record = await makeRecord()
    const reader = createMissionV2RecordReader({ factoryDir: record.factoryDir, localMachineId: LOCAL_MACHINE })
    for (const sessionId of ['../x', '..', '.', 'a/b', '', 'a\\b', `${SESSION_ID}/../${SESSION_ID}`, 'x'.repeat(129), 'a\u0000b']) {
      expectFailure(await reader.read({ machineId: LOCAL_MACHINE, sessionId, snapshot: snapshotFor(snapshots.final, { sessionId }) }), 'invalid_session_id')
    }
    expectFailure(await reader.read({ machineId: LOCAL_MACHINE, sessionId: SESSION_ID, snapshot: snapshotFor(snapshots.final, { sessionId: 'other' }) }), 'session_mismatch')
  })

  await test('a record read for another machine is refused before any file access', async () => {
    const record = await makeRecord()
    expectFailure(await read(record, snapshots.final, { machineId: 'machine-remote' }), 'machine_mismatch')
    const reader = createMissionV2RecordReader({ factoryDir: record.factoryDir, localMachineId: LOCAL_MACHINE })
    expectFailure(await reader.read({ machineId: 'machine-remote', sessionId: SESSION_ID, snapshot: snapshots.final }), 'machine_mismatch')
    // A local read of the same record still verifies.
    assert.equal((await reader.read({ machineId: LOCAL_MACHINE, sessionId: SESSION_ID, snapshot: snapshots.final })).verified, true)
  })

  await test('invalid snapshots are refused', async () => {
    const record = await makeRecord()
    for (const overrides of [
      { planHash: 'A'.repeat(64) },
      { checksHash: 'abc' },
      { latestEventNumber: -1 },
      { latestEventNumber: 1.5 },
      { approvedAt: 'yesterday' },
      { title: '' },
      { checkCounts: { total: 3, met: 3, unmet: 0 } },
      { extra: true },
    ]) {
      expectFailure(await read(record, snapshotFor(snapshots.final, overrides)), 'invalid_snapshot')
    }
  })

  await test('check counts must equal the snapshot', async () => {
    const record = await makeRecord()
    expectFailure(await read(record, snapshotFor(snapshots.final, { checkCounts: { total: 3, met: 2, unmet: 1, waived: 0 } })), 'check_counts_mismatch')
    expectFailure(await read(record, snapshotFor(snapshots.final, { checkCounts: { total: 4, met: 3, unmet: 0, waived: 0 } })), 'check_counts_mismatch')
  })

  await test('unmet and waived outcomes with latest-wins semantics', async () => {
    const events = jsonl([
      event(1, [['feature-shape', 'unmet'], ['npm-test-passes', 'unmet'], ['local-commit-complete', 'unmet']]),
      event(2, [['feature-shape', 'met']]),
      event(3, [['npm-test-passes', 'waived'], ['feature-shape', 'met'], ['feature-shape', 'unmet']]),
    ])
    const record = await makeRecord({ events })
    const snapshot = snapshotFor(snapshots.final, { latestEventNumber: 3, checkCounts: { total: 3, met: 0, unmet: 2, waived: 1 } })
    const result = await read(record, snapshot)
    assert.equal(result.verified, true)
    assert.deepEqual(result.counts, { total: 3, met: 0, unmet: 2, waived: 1 })
    assert.deepEqual(
      Object.fromEntries(Object.entries(result.evaluations).map(([id, value]) => [id, [value.outcome, value.eventNumber]])),
      { 'feature-shape': ['unmet', 3], 'npm-test-passes': ['waived', 3], 'local-commit-complete': ['unmet', 1] },
    )
    assert.equal(result.evaluations['feature-shape'].summary, 'feature-shape unmet')
    assert.deepEqual(result.events.map((value) => value.checkIds), [
      ['feature-shape', 'npm-test-passes', 'local-commit-complete'],
      ['feature-shape'],
      ['npm-test-passes', 'feature-shape', 'feature-shape'],
    ])
  })

  await test('programmer errors throw', async () => {
    assert.throws(() => createMissionV2RecordReader({ factoryDir: 'relative/path' }), TypeError)
    assert.throws(() => createMissionV2RecordReader({}), TypeError)
    assert.throws(() => createMissionV2RecordReader({ factoryDir: '/tmp' }), TypeError)
    assert.throws(() => createMissionV2RecordReader({ factoryDir: '/tmp', localMachineId: '' }), TypeError)
    assert.throws(() => createMissionV2RecordReader({ factoryDir: '/tmp', localMachineId: LOCAL_MACHINE, maxFileBytes: 0 }), TypeError)
    assert.throws(() => createMissionV2RecordReader({ factoryDir: '/tmp', localMachineId: LOCAL_MACHINE, maxEvents: 1.5 }), TypeError)
    const reader = createMissionV2RecordReader({ factoryDir: '/tmp', localMachineId: LOCAL_MACHINE })
    await assert.rejects(reader.read({ sessionId: SESSION_ID, snapshot: snapshots.final }), TypeError)
    await assert.rejects(reader.read({ machineId: LOCAL_MACHINE, sessionId: 1, snapshot: snapshots.final }), TypeError)
    await assert.rejects(reader.read({ machineId: LOCAL_MACHINE, sessionId: SESSION_ID, snapshot: null }), TypeError)
  })
} finally {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
}

console.log(`native mission v2 record: ${passed} tests passed`)
