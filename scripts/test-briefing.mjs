/**
 * Phase 3 briefing tests (Persistent Companion spec §16, §17, §25.19-23).
 *
 * Runs the real Supervisor + MissionStore against the scripted provider
 * (shared with the runtime suite) and exercises the return experience:
 * concise outcome briefings, the coverage ledger (watermark + sparse acks),
 * reconnect coalescing, cross-surface acknowledgement, the fixed briefing
 * target, last-known freshness labeling, the phone inbox projection, and the
 * acknowledgement validation rules.
 *
 * Usage: npm run test:briefing
 */
import {
  TestKV,
  makeClients,
  makeRuntime,
  cmd,
  mission,
  snapshotOf,
  drive,
  settleAll,
  quiesce,
  makeTally,
} from './lib/runtime-fake.mjs'
import {
  advanceWatermark,
  applyAcknowledgement,
  coveredIdsFor,
  coverageOf,
  coversMatch,
  isAcknowledged,
} from '../src/briefing/receipts.ts'
import { isMeaningful } from '../src/briefing/meaning.ts'
import { buildBriefing, cardsForSurface, GLASSES_CARD_LIMIT } from '../src/briefing/build.ts'
import { initialSpriiteState, validateSpriiteState } from '../src/domain/state.ts'

const { assert, failures } = makeTally()

/** A synthetic journal event for the pure-ledger unit tests. */
function ev(seq, type, missionId = undefined, payload = {}) {
  return {
    schemaVersion: 2,
    eventId: `e${seq}`,
    seq,
    entityId: 'entity_test',
    ...(missionId === undefined ? {} : { missionId }),
    type,
    observedAt: `2026-10-06T12:${String(seq).padStart(2, '0')}:00Z`,
    payload,
  }
}

/** A pending briefing shape for the pure-ledger unit tests. */
function briefOf(scope, targetSeq, coveredEventIds) {
  return {
    schemaVersion: 2,
    briefingId: `brf_${targetSeq}`,
    scope,
    kind: 'return',
    targetSeq,
    coveredEventIds,
    missionRevisions: {},
    cards: [],
    createdAt: '2026-10-06T13:00:00Z',
  }
}

console.log('== Briefing tests (spec §16, §17, §25.19-23) ==')

// ------------------------------------------------ R. the coverage ledger
{
  // Interleaved missions: A at seqs 1 and 3, B at seqs 2 and 4. This is the
  // shape that needs the sparse set: a mission ack cannot move the cursor
  // over the OTHER mission's unseen events.
  const events = [
    ev(1, 'mission_created', 'mA'),
    ev(2, 'mission_created', 'mB'),
    ev(3, 'milestone_accepted', 'mA'),
    ev(4, 'mission_completed', 'mB'),
  ]
  const coverage = { acknowledgedSeq: 0, acknowledgedEvents: {} }

  const ids = (list) => list.map((e) => e.eventId)

  // Owner scope covers the WHOLE considered range, meaningful or not.
  const ownerCovered = coveredIdsFor(briefOf({ kind: 'owner' }, 4, []), events)
  assert(
    ids(events).every((id) => ownerCovered.has(id)) && ownerCovered.size === 4,
    'an owner acknowledgement covers every event up to the fixed target (§16)',
  )

  // Mission scope covers only that mission's events in the range.
  const aCovered = coveredIdsFor(briefOf({ kind: 'mission', missionId: 'mA' }, 4, []), events)
  assert(
    aCovered.has('e1') && aCovered.has('e3') && !aCovered.has('e2') && !aCovered.has('e4'),
    'a mission acknowledgement covers only that mission\u2019s events; the other mission stays unseen',
  )

  // The watermark stops at the first uncovered event.
  const walk = advanceWatermark(events, new Set(['e1', 'e3']), 0)
  assert(walk === 1, 'the watermark advances only over provably covered events')
  assert(
    advanceWatermark(events, new Set(['e1', 'e4']), 0) === 1,
    'the cursor never passes an omitted unseen event, even with later ones covered',
  )

  // The watermark stops at a compaction gap: events the window no longer
  // holds are unseeable, so the cursor must not jump over them.
  const gapped = [ev(3, 'milestone_accepted', 'mA'), ev(5, 'mission_completed', 'mB')]
  assert(
    advanceWatermark(gapped, new Set(['e3', 'e5']), 0) === 0,
    'a window gap stops the watermark instead of skipping held-back events',
  )

  // coversMatch: order and duplicates do not matter; a different set does.
  assert(coversMatch(briefOf({ kind: 'owner' }, 4, ['e2', 'e1']), ['e1', 'e1', 'e2']), 'echo comparison tolerates order and duplicates')
  assert(!coversMatch(briefOf({ kind: 'owner' }, 4, ['e1']), ['e1', 'e2']), 'an echo with an extra id is rejected')

  // Mission A acks its interleaved slice: the watermark stops at B's unseen
  // event, and A's beyond-watermark event rides the sparse set.
  const afterA = applyAcknowledgement(briefOf({ kind: 'mission', missionId: 'mA' }, 4, []), events, coverage, '2026-10-06T14:00:00Z')
  assert(
    afterA.acknowledgedSeq === 1 && 'e3' in afterA.acknowledgedEvents && !('e1' in afterA.acknowledgedEvents),
    'a mission ack stops the watermark at the other mission\u2019s unseen event and sparsely holds its own',
  )

  // A brief that NAMES a compaction gap settles it: the seqs below the gap
  // are unseeable, so the cursor may start above them (§9/§16).
  const gappedSettle = applyAcknowledgement(
    { ...briefOf({ kind: 'owner' }, 6, []), gapBeforeSeq: 2 },
    gapped,
    { acknowledgedSeq: 0, acknowledgedEvents: {} },
    '2026-10-06T14:15:00Z',
  )
  assert(
    gappedSettle.acknowledgedSeq === 3,
    'a gap-naming ack starts the walk above the named gap, then stops at the NEXT gap',
  )
  const gapOnly = applyAcknowledgement(
    { ...briefOf({ kind: 'return' }, 6, []), gapBeforeSeq: 2 },
    gapped,
    { acknowledgedSeq: 0, acknowledgedEvents: {} },
    '2026-10-06T14:20:00Z',
  )
  assert(
    gapOnly.acknowledgedSeq === 2 && Object.keys(gapOnly.acknowledgedEvents).length === 0,
    'a gap-only ack (no ids to echo) still settles exactly the gap it named',
  )

  // A brief may declare an id outside its own scope (the absence line in a
  // mission brief names an owner-wide recovery event). The echo was already
  // validated, so it must be PROVEN — otherwise it settles nothing and the
  // line repeats forever.
  const mixed = [ev(1, 'mission_created', 'mA'), ev(2, 'recovery_completed'), ev(3, 'run_observed', 'mB')]
  const missionAck = applyAcknowledgement(
    briefOf({ kind: 'mission', missionId: 'mA' }, 3, ['e2']),
    mixed,
    { acknowledgedSeq: 0, acknowledgedEvents: {} },
    '2026-10-06T14:45:00Z',
  )
  assert(
    missionAck.acknowledgedSeq === 2,
    'an out-of-scope id the briefing itself declared is proven, so the ack settles it (no repeat)',
  )
  const withoutSeeding = applyAcknowledgement(
    briefOf({ kind: 'mission', missionId: 'mA' }, 3, []),
    mixed,
    { acknowledgedSeq: 0, acknowledgedEvents: {} },
    '2026-10-06T14:45:00Z',
  )
  assert(
    withoutSeeding.acknowledgedSeq === 1,
    'without the declared id, the walk correctly stops before the unproven absence event',
  )

  // The sparse entry suppresses a replay for A's next brief.
  const aUnseen = events.filter(
    (e) =>
      e.missionId === 'mA' &&
      e.seq > afterA.acknowledgedSeq &&
      !(e.eventId in afterA.acknowledgedEvents),
  )
  assert(aUnseen.length === 0, 'sparse acks mean no replay of A\u2019s covered events in A\u2019s next brief')

  // A later B ack walks over A's already-proven event and owns the rest.
  const afterB = applyAcknowledgement(briefOf({ kind: 'mission', missionId: 'mB' }, 4, []), events, {
    acknowledgedSeq: afterA.acknowledgedSeq,
    acknowledgedEvents: afterA.acknowledgedEvents,
  }, '2026-10-06T14:30:00Z')
  assert(
    afterB.acknowledgedSeq === 4,
    'a later ack advances over events proven by earlier sparse acks (no skipped, no replay)',
  )
  assert(Object.keys(afterB.acknowledgedEvents).length === 0, 'entries below the watermark are pruned, keeping the set bounded')
  assert(
    isAcknowledged('e3', events, { acknowledgedSeq: afterA.acknowledgedSeq, acknowledgedEvents: afterA.acknowledgedEvents }) &&
      !isAcknowledged('e2', events, { acknowledgedSeq: afterA.acknowledgedSeq, acknowledgedEvents: afterA.acknowledgedEvents }),
    'isAcknowledged sees sparse acks and the watermark alike',
  )
}

