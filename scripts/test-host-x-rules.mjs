/**
 * Parity: broker/x-rules.mjs (the host X reader's rules) against the phone's
 * originals in src/intake/x.ts, src/native/delivery.ts and
 * src/context/gather.ts. Every case runs through both and must agree exactly.
 * Pure: no network, no credentials.
 */
import assert from 'node:assert/strict'
import * as host from '../broker/x-rules.mjs'
import * as intake from '../src/intake/x.ts'
import * as delivery from '../src/native/delivery.ts'
import { isDeictic } from '../src/context/gather.ts'

let passed = 0
let compared = 0
const test = async (name, fn) => { await fn(); passed++; console.log(`  PASS: ${name}`) }

const OWNER = '1001'
const SPRIITE = '2002'
const binding = { ownerXUserId: OWNER, ownerHandle: 'owner', spriiteXUserId: SPRIITE, spriiteHandle: 'spriite',
  verifiedAt: '2026-10-14T00:00:00.000Z', verification: 'users_me', credentialRef: 'ref', enabled: true, protectedOwner: false }

const cpLen = (s) => Array.from(s).length
/** Code-point offset of the nth occurrence of `needle` in `text`. */
const at = (text, needle, nth = 0) => {
  let i = -1
  for (let k = 0; k <= nth; k++) { i = text.indexOf(needle, i + 1); assert.ok(i >= 0, `${needle} in ${text}`) }
  return cpLen(text.slice(0, i))
}
const mention = (text, handle, id, nth = 0) => {
  const start = at(text, handle, nth)
  return { start, end: start + cpLen(handle), username: handle.slice(1), id }
}
const url = (text, short, expanded) => {
  const start = at(text, short)
  return { start, end: start + cpLen(short), url: short, expanded_url: expanded }
}
const post = (text, extra = {}) => ({ id: '9001', text, author_id: OWNER, edit_history_tweet_ids: ['9001'], ...extra })
const spriitePost = (text, extra = {}) =>
  post(text, { entities: { mentions: [mention(text, '@spriite', SPRIITE)] }, ...extra })

const same = (label, a, b) => { compared++; assert.deepEqual(a, b, label) }

/** One post through both pipelines: verdict, instruction, logical id and everything downstream. */
const parityPost = (label, p, b = binding) => {
  const src = intake.authorizeTrigger(p, b)
  const ours = host.authorizeTrigger(p, b)
  same(`${label}: verdict`, ours, src)
  same(`${label}: logicalPostId`, host.logicalPostId(p), p.edit_history_tweet_ids?.[0] ?? p.id)
  if (src.ok) {
    same(`${label}: instructionOf`, host.instructionOf(p, b), src.instruction)
    parityText(`${label}: instruction`, src.instruction, host.logicalPostId(p))
  }
  return ours
}

/** One instruction through every text rule. */
const parityText = (label, text, postId = '1234567890123') => {
  same(`${label}: classifyIntent`, host.classifyIntent(text), intake.classifyIntent(text))
  same(`${label}: repositoryFrom`, host.repositoryFrom(text), intake.repositoryFrom(text))
  same(`${label}: destinationRepositoryFrom`, host.destinationRepositoryFrom(text), intake.destinationRepositoryFrom(text))
  same(`${label}: newRepositoryNameFrom`, host.newRepositoryNameFrom(text), delivery.newRepositoryNameFrom(text))
  same(`${label}: derivedRepositoryName`, host.derivedRepositoryName(text, postId), delivery.derivedRepositoryName(text, postId))
  same(`${label}: hasRequestSubstance`, host.hasRequestSubstance(text), intake.hasRequestSubstance(text, []))
  same(`${label}: isDeictic`, host.isDeictic(text), isDeictic(text))
}

console.log('host X rules parity')

await test('owner, non-owner and missing author', () => {
  const p = spriitePost('@spriite build me a habit tracker')
  assert.equal(parityPost('owner', p).ok, true)
  assert.deepEqual(parityPost('stranger', { ...p, author_id: '3003' }), { ok: false, reason: 'not_owner' })
  const { author_id: _, ...anon } = p
  assert.deepEqual(parityPost('no author', anon), { ok: false, reason: 'not_owner' })
  // A handle is a label: the right handle on the wrong id is not a trigger.
  const wrongId = post('@spriite build it', { entities: { mentions: [mention('@spriite build it', '@spriite', '7777')] } })
  assert.deepEqual(parityPost('wrong mention id', wrongId), { ok: false, reason: 'not_a_trigger' })
  // A numeric owner id compared as a number is not the bound string id.
  assert.deepEqual(parityPost('numeric author', { ...p, author_id: 1001 }), { ok: false, reason: 'not_owner' })
})

