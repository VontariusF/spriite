/**
 * SpriiteState construction and validation (spec §6/§8).
 *
 * The store keeps the envelope's state structurally valid: a checkpoint
 * whose state fails validation is treated as an invalid slot (recovery
 * falls back), never as a crash. Validation is deliberately permissive
 * about unknown fields — schema drift is a migration concern, not a
 * corruption concern — but strict about the shapes the runtime depends on.
 */
import { mintId, nowIso } from './ids'
import { validBuildDraft } from '../factory/build-intent'
import { BRIEFING_KINDS, CONTROL_MODES, FRESHNESS, MISSION_PHASES, X_RECEIPT_STATUSES } from './types'
import type { EntityRecord, SpriiteState } from './types'
import { decodeNativeCache, decodeNativeIntent, decodeNativeProfile } from '../native/decode'
import { nativeIntentMatchesProfile } from '../native/workspace'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

const isNumberMapString = (v: unknown): boolean =>
  isRecord(v) && Object.values(v).every((x) => typeof x === 'number')

const isStringMapString = (v: unknown): boolean =>
  isRecord(v) && Object.values(v).every((x) => typeof x === 'string')

/** A journal seq: a non-negative integer. A fractional watermark would stall
 *  the coverage walk forever; a negative one would replay the whole window. */
const isSeq = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0

const isOneOf = <T extends string>(v: unknown, allowed: readonly T[]): boolean =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v)

/** One briefing card: the shape the surfaces and the ack echo depend on. */
function validCard(c: unknown): boolean {
  if (!isRecord(c)) return false
  const rank = c.rank
  if (rank !== 1 && rank !== 2 && rank !== 3 && rank !== 4 && rank !== 5) return false
  if (typeof c.headline !== 'string' || c.headline === '') return false
  if (!isOneOf(c.freshness, FRESHNESS)) return false
  if (c.lastObservedAt !== null && typeof c.lastObservedAt !== 'string') return false
  if (!isStringArray(c.coveredEventIds)) return false
  return true
}

/** A pending briefing: a durable record the owner may still acknowledge. */
function validBriefing(b: unknown): boolean {
  if (!isRecord(b)) return false
  if (typeof b.briefingId !== 'string' || b.briefingId === '') return false
  if (!isOneOf(b.kind, BRIEFING_KINDS)) return false
  if (!isSeq(b.targetSeq)) return false
  if (!isStringArray(b.coveredEventIds)) return false
  if (!isNumberMapString(b.missionRevisions)) return false
  if (b.gapBeforeSeq !== undefined && !isSeq(b.gapBeforeSeq)) return false
  if (typeof b.createdAt !== 'string' || b.createdAt === '') return false
  if (!Array.isArray(b.cards) || !b.cards.every(validCard)) return false
  const scope = b.scope
  if (!isRecord(scope)) return false
  if (scope.kind === 'owner') return true
  return scope.kind === 'mission' && typeof scope.missionId === 'string' && scope.missionId !== ''
}

function validDelivery(d: unknown): boolean {
  if (!isRecord(d)) return false
  return (
    typeof d.briefingId === 'string' &&
    d.briefingId !== '' &&
    typeof d.surfaceId === 'string' &&
    d.surfaceId !== '' &&
    typeof d.deliveredAt === 'string'
  )
}

const isNumericId = (v: unknown): boolean => typeof v === 'string' && /^\d{1,20}$/.test(v)
const isOptString = (v: unknown): boolean => v === undefined || typeof v === 'string'
const isNullableString = (v: unknown): boolean => v === null || typeof v === 'string'
/** Newer optional state: absent (older archives), null, or a value. */
const isOptNullableString = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string'

function validBinding(b: unknown): boolean {
  if (b === null) return true
  if (!isRecord(b)) return false
  return (
    isNumericId(b.ownerXUserId) &&
    isNumericId(b.spriiteXUserId) &&
    b.ownerXUserId !== b.spriiteXUserId &&
    typeof b.ownerHandle === 'string' &&
    typeof b.spriiteHandle === 'string' &&
    typeof b.verifiedAt === 'string' &&
    b.verification === 'users_me' &&
    typeof b.credentialRef === 'string' &&
    typeof b.enabled === 'boolean' &&
    typeof b.protectedOwner === 'boolean' &&
    isOptString(b.defaultRepository)
  )
}

