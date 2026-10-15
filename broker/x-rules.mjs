/**
 * Pure port of the phone's X trigger and routing rules (src/intake/x.ts,
 * src/native/delivery.ts, isDeictic from src/context/gather.ts) for the host
 * X reader. Dependency-free and behavior-identical: scripts/test-host-x-rules.mjs
 * runs the same cases against both and fails on any difference.
 *
 * Authority rules (restated from x.ts because they are easy to erode):
 * - a handle is a label; only numeric ids authorize;
 * - only a mention ENTITY of the Spriite id, on a typed "@" inside the visible
 *   range, is a trigger (a reply's leading auto-mentions are not);
 * - a repost is never a trigger; a malformed range fails closed.
 *
 * The one deliberate difference: a post whose shape the src code would throw
 * on (non-string text, a non-object note_tweet, non-array referenced_tweets
 * or mentions) is refused here as not_a_trigger instead of throwing.
 */

const cp = (s) => Array.from(s)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The shape the rules read; anything else fails closed. */
function wellShaped(post) {
  if (!isObject(post) || typeof post.text !== 'string') return false
  if (post.referenced_tweets !== undefined && post.referenced_tweets !== null && !Array.isArray(post.referenced_tweets)) return false
  if (post.note_tweet !== undefined && (!isObject(post.note_tweet) || typeof post.note_tweet.text !== 'string')) return false
  const entities = post.note_tweet !== undefined ? post.note_tweet.entities : post.entities
  if (entities !== undefined && entities !== null) {
    if (!isObject(entities)) return false
    for (const key of ['mentions', 'urls']) {
      const list = entities[key]
      if (list !== undefined && list !== null && (!Array.isArray(list) || !list.every(isObject))) return false
    }
  }
  return (post.referenced_tweets ?? []).every(isObject)
}

/** The evaluated text, its code points, entities and visible range (null range: fail closed). */
function evaluated(post) {
  const long = post.note_tweet !== undefined
  const text = long ? post.note_tweet.text : post.text
  const entities = long ? post.note_tweet.entities : post.entities
  const chars = cp(text)
  const isReply = (post.referenced_tweets ?? []).some((r) => r.type === 'replied_to')
  return { chars, entities, range: visibleRange(post, chars, long, isReply) }
}

/**
 * Is this post a trigger from the bound owner? Pure. The mention must be a
 * mention ENTITY carrying the Spriite account's numeric id, inside the
 * visible text range (a reply's leading auto-mentions sit outside it and are
 * implicit, not a request).
 */
export function authorizeTrigger(post, binding) {
  if (!wellShaped(post)) return { ok: false, reason: 'not_a_trigger' }
  if ((post.referenced_tweets ?? []).some((r) => r.type === 'retweeted')) return { ok: false, reason: 'repost' }
  if (post.author_id !== binding.ownerXUserId) return { ok: false, reason: 'not_owner' }
  const { chars, entities, range } = evaluated(post)
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
      (chars[m.start] === '@' || chars[m.start] === '＠'),
  )
  if (explicit.length === 0) return { ok: false, reason: 'not_a_trigger' }
  return { ok: true, instruction: instructionFrom(chars, visStart, visEnd, entities, binding.spriiteXUserId) }
}

/**
 * The owner's instruction: visible text with Spriite mentions removed and
 * t.co links expanded, exactly what x.ts composes goals from. Null when the
 * visible range cannot be established (fail closed). It does not authorize:
 * call authorizeTrigger first.
 */
export function instructionOf(post, binding) {
  if (!wellShaped(post)) return null
  const { chars, entities, range } = evaluated(post)
  if (range === null) return null
  return instructionFrom(chars, range[0], range[1], entities, binding.spriiteXUserId)
}

/**
 * The visible span of the evaluated text, or null to fail closed. Without a
 * range a reply's leading auto-mentions are indistinguishable from an
 * explicit one; a malformed range is never widened to the whole text. A long
 * post's range describes its short `text`, so when the note text repeats that
 * hidden prefix (a reply's auto-mentions) the prefix is skipped there too.
 */
