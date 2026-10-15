/**
 * Owner-only X intake (spec §10, §11, §24, §25 "X and context").
 *
 * Pipeline per post: authorize (bound owner's numeric id + an explicit,
 * visible mention entity of the bound Spriite id) -> logical-post dedupe ->
 * intent -> catch-up window -> product routing -> bounded context ->
 * durable command (supervisor.submitCommand) -> private receipt. The intake
 * checkpoint advances only after every post it covers is durably receipted.
 *
 * Nothing here writes to X. Receipts, holds, clarifications, and status
 * answers are private: they appear on the phone and in return briefings.
 *
 * Authority rules worth restating because they are easy to erode:
 * - a handle is a label; only numeric ids authorize;
 * - the subscription or timeline filter narrows traffic, it never authorizes;
 * - text inside a quoted post, a screenshot, or the thread is context, never
 *   a trigger and never an instruction;
 * - X is limited to create / extend / status; controls are held privately;
 * - a deleted post does not cancel anything; an edit after dispatch is a
 *   proposed change, never a silent rewrite.
 */
import { draftEvent, type EventDraft } from '../domain/events'
import { isTerminalPhase } from '../domain/types'
import type {
  ContextArtifact,
  Mission,
  SpriiteState,
  XDeliveryGap,
  XIntakeReceipt,
  XIntakeState,
  XOwnerBinding,
  XReceiptStatus,
} from '../domain/types'
import type { MissionStore } from '../state/mission-store'
import type { SubmitCommandInput, SubmitReceipt } from '../runtime/supervisor'
import { composeGoal, gatherContext, isDeictic, type ContextBudget, type GitHubIntakeReader } from '../context/gather'
import {
  postIdFromLink,
  XTransportError,
  type XErrorKind,
  type XIncludes,
  type XPost,
  type XTransport,
} from './x-transport'

export const X_INTAKE_DEFAULTS = {
  /** Spec §11 product default: older requests are held for confirmation. */
  autoLaunchWindowMs: 24 * 60 * 60 * 1000,
  /** Each catch-up re-reads this much before the last successful check. */
  overlapMs: 10 * 60 * 1000,
  /** Pages of 100 posts one check may read before declaring a gap. */
  maxPages: 5,
  maxReceipts: 200,
  maxGaps: 20,
  /** Commands whose captured context is retained. */
  maxContextCommands: 30,
}

export type XIntakeOptions = typeof X_INTAKE_DEFAULTS

/** What the runtime offers the intake: the shared command pipeline. */
export interface XIntakeRuntime {
  submitCommand(input: SubmitCommandInput): Promise<SubmitReceipt>
  /** A refusal because X intake was switched off carries reason 'X intake is off', as submitCommand's does. */
  submitXFollowup(receipt: XIntakeReceipt, ownerId: string): Promise<{ status: 'saved' | 'duplicate' | 'failed'; reason?: string }>
  resolveXFollowup(key: string, action: 'resend' | 'dismiss', attempt: number): Promise<boolean>
  readonly missions: readonly Mission[]
  /** True when a submitted command becomes a held native intent, not a running build. */
  nativeExecution?(): boolean
  /** Native only: the owner's setting allows a post to ask for a new private repository. */
  nativeCreatesPrivateRepositories?(): boolean
  /** Native only: the owner's configured GitHub account, the only owner a new repository may have. */
  nativeRepositoryAccount?(): string | null
}

export { X_NATIVE_HELD_REASON, X_NATIVE_NO_NEW_REPO_REASON, X_NATIVE_PROMOTED_REASON, X_NATIVE_DISMISSED_REASON } from './x-native-copy'
import { NATIVE_GOAL_LIMIT, X_NATIVE_NEW_REPO_ACCOUNT_REASON, X_NATIVE_NEW_REPO_NAME_REASON, X_NATIVE_NO_DESTINATION_REASON, X_NATIVE_NO_NEW_REPO_REASON,
  xNativeReceiptReason, xNativeTooLongReason } from './x-native-copy'
import { derivedRepositoryName, newRepositoryNameFrom, validGithubAccount, validRepositoryName } from '../native/delivery'

export interface XIntakeDeps {
  store: MissionStore<SpriiteState>
  runtime: XIntakeRuntime
  /** Null while no owner credential is configured. */
  transport: () => XTransport | null
  /** Reads through the owner's own GitHub token; null while none is saved. */
  github?: () => GitHubIntakeReader | null
  now?: () => number
  options?: Partial<XIntakeOptions>
  contextBudget?: ContextBudget
}

export function initialXIntake(): XIntakeState {
  return {
    binding: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastReceivedAt: null,
    lastReceivedPostId: null,
    lastSeenPostId: null,
    receipts: [],
    gaps: [],
    rejectedCount: 0,
  }
}

// ------------------------------------------------------------ authorization

export type TriggerVerdict =
  | { ok: true; instruction: string }
  | { ok: false; reason: 'not_owner' | 'not_a_trigger' | 'repost' }

const cp = (s: string): string[] => Array.from(s)

/**
 * Is this post a trigger from the bound owner? Pure. The mention must be a
 * mention ENTITY carrying the Spriite account's numeric id, inside the
 * visible text range (a reply's leading auto-mentions sit outside it and are
 * implicit, not a request).
 */
export function authorizeTrigger(post: XPost, binding: XOwnerBinding): TriggerVerdict {
  if ((post.referenced_tweets ?? []).some((r) => r.type === 'retweeted')) return { ok: false, reason: 'repost' }
  if (post.author_id !== binding.ownerXUserId) return { ok: false, reason: 'not_owner' }
  const long = post.note_tweet !== undefined
  const text = long ? post.note_tweet!.text : post.text
  const entities = long ? post.note_tweet!.entities : post.entities
  const chars = cp(text)
  const isReply = (post.referenced_tweets ?? []).some((r) => r.type === 'replied_to')
  const range = visibleRange(post, chars, long, isReply)
  if (range === null) return { ok: false, reason: 'not_a_trigger' }
  const [visStart, visEnd] = range
  const mentions = entities?.mentions ?? []
  // The entity must also sit on a visible "@" in the text it indexes: an
  // entity whose offsets do not land on a typed mention is not explicit.
  const explicit = mentions.filter(
    (m) =>
      m.id === binding.spriiteXUserId &&
      Number.isInteger(m.start) &&
      Number.isInteger(m.end) &&
      m.start < m.end &&
      m.start >= visStart &&
      m.end <= visEnd &&
      (chars[m.start] === '@' || chars[m.start] === '\uFF20'),
  )
  if (explicit.length === 0) return { ok: false, reason: 'not_a_trigger' }
  return { ok: true, instruction: instructionOf(chars, visStart, visEnd, entities, binding.spriiteXUserId) }
}

/**
 * The visible span of the evaluated text, or null to fail closed. Without a
 * range a reply's leading auto-mentions are indistinguishable from an
 * explicit one; a malformed range is never widened to the whole text. A long
 * post's range describes its short `text`, so when the note text repeats that
 * hidden prefix (a reply's auto-mentions) the prefix is skipped there too.
 */
function visibleRange(post: XPost, chars: string[], long: boolean, isReply: boolean): [number, number] | null {
  const raw: unknown = post.display_text_range
  if (raw === undefined || raw === null) return isReply ? null : [0, chars.length]
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((n) => Number.isInteger(n))) return null
  const [s, e] = raw as [number, number]
  const short = cp(post.text)
  if (s < 0 || s > e || s > short.length) return null
  if (!long) return [s, Math.min(e, chars.length)]
  const prefix = short.slice(0, s).join('')
  const start = prefix !== '' && post.note_tweet!.text.startsWith(prefix) ? s : 0
  return [start, chars.length]
}

/** Visible text with Spriite mentions removed and t.co links expanded. */
function instructionOf(
  chars: string[],
  visStart: number,
  visEnd: number,
  entities: XPost['entities'],
  spriiteId: string,
): string {
  type Span = { start: number; end: number; with: string }
  const spans: Span[] = []
  for (const m of entities?.mentions ?? []) {
    if (m.id === spriiteId) spans.push({ start: m.start, end: m.end, with: ' ' })
  }
  for (const u of entities?.urls ?? []) {
    if (u.expanded_url) spans.push({ start: u.start, end: u.end, with: u.expanded_url })
  }
  spans.sort((a, b) => b.start - a.start)
  const out = chars.slice()
  for (const s of spans) {
    if (s.start < visStart || s.end > visEnd) continue
    out.splice(s.start, s.end - s.start, s.with)
  }
  const shift = out.length - chars.length
  return out
    .slice(visStart, visEnd + shift)
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:;.\-–—]+/, '')
    .trim()
}