function validXReceipt(r: unknown): boolean {
  if (!isRecord(r)) return false
  return (
    typeof r.dedupeKey === 'string' &&
    r.dedupeKey.startsWith('x:') &&
    isNumericId(r.logicalPostId) &&
    isNumericId(r.revisionId) &&
    isNullableString(r.conversationId) &&
    isOneOf(r.status, X_RECEIPT_STATUSES) &&
    typeof r.instruction === 'string' &&
    typeof r.postedAt === 'string' &&
    (r.postedAtTrusted === undefined || typeof r.postedAtTrusted === 'boolean') &&
    (r.followupDelivery === undefined || isOneOf(r.followupDelivery, ['pending', 'sending', 'sent', 'unknown', 'dismissed'] as const)) &&
    (r.followupAttempt === undefined || (Number.isSafeInteger(r.followupAttempt) && Number(r.followupAttempt) >= 0)) &&
    typeof r.receivedAt === 'string' &&
    isOneOf(r.via, ['catch_up', 'stream', 'import'] as const) &&
    isOptString(r.reason) &&
    isOptString(r.commandId) &&
    isOptString(r.missionId) &&
    isOptString(r.repository) &&
    isOptString(r.projectName) &&
    (r.repositoryChoices === undefined ||
      (Array.isArray(r.repositoryChoices) && r.repositoryChoices.every((u) => typeof u === 'string'))) &&
    isOptString(r.proposedRevisionId) &&
    isOptString(r.deletedAt)
  )
}

function validXIntake(x: unknown): boolean {
  if (!isRecord(x)) return false
  return (
    validBinding(x.binding) &&
    isNullableString(x.lastCheckedAt) &&
    isNullableString(x.lastSuccessAt) &&
    isNullableString(x.lastError) &&
    isNullableString(x.lastReceivedAt) &&
    isNullableString(x.lastReceivedPostId) &&
    isOptNullableString(x.lastSeenPostId) &&
    Array.isArray(x.receipts) &&
    x.receipts.every(validXReceipt) &&
    Array.isArray(x.gaps) &&
    x.gaps.every(
      (g) => isRecord(g) && typeof g.from === 'string' && typeof g.to === 'string' && typeof g.reason === 'string' && typeof g.observedAt === 'string',
    ) &&
    isSeq(x.rejectedCount)
  )
}

function validArtifact(a: unknown): boolean {
  if (!isRecord(a)) return false
  return (
    typeof a.artifactId === 'string' &&
    isOneOf(a.kind, ['x_post', 'link', 'github_repo', 'github_issue', 'github_pull'] as const) &&
    isOneOf(a.role, ['owner_instruction', 'parent_post', 'quoted_post', 'thread_post', 'link'] as const) &&
    typeof a.sourceId === 'string' &&
    isNullableString(a.authorId) &&
    typeof a.authorIsOwner === 'boolean' &&
    typeof a.retrievedAt === 'string' &&
    isNullableString(a.contentHash) &&
    isOneOf(a.completeness, ['complete', 'truncated', 'unavailable', 'not_fetched'] as const) &&
    isOneOf(a.method, ['x_api_v2', 'x_event_payload', 'github_api', 'none'] as const) &&
    typeof a.text === 'string'
  )
}

export function initialSpriiteState(): SpriiteState {
  const entity: EntityRecord = {
    schemaVersion: 2,
    entityId: mintId('entity'),
    name: 'Spriite',
    preferencesRevision: '0',
    createdAt: nowIso(),
  }
  return {
    schemaVersion: 2,
    entity,
    missions: [],
    runs: {},
    outbox: [],
    decisions: [],
    cursors: {},
    acknowledgedSeq: 0,
    acknowledgedEvents: {},
    briefings: [],
    briefingDeliveries: [],
    migratedFromV1: false,
  }
}

/** Frozen restore inputs. Unknown fields survive; newer optional settings
 * remain optional so pre-settings and migrated missions keep their defaults. */
