/**
 * The X announcement board (spec §11/§21): the one scheduler that turns a
 * held X post, an accepted X request, and a steering reply into what the
 * surfaces say.
 *
 * One beat (main.ts's 400 ms tick) calls `tick()`. Three facts come out of it:
 *  - the phone banner fires ONCE per post, the moment the post is first
 *    observed — never once per tick. A receipt that cannot take the HUD
 *    yet (a capture, the reading page, another local card, the glasses
 *    detached) waits unconsumed and takes the screen the moment it frees,
 *    without re-firing the banner (and without re-logging a feed row) on
 *    every beat while it waits;
 *  - a card is consumed ONLY when its present actually landed: the present
 *    answers for itself synchronously (main.ts stages the card through the
 *    same scene validation every card passes), so a card that validator
 *    refuses is not swallowed as announced — it retries on a later beat
 *    once its copy is fixed, and never replays as already-said news;
 *  - an announcement is never replayed: relaunch honesty (`since`, the
 *    session's boot time, ISO) is the line between news and history. A
 *    receipt received before it is marked seen silently — the mission is
 *    already in the builds list, so replaying the announcement would
 *    present an old state transition as news (spec §1).
 */
import type { XIntakeReceipt } from '../domain/types'

/** What the board may read: owner-scoped facts, exactly what main.ts passes. */
export interface XNoticeSources {
  /** Intake enabled and verified (held posts are actionable only then). */
  active(): boolean
  /** Receipts waiting on the owner right now (health().needsOwner). */
  needsOwner(): XIntakeReceipt[]
  /** Accepted requests, newest first (connection.submitted()). */
  submitted(): XIntakeReceipt[]
  /**
   * Replies that steered a live mission (status 'extended'), newest first
   * (connection.extended()): a held reply confirmed later steers the parent
   * mission with no card of its own, so it is announced here like a start —
   * once, with the same honesty.
   */
  extended(): XIntakeReceipt[]
  /** Requests saved as held native intents (connection.nativeHeld()): never "started". */
  nativeHeld?(): XIntakeReceipt[]
}

export interface XNoticeDeps {
  sources: XNoticeSources
  /** True when the glasses HUD can take a notice card right now. */
  canPresent(): boolean
  /**
   * Present the held-posts card ("N posts are waiting"). True only when the
   * card took the HUD: the announcement is consumed only on a real present,
   * so a card the validator refuses stays retriable, never swallowed.
   */
  presentHeld(count: number): boolean
  /** Present the started-request card; true when it took the HUD. Its Show
   * opens `missionId`. */
  presentStarted(instruction: string, missionId: string | null): boolean
  /** Present the added-reply card (a steer on a live mission); true when it
   * took the HUD. Its Show opens the steered mission. */
  presentExtended(instruction: string, missionId: string | null): boolean
  /** Present the held native intent card; true when it took the HUD. */
  presentNativeHeld?(instruction: string, missionId: string | null): boolean
  /** The phone banner for a held native intent. */
  phoneNativeHeld?(instruction: string): void
  /** The phone needs-you banner (a held post waits). */
  phoneHeld(): void
  /** The phone started banner (a request became a mission). */
  phoneStarted(instruction: string): void
  /** The phone added-to-its-build banner (a reply steered a mission). */
  phoneExtended(instruction: string): void
  /** The session's boot time (ISO): receipts received before it are history. */
  since: string
}

export class XNoticeBoard {
  private readonly deps: XNoticeDeps
  /** Held posts whose card presented (consumed). */
  private readonly heldSeen = new Set<string>()
  /** Held posts whose phone banner fired (once per post). */
  private readonly heldBannered = new Set<string>()
  /** Accepted requests whose card presented (consumed). */
  private readonly startedSeen = new Set<string>()
  /** Accepted requests whose phone banner fired (once per request). */
  private readonly startedBannered = new Set<string>()
  /** Steering replies whose card presented (consumed). */
  private readonly extendedSeen = new Set<string>()
  /** Steering replies whose phone banner fired (once per reply). */
  private readonly extendedBannered = new Set<string>()
  private readonly nativeHeldSeen = new Set<string>()
  private readonly nativeHeldBannered = new Set<string>()

  constructor(deps: XNoticeDeps) {
    this.deps = deps
  }

