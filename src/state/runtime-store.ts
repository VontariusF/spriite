/**
 * The one construction site for the durable runtime store. Briefing
 * coverage depends on the hold-back option (spec §9: compaction preserves
 * events the owner has not acknowledged), so every runtime store is built
 * here rather than hand-wired at each caller.
 *
 * The hold-back reads the contiguous watermark only, not the sparse
 * acknowledgement set: an event acknowledged by a mission-scoped brief may
 * therefore be held a little longer than strictly necessary. That is a
 * bounded over-retention (the ceiling still applies), never a replay, and it
 * keeps the option a pure function of one durable number.
 */
import { initialSpriiteState, validateSpriiteState } from '../domain/state'
import type { SpriiteState } from '../domain/types'
import { CHECKPOINT_NAMESPACE, MissionStore, type KVBackend } from './mission-store'

export function createRuntimeStore(
  kv: KVBackend,
  opts: {
    eventWindow?: number
    maxEventWindow?: number
    /** The archive mirror's commit observer (see MissionStoreOptions). */
    observe?: (prev: SpriiteState, next: SpriiteState) => void
  } = {},
): MissionStore<SpriiteState> {
  return new MissionStore<SpriiteState>(kv, {
    initial: initialSpriiteState,
    validateState: validateSpriiteState,
    holdEventsAfter: (s) => s.acknowledgedSeq,
    eventWindow: opts.eventWindow,
    maxEventWindow: opts.maxEventWindow,
    observe: opts.observe,
  })
}

/**
 * Whether this phone's durable store has ever committed a checkpoint. Used by
 * the launch plan's rollback decision (spec §26) instead of a marker written
 * only after a fully successful boot: a first boot that commits records and
 * then throws must still keep the legacy engine from resuming the same work
 * (spec §22). It probes the slot manifests, not the head: the head is advisory
 * and is written after the slots, so a force-quit in that window would leave
 * valid records the head does not mention. Any read failure answers "unknown",
 * and the caller treats that as records existing — the safe direction.
 */
export async function durableRecordsExist(kv: KVBackend): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      kv.get(`${CHECKPOINT_NAMESPACE}.slot.a.m`),
      kv.get(`${CHECKPOINT_NAMESPACE}.slot.b.m`),
    ])
    return [a, b].some((m) => typeof m === 'string' && m !== '')
  } catch {
    return true
  }
}