function validMissionConfig(c: unknown): boolean {
  if (!isRecord(c) || c.leadProvider !== 'factory' ||
    !Array.isArray(c.workerProviders) ||
    !c.workerProviders.every((p) => isOneOf(p, ['factory', 'cursor'])) ||
    !Number.isSafeInteger(c.maxConcurrentWorkers) || Number(c.maxConcurrentWorkers) < 1 ||
    typeof c.repository !== 'string' || typeof c.baseRef !== 'string' ||
    typeof c.policyRevision !== 'string') return false
  if (c.executionBackend !== undefined && !isOneOf(c.executionBackend, ['legacy', 'factory_native'])) return false
  if (c.executionBackend !== 'factory_native' && (c.nativeIntent !== undefined || c.nativeProfile !== undefined)) return false
  if (c.nativeQuarantine !== undefined && typeof c.nativeQuarantine !== 'string') return false
  if (c.executionBackend !== 'factory_native' && (c.nativeOrigin !== undefined || c.nativeHeldResolution !== undefined)) return false
  if (c.nativeOrigin !== undefined && !isOneOf(c.nativeOrigin, ['x', 'generic'])) return false
  if (c.nativeHeldResolution !== undefined) {
    const r = c.nativeHeldResolution
    if (!isRecord(r) || !(r.outcome === 'dismissed' ||
      (r.outcome === 'promoted' && typeof r.missionId === 'string' && r.missionId !== ''))) return false
  }
  if (c.workerPreference !== undefined && !isOneOf(c.workerPreference, ['auto', 'cursor', 'factory', 'mix'])) return false
  if (c.newRepository !== undefined && typeof c.newRepository !== 'boolean') return false
  if (c.startApproved !== undefined && typeof c.startApproved !== 'boolean') return false
  if (c.approvedPlan !== undefined || c.buildSourceSessionId !== undefined) {
    if (c.startApproved !== true || !validBuildDraft({
      requestId: 'checked', sourceSessionId: c.buildSourceSessionId,
      goal: 'saved scope', repository: c.repository, plan: c.approvedPlan,
    })) return false
  }
  if (c.newRepositoryName !== undefined && typeof c.newRepositoryName !== 'string') return false
  if (c.sessionSettings === undefined) return true
  if (!isRecord(c.sessionSettings)) return false
  const settings = c.sessionSettings
  const strings = [
    'interactionMode', 'specModeModel', 'specModeReasoningEffort', 'leadModel',
    'leadReasoningEffort', 'leadAutonomyLevel', 'workerModel',
    'workerReasoningEffort', 'workerInstructions',
  ]
  const lists = ['workerEnabledToolIds', 'workerDisabledToolIds', 'workerRestrictToolIds']
  return strings.every((k) => settings[k] === undefined || typeof settings[k] === 'string') &&
    lists.every((k) => settings[k] === undefined || isStringArray(settings[k]))
}