await test('reposts are refused before ownership', () => {
  const p = spriitePost('RT @spriite build me a site', { referenced_tweets: [{ type: 'retweeted', id: '55' }] })
  assert.deepEqual(parityPost('repost', p), { ok: false, reason: 'repost' })
  assert.deepEqual(parityPost('stranger repost', { ...p, author_id: '3003' }), { ok: false, reason: 'repost' })
})

await test('replies: leading auto-mentions are not a trigger', () => {
  const text = '@spriite @friend nice one'
  const auto = post(text, {
    entities: { mentions: [mention(text, '@spriite', SPRIITE), mention(text, '@friend', '4004')] },
    referenced_tweets: [{ type: 'replied_to', id: '77' }], display_text_range: [at(text, 'nice'), cpLen(text)],
  })
  assert.deepEqual(parityPost('auto-mention only', auto), { ok: false, reason: 'not_a_trigger' })
  const text2 = '@friend @spriite fix the login page please'
  const typed = post(text2, {
    entities: { mentions: [mention(text2, '@friend', '4004'), mention(text2, '@spriite', SPRIITE)] },
    referenced_tweets: [{ type: 'replied_to', id: '77' }], display_text_range: [at(text2, '@spriite'), cpLen(text2)],
  })
  const v = parityPost('typed mention in reply', typed)
  assert.equal(v.ok, true)
  assert.equal(v.instruction, 'fix the login page please')
  // A reply without a range cannot tell auto-mentions from typed ones.
  const { display_text_range: _, ...noRange } = typed
  assert.deepEqual(parityPost('reply without range', noRange), { ok: false, reason: 'not_a_trigger' })
  // Spriite as the auto-mention, and typed again inside the visible text.
  const text3 = '@spriite ok @spriite add dark mode'
  const both = post(text3, {
    entities: { mentions: [mention(text3, '@spriite', SPRIITE), mention(text3, '@spriite', SPRIITE, 1)] },
    referenced_tweets: [{ type: 'replied_to', id: '77' }], display_text_range: [at(text3, 'ok'), cpLen(text3)],
  })
  assert.equal(parityPost('auto plus typed', both).ok, true)
})

await test('mentions outside or beyond the visible range', () => {
  const text = 'make a game @spriite'
  const m = mention(text, '@spriite', SPRIITE)
  assert.deepEqual(parityPost('mention past range end', post(text, { entities: { mentions: [m] }, display_text_range: [0, 11] })),
    { ok: false, reason: 'not_a_trigger' })
  assert.equal(parityPost('mention at range end', post(text, { entities: { mentions: [m] }, display_text_range: [0, cpLen(text)] })).ok, true)
  // A range longer than the text is clamped, never a widening into nothing.
  assert.equal(parityPost('range past text', post(text, { entities: { mentions: [m] }, display_text_range: [0, 500] })).ok, true)
  // Offsets that do not land on a typed "@".
  const shifted = { ...m, start: m.start + 1, end: m.end }
  assert.deepEqual(parityPost('offset off the @', post(text, { entities: { mentions: [shifted] } })), { ok: false, reason: 'not_a_trigger' })
  assert.deepEqual(parityPost('empty entity', post(text, { entities: { mentions: [{ ...m, end: m.start }] } })),
    { ok: false, reason: 'not_a_trigger' })
  assert.deepEqual(parityPost('fractional entity', post(text, { entities: { mentions: [{ ...m, start: 11.5 }] } })),
    { ok: false, reason: 'not_a_trigger' })
  assert.deepEqual(parityPost('no entities', post(text)), { ok: false, reason: 'not_a_trigger' })
})

await test('malformed ranges fail closed', () => {
  const text = '@spriite build a landing page'
  const base = spriitePost(text)
  for (const [label, range] of [
    ['negative', [-1, 10]], ['inverted', [10, 2]], ['start past text', [400, 500]], ['three numbers', [0, 5, 9]],
    ['one number', [0]], ['strings', ['0', '29']], ['fractional', [0.5, 29]], ['object', { 0: 0, 1: 29 }], ['NaN', [NaN, 29]],
  ]) {
    assert.deepEqual(parityPost(`range ${label}`, { ...base, display_text_range: range }), { ok: false, reason: 'not_a_trigger' })
    assert.equal(host.instructionOf({ ...base, display_text_range: range }, binding), null, label)
  }
  assert.equal(parityPost('null range', { ...base, display_text_range: null }).ok, true)
})