// ------------------------------ B1 (§25.19). one concise outcome briefing
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b1'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  const finished = await drive(ctx, () => mission(ctx, id).phase === 'completed', 120000, 500)
  assert(finished, 'the mission completed while the owner was away')
  await settleAll(ctx)

  const brief = await ctx.supervisor.getBriefing('phone')
  assert(brief.kind === 'return', 'unseen outcomes produce a return briefing')
  assert(brief.targetSeq === ctx.supervisor.missionStore.journalSeq, 'the target is the journal head at build time (§16)')
  const journal = ctx.supervisor.missionStore.events
  assert(
    brief.coveredEventIds.length > 0 &&
      brief.coveredEventIds.every((cid) => journal.some((e) => e.eventId === cid && e.seq <= brief.targetSeq)),
    'covered ids name real events inside the fixed target',
  )
  const planish = journal.filter((e) => ['run_observed', 'plan_revised', 'command_received', 'mission_created'].includes(e.type))
  assert(
    planish.length >= 3 && brief.coveredEventIds.every((cid) => !planish.some((e) => e.eventId === cid)),
    'planning and run transitions carry no cards: they are collapsed, not replayed',
  )
  assert(brief.cards.length === 1, 'the whole run collapses to ONE card (§25.19)')
  const card = brief.cards[0]
  assert(card.rank === 2 && card.missionId === id, 'a completed mission is rank 2 and tied to its mission')
  assert(
    /ready|Delivered/i.test(card.headline) === true && /Deliver the empty-state screen/i.test(card.headline),
    'the headline is direct outcome language naming the work',
  )
  assert(card.evidenceUrl === `${'https://github.com/example/sprite-test'}/pull/9`, 'the card carries the PR evidence link')
  assert(card.freshness === 'current', 'a just-observed completion is labeled current')

  // The ack covers the whole considered range (cards or not) and lands the
  // watermark on the fixed target.
  const ack = await ctx.supervisor.acknowledgeBriefing({
    briefingId: brief.briefingId,
    coveredEventIds: brief.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(ack.ok === true && ack.acknowledgedSeq === brief.targetSeq, 'acknowledgement advances the watermark to the fixed target')
  assert(eventsAck(ctx, brief.briefingId).length === 1, 'the acknowledgement is a durable journal event')
}

function eventsAck(ctx, briefingId) {
  return ctx.supervisor.missionStore.events.filter((e) => e.type === 'briefing_acknowledged' && e.payload.briefingId === briefingId)
}

// --------------------- B2 (§25.20). a disconnect keeps the briefing eligible
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b2'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => mission(ctx, id).phase === 'completed', 120000, 500)
  await settleAll(ctx)

  const glasses = await ctx.supervisor.getBriefing('glasses')
  // The glasses drop mid-card, then BOTH surfaces reconnect: the same
  // account is shown again, never a different one mid-flight.
  const again = await ctx.supervisor.getBriefing('glasses')
  const phone = await ctx.supervisor.getBriefing('phone')
  assert(
    again.briefingId === glasses.briefingId && phone.briefingId === glasses.briefingId,
    'reconnects coalesce onto the same pending briefing until it is acknowledged (§25.20)',
  )
  assert(
    ctx.supervisor.getInbox().pendingBriefings.length === 1,
    'the inbox shows one pending briefing, not one per surface delivery',
  )
  const deliveries = ctx.supervisor.missionStore.current.briefingDeliveries ?? []
  assert(
    deliveries.some((d) => d.surfaceId === 'glasses' && d.briefingId === glasses.briefingId) &&
      deliveries.some((d) => d.surfaceId === 'phone' && d.briefingId === glasses.briefingId),
    'per-surface delivery attempts are recorded separately from acknowledgement (§16)',
  )

  // A wrong echo is refused, the brief stays pending, the right one lands.
  const stale = await ctx.supervisor.acknowledgeBriefing({ briefingId: glasses.briefingId, coveredEventIds: [], surfaceId: 'phone' })
  assert(stale.ok === false && stale.reason === 'stale' && stale.expected.length === glasses.coveredEventIds.length, 'a wrong echo is rejected as stale with the expected ids')
  assert(ctx.supervisor.getInbox().pendingBriefings.length === 1, 'a rejected acknowledgement leaves the briefing pending')
  const ok = await ctx.supervisor.acknowledgeBriefing({
    briefingId: glasses.briefingId,
    coveredEventIds: glasses.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(ok.ok === true, 'the exact echo acknowledges the briefing')
  const next = await ctx.supervisor.getBriefing('glasses')
  assert(next.briefingId !== glasses.briefingId, 'after acknowledgement a fresh brief is built, not the old one replayed')
  assert(next.kind === 'status' || next.coveredEventIds.length === 0, 'nothing covered remains to repeat (no replay)')
}

// --------------- B3 (§25.21). cross-surface ack; decisions are retained
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const a = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b3a'))).missionId
  const b = (await ctx.supervisor.submitCommand(cmd('Verify the bounds', 'b3b'))).missionId
  for (const id of [a, b]) {
    await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
    ctx.supervisor.handleAction(id, 'begin')
    ctx.supervisor.handleAction(id, 'use_it')
  }
  await drive(ctx, () => mission(ctx, a).phase === 'completed' && mission(ctx, b).phase === 'completed', 180000, 500)
  await settleAll(ctx)

  // The glasses asked about mission A specifically.
  const glasses = await ctx.supervisor.getBriefing('glasses', { kind: 'mission', missionId: a })
  assert(glasses.kind === 'return' && glasses.cards.every((c) => c.missionId === a || c.missionId === undefined), 'a mission brief accounts for that mission only')
  // Then the phone took the owner-wide account.
  const phone = await ctx.supervisor.getBriefing('phone')
  assert(phone.briefingId !== glasses.briefingId, 'owner and mission briefings stay distinct records')

  const ack = await ctx.supervisor.acknowledgeBriefing({
    briefingId: phone.briefingId,
    coveredEventIds: phone.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(ack.ok === true, 'the phone acknowledges its brief')
  assert(
    ack.superseded.includes(glasses.briefingId),
    'the owner-wide ack supersedes the glasses\u2019 pending mission brief (cross-surface, §25.21)',
  )
  assert((ctx.supervisor.missionStore.current.briefings ?? []).length === 0, 'no pending briefings remain after the cross-surface ack')

  const after = await ctx.supervisor.getBriefing('glasses', { kind: 'mission', missionId: a })
  assert(
    after.kind === 'status' && !after.cards.some((c) => c.coveredEventIds.some((cid) => glasses.coveredEventIds.includes(cid))),
    'the glasses do not get a replay of events acknowledged on the phone: the account is a status line, not a return',
  )

  // An unresolved decision is NOT suppressed by acknowledgement: it is
  // state, not journal history.
  const c = (await ctx.supervisor.submitCommand(cmd('Polish the animations', 'b3c'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, c)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(c, 'begin')
  await ctx.supervisor.flush()
  const open = ctx.supervisor.decisions.find((d) => d.missionId === c && d.answeredAt === null)
  assert(open !== undefined, 'a decision is waiting on the owner')
  const withDecision = await ctx.supervisor.getBriefing('phone')
  const dcard = withDecision.cards.find((cd) => cd.decisionId === open.decisionId)
  assert(dcard !== undefined && dcard.rank === 1, 'an unresolved decision is the top card even among other news')
  await ctx.supervisor.acknowledgeBriefing({
    briefingId: withDecision.briefingId,
    coveredEventIds: withDecision.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(
    ctx.supervisor.decisions.find((d) => d.decisionId === open.decisionId)?.answeredAt == null,
    'acknowledging a briefing never answers the decision (§16)',
  )
  const nextBrief = await ctx.supervisor.getBriefing('phone')
  assert(
    nextBrief.cards.some((cd) => cd.decisionId === open.decisionId && cd.rank === 1),
    'the unresolved decision reappears after the ack until it is answered (§25.21)',
  )
  assert(mission(ctx, c).phase === 'awaiting_decision', 'the mission is still suspended on the decision')
}

// ----------------- B4 (§25.22). events after the target go to the NEXT brief
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const first = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b4a'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, first)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(first, 'begin')
  ctx.supervisor.handleAction(first, 'use_it')
  const doneFirst = await drive(ctx, () => mission(ctx, first).phase === 'completed', 120000, 500)
  assert(doneFirst, 'mission one completed before the brief was built')
  await settleAll(ctx)

  // The brief is built with a FIXED target over mission one's world.
  const b1 = await ctx.supervisor.getBriefing('phone')
  assert(b1.kind === 'return' && b1.cards.some((cd) => cd.missionId === first), 'the first brief accounts for the completed mission')
  const target = b1.targetSeq

  // New work is submitted and finishes while the brief is still on screen.
  const second = (await ctx.supervisor.submitCommand(cmd('Verify the bounds', 'b4b'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, second)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(second, 'begin')
  ctx.supervisor.handleAction(second, 'use_it')
  const doneSecond = await drive(ctx, () => mission(ctx, second).phase === 'completed', 180000, 500)
  assert(doneSecond, 'mission two completed while the brief was presented')
  await settleAll(ctx)
  assert(ctx.supervisor.missionStore.journalSeq > target, 'the journal grew while the briefing was presented')

  const ack = await ctx.supervisor.acknowledgeBriefing({
    briefingId: b1.briefingId,
    coveredEventIds: b1.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(
    ack.ok === true && ack.acknowledgedSeq === target,
    'the ack advances the watermark only to the fixed target; later events stay unseen (§25.22)',
  )

  const b2 = await ctx.supervisor.getBriefing('phone')
  assert(b2.kind === 'return' && b2.briefingId !== b1.briefingId, 'the next brief is a new record')
  assert(
    b2.coveredEventIds.length > 0 && b2.coveredEventIds.every((cid) => !b1.coveredEventIds.includes(cid)),
    'the next brief covers only events that arrived after the fixed target',
  )
  assert(
    b2.cards.some((cd) => cd.missionId === second),
    'the next brief carries mission two\u2019s outcome',
  )
}

// ------------------------ B5 (§25.23). failed freshness labels last-known
{
  const opts = { getSessionFailures: [] }
  const kv = new TestKV()
  const clients = makeClients(opts)
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b5'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).some((j) => j.state === 'building'), 60000)
  await settleAll(ctx)
  assert(mission(ctx, id).freshness === 'current', 'a healthy observation leaves the mission current')

  // The next provider check fails with a kinded auth error: not a blip, so
  // the engine surfaces the fault and the mission is no longer confirmed.
  opts.getSessionFailures.push(Object.assign(new Error('403 unauthorized'), { kind: 'auth' }))
  await drive(ctx, () => mission(ctx, id).freshness !== 'current' &&
    ctx.supervisor.missionStore.events.some(e => e.type === 'provider_connectivity_changed' && e.payload.kind === 'auth'), 30000, 250)
  await ctx.supervisor.flush()

  const brief = await ctx.supervisor.getBriefing('phone')
  assert(brief.kind === 'return', 'the connectivity change is a return brief')
  const card = brief.cards.find((cd) => cd.missionId === id)
  assert(card !== undefined, 'the blocked mission has a card')
  assert(
    card.freshness === 'unknown' || card.freshness === 'stale',
    'a failed check is never labeled current (§5)',
  )
  assert(
    /last-known/i.test(card.detail ?? ''),
    'the card labels its progress last-known when the last check failed (§25.23)',
  )
  assert(/blocked: auth/i.test(card.headline), 'an owner-actionable block names the account fix')
  assert(
    brief.coveredEventIds.some((cid) =>
      ctx.supervisor.missionStore.events.some((e) => e.eventId === cid && e.type === 'provider_connectivity_changed'),
    ),
    'the connectivity fault is one of the covered events',
  )
}

// ---------------------------- B6. runtime absence says so, honestly
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  const boot1 = await ctx.supervisor.boot()
  assert(boot1.epoch === 1, 'fresh boot is epoch 1')
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b6'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).some((j) => j.state === 'building'), 60000)
  const seen = await ctx.supervisor.getBriefing('phone')
  await ctx.supervisor.acknowledgeBriefing({ briefingId: seen.briefingId, coveredEventIds: seen.coveredEventIds, surfaceId: 'phone' })

  // The process dies. A new generation boots over the same storage.
  const clients2 = makeClients()
  const ctx2 = makeRuntime(kv, clients2, { capacity: 4 })
  const boot2 = await ctx2.supervisor.boot()
  assert(boot2.epoch === 2, 'the new generation takes epoch 2')

  const brief = await ctx2.supervisor.getBriefing('glasses')
  assert(
    brief.cards.some((cd) => /offline/i.test(cd.headline)),
    'a restart since the last acknowledgement produces the offline line',
  )
  assert(brief.kind === 'absent' || brief.kind === 'return', 'the absent variant is explicit, never a silent status')
  const ackAbsent = await ctx2.supervisor.acknowledgeBriefing({
    briefingId: brief.briefingId,
    coveredEventIds: brief.coveredEventIds,
    surfaceId: 'glasses',
  })
  assert(ackAbsent.ok === true, 'the absence line is acknowledgeable, not a permanent banner (§16)')
  const afterAbsent = await ctx2.supervisor.getBriefing('glasses')
  assert(
    afterAbsent.cards.every((cd) => !/offline/i.test(cd.headline)),
    'an acknowledged absence never repeats',
  )
  await ctx2.supervisor.tick(ctx2.clock.now)
  await ctx2.supervisor.flush()

  // First-boot honesty: an empty world does not claim absence.
  const fresh = makeRuntime(new TestKV(), makeClients(), { capacity: 4 })
  await fresh.supervisor.boot()
  const empty = await fresh.supervisor.getBriefing('phone')
  assert(empty.cards.every((cd) => !/offline/i.test(cd.headline)), 'a first-ever boot is not reported as an absence')
}

// ------------------------------ B7. the status variant says what is running
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b7'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).some((j) => j.state === 'building'), 60000)
  await settleAll(ctx)

  const first = await ctx.supervisor.getBriefing('phone')
  await ctx.supervisor.acknowledgeBriefing({ briefingId: first.briefingId, coveredEventIds: first.coveredEventIds, surfaceId: 'phone' })

  // The run keeps producing events (review, milestones): acknowledge each
  // return brief until the world is quiet, THEN the status variant must hold.
  let status = await ctx.supervisor.getBriefing('phone')
  for (let i = 0; i < 5 && status.kind === 'return'; i += 1) {
    await ctx.supervisor.acknowledgeBriefing({
      briefingId: status.briefingId,
      coveredEventIds: status.coveredEventIds,
      surfaceId: 'phone',
    })
    await settleAll(ctx)
    status = await ctx.supervisor.getBriefing('phone')
  }
  assert(status.kind === 'status', 'with nothing new unseen, the brief is an honest status line')
  const focus = status.cards.find((cd) => cd.missionId === id)
  assert(focus !== undefined && focus.rank === 5, 'the status card is the lowest rank')
  assert(
    /Nothing new\. Still /i.test(focus.headline) && /Deliver the empty-state screen/i.test(focus.headline),
    'status copy names the running work and when it was last checked (§16)',
  )
  assert(/Last checked/i.test(focus.detail ?? ''), 'the status line says when the work was last checked')
  assert(status.coveredEventIds.length === 0, 'a status brief requires no acknowledgement')
}

// ------------------------------------------- B8. the phone inbox projection
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const done = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b8'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, done)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(done, 'begin')
  ctx.supervisor.handleAction(done, 'use_it')
  const finished = await drive(ctx, () => mission(ctx, done).phase === 'completed', 120000, 500)
  assert(finished, 'the mission completed')
  await settleAll(ctx)

  const inbox = ctx.supervisor.getInbox()
  assert(inbox.health.epoch === 1 && inbox.health.durability === 'ok', 'health reports the runtime epoch and store durability')
  assert(
    inbox.health.intake.lastCheckAt === null && inbox.health.intake.configured === false,
    'an unconfigured intake is "never checked", never "no requests" (§11)',
  )
  const row = inbox.missions.find((r) => r.missionId === done)
  assert(row !== undefined && row.phase === 'completed', 'terminal missions stay in the inbox (evidence)')
  assert(row.unseenChanges === true && row.unseenEventIds.length > 0, 'rows flag unseen changes before acknowledgement')
  assert(
    row.unseenEventIds.every((e) =>
      ctx.supervisor.missionStore.events.some((evt) => evt.eventId === e.eventId && isMeaningful(evt)),
    ),
    'the unseen list carries meaningful changes only: a noise badge teaches the owner to ignore it (§16/§17)',
  )
  assert(
    !row.unseenEventIds.some((e) => e.type === 'command_received' || e.type === 'mission_created' || e.type === 'run_observed'),
    'concrete noise types (receipt, creation, ordinary phase transitions) never reach the unseen list',
  )
  assert(
    ctx.supervisor.missionStore.events.some((e) => e.type === 'run_observed') &&
      !row.unseenEventIds.some((e) => e.type === 'run_observed'),
    'the window really does hold run transitions, so the filter above is doing work',
  )
  assert(inbox.openDecisions.length === 0, 'no decisions are open in this world')

  const brief = await ctx.supervisor.getBriefing('phone')
  const pending = ctx.supervisor.getInbox().pendingBriefings
  assert(
    pending.length === 1 && pending[0].briefingId === brief.briefingId && pending[0].cardCount === brief.cards.length,
    'the inbox lists the pending briefing with its card count',
  )
  await ctx.supervisor.acknowledgeBriefing({ briefingId: brief.briefingId, coveredEventIds: brief.coveredEventIds, surfaceId: 'phone' })
  const after = ctx.supervisor.getInbox()
  assert(after.pendingBriefings.length === 0, 'acknowledged briefings leave the inbox')
  assert(after.missions.find((r) => r.missionId === done).unseenChanges === false, 'rows clear their unseen flag after the ack')
  assert(after.acknowledgedSeq === brief.targetSeq, 'the inbox exposes the coverage watermark')

  // Unknown launches surface in health, never as a health score.
  const kv2 = new TestKV()
  const flaky = makeClients({ transportFailCreateSession: true })
  const ctx2 = makeRuntime(kv2, flaky, { capacity: 4 })
  await ctx2.supervisor.boot()
  const u = (await ctx2.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b8u'))).missionId
  await drive(ctx2, () => (ctx2.supervisor.unresolvedDispatches.length > 0), 30000)
  const inbox2 = ctx2.supervisor.getInbox()
  assert(
    inbox2.health.unresolvedDispatches.some((d) => d.includes(u)),
    'an unknown launch is named in health, not hidden (§21)',
  )
}

// ------------------------ B9. acknowledgement validation and idempotence
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b9'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  const finished = await drive(ctx, () => mission(ctx, id).phase === 'completed', 120000, 500)
  assert(finished, 'the mission completed')
  await settleAll(ctx)

  const unknown = await ctx.supervisor.acknowledgeBriefing({ briefingId: 'brf_nope', coveredEventIds: [] })
  assert(unknown.ok === false && unknown.reason === 'unknown', 'an id that is not pending is unknown, never a success')

  const brief = await ctx.supervisor.getBriefing('phone')
  const first = await ctx.supervisor.acknowledgeBriefing({
    briefingId: brief.briefingId,
    coveredEventIds: brief.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(first.ok === true, 'the first acknowledgement lands')
  const second = await ctx.supervisor.acknowledgeBriefing({
    briefingId: brief.briefingId,
    coveredEventIds: brief.coveredEventIds,
    surfaceId: 'glasses',
  })
  assert(second.ok === false && second.reason === 'unknown', 'a repeat ack is unknown: already acknowledged, not an error loop')
  assert(
    eventsAck(ctx, brief.briefingId).length === 1,
    'the acknowledged briefing is journalled exactly once',
  )
}

// ---------- B10. hold-back at watermark 0, and the named gap that settles
{
  const kv = new TestKV()
  const clients = makeClients()
  // A deliberately tiny window: the ceiling has to evict, and the briefing
  // has to say so instead of quietly skipping the range it lost.
  const ctx = makeRuntime(kv, clients, { capacity: 4, eventWindow: 4, maxEventWindow: 6 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b10'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  const finished = await drive(ctx, () => mission(ctx, id).phase === 'completed', 120000, 500)
  assert(finished, 'the mission completed')
  await settleAll(ctx)

  const store = ctx.supervisor.missionStore
  assert(store.journalSeq > 6, 'the journal grew past the hard ceiling')
  assert(
    store.events.length === 6,
    'with nothing acknowledged, unseen events are held up to the ceiling instead of being compacted away (§9)',
  )
  assert(store.events.at(-1).seq === store.journalSeq, 'the window still ends at the journal head')
  const firstSeq = store.events[0].seq
  assert(firstSeq > 1, 'the window really did move: this is a gap, not a fresh world')

  const brief = await ctx.supervisor.getBriefing('phone')
  assert(
    brief.kind === 'return' && brief.gapBeforeSeq === firstSeq - 1,
    'the brief names the unseeable range as gapBeforeSeq (§9/§16)',
  )
  assert(brief.cards.some((c) => /compacted/i.test(c.headline)), 'the gap is a card, never a silent skip')
  assert(
    brief.cards.some((c) => c.missionId === id && c.rank === 2 && /ready/i.test(c.headline)),
    'the real outcome is still the card that matters',
  )

  const ack = await ctx.supervisor.acknowledgeBriefing({
    briefingId: brief.briefingId,
    coveredEventIds: brief.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(
    ack.ok === true && ack.acknowledgedSeq === brief.targetSeq,
    'acknowledging the account settles the named gap and everything behind it',
  )
  const next = await ctx.supervisor.getBriefing('phone')
  assert(next.kind === 'status', 'a settled world is a status brief, not another return')
  assert(
    !next.cards.some((c) => /compacted/i.test(c.headline)),
    'the settled gap never repeats (§9: named once, then settled)',
  )
  assert(
    next.cards.some((c) => c.missionId === id && c.rank === 5 && /is done/i.test(c.headline)),
    'the status line still says what is true about the last mission',
  )
}

// ------------------ B11. a storage failure on the ack is never success (§8)
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b11'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  const finished = await drive(ctx, () => mission(ctx, id).phase === 'completed', 120000, 500)
  assert(finished, 'the mission completed')
  await settleAll(ctx)

  const brief = await ctx.supervisor.getBriefing('phone')
  const before = ctx.supervisor.missionStore.current.acknowledgedSeq
  kv.failNextSets = 1
  const failed = await ctx.supervisor.acknowledgeBriefing({
    briefingId: brief.briefingId,
    coveredEventIds: brief.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(
    failed.ok === false && failed.reason === 'storage',
    'a ledger write that did not land is reported as storage, not as an acknowledgement and not as unknown (§8)',
  )
  assert(ctx.supervisor.missionStore.durability === 'broken', 'the store marks itself broken after a failed write')
  assert(
    (ctx.supervisor.missionStore.current.briefings ?? []).some((b) => b.briefingId === brief.briefingId),
    'the account stays pending: the owner did not lose it to a failed write',
  )
  assert(ctx.supervisor.missionStore.current.acknowledgedSeq === before, 'the watermark did not move')
}

// ---------- B12. urgent news breaks coalescing; ordinary news does not
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const a = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b12a'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, a)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(a, 'begin')
  ctx.supervisor.handleAction(a, 'use_it')
  const doneA = await drive(ctx, () => mission(ctx, a).phase === 'completed', 120000, 500)
  assert(doneA, 'mission one completed')
  await settleAll(ctx)

  const first = await ctx.supervisor.getBriefing('phone')
  assert(first.kind === 'return', 'the completion is a return brief')

  // A question opens while that account is still on screen.
  const b = (await ctx.supervisor.submitCommand(cmd('Verify the bounds', 'b12b'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, b)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(b, 'begin')
  await ctx.supervisor.flush()
  const open = ctx.supervisor.decisions.find((d) => d.missionId === b && d.answeredAt === null)
  assert(open !== undefined, 'a decision is waiting on the owner')

  const urgent = await ctx.supervisor.getBriefing('phone')
  assert(
    urgent.briefingId !== first.briefingId,
    'an unanswered decision is never held behind a fixed target (§16)',
  )
  assert(
    urgent.cards.some((c) => c.decisionId === open.decisionId && c.rank === 1),
    'the replacement carries the question at rank 1',
  )
  assert(
    (ctx.supervisor.missionStore.current.briefings ?? []).length === 1,
    'the replaced record is dropped, not orphaned in the pending list',
  )
  const lateAck = await ctx.supervisor.acknowledgeBriefing({
    briefingId: first.briefingId,
    coveredEventIds: first.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(lateAck.ok === false && lateAck.reason === 'unknown', 'the superseded account can no longer be acknowledged')

  // An ordinary outcome arrives while the question is pending: coalescing holds.
  const c = (await ctx.supervisor.submitCommand(cmd('Polish the animations', 'b12c'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, c)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(c, 'begin')
  ctx.supervisor.handleAction(c, 'use_it')
  const doneC = await drive(ctx, () => mission(ctx, c).phase === 'completed', 120000, 500)
  assert(doneC, 'mission three completed')
  await settleAll(ctx)
  const coalesced = await ctx.supervisor.getBriefing('phone')
  assert(
    coalesced.briefingId === urgent.briefingId,
    'a completion alone does not swap the account mid-flight (§25.20)',
  )
  const coverAll = await ctx.supervisor.acknowledgeBriefing({
    briefingId: urgent.briefingId,
    coveredEventIds: urgent.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(coverAll.ok === true, 'the coalesced account is still the one the owner acknowledges')
  const after = await ctx.supervisor.getBriefing('phone')
  assert(
    after.cards.some((cd) => cd.missionId === c && cd.rank === 2),
    'the completion deferred by the fixed target is the next brief\u2019s news (§25.22)',
  )
}

// -------------- B13. absence reaches a mission-scoped brief too (§16)
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b13'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).some((j) => j.state === 'building'), 60000)
  await settleAll(ctx)

  // The process dies mid-run; the next generation boots over the same storage.
  const ctx2 = makeRuntime(kv, makeClients(), { capacity: 4 })
  await ctx2.supervisor.boot()
  const brief = await ctx2.supervisor.getBriefing('glasses', { kind: 'mission', missionId: id })
  assert(
    brief.cards.some((c) => /offline/i.test(c.headline)),
    'the absence line reaches a mission-scoped brief: the runtime was gone, whatever the scope',
  )
}

// ------------- B14. control and terminal copy, and the honesty scan
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b14'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  await drive(ctx, () => (snapshotOf(ctx, id)?.jobs ?? []).some((j) => j.state === 'building'), 60000)
  await settleAll(ctx)

  const first = await ctx.supervisor.getBriefing('phone')
  await ctx.supervisor.acknowledgeBriefing({ briefingId: first.briefingId, coveredEventIds: first.coveredEventIds, surfaceId: 'phone' })

  ctx.supervisor.handleAction(id, 'pause')
  await settleAll(ctx)
  const paused = await ctx.supervisor.getBriefing('phone')
  const pausedCard = paused.cards.find((c) => c.missionId === id)
  assert(pausedCard !== undefined, 'the paused mission still gets a line')
  assert(
    /paused|Pausing/i.test(pausedCard.headline) && !/Still /i.test(pausedCard.headline),
    'a paused mission says it is paused, never "still building" (§16)',
  )

  // Copy honesty across every card this suite produced: freshness is never
  // claimed and a retry is never announced.
  const briefs = [first, paused]
  for (const b of briefs) {
    for (const c of b.cards) {
      const text = `${c.headline} ${c.detail ?? ''}`
      assert(!/just now/i.test(text), `no card claims "just now" freshness: ${c.headline}`)
      assert(!/Retrying/i.test(text), `no card announces a retry the runtime cannot promise: ${c.headline}`)
      assert(!/\ba offline\b/.test(text), `no card leaks broken article copy: ${c.headline}`)
      assert(c.headline.length <= 96, `headline copy is clipped to the surface budget: ${c.headline}`)
      assert((c.detail ?? '').length <= 130, `detail copy is clipped: ${c.detail ?? ''}`)
    }
  }
}

// ---- B15. pure: the glasses cap, and the checkpoint validator's briefing shape
{
  const cards = Array.from({ length: 5 }, (_, i) => ({
    rank: (i + 1),
    missionId: `m${i}`,
    headline: `card ${i}`,
    freshness: 'current',
    lastObservedAt: null,
    coveredEventIds: [],
  }))
  const brief = { schemaVersion: 2, briefingId: 'brf_x', scope: { kind: 'owner' }, kind: 'return', targetSeq: 9, coveredEventIds: [], missionRevisions: {}, cards, createdAt: '2026-10-06T13:00:00Z' }
  assert(cardsForSurface(brief, 'glasses').length === GLASSES_CARD_LIMIT, 'the glasses surface renders at most three cards (§16)')
  assert(cardsForSurface(brief, 'phone').length === 5, 'the phone keeps the full ranked list (§17)')

  const base = initialSpriiteState()
  assert(validateSpriiteState(base) !== null, 'a fresh state validates')
  assert(
    validateSpriiteState({ ...base, briefings: [{ ...brief, targetSeq: 'nine' }] }) === null,
    'a briefing with a non-numeric target is corruption, not drift',
  )
  assert(
    validateSpriiteState({ ...base, briefings: [{ ...brief, cards: [{ rank: 9, headline: 'x' }] }] }) === null,
    'a card with an unknown rank or missing fields is corruption',
  )
  assert(validateSpriiteState({ ...base, briefings: [{ ...brief }] }) !== null, 'a well-formed briefing validates')
  assert(
    validateSpriiteState({ ...base, briefings: [{ ...brief, kind: 'banana' }] }) === null,
    'a briefing kind outside the union is corruption',
  )
  assert(
    validateSpriiteState({ ...base, briefings: [{ ...brief, targetSeq: 2.5 }] }) === null,
    'a fractional journal target is corruption: the coverage walk would stall on it',
  )
  assert(
    validateSpriiteState({ ...base, briefings: [{ ...brief, gapBeforeSeq: -1 }] }) === null,
    'a negative gap is corruption',
  )
  assert(
    validateSpriiteState({ ...base, briefings: [{ ...brief, cards: [{ ...cards[0], freshness: 'purple' }] }] }) === null,
    'a card freshness outside the union is corruption',
  )
  assert(validateSpriiteState({ ...base, acknowledgedSeq: 2.5 }) === null, 'a fractional watermark is corruption')
  assert(validateSpriiteState({ ...base, acknowledgedSeq: -1 }) === null, 'a negative watermark is corruption')
  assert(
    validateSpriiteState({ ...base, missions: [{ missionId: 'm1', goal: 'g', phase: 'finished', control: 'running' }] }) === null,
    'a mission phase outside the union is corruption',
  )
  assert(
    validateSpriiteState({ ...base, missions: [{ missionId: 'm1', goal: 'g', phase: 'building', control: 'idle' }] }) === null,
    'a control mode outside the union is corruption',
  )
  assert(
    validateSpriiteState({ ...base, acknowledgedEvents: { e1: 12 } }) === null,
    'the sparse acknowledgement set must map ids to timestamps',
  )
  assert(
    validateSpriiteState({ ...base, briefingDeliveries: [{ briefingId: 'b', surfaceId: '' }] }) === null,
    'a delivery row without a surface is corruption',
  )
  assert(
    validateSpriiteState({ ...base, briefings: [{ ...brief, scope: { kind: 'mission' } }] }) === null,
    'a mission-scoped briefing must name its mission',
  )
  assert(
    validateSpriiteState({ ...base, briefings: [{ ...brief, scope: { kind: 'mission', missionId: '' } }] }) === null,
    'an empty mission id in a scope is corruption',
  )
}

// --------------------- B16. long copy stays inside the surface budgets
{
  const longGoal =
    'Deliver the empty-state screen with the onboarding illustration, the retry affordance, and the accessibility labels for every control in the flow'
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd(longGoal, 'b16'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  const finished = await drive(ctx, () => mission(ctx, id).phase === 'completed', 120000, 500)
  assert(finished, 'the long-titled mission completed')
  await settleAll(ctx)

  const brief = await ctx.supervisor.getBriefing('phone')
  const card = brief.cards.find((c) => c.missionId === id)
  assert(card !== undefined, 'the long-titled mission has a card')
  assert(card.headline.length <= 96, `a long title cannot overflow the headline (${card.headline.length} chars)`)
  assert(
    card.headline.includes('…'),
    'an over-long title is visibly clipped rather than silently truncated',
  )
}

// ---------- B17. the sweep reaches briefs whose events were compacted away
{
  const kv = new TestKV()
  const clients = makeClients()
  // A tiny window: the pending mission brief's covered events are evicted
  // before the owner-wide ack arrives.
  const ctx = makeRuntime(kv, clients, { capacity: 4, eventWindow: 4, maxEventWindow: 6 })
  await ctx.supervisor.boot()
  const a = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b17a'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, a)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(a, 'begin')
  ctx.supervisor.handleAction(a, 'use_it')
  const doneA = await drive(ctx, () => mission(ctx, a).phase === 'completed', 120000, 500)
  assert(doneA, 'mission one completed')
  await settleAll(ctx)

  // The glasses take a MISSION brief for A and leave it unacknowledged.
  const glasses = await ctx.supervisor.getBriefing('glasses', { kind: 'mission', missionId: a })
  assert(glasses.kind === 'return' && glasses.coveredEventIds.length > 0, 'the mission brief covers real events')

  // Mission B runs long enough to push A's events out of the window.
  const b = (await ctx.supervisor.submitCommand(cmd('Verify the bounds', 'b17b'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, b)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(b, 'begin')
  ctx.supervisor.handleAction(b, 'use_it')
  const doneB = await drive(ctx, () => mission(ctx, b).phase === 'completed', 120000, 500)
  assert(doneB, 'mission two completed')
  await settleAll(ctx)
  const store = ctx.supervisor.missionStore
  assert(
    glasses.coveredEventIds.every((id) => !store.events.some((e) => e.eventId === id)),
    'the pending mission brief\u2019s covered events are now outside the window',
  )

  // The phone takes the owner brief (which names the gap) and acknowledges it.
  const phone = await ctx.supervisor.getBriefing('phone')
  const ack = await ctx.supervisor.acknowledgeBriefing({
    briefingId: phone.briefingId,
    coveredEventIds: phone.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(ack.ok === true, 'the owner acknowledges the phone brief')
  assert(
    ack.superseded.includes(glasses.briefingId),
    'the owner-wide ack sweeps a pending brief whose covered events were compacted away (§16/§25.21)',
  )
  assert(
    !(ctx.supervisor.missionStore.current.briefings ?? []).some((x) => x.briefingId === glasses.briefingId),
    'the compacted brief is gone, not left pending forever',
  )
  const reGlasses = await ctx.supervisor.getBriefing('glasses', { kind: 'mission', missionId: a })
  assert(
    reGlasses.briefingId !== glasses.briefingId && reGlasses.kind === 'status',
    'the glasses get an honest status line, not a replay of the settled account',
  )
}

// ---------- B18. a mission-scoped gap card settles on its own ack
{
  // A gap is "the window starts above watermark + 1". Building it directly
  // keeps this deterministic: no need to push a real run past the ceiling.
  const state = {
    schemaVersion: 2,
    entity: { schemaVersion: 2, entityId: 'e1', name: 'Spriite', preferencesRevision: '0', createdAt: '2026-10-06T12:00:00Z' },
    missions: [mkMission('m1', 'Onboarding', 'current', '2026-10-06T12:00:00Z')],
    runs: {},
    outbox: [],
    decisions: [],
    cursors: {},
    acknowledgedSeq: 0,
    migratedFromV1: false,
  }
  const window = [ev(5, 'run_observed', 'm1', { phase: 'repairing' })]
  const brief = buildBriefing({
    state,
    events: window,
    journalSeq: 5,
    scope: { kind: 'mission', missionId: 'm1' },
    now: Date.parse('2026-10-06T12:05:00Z'),
  })
  assert(brief.kind === 'return', 'a gap-only mission brief is a return brief, not a status line')
  assert(brief.gapBeforeSeq === 4, 'a mission-scoped brief names the gap it showed, so its own ack can settle it')
  assert(brief.cards.some((c) => /compacted/i.test(c.headline)), 'the mission-scoped gap card is shown')

  const ack = applyAcknowledgement(brief, window, { acknowledgedSeq: 0, acknowledgedEvents: {} }, '2026-10-06T13:00:00Z')
  assert(ack.acknowledgedSeq === 5, 'the mission-scoped ack settles the named gap and the covered range behind it')
  const after = buildBriefing({
    state: { ...state, acknowledgedSeq: ack.acknowledgedSeq },
    events: window,
    journalSeq: 5,
    scope: { kind: 'mission', missionId: 'm1' },
    now: Date.parse('2026-10-06T13:05:00Z'),
  })
  assert(
    !after.cards.some((c) => /compacted/i.test(c.headline)),
    'the settled gap never repeats in a mission-scoped brief',
  )
}

// ---------- B19. honest status copy after the owner has answered
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b19'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  await ctx.supervisor.flush()
  const open = ctx.supervisor.decisions.find((d) => d.missionId === id && d.answeredAt === null)
  assert(open !== undefined, 'the build gate is open')
  ctx.supervisor.answerDecision(id, open.decisionId, 'proceed')
  await ctx.supervisor.flush()
  assert(
    ctx.supervisor.decisions.find((d) => d.decisionId === open.decisionId)?.answeredAt != null,
    'the durable record says the owner answered',
  )

  // Whatever the engine's own view still shows, the copy must not ask again.
  const brief = await ctx.supervisor.getBriefing('phone')
  for (const card of brief.cards) {
    const text = `${card.headline} ${card.detail ?? ''}`
    assert(
      !/Still waiting on your choice/i.test(text),
      `an answered decision is never described as still waiting: ${card.headline}`,
    )
  }
}

// ---------- B20. the still-running line is honest about every mission it names
{
  const state = {
    schemaVersion: 2,
    entity: { schemaVersion: 2, entityId: 'e1', name: 'Spriite', preferencesRevision: '0', createdAt: '2026-10-06T12:00:00Z' },
    missions: [
      mkMission('m1', 'Onboarding', 'current', '2026-10-06T12:00:00Z'),
      mkMission('m2', 'Search', 'unknown', '2026-10-03T12:00:00Z'),
      mkMission('m3', 'Checkout', 'current', '2026-10-06T12:01:00Z', 'completed'),
    ],
    runs: {},
    outbox: [],
    decisions: [],
    cursors: {},
    acknowledgedSeq: 0,
    migratedFromV1: false,
  }
  const brief = buildBriefing({
    state,
    events: [ev(1, 'mission_completed', 'm3')],
    journalSeq: 1,
    scope: { kind: 'owner' },
    now: Date.parse('2026-10-06T12:05:00Z'),
  })
  const running = brief.cards.find((c) => /Still running/i.test(c.headline))
  assert(running !== undefined, 'unseen news plus running work produces the summary line')
  assert(
    running.freshness === 'unknown',
    'a summary naming an unconfirmed mission never claims current freshness (§5)',
  )
  assert(
    running.lastObservedAt === '2026-10-03T12:00:00Z',
    'the summary carries the OLDEST observation, not the newest',
  )
  assert(
    /Not all of these are confirmed current/i.test(running.detail ?? ''),
    'the summary labels the last-known part instead of lending one mission\u2019s freshness to the rest',
  )
}

function mkMission(missionId, title, freshness, lastObservedAt, phase = 'building') {
  return {
    schemaVersion: 2,
    missionId,
    entityId: 'e1',
    productId: 'p1',
    originatingCommandId: 'c1',
    title,
    goal: title,
    phase,
    control: 'running',
    freshness,
    planRevision: 1,
    config: {
      leadProvider: 'factory',
      workerProviders: ['factory'],
      workerPreference: 'factory',
      maxConcurrentWorkers: 1,
      repository: 'https://github.com/example/sprite-test',
      baseRef: 'main',
      policyRevision: 'v2-default',
      acceptCriteria: [],
    },
    activeRunIds: [],
    decisionIds: [],
    suspendedPhase: null,
    lastObservedAt,
    createdAt: '2026-10-06T12:00:00Z',
    updatedAt: lastObservedAt,
  }
}

// ---------- B21. a mission-scoped ack clears that mission's inbox badge
{
  const kv = new TestKV()
  const clients = makeClients()
  const ctx = makeRuntime(kv, clients, { capacity: 4 })
  await ctx.supervisor.boot()
  const a = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b21a'))).missionId
  const b = (await ctx.supervisor.submitCommand(cmd('Verify the bounds', 'b21b'))).missionId
  for (const id of [a, b]) {
    await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
    ctx.supervisor.handleAction(id, 'begin')
    ctx.supervisor.handleAction(id, 'use_it')
  }
  const done = await drive(ctx, () => mission(ctx, a).phase === 'completed' && mission(ctx, b).phase === 'completed', 180000, 500)
  assert(done, 'both missions completed')
  await settleAll(ctx)

  const missionBrief = await ctx.supervisor.getBriefing('glasses', { kind: 'mission', missionId: a })
  const ack = await ctx.supervisor.acknowledgeBriefing({
    briefingId: missionBrief.briefingId,
    coveredEventIds: missionBrief.coveredEventIds,
    surfaceId: 'glasses',
  })
  assert(ack.ok === true, 'the mission brief is acknowledged on the glasses')
  const inbox = ctx.supervisor.getInbox()
  assert(
    inbox.missions.find((r) => r.missionId === a).unseenChanges === false,
    'the mission-scoped ack clears that mission\u2019s unseen badge (sparse acknowledgements count)',
  )
  assert(
    inbox.missions.find((r) => r.missionId === b).unseenChanges === true,
    'the other mission keeps its badge: a mission ack never covers another mission\u2019s events',
  )
}

// ---------- B22. a briefing pending across a restart is still acknowledgeable
{
  const kv = new TestKV()
  const ctx = makeRuntime(kv, makeClients(), { capacity: 4 })
  await ctx.supervisor.boot()
  const id = (await ctx.supervisor.submitCommand(cmd('Deliver the empty-state screen', 'b22'))).missionId
  await drive(ctx, () => (snapshotOf(ctx, id)?.planLabels.length ?? 0) > 0, 30000)
  ctx.supervisor.handleAction(id, 'begin')
  ctx.supervisor.handleAction(id, 'use_it')
  const finished = await drive(ctx, () => mission(ctx, id).phase === 'completed', 120000, 500)
  assert(finished, 'the mission completed')
  await settleAll(ctx)
  const before = await ctx.supervisor.getBriefing('phone')
  assert(before.kind === 'return', 'the account is pending acknowledgement')

  // The process dies with the account unacknowledged.
  const ctx2 = makeRuntime(kv, makeClients(), { capacity: 4 })
  await ctx2.supervisor.boot()
  const restored = ctx2.supervisor.getInbox().pendingBriefings
  assert(
    restored.some((p) => p.briefingId === before.briefingId),
    'an unacknowledged account survives a restart (§16: missing an update is worse than a repeat)',
  )
  const ack = await ctx2.supervisor.acknowledgeBriefing({
    briefingId: before.briefingId,
    coveredEventIds: before.coveredEventIds,
    surfaceId: 'phone',
  })
  assert(
    ack.ok === true && ack.acknowledgedSeq === before.targetSeq,
    'the pre-crash echo still validates and advances the watermark to the fixed target',
  )
  const after = await ctx2.supervisor.getBriefing('phone')
  assert(
    after.kind === 'absent' || after.kind === 'status',
    'the settled account is not rebuilt; the reboot is reported as absence or an honest status',
  )
  assert(
    !after.coveredEventIds.some((cid) => before.coveredEventIds.includes(cid)),
    'no covered event replays after the restart',
  )
}

console.log(failures() === 0 ? '\nAll briefing tests passed.' : `\n${failures()} briefing test(s) FAILED.`)
process.exit(failures() === 0 ? 0 : 1)