/** A structurally valid SpriiteState, or null when the payload is unusable. */
export function validateSpriiteState(raw: unknown): SpriiteState | null {
  if (raw === null || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.schemaVersion !== 2) return null
  const entity = s.entity as Record<string, unknown> | undefined
  if (!entity || typeof entity.entityId !== 'string' || entity.entityId === '') return null
  if (!Array.isArray(s.missions)) return null
  for (const m of s.missions as Array<Record<string, unknown> | null>) {
    const bad =
      !isRecord(m) ||
      typeof m.missionId !== 'string' ||
      m.missionId === '' ||
      typeof m.goal !== 'string' ||
      !isOneOf(m.phase, MISSION_PHASES) ||
      !isOneOf(m.control, CONTROL_MODES) ||
      !validMissionConfig(m.config) ||
      !isStringArray(m.activeRunIds) ||
      !isStringArray(m.decisionIds) ||
      !isSeq(m.planRevision)
    if (bad) return null
  }
  // Keep the checkpoint containing the newest ownership facts. Falling back
  // to an older slot on nested native corruption could resurrect a grant.
  // Quarantine only the damaged mission; never manufacture a legacy engine.
  const missions = (s.missions as SpriiteState['missions']).map(m => {
    const config = m.config
    if (config.executionBackend !== 'factory_native') {
      const rawCache = isRecord(s.engineSnapshots) ? s.engineSnapshots[m.missionId] : undefined
      if (isRecord(rawCache) && (rawCache.backend === 'factory_native' || rawCache.nativeCacheVersion !== undefined)) {
        return { ...m, freshness: 'unknown' as const, config: { ...config, nativeQuarantine: 'Backend/cache ownership mismatch' } }
      }
      return m
    }
    const intent = decodeNativeIntent(config.nativeIntent)
    const profile = decodeNativeProfile(config.nativeProfile)
    const rawCache = isRecord(s.engineSnapshots) ? s.engineSnapshots[m.missionId] : undefined
    const cache = rawCache === undefined ? undefined : decodeNativeCache(rawCache)
    const mismatch = !intent || !profile || intent.missionId !== m.missionId ||
      intent.commandId !== m.originatingCommandId || intent.goal !== m.goal ||
      intent.workspace.repository !== config.repository || intent.workspace.baseRef !== config.baseRef ||
      profile.ownerId !== intent.ownerId || profile.machineId !== intent.workspace.machineId ||
      !nativeIntentMatchesProfile(profile, intent) ||
      (cache !== undefined && (!cache || cache.snapshot.missionId !== m.missionId ||
        cache.snapshot.ownerId !== intent.ownerId || cache.snapshot.scopeRevision !== intent.scopeRevision ||
        (cache.prepareReceipt && cache.prepareReceipt.commandId !== intent.commandId) ||
        (cache.snapshot.binding && (cache.snapshot.binding.machineId !== intent.workspace.machineId ||
          cache.snapshot.binding.cwd !== intent.workspace.cwd ||
          cache.snapshot.binding.repository !== intent.workspace.repository ||
          cache.snapshot.binding.baseRef !== intent.workspace.baseRef ||
          (intent.workspace.baseSha && cache.snapshot.binding.baseSha !== intent.workspace.baseSha)))))
    if (mismatch || config.nativeQuarantine) return {
      ...m, freshness: 'unknown' as const,
      config: { ...config, nativeIntent: undefined, nativeProfile: profile ?? undefined,
        nativeQuarantine: config.nativeQuarantine ?? 'Nested native record quarantined' },
    }
    return { ...m, config: { ...config, nativeIntent: intent, nativeProfile: profile } }
  })
  if (!Array.isArray(s.outbox)) return null
  if (!Array.isArray(s.decisions)) return null
  if (s.runs === null || typeof s.runs !== 'object' || Array.isArray(s.runs)) return null
  if (s.cursors === null || typeof s.cursors !== 'object' || Array.isArray(s.cursors)) return null
  if (!isSeq(s.acknowledgedSeq)) return null
  if (typeof s.migratedFromV1 !== 'boolean') return null
  // Briefing coverage (spec §16): optional fields default when absent so an
  // older checkpoint still loads, but a malformed shape is corruption. These
  // are the fields an acknowledgement is validated against, so a half-shaped
  // record must never reach the surfaces or the ledger.
  if (s.acknowledgedEvents !== undefined && !isStringMapString(s.acknowledgedEvents)) return null
  if (s.briefings !== undefined && !(Array.isArray(s.briefings) && s.briefings.every(validBriefing))) return null
  if (
    s.briefingDeliveries !== undefined &&
    !(Array.isArray(s.briefingDeliveries) && s.briefingDeliveries.every(validDelivery))
  ) {
    return null
  }
  if (s.xFollowups !== undefined) {
    if (!Array.isArray(s.xFollowups) || s.xFollowups.length > 2000) return null
    const keys = new Set<string>()
    for (const f of s.xFollowups) {
      if (!isRecord(f) || typeof f.dedupeKey !== 'string' || typeof f.ownerId !== 'string' ||
        !isNumericId(f.ownerId) || !f.dedupeKey.startsWith(`x:${f.ownerId}:`) ||
        typeof f.missionId !== 'string' || f.missionId === '' || typeof f.instruction !== 'string' || f.instruction.trim() === '' ||
        typeof f.receivedAt !== 'string' || !Number.isFinite(Date.parse(f.receivedAt)) ||
        !Number.isSafeInteger(f.attempt) || Number(f.attempt) < 0 ||
        !isOneOf(f.state, ['pending', 'sending', 'sent', 'unknown', 'dismissed'] as const) || keys.has(f.dedupeKey)) return null
      keys.add(f.dedupeKey)
    }
  }
  if (s.xIntake !== undefined && !validXIntake(s.xIntake)) return null
  if (
    s.contextArtifacts !== undefined &&
    !(isRecord(s.contextArtifacts) && Object.values(s.contextArtifacts).every((l) => Array.isArray(l) && l.every(validArtifact)))
  ) {
    return null
  }
  const engineSnapshots = isRecord(s.engineSnapshots) ? { ...s.engineSnapshots } : {}
  for (const m of missions) {
    if (m.config.nativeQuarantine) delete engineSnapshots[m.missionId]
    else if (m.config.executionBackend === 'factory_native' && engineSnapshots[m.missionId] !== undefined) {
      engineSnapshots[m.missionId] = decodeNativeCache(engineSnapshots[m.missionId])
    }
  }
  return { ...(raw as SpriiteState), missions, ...(s.engineSnapshots === undefined ? {} : { engineSnapshots }) }
}