  /**
   * One beat of observation: held posts (when intake is active), then
   * starts, then steering replies — one card per beat, so two receipts
   * arriving together are two cards over two beats, never one swallowed.
   */
  tick(): void {
    if (this.deps.sources.active()) this.noticeHeld()
    this.noticeStarted()
    this.noticeNativeHeld()
    this.noticeExtended()
  }

  /** Same once-only, consume-on-present rules as a start, with held wording. */
  private noticeNativeHeld(): void {
    const present = this.deps.presentNativeHeld
    for (const r of this.deps.sources.nativeHeld?.() ?? []) {
      if (this.nativeHeldSeen.has(r.dedupeKey)) continue
      if (r.receivedAt <= this.deps.since) {
        this.nativeHeldSeen.add(r.dedupeKey)
        continue
      }
      if (!this.nativeHeldBannered.has(r.dedupeKey)) {
        this.nativeHeldBannered.add(r.dedupeKey)
        this.deps.phoneNativeHeld?.(r.instruction)
      }
      if (present === undefined) { this.nativeHeldSeen.add(r.dedupeKey); continue }
      if (!this.deps.canPresent()) return
      if (!present(r.instruction, r.missionId ?? null)) return
      this.nativeHeldSeen.add(r.dedupeKey)
      return
    }
  }

  /** A post that mentions Spriite is held for the owner's OK. */
  private noticeHeld(): void {
    const needs = this.deps.sources.needsOwner()
    const fresh = needs.filter((r) => !this.heldSeen.has(r.dedupeKey))
    if (fresh.length === 0) return
    // The banner says "something waits" — once per post, never per beat.
    const unbannered = fresh.filter((r) => !this.heldBannered.has(r.dedupeKey))
    if (unbannered.length > 0) {
      for (const r of unbannered) this.heldBannered.add(r.dedupeKey)
      this.deps.phoneHeld()
    }
    // Seen means its card presented. A card that cannot take the HUD yet —
    // or one the validator refused — is not consumed: it comes back on the
    // next beat that can show it.
    if (!this.deps.canPresent()) return
    if (!this.deps.presentHeld(needs.length)) return
    for (const r of fresh) this.heldSeen.add(r.dedupeKey)
  }

  /** An accepted request became a durable mission with no card of its own. */
  private noticeStarted(): void {
    for (const r of this.deps.sources.submitted()) {
      if (this.startedSeen.has(r.dedupeKey)) continue
      // Relaunch must not replay old announcements: a request received
      // before this session is already in the mission list, not news.
      if (r.receivedAt <= this.deps.since) {
        this.startedSeen.add(r.dedupeKey)
        continue
      }
      // The phone banner stands even while the card waits for a free HUD —
      // but it fires once per request, not once per beat.
      if (!this.startedBannered.has(r.dedupeKey)) {
        this.startedBannered.add(r.dedupeKey)
        this.deps.phoneStarted(r.instruction)
      }
      if (!this.deps.canPresent()) return
      if (!this.deps.presentStarted(r.instruction, r.missionId ?? null)) return
      this.startedSeen.add(r.dedupeKey)
      return // one card at a time; a second request takes the next beat
    }
  }

  /**
   * A reply steered a live mission (a held reply the owner confirmed, or a
   * fresh one inside the window): the parent mission's own announcement
   * already fired for a different receipt, so this reply needs its own one
   * card — honest short text like the started card, never silence.
   */
  private noticeExtended(): void {
    for (const r of this.deps.sources.extended()) {
      if (this.extendedSeen.has(r.dedupeKey)) continue
      // A reply received before this session is already in the mission's
      // chat history, not news to announce.
      if (r.receivedAt <= this.deps.since) {
        this.extendedSeen.add(r.dedupeKey)
        continue
      }
      if (!this.extendedBannered.has(r.dedupeKey)) {
        this.extendedBannered.add(r.dedupeKey)
        this.deps.phoneExtended(r.instruction)
      }
      if (!this.deps.canPresent()) return
      if (!this.deps.presentExtended(r.instruction, r.missionId ?? null)) return
      this.extendedSeen.add(r.dedupeKey)
      return // one card at a time; a second reply takes the next beat
    }
  }
}