// ------------------------------------------------------------------ intent

export type XIntent = 'empty' | 'control' | 'status' | 'build' | 'unclear'

const LEAD_IN = /^(?:(?:hey|hi|ok|okay|yo|please|pls|plz|can you|could you|would you|will you|go|now)\b[\s,!]*)+/i
const CONTROL = /^(cancel|stop|pause|resume|unpause|abort|kill|halt|delete|undo|revert|merge|deploy|roll ?back|close|restart|retry)\b/i
const STATUS = /^(?:status|progress|update|how(?:['’]s| is) (?:it|the build|everything|work) going|where are we|any (?:news|update)|what(?:['’]s| is) (?:the )?(?:status|progress)(?: of (?:(?:the|this|my) )?(?:build|job|mission|project|work))?)(?:[.!?]*)$/i
const BUILD =
  /\b(build|make|create|add|fix|implement|ship|design|write|prototype|code|develop|set ?up|turn\b.*\binto|port|refactor|improve|redesign|generate|scaffold|draft|extend|change|update|clone|fork|adapt)\b/i

/** Classify the owner's instruction. Conservative: unclear is never a build. */
export function classifyIntent(instruction: string): XIntent {
  const bare = instruction.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (bare === '') return 'empty'
  const lead = instruction.replace(LEAD_IN, '').trim()
  if (CONTROL.test(lead)) return 'control'
  if (STATUS.test(lead)) return 'status'
  if (BUILD.test(lead)) return 'build'
  return 'unclear'
}