function visibleRange(post, chars, long, isReply) {
  const raw = post.display_text_range
  if (raw === undefined || raw === null) return isReply ? null : [0, chars.length]
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((n) => Number.isInteger(n))) return null
  const [s, e] = raw
  const short = cp(post.text)
  if (s < 0 || s > e || s > short.length) return null
  if (!long) return [s, Math.min(e, chars.length)]
  const prefix = short.slice(0, s).join('')
  const start = prefix !== '' && post.note_tweet.text.startsWith(prefix) ? s : 0
  return [start, chars.length]
}

function instructionFrom(chars, visStart, visEnd, entities, spriiteId) {
  const spans = []
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

/** Dedupe identity: the first edit-history id (the original post), else the post id. */
export function logicalPostId(post) {
  return post.edit_history_tweet_ids?.[0] ?? post.id
}

// ------------------------------------------------------------------ intent

const LEAD_IN = /^(?:(?:hey|hi|ok|okay|yo|please|pls|plz|can you|could you|would you|will you|go|now)\b[\s,!]*)+/i
const CONTROL = /^(cancel|stop|pause|resume|unpause|abort|kill|halt|delete|undo|revert|merge|deploy|roll ?back|close|restart|retry)\b/i
const STATUS = /^(?:status|progress|update|how(?:['’]s| is) (?:it|the build|everything|work) going|where are we|any (?:news|update)|what(?:['’]s| is) (?:the )?(?:status|progress)(?: of (?:(?:the|this|my) )?(?:build|job|mission|project|work))?)(?:[.!?]*)$/i
const BUILD =
  /\b(build|make|create|add|fix|implement|ship|design|write|prototype|code|develop|set ?up|turn\b.*\binto|port|refactor|improve|redesign|generate|scaffold|draft|extend|change|update|clone|fork|adapt)\b/i

/** Classify the owner's instruction. Conservative: unclear is never a build. */
export function classifyIntent(instruction) {
  const bare = instruction.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (bare === '') return 'empty'
  const lead = instruction.replace(LEAD_IN, '').trim()
  if (CONTROL.test(lead)) return 'control'
  if (STATUS.test(lead)) return 'status'
  if (BUILD.test(lead)) return 'build'
  return 'unclear'
}

// ---------------------------------------------------------------- routing

/** An explicit GitHub repository in the owner's own words, normalized. */
export function repositoryFrom(instruction) {
  // The host must start a token: `gist.github.com/...` and
  // `evil.com/github.com/...` are not a github.com repository.
  const m = /(?:^|[\s(<"'])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})/i.exec(instruction)
  if (!m) return null
  const name = m[2].replace(/\.git$/i, '').replace(/[.]+$/, '')
  if (name === '' || name === '.' || name === '..') return null
  return `https://github.com/${m[1]}/${name}`
}

/** Source/adaptation links do not authorize a checkout or the saved default. */
export function destinationRepositoryFrom(instruction) {
  const repository = repositoryFrom(instruction)
  if (!repository) return null
  if (/\b(?:clone|fork|adapt|inspired|similar|like|based on|from|new repo(?:sitory)?)\b/i.test(instruction)) {
    const explicit = /\b(?:in|into|destination(?: repository)?[: ]+|target(?: repository)?[: ]+)\s*(https?:\/\/github\.com\/[^\s]+)/i.exec(instruction)
    return explicit ? repositoryFrom(explicit[1]) : null
  }
  return repository
}

export const validGithubAccount = (v) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(v)
/** GitHub's repository-name alphabet; `.`/`..` and a `.git` suffix are refused. */
export const validRepositoryName = (v) =>
  /^[A-Za-z0-9._-]{1,100}$/.test(v) && !/^\.{1,2}$/.test(v) && !/\.git$/i.test(v)

/**
 * The repository name a post states explicitly ("new repo called habit-log",
 * "new private repository named `habit-log`"). Never invented from the goal.
 */
export function newRepositoryNameFrom(instruction) {
  const name = '[`"\'“‘]?([A-Za-z0-9._-]+?)[`"\'”’]?(?=[\\s,;:!?)]|\\.(?:\\s|$)|$)'
  for (const pattern of [
    new RegExp(`\\bnew (?:private )?repo(?:sitory)?\\s+(?:called|named)\\s+${name}`, 'i'),
    new RegExp(`\\b(?:called|named)\\s+${name}\\s+(?:in|as)\\s+a\\s+new (?:private )?repo(?:sitory)?\\b`, 'i'),
    new RegExp(`\\bnew (?:private )?repo(?:sitory)?:\\s*${name}`, 'i'),
  ]) {
    const m = pattern.exec(instruction)
    if (m && validRepositoryName(m[1])) return m[1]
  }
  return null
}

/** The generic words a project-name match must never mistake for a name (x.ts PROJECT_STOP). */
const PROJECT_STOP = new Set(
  (
    'build make create add fix implement ship design write draft extend change update port refactor improve generate ' +
    'scaffold prototype code develop please pls plz this that these those with for from into when then also just like ' +
    'want wanted needs need should must have has will your yours mine ours their here there about using give very much ' +
    'many what which where why does did done been was were are the and but not now new own same next first last every ' +
    'each other more most less app site page web website'
  ).split(' '),
)

/**
 * The owner's repositories that a word in the instruction names, if any: the
 * match half of x.ts projectCandidates, over a list already read (the phone
 * reads it through the owner's GitHub token and hands it over).
 */
export function projectCandidates(instruction, repos) {
  const tokens = []
  for (const w of instruction.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !PROJECT_STOP.has(w) && !tokens.includes(w)) tokens.push(w)
  }
  const urls = []
  let projectName = null
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

const NAME_STOPWORDS = new Set(['a', 'an', 'the', 'me', 'my', 'us', 'our', 'for', 'to', 'of', 'and', 'with', 'that', 'this',
  'please', 'build', 'make', 'create', 'add', 'write', 'can', 'you', 'could', 'would', 'should', 'i', 'want', 'need', 'new',
  'repo', 'repository', 'spriite', 'in', 'on', 'it', 'some', 'simple', 'small', 'quick'])

/**
 * A repository name for a request that named none: a few content words from
 * the post plus a stable suffix from the post id, so the same post always
 * maps to the same repository and two posts never collide.
 */
export function derivedRepositoryName(instruction, postId) {
  const words = instruction.toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ').replace(/[@#]\w+/g, ' ')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1 && !NAME_STOPWORDS.has(w)).slice(0, 4)
  const suffix = (postId.replace(/[^0-9A-Za-z]/g, '').slice(-10) || '0').toLowerCase()
  // Truncate the words, never the suffix: the suffix is what keeps two posts apart.
  const stem = (words.join('-') || 'x-build').slice(0, 100 - suffix.length - 1).replace(/-+$/, '')
  const name = `${stem || 'x-build'}-${suffix}`
  return validRepositoryName(name) ? name : `x-build-${suffix}`
}

// ------------------------------------------------------- request substance

/** Too short to stand alone, or pointing at something else (gather.ts). */
export function isDeictic(instruction) {
  const words = instruction.trim().split(/\s+/).filter(Boolean)
  return words.length < 6 || /\b(this|that|these|those|it|here|above)\b/i.test(instruction)
}

/** Words that ask for something without carrying a build verb. */
const REQUEST_WORDS =
  /\b(?:want|wants|wanted|need|needs|needed|wish|should|must|gotta|looking for|hoping for|asking for|can you|could you|would you|will you|let'?s|how about|what about)\b/i
/** Words that name a product: enough that a substantive post is about one. */
const PROJECT_WORDS =
  /\b(?:app|application|site|website|web ?page|page|landing|portfolio|blog|store|shop|dashboard|tool|service|api|bot|extension|plugin|script|game|theme|form|gallery|map|tracker|calendar|widget|menu|checkout|repo|repository|project)\b/i
/** Praise reads as praise, not as a request, however substantive it is. */
const PLEASANTRY = /\b(?:thanks?|thank you|great work|good job|nice work|well done|awesome|amazing|congrats|congratulations)\b/i

/**
 * Does the post amount to a request? The host reader passes no captured
 * context (artifacts default to none), so only an explicit repository with
 * something said about it, or substantive words that ask for or name a
 * product, count; a bare compliment or a bare mention does not.
 */
export function hasRequestSubstance(instruction, artifacts = []) {
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