await test('full-width at sign and unicode offsets', () => {
  const text = '＠spriite 🚀 build a 日本語 menu app ✨'
  const p = post(text, { entities: { mentions: [mention(text, '＠spriite', SPRIITE)] } })
  const v = parityPost('full-width', p)
  assert.equal(v.ok, true)
  assert.equal(v.instruction, '🚀 build a 日本語 menu app ✨')
  const text2 = '🎉🎉 @spriite create a café tracker for my 👩‍💻 team'
  assert.equal(parityPost('emoji before mention', post(text2, { entities: { mentions: [mention(text2, '@spriite', SPRIITE)] } })).ok, true)
  // An entity indexed in UTF-16 units (not code points) misses the "@".
  const utf16 = { start: text2.indexOf('@spriite'), end: text2.indexOf('@spriite') + 8, id: SPRIITE }
  assert.deepEqual(parityPost('utf16 offsets', post(text2, { entities: { mentions: [utf16] } })), { ok: false, reason: 'not_a_trigger' })
})

await test('quote posts and links', () => {
  const text = '@spriite build this https://t.co/abc'
  const p = post(text, {
    entities: { mentions: [mention(text, '@spriite', SPRIITE)], urls: [url(text, 'https://t.co/abc', 'https://x.com/i/status/42')] },
    referenced_tweets: [{ type: 'quoted', id: '42' }],
  })
  const v = parityPost('quote', p)
  assert.equal(v.instruction, 'build this https://x.com/i/status/42')
  const text2 = '@spriite fix the nav in https://t.co/r1 thanks'
  const gh = post(text2, { entities: { mentions: [mention(text2, '@spriite', SPRIITE)],
    urls: [url(text2, 'https://t.co/r1', 'https://github.com/owner/site')] } })
  assert.equal(parityPost('github link', gh).instruction, 'fix the nav in https://github.com/owner/site thanks')
  // A url entity without expansion stays the t.co text.
  const bare = post(text2, { entities: { mentions: [mention(text2, '@spriite', SPRIITE)], urls: [{ ...url(text2, 'https://t.co/r1', ''), expanded_url: undefined }] } })
  parityPost('unexpanded link', bare)
  const empty = spriitePost('@spriite', { referenced_tweets: [{ type: 'quoted', id: '42' }] })
  assert.equal(parityPost('bare mention quote', empty).instruction, '')
})

await test('long posts (note_tweet) and edit history', () => {
  const short = '@friend @spriite build a recipe app with a shopping list and…'
  const long = `@friend @spriite build a recipe app with a shopping list and ${'meal planning, '.repeat(30)}done`
  const p = post(short, {
    note_tweet: { text: long, entities: { mentions: [mention(long, '@friend', '4004'), mention(long, '@spriite', SPRIITE)] } },
    referenced_tweets: [{ type: 'replied_to', id: '7' }], display_text_range: [at(short, '@spriite'), cpLen(short)],
    edit_history_tweet_ids: ['8000', '9001'],
  })
  const v = parityPost('long reply', p)
  assert.equal(v.ok, true)
  assert.equal(host.logicalPostId(p), '8000')
  const noPrefix = { ...p, note_tweet: { ...p.note_tweet, text: long.replace('@friend ', '@other ') } }
  parityPost('long, prefix not repeated', noPrefix)
  const longOnlyMention = post('@spriite short', { note_tweet: { text: '@spriite ' + 'x'.repeat(400) } })
  assert.deepEqual(parityPost('note without entities', longOnlyMention), { ok: false, reason: 'not_a_trigger' })
  const { edit_history_tweet_ids: _, ...noHistory } = spriitePost('@spriite add a footer')
  assert.equal(host.logicalPostId(noHistory), '9001')
  parityPost('no edit history', noHistory)
  parityPost('empty edit history', { ...noHistory, edit_history_tweet_ids: [] })
})