/** An explicit GitHub repository in the owner's own words, normalized. */
export function repositoryFrom(instruction: string): string | null {
  // The host must start a token: `gist.github.com/...` and
  // `evil.com/github.com/...` are not a github.com repository.
  const m = /(?:^|[\s(<"'])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})/i.exec(instruction)
  if (!m) return null
  const name = m[2].replace(/\.git$/i, '').replace(/[.]+$/, '')
  if (name === '' || name === '.' || name === '..') return null
  return `https://github.com/${m[1]}/${name}`
}

/** Source/adaptation links do not authorize a checkout or the saved default. */
export function destinationRepositoryFrom(instruction: string): string | null {
  const repository = repositoryFrom(instruction)
  if (!repository) return null
  if (/\b(?:clone|fork|adapt|inspired|similar|like|based on|from|new repo(?:sitory)?)\b/i.test(instruction)) {
    const explicit = /\b(?:in|into|destination(?: repository)?[: ]+|target(?: repository)?[: ]+)\s*(https?:\/\/github\.com\/[^\s]+)/i.exec(instruction)
    return explicit ? repositoryFrom(explicit[1]) : null
  }
  return repository
}

/**
 * A GitHub repository the owner's own captured context points at (a quoted
 * or parent post they wrote, or a link they posted). Only owner-authored
 * material can name the product; a stranger's reference never can.
 */
export function repositoryFromContext(artifacts: ContextArtifact[]): string | null {
  for (const a of artifacts) {
    if (!a.authorIsOwner) continue
    // A captured post: its own words. A link (recorded or opened): its URL.
    // A link itself is evidence, not destination authority.
    const r = a.kind === 'x_post' && a.role !== 'owner_instruction'
      ? destinationRepositoryFrom(a.text) : null
    if (r !== null) return r
  }
  return null
}

// ------------------------------------------------------- request substance

/** Words that ask for something without carrying a build verb. */
const REQUEST_WORDS =
  /\b(?:want|wants|wanted|need|needs|needed|wish|should|must|gotta|looking for|hoping for|asking for|can you|could you|would you|will you|let'?s|how about|what about)\b/i
/** Words that name a product: enough that a substantive post is about one. */
const PROJECT_WORDS =
  /\b(?:app|application|site|website|web ?page|page|landing|portfolio|blog|store|shop|dashboard|tool|service|api|bot|extension|plugin|script|game|theme|form|gallery|map|tracker|calendar|widget|menu|checkout|repo|repository|project)\b/i
/** Praise reads as praise, not as a request, however substantive it is. */
const PLEASANTRY = /\b(?:thanks?|thank you|great work|good job|nice work|well done|awesome|amazing|congrats|congratulations)\b/i

/**
 * Does the post, with its references captured, amount to a request? The
 * pipeline gathers context BEFORE this runs, so "this" can lean on a readable
 * quote. A readable reference, an explicit repository, or substantive words
 * that ask for or name a product all count; a bare compliment or a bare
 * mention does not.
 */
export function hasRequestSubstance(instruction: string, artifacts: ContextArtifact[]): boolean {
  // A readable reference the post points at supplies the request.
  const readable = artifacts.some(
    (a) =>
      a.kind === 'x_post' &&
      a.role !== 'owner_instruction' &&
      (a.completeness === 'complete' || a.completeness === 'truncated') &&
      a.text.trim() !== '',
  )
  if (readable) return true
  // An explicit product: a GitHub repository in the owner's own words, with
  // at least something said about it (a bare URL is a bookmark, not a ask).
  const repository = repositoryFrom(instruction)
  if (repository !== null) {
    const said = instruction.replace(repository, '').split(/\s+/).filter(Boolean).length
    if (said >= 2) return true
  }
  // Substantive words that ask, or that name a product (never a compliment).
  if (!isDeictic(instruction)) {
    if (REQUEST_WORDS.test(instruction)) return true
    if (PROJECT_WORDS.test(instruction) && !PLEASANTRY.test(instruction)) return true
  }
  return false
}

/** The generic words a project-name match must never mistake for a name. */
const PROJECT_STOP = new Set(
  (
    'build make create add fix implement ship design write draft extend change update port refactor improve generate ' +
    'scaffold prototype code develop please pls plz this that these those with for from into when then also just like ' +
    'want wanted needs need should must have has will your yours mine ours their here there about using give very much ' +
    'many what which where why does did done been was were are the and but not now new own same next first last every ' +
    'each other more most less app site page web website'
  ).split(' '),
)

/** The owner's repositories that a word in the instruction names, if any. */
async function projectCandidates(
  instruction: string,
  github: () => GitHubIntakeReader | null,
): Promise<{ projectName: string; urls: string[]; incomplete?: boolean } | null> {
  const reader = github()
  if (reader === null || reader === undefined) return null
  let repos: Array<{ fullName: string; url: string }>
  try {
    repos = await reader.repos()
  } catch {
    // An incomplete discovery is not "no match" and cannot authorize the
    // saved default. The GitHub reader owns bounded/complete pagination.
    return { projectName: '', urls: [], incomplete: true }
  }
  const tokens: string[] = []
  for (const w of instruction.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !PROJECT_STOP.has(w) && !tokens.includes(w)) tokens.push(w)
  }
  const urls: string[] = []
  let projectName: string | null = null
  for (const repo of repos) {
    const name = repo.fullName.split('/')[1] ?? ''
    const norm = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (norm === '') continue
    const joined = norm.replace(/ /g, '')
    const hit = tokens.find((t) => t === joined || norm.split(' ').includes(t))
    if (hit === undefined) continue
    if (!urls.includes(repo.url)) urls.push(repo.url)
    if (projectName === null) projectName = name
  }
  if (urls.length === 0) return null
  return { projectName: projectName ?? '', urls: urls.slice(0, 3) }
}

const NEEDS_OWNER: readonly XReceiptStatus[] = ['held_window', 'held_confirm', 'clarify']

export function needsOwner(r: XIntakeReceipt): boolean {
  return NEEDS_OWNER.includes(r.status) && r.followupDelivery !== 'pending'
}

const NUMERIC_POST_ID = /^\d{1,20}$/
/** Timeline pages (100 posts each) a confirmation reads back looking for its post. */
const CONFIRM_TIMELINE_PAGES = 5

const big = (id: string): bigint => {
  try {
    return BigInt(id)
  } catch {
    return 0n
  }
}

/** The newest well-formed id in a post's edit history (itself when none). */
function newestRevision(post: XPost): string {
  const history: unknown = post.edit_history_tweet_ids
  let newest = post.id
  if (!Array.isArray(history)) return newest
  for (const id of history) {
    if (typeof id === 'string' && NUMERIC_POST_ID.test(id) && big(id) > big(newest)) newest = id
  }
  return newest
}

// ---------------------------------------------------------------- results

/**
 * One ingest's outcome. 'off' is the owner's kill switch landing mid-read
 * (the check stops, nothing is wrong, the checkpoint stays put): a failure
 * in every other sense would pin a health error on the connection the owner
 * themselves switched off.
 */
export type IngestStatus = XReceiptStatus | 'duplicate' | 'ignored' | 'rejected' | 'failed' | 'off'

export interface IngestResult {
  status: IngestStatus
  reason?: string
  missionId?: string
  dedupeKey?: string
}

export type BindResult =
  | { ok: true; binding: XOwnerBinding }
  | {
      ok: false
      reason:
        | 'no_credential'
        /** The paste claimed to be the token JSON X issues but did not parse
         * (clipped, quote-rewritten, partial copy). Nothing was stored. */
        | 'bad_paste'
        /** A refresh-only paste cannot be minted without the owner's X app:
         * renewal failed closed before any request. */
        | 'no_client_id'
        /** X rotated the pair during a refresh-only paste's renewal and the
         * phone could not store the minted pair: the pasted refresh token is
         * spent, the new pair is lost. Only a fresh token JSON from X works. */
        | 'rotation_lost'
        | 'same_account'
        | 'storage'
        | `x_${XTransportError['kind']}`
    }

/**
 * The failure arm of BindResult, named so the save-only path (storeXPaste in
 * src/intake/connection.ts) can return the same reasons and reuse the
 * panel's exact copy for each one.
 */
export type BindFailure = Extract<BindResult, { ok: false }>

export interface PollResult {
  ok: boolean
  checked: number
  outcomes: IngestResult[]
  gap: XDeliveryGap | null
  error?: string
  /** What kind of check failed, for an honest backoff: quota-style errors earn
   * the long backoff, ordinary network and storage errors the short one. */
  errorKind?: XErrorKind | 'storage'
}

/** Auto-refresh state for the phone. No token value ever appears here. */
export type XRefreshState = 'off' | 'armed' | 'on' | 'failed'

export interface XIntakeHealth {
  state: 'unbound' | 'disabled' | 'protected_unsupported' | 'never_checked' | 'ok' | 'error'
  ownerHandle: string | null
  spriiteHandle: string | null
  lastCheckedAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  lastReceivedAt: string | null
  lastReceivedPostId: string | null
  /** 'off' without a stored refresh token, 'armed' when one is stored but the
   * credential is not verified yet (renewal runs only once it is), 'on' when
   * Spriite renews the token itself, 'failed' when the last renewal did. */
  refresh: XRefreshState
  /** One honest line: never "no requests" when the connection was not checked. */
  summary: string
  gaps: XDeliveryGap[]
  needsOwner: XIntakeReceipt[]
  recent: XIntakeReceipt[]
  rejectedCount: number
  limitations: string[]
}

export const X_LIMITATIONS = [
  'Spriite reads your own recent posts on each check; live streaming is not qualified yet, so a request arrives on the next check.',
  'Posts beyond one check\u2019s reach are reported as a delivery gap. Use Import X link for anything missed.',
  'Protected accounts are not supported: X does not deliver their posts to this kind of intake.',
  'Links in a post are recorded, not opened. GitHub links are read through your own token, nothing else.',
  'Spriite never posts, replies, likes, or reposts on X. Every answer stays private.',
]

// ------------------------------------------------------------------ intake

export class XIntake {
  private readonly store: MissionStore<SpriiteState>
  private readonly runtime: XIntakeRuntime
  private readonly transportOf: () => XTransport | null
  private readonly githubOf: () => GitHubIntakeReader | null
  private readonly now: () => number
  private readonly opts: XIntakeOptions
  private readonly contextBudget: ContextBudget | undefined
  /** Ingest is serialized: a stream event and a catch-up page never race. */
  private chain: Promise<unknown> = Promise.resolve()
  /**
   * A failure the store could not persist (it is usually broken by then).
   * Health overlays it so the phone never says "ok" about a failed check.
   */
  private unsavedError: string | null = null

  constructor(deps: XIntakeDeps) {
    this.store = deps.store
    this.runtime = deps.runtime
    this.transportOf = deps.transport
    this.githubOf = deps.github ?? (() => null)
    this.now = deps.now ?? (() => Date.now())
    this.opts = { ...X_INTAKE_DEFAULTS, ...(deps.options ?? {}) }
    this.contextBudget = deps.contextBudget
  }

  get state(): XIntakeState {
    const x = this.store.current.xIntake ?? initialXIntake()
    return { ...x, receipts: x.receipts.map((r) => {
      const f = this.store.current.xFollowups?.find((p) => p.dedupeKey === r.dedupeKey)
      const orphan = !f && r.missionId !== undefined && r.commandId === undefined &&
        (r.status === 'extended' || r.status === 'held_confirm')
      const unknown = orphan || f?.state === 'sending' || f?.state === 'unknown'
      if (!unknown && !f) return r
      const delivery = unknown ? 'unknown' : f!.state
      return { ...r, missionId: f?.missionId ?? r.missionId, instruction: f?.instruction ?? r.instruction,
        status: delivery === 'sent' ? 'extended' : delivery === 'dismissed' ? 'dismissed' : 'held_confirm',
        followupDelivery: delivery, followupAttempt: f?.attempt ?? 0,
        reason: unknown ? 'Delivery could not be confirmed. Resending may add it twice. Choose Resend or Dismiss.'
          : delivery === 'pending' ? 'Saved for this build; waiting to send.' : undefined }
    }) }
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async write(
    mutate: (x: XIntakeState, s: SpriiteState) => { x: XIntakeState; events?: EventDraft[]; artifacts?: Record<string, ContextArtifact[]> } | null,
  ): Promise<boolean> {
    const res = await this.store.commit((s) => {
      const out = mutate(s.xIntake ?? initialXIntake(), s)
      if (out === null) return null
      return {
        state: {
          ...s,
          xIntake: this.bounded(out.x),
          ...(out.artifacts !== undefined ? { contextArtifacts: out.artifacts } : {}),
        },
        events: out.events ?? [],
      }
    })
    return res.ok === true
  }

  /**
   * Receipts and gaps stay bounded. A receipt is the dedupe record for its
   * post, so only receipts the next catch-up can no longer re-read are
   * dropped (otherwise a pruned post would re-ingest, re-steer, or a
   * dismissed one resurrect). Anything still waiting on the owner is kept.
   * The cap is soft: one check's span is itself bounded by maxPages.
   */
  private bounded(x: XIntakeState): XIntakeState {
    let receipts = x.receipts
    if (receipts.length > this.opts.maxReceipts) {
      const horizon = x.lastSuccessAt !== null ? Date.parse(x.lastSuccessAt) - this.opts.overlapMs : -Infinity
      const prunable = (r: XIntakeReceipt): boolean => !needsOwner(r) &&
        !this.store.current.xFollowups?.some((f) => f.dedupeKey === r.dedupeKey &&
          (f.state === 'pending' || f.state === 'sending' || f.state === 'unknown')) && Date.parse(r.postedAt) < horizon
      const excess = receipts.length - this.opts.maxReceipts
      let dropped = 0
      receipts = receipts.filter((r) => {
        if (dropped >= excess || !prunable(r)) return true
        dropped += 1
        return false
      })
    }
    const gaps = x.gaps.length > this.opts.maxGaps ? x.gaps.slice(-this.opts.maxGaps) : x.gaps
    return { ...x, receipts, gaps }
  }

  // ------------------------------------------------------------- binding

  /**
   * Bind the owner. The owner's own user-context token must answer
   * /2/users/me — that is what makes the numeric id "verified". The Spriite
   * account is resolved by handle once and stored by id.
   *
   * Binding shares the ingest queue: a rebind while a check is mid-read
   * would let that check's checkpoint advance land on the NEW owner's fresh
   * state, and their first check would then read a window the old owner
   * chose — treating posts the new owner made before binding as requests,
   * exactly what the fresh checkpoint exists to prevent. Serialized, the
   * rebind's reset always lands after the in-flight check is done.
   */
  bind(input: { spriiteHandle: string; credentialRef: string; defaultRepository?: string }): Promise<BindResult> {
    return this.serial(() => this.bindNow(input))
  }

  private async bindNow(input: { spriiteHandle: string; credentialRef: string; defaultRepository?: string }): Promise<BindResult> {
    const t = this.transportOf()
    if (t === null) return { ok: false, reason: 'no_credential' }
    let me: Awaited<ReturnType<XTransport['me']>>
    let spriite: Awaited<ReturnType<XTransport['userByUsername']>>
    try {
      me = await t.me()
      spriite = await t.userByUsername(input.spriiteHandle)
    } catch (err) {
      const kind = err instanceof XTransportError ? err.kind : 'service'
      return { ok: false, reason: `x_${kind}` }
    }
    if (me.id === spriite.id) return { ok: false, reason: 'same_account' }
    const protectedOwner = me.protected === true
    const binding: XOwnerBinding = {
      ownerXUserId: me.id,
      ownerHandle: me.username,
      spriiteXUserId: spriite.id,
      spriiteHandle: spriite.username,
      verifiedAt: this.iso(),
      verification: 'users_me',
      credentialRef: input.credentialRef,
      // Protected-account delivery is a separate capability gate (§11).
      enabled: !protectedOwner,
      protectedOwner,
      ...(input.defaultRepository ? { defaultRepository: input.defaultRepository } : {}),
    }
    const ok = await this.write((x, s) => {
      const sameOwner = x.binding?.ownerXUserId === binding.ownerXUserId
      return {
        // A different owner starts a fresh checkpoint: nothing they posted
        // before binding is ever treated as a request.
        x: sameOwner
          ? { ...x, binding }
          : { ...initialXIntake(), binding, receipts: x.receipts, rejectedCount: x.rejectedCount },
        events: [
          draftEvent(
            'x_binding_changed',
            { bound: true, protectedOwner, enabled: binding.enabled },
            { entityId: s.entity.entityId },
          ),
        ],
      }
    })
    return ok ? { ok: true, binding } : { ok: false, reason: 'storage' }
  }

  async setEnabled(on: boolean): Promise<boolean> {
    return this.write((x) => {
      if (x.binding === null) return null
      if (on && x.binding.protectedOwner) return null
      return { x: { ...x, binding: { ...x.binding, enabled: on } } }
    })
  }

  async setDefaultRepository(repository: string | null): Promise<boolean> {
    return this.write((x) => {
      if (x.binding === null) return null
      const { defaultRepository: _old, ...rest } = x.binding
      void _old
      return { x: { ...x, binding: repository ? { ...rest, defaultRepository: repository } : rest } }
    })
  }

  /** Unbind shares the ingest queue too: the binding is the checkpoint's owner. */
  unbind(): Promise<boolean> {
    return this.serial(() => this.write((x, s) => ({
      x: { ...x, binding: null },
      events: [draftEvent('x_binding_changed', { bound: false }, { entityId: s.entity.entityId })],
    })))
  }

  // ------------------------------------------------------------ catch-up

  /**
   * One check: read the owner's own posts since the last successful check
   * (minus the overlap), receipt each trigger durably, and only then advance
   * the checkpoint. A failure leaves the checkpoint where it was, so the next
   * check re-reads the same span and dedupe absorbs the repeats.
   */
  poll(): Promise<PollResult> {
    return this.serial(() => this.pollNow())
  }

  private async pollNow(): Promise<PollResult> {
    const binding = this.state.binding
    const t = this.transportOf()
    if (binding === null || !binding.enabled || t === null) {
      return { ok: false, checked: 0, outcomes: [], gap: null, error: 'intake disabled' }
    }
    const startedAt = this.now()
    await this.write((x) => ({ x: { ...x, lastCheckedAt: this.iso(startedAt) } }))
    // A new owner's checkpoint is null, so they start at bind time. A
    // same-owner rebind keeps its checkpoint and must read the whole span
    // since it: clamping to the new verifiedAt would skip it silently.
    // With a seen-post id the read is exact — every post with a greater id
    // — so the minute-precision overlap window is only the first-check path.
    const prev = this.state.lastSuccessAt
    const sinceId = this.state.lastSeenPostId ?? null
    const from = this.iso(prev !== null ? Date.parse(prev) - this.opts.overlapMs : Date.parse(binding.verifiedAt))

    const posts: XPost[] = []
    const includes: XIncludes = { tweets: [], users: [] }
    let token: string | undefined
    let pages = 0
    try {
      do {
        const page = await t.ownerPosts(binding.ownerXUserId, from, token, sinceId)
        posts.push(...page.posts)
        includes.tweets!.push(...(page.includes.tweets ?? []))
        includes.users!.push(...(page.includes.users ?? []))
        token = page.nextToken ?? undefined
        pages += 1
      } while (token !== undefined && pages < this.opts.maxPages)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'X check failed'
      await this.recordError(message)
      return {
        ok: false,
        checked: 0,
        outcomes: [],
        gap: null,
        error: message,
        errorKind: err instanceof XTransportError ? err.kind : 'network',
      }
    }

    posts.sort((a, b) => (big(a.id) < big(b.id) ? -1 : big(a.id) > big(b.id) ? 1 : 0))
    const outcomes: IngestResult[] = []
    let failed = false
    for (const post of posts) {
      const r = await this.ingestNow(post, includes, 'catch_up')
      outcomes.push(r)
      if (r.status === 'off') {
        // The owner's kill switch landed mid-read (the runtime refused the
        // submit because intake was switched off underneath this check).
        // Not a failure: nothing is wrong with X or the credential, so no
        // health error is recorded — and the checkpoint stays where it was,
        // so a check after the intake comes back on re-reads the span and
        // dedupe absorbs the repeats.
        return { ok: false, checked: posts.length, outcomes, gap: null, error: 'intake disabled' }
      }
      if (r.status === 'failed') {
        failed = true
        break
      }
    }
    if (failed) {
      await this.recordError('a request could not be saved; it will be re-read')
      return { ok: false, checked: posts.length, outcomes, gap: null, error: 'storage', errorKind: 'storage' }
    }

    // More posts than one check reads: the older part of the span was not
    // seen. Declare it, never imply full coverage.
    let gap: XDeliveryGap | null = null
    if (token !== undefined) {
      const oldest = posts.length > 0 ? posts[0].created_at ?? from : from
      gap = { from, to: oldest, reason: 'more posts than one check reads', observedAt: this.iso() }
    }
    // The seen-post checkpoint: the newest id this check covered, so the next
    // read is exact. It moves only with the checkpoint, never past a post the
    // store could not receipt.
    let seen = this.state.lastSeenPostId ?? null
    for (const p of posts) {
      if (seen === null || big(p.id) > big(seen)) seen = p.id
    }
    const advanced = await this.write((x, s) => ({
      x: {
        ...x,
        lastSuccessAt: this.iso(startedAt),
        lastError: null,
        lastSeenPostId: seen,
        gaps: gap !== null ? [...x.gaps, gap] : x.gaps,
      },
      events:
        gap !== null
          ? [draftEvent('x_delivery_gap', { from: gap.from, to: gap.to, reason: gap.reason }, { entityId: s.entity.entityId })]
          : [],
    }))
    if (advanced) this.unsavedError = null
    else this.unsavedError = 'the check could not be saved; it will be re-read'
    return {
      ok: advanced,
      checked: posts.length,
      outcomes,
      gap,
      ...(advanced ? {} : { error: 'storage', errorKind: 'storage' as const }),
    }
  }

  // ----------------------------------------------------- stream / webhook

  /**
   * One X Activity delivery. Treated as a hint: the filter user must be the
   * bound owner, and a post.create is re-fetched before it is evaluated.
   * A fetch failure defers to catch-up rather than dropping the request.
   *
   * A post.delete cannot be re-fetched, so it is taken at its word. Whatever
   * adapter feeds this must therefore receive deliveries over a channel
   * authenticated to X (a stream it opened, or a signature-checked webhook);
   * never from an unauthenticated inbound route.
   */
  ingestActivity(event: unknown): Promise<IngestResult> {
    return this.serial(async () => {
      const binding = this.state.binding
      const t = this.transportOf()
      if (binding === null || !binding.enabled || t === null) return { status: 'ignored', reason: 'intake disabled' }
      const data = (event as { data?: { event_type?: unknown; filter?: { user_id?: unknown }; payload?: unknown } })?.data
      if (!data || data.filter?.user_id !== binding.ownerXUserId) {
        await this.countRejected()
        return { status: 'rejected', reason: 'not the bound owner\u2019s subscription' }
      }
      const payload = data.payload as { id?: unknown; author_id?: unknown } | undefined
      const id = typeof payload?.id === 'string' ? payload.id : null
      if (id === null) return { status: 'ignored', reason: 'no post id' }
      if (data.event_type === 'post.delete') {
        if (payload?.author_id !== binding.ownerXUserId) return { status: 'ignored' }
        return this.recordDeletion(id)
      }
      if (data.event_type !== 'post.create') return { status: 'ignored', reason: 'not an intake event' }
      let got: Awaited<ReturnType<XTransport['post']>>
      try {
        got = await t.post(id)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'X lookup failed'
        await this.write((x) => ({ x: { ...x, lastError: message } }))
        return { status: 'failed', reason: 'deferred to the next check' }
      }
      if (got === null) return { status: 'ignored', reason: 'the post is gone' }
      return this.ingestNow(got.post, got.includes, 'stream')
    })
  }

  /** "Import X link": the owner's manual path for a request intake missed. */
  importLink(link: string): Promise<IngestResult> {
    return this.serial(async () => {
      const binding = this.state.binding
      const t = this.transportOf()
      if (binding === null || t === null) return { status: 'ignored', reason: 'X is not connected' }
      if (!binding.enabled) return { status: 'ignored', reason: 'X intake is off' }
      const id = postIdFromLink(link)
      if (id === null) return { status: 'ignored', reason: 'not an X post link' }
      let got: Awaited<ReturnType<XTransport['post']>>
      try {
        got = await t.post(id)
        // A URL identifies a revision, not necessarily today's instruction.
        const visited = new Set<string>()
        while (got !== null && newestRevision(got.post) !== got.post.id) {
          const latest = newestRevision(got.post)
          if (visited.has(latest) || visited.size >= 5) {
            return { status: 'failed', reason: 'The current X revision could not be established. Try again.' }
          }
          visited.add(latest)
          got = await t.post(latest)
          if (got === null || got.post.id !== latest) {
            return { status: 'failed', reason: 'X would not return the current revision. No request was started.' }
          }
        }
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : 'X lookup failed' }
      }
      if (got === null) return { status: 'ignored', reason: 'the post is gone or not visible' }
      return this.ingestNow(got.post, got.includes, 'import')
    })
  }

  /** Ingest an authoritative post (tests and adapters that already fetched it). */
  ingestPost(post: XPost, includes: XIncludes, via: XIntakeReceipt['via']): Promise<IngestResult> {
    return this.serial(() => this.ingestNow(post, includes, via))
  }

  // ------------------------------------------------------- owner choices

  /**
   * The owner confirmed a held request on the phone. Re-reads the post (it
   * may have been edited or deleted since) and runs the full pipeline with
   * the window waived and, optionally, the product chosen — an existing
   * repository, or a fresh one for a named project. A control post is the
   * one thing this can never start.
   */
  confirmHeld(
    dedupeKey: string,
    choice: { repository?: string; newRepository?: boolean } = {},
  ): Promise<IngestResult> {
    return this.serial(async () => {
      const r = this.state.receipts.find((x) => x.dedupeKey === dedupeKey)
      if (!r || !needsOwner(r)) return { status: 'ignored', reason: 'nothing is waiting for this request' }
      if (r.followupDelivery === 'unknown') return { status: 'held_confirm', reason: r.reason, dedupeKey }
      if (r.deletedAt !== undefined) return { status: 'ignored', reason: 'the post was deleted' }
      if (classifyIntent(r.instruction) === 'control') {
        return { status: 'held_confirm', reason: 'Use the mission\u2019s own controls on the phone for this.' }
      }
      if (this.state.binding?.enabled !== true) return { status: 'ignored', reason: 'X intake is off' }
      const t = this.transportOf()
      if (t === null) return { status: 'failed', reason: 'X is not connected' }
      let got: Awaited<ReturnType<XTransport['post']>>
      try {
        got = await this.readOwnPost(t, r, r.revisionId)
        // The stored revision may have been edited since the hold, and X still
        // serves the old revision by its own id: confirm what the owner's post
        // says now, never the superseded draft.
        const newest = got === null ? null : newestRevision(got.post)
        if (got !== null && newest !== null && newest !== got.post.id) got = await this.readOwnPost(t, r, newest)
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : 'X lookup failed' }
      }
      if (got === null) {
        return { status: 'ignored', reason: 'X would not return the post (deleted, or not visible to the connected account)' }
      }
      return this.ingestNow(got.post, got.includes, r.via, {
        confirmed: true,
        repository: choice.repository,
        newRepository: choice.newRepository === true,
      })
    })
  }

  /**
   * One revision of a held request, re-read for confirmation. X's single-post
   * lookup can answer 404 or no data for a post the owner's timeline still
   * serves (the read that held it), so an empty lookup falls back to that
   * timeline, from the post's own time, before the post is called gone.
   */
  private async readOwnPost(
    t: XTransport,
    r: XIntakeReceipt,
    id: string,
  ): Promise<Awaited<ReturnType<XTransport['post']>>> {
    const direct = await t.post(id)
    if (direct !== null) return direct
    const owner = this.state.binding?.ownerXUserId
    const at = Date.parse(r.postedAt)
    if (owner === undefined || (r.postedAtTrusted !== false && !Number.isFinite(at))) return null
    // X v2's supported start_time floor. Legacy archive receive time is not
    // publication time: use the bounded timeline, never a fabricated date.
    const floor = Date.parse('2010-11-06T00:00:00.000Z')
    const startTime = new Date(r.postedAtTrusted === false ? floor : Math.max(floor, at - 1000)).toISOString()
    const matches = (p: XPost): boolean =>
      p.id === id || (Array.isArray(p.edit_history_tweet_ids) && p.edit_history_tweet_ids.includes(id))
    let token: string | undefined
    for (let page = 0; page < CONFIRM_TIMELINE_PAGES; page++) {
      const res = await t.ownerPosts(owner, startTime, token, null)
      const hit = res.posts.find(matches)
      if (hit !== undefined) return { post: hit, includes: res.includes }
      if (res.nextToken === null) return null
      token = res.nextToken
    }
    return null
  }

  resendFollowup(dedupeKey: string, attempt: number): Promise<boolean> {
    return this.serial(() => this.runtime.resolveXFollowup(dedupeKey, 'resend', attempt))
  }

  dismissHeld(dedupeKey: string): Promise<boolean> {
    const r = this.state.receipts.find((p) => p.dedupeKey === dedupeKey)
    if (r?.followupDelivery === 'pending') {
      // Do not wait for the delivery drain: race its durable claim instead.
      // A sending/sent/unknown winner is not proof of cancellation.
      return this.serial(async () => {
        let changed = false
        const result = await this.store.commit((s) => {
          const f = s.xFollowups?.find((p) => p.dedupeKey === dedupeKey)
          const current = s.xIntake?.receipts.find((p) => p.dedupeKey === dedupeKey)
          if (!f || f.state !== 'pending' || f.attempt !== (r.followupAttempt ?? 0) ||
              !current || current.status !== r.status ||
              s.xIntake?.binding?.ownerXUserId !== f.ownerId) return null
          changed = true
          return { state: { ...s,
            xFollowups: s.xFollowups!.map((p) => p === f ? { ...p, state: 'dismissed' } : p),
            xIntake: { ...s.xIntake!, receipts: s.xIntake!.receipts.map((p) => p === current
              ? { ...p, status: 'dismissed', followupDelivery: 'dismissed', followupAttempt: f.attempt, reason: undefined } : p) },
          }, events: [] }
        })
        return result.ok && changed
      })
    }
    if (r?.followupDelivery === 'unknown') {
      return this.serial(() => this.runtime.resolveXFollowup(dedupeKey, 'dismiss', r.followupAttempt ?? 0))
    }
    return this.serial(() =>
      this.write((x) => {
        const i = x.receipts.findIndex((r) => r.dedupeKey === dedupeKey)
        if (i < 0 || !needsOwner(x.receipts[i])) return null
        const receipts = x.receipts.slice()
        receipts[i] = { ...receipts[i], status: 'dismissed' }
        return { x: { ...x, receipts } }
      }),
    )
  }

  // --------------------------------------------------------------- core

  private async recordError(message: string): Promise<void> {
    const saved = await this.write((x) => ({ x: { ...x, lastError: message } }))
    this.unsavedError = saved ? null : message
  }

  private async countRejected(): Promise<void> {
    await this.write((x) => ({ x: { ...x, rejectedCount: x.rejectedCount + 1 } }))
  }

  private ownReceipt(r: XIntakeReceipt, binding: XOwnerBinding): boolean {
    return r.dedupeKey.startsWith(`x:${binding.ownerXUserId}:`)
  }

  private async recordDeletion(postId: string): Promise<IngestResult> {
    const binding = this.state.binding
    if (binding === null) return { status: 'ignored', reason: 'X is not connected' }
    const r = this.state.receipts.find(
      (x) => (x.logicalPostId === postId || x.revisionId === postId) && this.ownReceipt(x, binding),
    )
    if (!r) return { status: 'ignored', reason: 'not a request' }
    const ok = await this.write((x, s) => {
      const receipts = x.receipts.map((rr) => (rr.dedupeKey === r.dedupeKey ? { ...rr, deletedAt: this.iso() } : rr))
      return {
        x: { ...x, receipts },
        // Recorded, never acted on: deleting the post cancels nothing (§11).
        events: [
          draftEvent(
            'x_post_deleted',
            { logicalPostId: r.logicalPostId, missionId: r.missionId ?? null, cancelled: false },
            { entityId: s.entity.entityId },
          ),
        ],
      }
    })
    return ok ? { status: 'duplicate', reason: 'deletion recorded; nothing was cancelled', dedupeKey: r.dedupeKey } : { status: 'failed' }
  }

  private async ingestNow(
    post: XPost,
    includes: XIncludes,
    via: XIntakeReceipt['via'],
    override: { confirmed?: boolean; repository?: string; newRepository?: boolean } = {},
  ): Promise<IngestResult> {
    const binding = this.state.binding
    if (binding === null) return { status: 'ignored', reason: 'X is not connected' }
    // Malformed upstream data is refused here, not at the commit: a receipt
    // the store rejects would fail every check and pin the checkpoint.
    const history: unknown = post.edit_history_tweet_ids ?? []
    const ids: unknown[] = Array.isArray(history) ? [post.id, ...history] : [null]
    const wellFormed =
      ids.every((id) => typeof id === 'string' && NUMERIC_POST_ID.test(id)) &&
      typeof post.text === 'string' &&
      (post.conversation_id === undefined || typeof post.conversation_id === 'string') &&
      (post.created_at === undefined || typeof post.created_at === 'string')
    if (!wellFormed) {
      await this.countRejected()
      return { status: 'rejected', reason: 'malformed post data' }
    }
    const verdict = authorizeTrigger(post, binding)
    if (verdict.ok === false) {
      if (verdict.reason === 'not_owner') {
        await this.countRejected()
        return { status: 'rejected', reason: 'not authored by the bound owner' }
      }
      return { status: 'ignored', reason: verdict.reason }
    }
    const logicalPostId = post.edit_history_tweet_ids?.[0] ?? post.id
    const dedupeKey = `x:${binding.ownerXUserId}:${logicalPostId}`
    const existing = this.state.receipts.find((r) => r.dedupeKey === dedupeKey)

    if (existing !== undefined && override.confirmed && big(post.id) < big(existing.revisionId)) {
      return { status: 'ignored', reason: 'a newer revision of this post is on record; check again', dedupeKey }
    }
    if (existing !== undefined && !override.confirmed) {
      // Same or older revision (a duplicate or reordered delivery): the
      // original receipt stands.
      if (big(post.id) <= big(existing.revisionId)) {
        return { status: 'duplicate', missionId: existing.missionId, dedupeKey }
      }
      if (existing.status === 'dismissed') {
        return { status: 'duplicate', reason: 'the owner dismissed this request', dedupeKey }
      }
      if (!needsOwner(existing) || existing.followupDelivery !== undefined) {
        // An edit after dispatch: a proposed change for the owner, never a
        // silent rewrite of active work (§11).
        if (existing.proposedRevisionId !== undefined && big(post.id) <= big(existing.proposedRevisionId)) {
          return { status: 'duplicate', missionId: existing.missionId, dedupeKey }
        }
        const ok = await this.write((x, s) => ({
          x: {
            ...x,
            receipts: x.receipts.map((r) => (r.dedupeKey === dedupeKey ? { ...r, proposedRevisionId: post.id } : r)),
          },
          events: [
            draftEvent(
              'x_edit_after_dispatch',
              { logicalPostId, revisionId: post.id, missionId: existing.missionId ?? null },
              { entityId: s.entity.entityId },
            ),
          ],
        }))
        return ok
          ? { status: 'duplicate', reason: 'edit recorded as a proposed change', missionId: existing.missionId, dedupeKey }
          : { status: 'failed' }
      }
      // Held or unclear and not yet dispatched: the edit replaces the draft
      // after the same validation (below).
    }

    const instruction = verdict.instruction
    const intent = classifyIntent(instruction)
    const postedAt = post.created_at ?? this.iso()
    const base: XIntakeReceipt = {
      dedupeKey,
      logicalPostId,
      revisionId: post.id,
      conversationId: post.conversation_id ?? null,
      status: 'clarify',
      instruction,
      postedAt,
      ...(post.created_at === undefined || !Number.isFinite(Date.parse(post.created_at)) ? { postedAtTrusted: false } : {}),
      receivedAt: this.iso(),
      via,
    }

    // Controls and status come from the owner's own words only, and before
    // any context is read: captured material can never steer either (§10).
    if (intent === 'control') {
      return this.receipt({ ...base, status: 'held_confirm', reason: 'Controls from X need your OK on the phone.' })
    }
    if (intent === 'status') {
      const replyId = post.referenced_tweets?.find(r => r.type === 'replied_to')?.id
      const target = replyId ? this.state.receipts.find(r =>
        this.ownReceipt(r, binding) && (r.revisionId === replyId || r.logicalPostId === replyId))?.missionId : undefined
      const mission = target ? this.runtime.missions.find(m => m.missionId === target) : undefined
      const report = mission
        ? `${mission.title}: ${mission.phase}; control ${mission.control}. ${mission.freshness}; last successfully observed ${mission.lastObservedAt ?? 'never'}. This is a private cached status, not a new provider read.`
        : 'No exact build is selected by this post. Reply to that build’s original X request for its private status.'
      return this.receipt({ ...base, status: 'status_reported', reason: report,
        ...(mission ? { missionId: mission.missionId } : {}) })
    }
    // A post with nothing to say and nothing to point at asked for nothing.
    const hasRefs = (post.referenced_tweets ?? []).length > 0
    if (intent === 'empty' && !hasRefs) {
      return this.receipt({ ...base, status: 'clarify', reason: 'The post mentioned Spriite but asked for nothing.' })
    }

    // A missing post time is as unreadable as a garbled one: postedAt falls
    // back to the receive time for the record, never for the window.
    const age = post.created_at === undefined ? NaN : this.now() - Date.parse(postedAt)
    // Fail closed on an unreadable post time: the 24-hour window is a
    // product default, not a guess, so a post whose age cannot be
    // established is held for the owner's confirmation instead of
    // auto-launched on the strength of an unparsable timestamp (§11).
    if (via !== 'import' && !override.confirmed && (!Number.isFinite(age) || age > this.opts.autoLaunchWindowMs)) {
      return this.receipt({
        ...base,
        status: 'held_window',
        reason: Number.isFinite(age)
          ? 'Older than 24 hours. Confirm on the phone to start it.'
          : 'The post time could not be read. Confirm on the phone to start it.',
      })
    }

    // A direct reply to a request that already has a live mission extends
    // that mission (ownership was just verified on this post). Sharing a
    // conversation is not enough: two requests in one thread are two builds.
    // This runs before context is read: the parent is the mission's own
    // request, so it can neither supply substance (a stray "lol" under a live
    // build must not steer or start anything) nor be a missing essential.
    const repliedTo = post.referenced_tweets?.find((r) => r.type === 'replied_to')?.id
    if (repliedTo !== undefined) {
      const parent = this.state.receipts.find(
        (r) =>
          (r.revisionId === repliedTo || r.logicalPostId === repliedTo) &&
          r.missionId !== undefined &&
          r.dedupeKey !== dedupeKey &&
          this.ownReceipt(r, binding),
      )
      const m = parent ? this.runtime.missions.find((mm) => mm.missionId === parent.missionId) : undefined
      if (parent && m && !isTerminalPhase(m.phase)) {
        const steers =
          instruction !== '' &&
          (intent === 'build' || override.confirmed === true || hasRequestSubstance(instruction, []))
        if (!steers) {
          return this.receipt({ ...base, status: 'clarify', reason: 'I could not find a build request in the post.' })
        }
        const t = this.transportOf()
        if (!t) return { status: 'failed', reason: 'X is not connected' }
        const gathered = await gatherContext({
          post, includes, ownerId: binding.ownerXUserId, instruction, transport: t,
          method: via === 'stream' ? 'x_event_payload' : 'x_api_v2',
          budget: { ...(this.contextBudget ?? { maxParentHops: 5, maxPosts: 20, maxLinks: 3, maxTextPerPost: 4000 }), maxParentHops: 0 },
          github: this.githubOf(),
        })
        if (gathered.missingEssential) {
          return this.receipt({ ...base, missionId: m.missionId, status: 'clarify', reason: gathered.missingEssential })
        }
        const recorded = await this.runtime.submitXFollowup({ ...base,
          instruction: composeGoal(instruction, gathered.artifacts),
          status: 'held_confirm', missionId: m.missionId }, binding.ownerXUserId)
        if (recorded.status === 'failed') {
          // The owner's kill switch landing mid-read (the connection gate, or
          // the binding switched off under the context read) is not a failed
          // save: map it to 'off' exactly as the new-request path does, so the
          // check records no health error and the un-advanced checkpoint
          // re-reads this reply once intake is back on.
          if (recorded.reason === 'X intake is off' || this.state.binding?.enabled !== true) {
            return { status: 'off', reason: 'X intake is off' }
          }
          return { status: 'failed', reason: 'The follow-up could not be saved.', dedupeKey }
        }
        return { status: recorded.status === 'duplicate' ? 'duplicate' : 'held_confirm', missionId: m.missionId,
          dedupeKey, reason: 'Saved for this build; waiting to send.' }
      }
    }

    // Context is read BEFORE the request is judged, so "this" can lean on a
    // readable quote and a GitHub link can be opened (§12). The owner's
    // confirm waives the gaps context could not close: an explicit Build it
    // always starts the request, with the missing material still named.
    const t = this.transportOf()
    if (t === null) return { status: 'failed', reason: 'X is not connected' }
    const gathered = await gatherContext({
      post,
      includes,
      ownerId: binding.ownerXUserId,
      instruction,
      transport: t,
      method: via === 'stream' ? 'x_event_payload' : 'x_api_v2',
      budget: this.contextBudget,
      github: this.githubOf(),
    })
    const native = this.runtime.nativeExecution?.() === true
    const isRequest =
      intent === 'build' ||
      override.confirmed === true ||
      hasRequestSubstance(instruction, gathered.artifacts)
    if (!isRequest) {
      return this.receipt({ ...base, status: 'clarify', reason: 'I could not find a build request in the post.' })
    }
    const hasSourceReference = gathered.artifacts.some(a => a.role !== 'owner_instruction' &&
      (a.kind === 'github_repo' || a.kind === 'github_issue' || a.kind === 'github_pull' ||
        repositoryFrom(a.kind === 'x_post' ? a.text : a.sourceId) !== null))
    const nativeCreates = native && this.runtime.nativeCreatesPrivateRepositories?.() === true
    let nativeNewRepository = false
    if (!override.repository && !override.newRepository && !destinationRepositoryFrom(instruction) &&
      !repositoryFromContext(gathered.artifacts) &&
      (repositoryFrom(instruction) !== null || hasSourceReference || /\bnew repo(?:sitory)?\b/i.test(instruction))) {
      if (native && /\bnew repo(?:sitory)?\b/i.test(instruction) && repositoryFrom(instruction) === null && !hasSourceReference) {
        if (!nativeCreates) return this.receipt({ ...base, status: 'clarify', reason: X_NATIVE_NO_NEW_REPO_REASON })
        nativeNewRepository = true
      }
    }
    // A linked product with no named destination is a reference, never the
    // destination. With a designated X default it is held for the owner's
    // choice (never silently the default); without one, routing below gives
    // the request a repository of its own.
    if (binding.defaultRepository && !nativeNewRepository && !override.repository && !override.newRepository && !destinationRepositoryFrom(instruction) &&
      !repositoryFromContext(gathered.artifacts) &&
      (repositoryFrom(instruction) !== null || hasSourceReference || /\bnew repo(?:sitory)?\b/i.test(instruction))) {
      return this.receipt({ ...base, status: 'held_confirm', projectName: '',
        repositoryChoices: [binding.defaultRepository],
        reason: (native
          ? 'The linked product is a reference, not a destination. Choose an existing destination on the phone; native mode cannot create repositories.'
          : 'The linked product is a reference, not a destination. Choose an existing destination or New repo on the phone; local execution grants neither creation nor publication.') +
          (gathered.missingEssential ? ` Missing context: ${gathered.missingEssential}` : '') })
    }
    if (gathered.missingEssential !== null && override.confirmed !== true) {
      return this.receipt({ ...base, status: 'clarify', reason: gathered.missingEssential })
    }

    // A post that said nothing of its own: the goal is honest about that,
    // and the captured material carries the request.
    const goalInstruction =
      instruction === ''
        ? '(The post itself said nothing; the referenced material is the request.)'
        : instruction
    const goal = composeGoal(goalInstruction, gathered.artifacts)
    const dispatch = async (input: Omit<SubmitCommandInput, 'text' | 'source' | 'sourceEventId' | 'dedupeKey' | 'issuedAt' | 'contextRefs' | 'startApproved'>): Promise<IngestResult> => {
      // A native intent carries the goal exactly; it is refused, never cut.
      if (native && goal.length > NATIVE_GOAL_LIMIT) {
        return this.receipt({ ...base, status: 'clarify', reason: xNativeTooLongReason(goal.length) })
      }
      const submit = await this.runtime.submitCommand({
        text: goal,
        source: 'x',
        sourceEventId: post.id,
        dedupeKey,
        issuedAt: postedAt,
        contextRefs: gathered.artifacts.map((a) => a.artifactId),
        // The owner's post (or their Build it on a held one) is the start
        // approval: an X build has nobody at the glasses to tap Start.
        startApproved: true,
        ...input,
      })
      if (submit.receipt === 'rejected' || submit.missionId === undefined) {
        // The phone's kill switch (X turned off mid-read, the connection
        // wrapper in src/intake/connection.ts) is not a failure of X, the
        // credential, or the store: the check stops carrying no health error,
        // and the un-advanced checkpoint re-reads this span once intake is
        // back on.
        if (submit.reason === 'X intake is off') return { status: 'off', reason: submit.reason }
        // Not durably received: no receipt, so the checkpoint cannot pass it.
        return { status: 'failed', reason: submit.reason ?? 'not recorded' }
      }
      return this.receipt(
        {
          ...base,
          status: 'submitted',
          commandId: submit.commandId,
          missionId: submit.missionId,
          ...(native ? { reason: xNativeReceiptReason(this.runtime.missions.find((m) => m.missionId === submit.missionId)) } : {}),
          ...(input.repository !== undefined ? { repository: input.repository } : {}),
        },
        { commandId: submit.commandId, artifacts: gathered.artifacts },
      )
    }

    // Native: a new private, empty repository under the owner's own account,
    // named exactly in the post (or the project the owner chose on the phone).
    // It stays held until the owner reviews it like any other request.
    if (native && (nativeNewRepository || override.newRepository === true)) {
      if (!nativeCreates) return this.receipt({ ...base, status: 'clarify', reason: X_NATIVE_NO_NEW_REPO_REASON })
      const chosen = override.newRepository === true ? existing?.projectName?.trim() ?? '' : ''
      const name = chosen !== '' && validRepositoryName(chosen) ? chosen : newRepositoryNameFrom(instruction)
      if (name === null) return this.receipt({ ...base, status: 'clarify', reason: X_NATIVE_NEW_REPO_NAME_REASON })
      const account = this.runtime.nativeRepositoryAccount?.() ??
        /^https:\/\/github\.com\/([A-Za-z0-9-]+)\//.exec(binding.defaultRepository ?? '')?.[1] ?? null
      if (account === null || !validGithubAccount(account)) {
        return this.receipt({ ...base, status: 'clarify', reason: X_NATIVE_NEW_REPO_ACCOUNT_REASON })
      }
      return dispatch({ newRepository: true, newRepositoryName: name, newRepositoryAccount: account })
    }

    // A fresh repository the owner chose on the phone for a named project.
    if (override.newRepository === true) {
      const name = existing?.projectName
      return dispatch({
        newRepository: true,
        ...(name !== undefined && name !== '' ? { newRepositoryName: name } : {}),
      })
    }

    // Routing (§10): the owner's explicit repository, then the repository
    // the owner's own captured context points at, then a named project
    // (asked, never guessed), then the configured X default. A stranger's
    // reference can never choose the product.
    let repository = (override.repository || null) ?? destinationRepositoryFrom(instruction) ?? repositoryFromContext(gathered.artifacts) ?? null
    if (repository === null) {
      const candidates = await projectCandidates(instruction, () => this.githubOf())
      if (candidates?.incomplete) {
        return this.receipt({ ...base, status: 'held_confirm', projectName: '',
          repositoryChoices: [],
          reason: 'Repository discovery could not complete. Choose an exact existing destination or New repo on the phone; no default was selected.' })
      }
      if (candidates !== null && candidates.urls.length > 0) {
        if (binding.defaultRepository !== undefined && candidates.urls.includes(binding.defaultRepository)) {
          // The named project IS the configured default: asking would be a
          // question with one honest answer.
          repository = binding.defaultRepository
        } else {
          return this.receipt({
            ...base,
            status: 'held_confirm',
            reason: `Is ${candidates.projectName} a new repository or an existing one? Choose on the phone.`,
            projectName: candidates.projectName,
            repositoryChoices: candidates.urls,
          })
        }
      } else {
        // Only a default the owner designated for X (Setup → X requests),
        // never the repository the app happens to have selected.
        repository = binding.defaultRepository ?? null
      }
    }
    // A request with no destination is its own product: it gets a new
    // repository (the owner's rule: an X build never lands in Spriite, or any
    // other existing repository, unless that repository was designated).
    if (repository === null) {
      const name = newRepositoryNameFrom(instruction) ?? derivedRepositoryName(instruction, logicalPostId)
      if (native) {
        if (!nativeCreates) return this.receipt({ ...base, status: 'held_confirm', reason: X_NATIVE_NO_DESTINATION_REASON })
        const account = this.runtime.nativeRepositoryAccount?.() ??
          /^https:\/\/github\.com\/([A-Za-z0-9-]+)\//.exec(binding.defaultRepository ?? '')?.[1] ?? null
        if (account === null || !validGithubAccount(account)) {
          return this.receipt({ ...base, status: 'clarify', reason: X_NATIVE_NEW_REPO_ACCOUNT_REASON })
        }
        return dispatch({ newRepository: true, newRepositoryName: name, newRepositoryAccount: account })
      }
      return dispatch({ newRepository: true, newRepositoryName: name })
    }
    return dispatch({ repository })
  }

  /** Upsert the receipt (one per logical post) with its journal facts. */
  private async receipt(
    r: XIntakeReceipt,
    context?: { commandId: string; artifacts: ContextArtifact[] },
  ): Promise<IngestResult> {
    const ok = await this.write((x, s) => {
      const prior = x.receipts.find((p) => p.dedupeKey === r.dedupeKey)
      const merged: XIntakeReceipt = prior?.deletedAt !== undefined ? { ...r, deletedAt: prior.deletedAt } : r
      const receipts = prior ? x.receipts.map((p) => (p.dedupeKey === r.dedupeKey ? merged : p)) : [...x.receipts, merged]
      const entityId = s.entity.entityId
      const events: EventDraft[] = [
        draftEvent(
          'x_request_received',
          { status: r.status, via: r.via, logicalPostId: r.logicalPostId, missionId: r.missionId ?? null },
          { entityId, ...(r.commandId ? { causalCommandId: r.commandId } : {}) },
        ),
      ]
      if (needsOwner(r)) {
        events.push(
          draftEvent('x_request_needs_owner', { status: r.status, reason: r.reason ?? '', logicalPostId: r.logicalPostId }, { entityId }),
        )
      }
      let artifacts: Record<string, ContextArtifact[]> | undefined
      if (context !== undefined) {
        const all = { ...(s.contextArtifacts ?? {}), [context.commandId]: context.artifacts }
        const keys = Object.keys(all)
        for (const k of keys.slice(0, Math.max(0, keys.length - this.opts.maxContextCommands))) delete all[k]
        artifacts = all
      }
      return {
        x: { ...x, receipts, lastReceivedAt: this.iso(), lastReceivedPostId: r.revisionId },
        events,
        ...(artifacts !== undefined ? { artifacts } : {}),
      }
    })
    if (!ok) return { status: 'failed', reason: 'storage', dedupeKey: r.dedupeKey }
    return { status: r.status, reason: r.reason, missionId: r.missionId, dedupeKey: r.dedupeKey }
  }

  // --------------------------------------------------------------- health

  health(): XIntakeHealth {
    const x = this.state
    if (this.unsavedError === null) return xIntakeHealth(x)
    return xIntakeHealth({ ...x, lastCheckedAt: x.lastCheckedAt ?? this.iso(), lastError: this.unsavedError })
  }
}

/** The phone's intake panel (§11): honest about what has been checked. */
export function xIntakeHealth(x: XIntakeState): XIntakeHealth {
  const b = x.binding
  const state: XIntakeHealth['state'] =
    b === null
      ? 'unbound'
      : b.protectedOwner
        ? 'protected_unsupported'
        : !b.enabled
          ? 'disabled'
          : x.lastCheckedAt === null
            ? 'never_checked'
            : x.lastError !== null
              ? 'error'
              : 'ok'
  const clock = (iso: string | null): string => (iso ? iso.slice(11, 16) + ' UTC' : '')
  const summary =
    state === 'unbound'
      ? 'X is not connected.'
      : state === 'protected_unsupported'
        ? 'Your X account is protected; X does not deliver its posts to intake.'
        : state === 'disabled'
          ? 'X intake is off.'
          : state === 'never_checked'
            ? 'Not checked yet.'
            : state === 'error'
              ? `Last check failed (${x.lastError}). Last good check ${x.lastSuccessAt ? clock(x.lastSuccessAt) : 'never'}.`
              : x.lastSuccessAt === null
                ? 'Checking now.'
                : x.lastReceivedAt !== null && x.lastReceivedAt >= x.lastSuccessAt
                  ? `Request received ${clock(x.lastReceivedAt)}.`
                  : `No new requests as of ${clock(x.lastSuccessAt)}.`
  return {
    state,
    ownerHandle: b?.ownerHandle ?? null,
    spriiteHandle: b?.spriiteHandle ?? null,
    lastCheckedAt: x.lastCheckedAt,
    lastSuccessAt: x.lastSuccessAt,
    lastError: x.lastError,
    lastReceivedAt: x.lastReceivedAt,
    lastReceivedPostId: x.lastReceivedPostId,
    // Intake state holds no credential: the phone's connection layer answers
    // whether renewal is armed, and whether the last attempt failed.
    refresh: 'off',
    summary,
    gaps: x.gaps,
    needsOwner: x.receipts.filter(needsOwner),
    recent: x.receipts.slice(-10).reverse(),
    rejectedCount: x.rejectedCount,
    limitations: X_LIMITATIONS,
  }
}