await test('malformed shapes are refused, never thrown', () => {
  const ok = spriitePost('@spriite build an api')
  for (const [label, p] of [
    ['text not a string', { ...ok, text: 42 }], ['note_tweet null', { ...ok, note_tweet: null }],
    ['note text missing', { ...ok, note_tweet: { entities: ok.entities } }],
    ['references not an array', { ...ok, referenced_tweets: { type: 'quoted' } }],
    ['reference null', { ...ok, referenced_tweets: [null] }], ['mentions not an array', { ...ok, entities: { mentions: 'x' } }],
    ['mention null', { ...ok, entities: { mentions: [null] } }], ['url null', { ...ok, entities: { ...ok.entities, urls: [null] } }],
    ['post null', null],
  ]) {
    assert.deepEqual(host.authorizeTrigger(p, binding), { ok: false, reason: 'not_a_trigger' }, label)
    assert.equal(host.instructionOf(p, binding), null, label)
    // The src rules either throw or refuse; they never authorize these.
    let src
    try { src = intake.authorizeTrigger(p, binding) } catch { src = { ok: false } }
    assert.equal(src.ok, false, label)
  }
  // null references and entities are tolerated exactly as src tolerates them.
  parityPost('null references', { ...ok, referenced_tweets: null })
  parityPost('null mentions', { ...ok, entities: { mentions: null } })
})

await test('intent, destinations and repository names over a text table', () => {
  const cases = [
    '', '   ', '!!!', '🚀', 'build me a habit tracker', 'hey can you make a portfolio site',
    'please, please fix the header', 'cancel', 'stop the build now', 'roll back the deploy', 'rollback',
    'status', 'status?', 'how’s it going', "how's the build going?", 'what is the status of my build',
    'any news', 'where are we', 'update', 'update the readme', 'thanks, great work!', 'lol',
    'I want a dashboard for my plants', 'we need a calendar widget that syncs with my team',
    'turn my notes into a blog', 'Set up a landing page', 'ok go deploy',
    'fix the nav in https://github.com/owner/site', 'github.com/owner/site', 'https://github.com/owner/site.git',
    'https://github.com/owner/site...', 'https://github.com/owner/..', 'gist.github.com/owner/abc',
    'evil.com/github.com/owner/site fix it', '(https://www.github.com/Owner/My.Repo) improve tests',
    'clone https://github.com/a/b', 'fork https://github.com/a/b into https://github.com/me/c',
    'build something like https://github.com/a/b', 'based on https://github.com/a/b in https://github.com/me/dest.git',
    'adapt https://github.com/a/b destination: https://github.com/me/out', 'make a new repo from https://github.com/a/b',
    'build a todo app in a new repo called habit-log', 'new private repository named `habit-log`',
    'new repo called "my.app".', 'new repo called .git', 'new repo called foo.git', 'new repo: tracker-v2, please',
    'build it, called snack-map in a new repo', 'named site as a new private repository',
    'new repo called ' + 'a'.repeat(101), 'new repository called “quotes”',
    'build a CAFÉ menu for Ünïcödé friends 日本語 with #hashtags and @people',
    'make the https://example.com/page thing better for me and my team today',
    'add a ' + 'very long feature description '.repeat(40),
    'Créer une application de recettes avec liste de courses',
    'this', 'build this', 'can you do that for me please today', 'nice app, thank you so much for the work',
    'a tool to track my expenses every month at home', 'an amazing tool for my expenses every month at home',
  ]
  for (const text of cases) parityText(JSON.stringify(text.slice(0, 40)), text)
  for (const id of ['1234567890123456789', '42', '', 'abc-DEF_123', '0000000000000']) {
    parityText(`post id ${id}`, 'build a habit tracker for my morning routine', id)
    parityText(`post id ${id}, no words`, '', id)
    parityText(`post id ${id}, long words`, 'x'.repeat(150) + ' ' + 'y'.repeat(150), id)
  }
})

await test('repository validators match', () => {
  for (const v of ['owner', 'Owner-1', '-owner', 'owner-', 'ow--ner', 'a'.repeat(39), 'a'.repeat(40), '', 'own_er']) {
    same(`account ${v}`, host.validGithubAccount(v), delivery.validGithubAccount(v))
  }
  for (const v of ['site', 'my.repo', '.', '..', '...', 'x.git', 'x.GIT', 'a'.repeat(100), 'a'.repeat(101), 'a b', '']) {
    same(`repo ${v}`, host.validRepositoryName(v), delivery.validRepositoryName(v))
  }
})

await test('request substance with captured context', () => {
  const readable = [{ kind: 'x_post', role: 'quoted_post', completeness: 'complete', text: 'a game idea' }]
  const unreadable = [{ kind: 'x_post', role: 'quoted_post', completeness: 'missing', text: '' }]
  for (const [label, artifacts] of [['readable', readable], ['unreadable', unreadable]]) {
    same(label, host.hasRequestSubstance('', artifacts), intake.hasRequestSubstance('', artifacts))
  }
})

console.log(`host X rules parity: ${passed} passed, ${compared} comparisons`)
