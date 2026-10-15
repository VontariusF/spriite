/**
 * HUD regression tests: the chat reader's landing page and briefing clip().
 *
 *  - an all-owner chat log opens on the newest turn, not the oldest;
 *  - a clipped briefing title never leaves half a surrogate pair before
 *    the ellipsis.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs scripts/test-hud-fixes.mjs
 */
import { makeTally } from './lib/runtime-fake.mjs'
import { paginateChat } from '../src/render/chat-pages.ts'
import { buildBriefing } from '../src/briefing/build.ts'

const { assert, failures } = makeTally()
const entry = (who, text) => ({ who, text, at: 1 })
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

// ---------- H1. no reply yet: the reader opens on the newest owner turn
{
  const { pages, latestPage } = paginateChat([
    entry('you', 'FIRST GOAL'), entry('you', 'SECOND GOAL'), entry('you', 'NEWEST FOLLOW-UP'),
  ])
  assert(/NEWEST FOLLOW-UP/.test(pages[latestPage]), 'an all-owner log lands on the newest owner turn')
  const single = paginateChat([entry('you', 'ONLY GOAL')])
  assert(single.latestPage === 0, 'a single owner turn still lands on its own page')
  const replied = paginateChat([entry('spriite', 'THE REPLY'), entry('you', 'a'), entry('you', 'b')])
  assert(/THE REPLY/.test(replied.pages[replied.latestPage]), 'a reply at index 0 is still the landing page')
}

// ---------- H2. clip() never splits a surrogate pair before the ellipsis
{
  const mission = (missionId, title) => ({
    schemaVersion: 2, missionId, entityId: 'e1', productId: 'p1', originatingCommandId: 'c1',
    title, goal: title, phase: 'completed', control: 'running', freshness: 'current', planRevision: 1,
    config: {
      leadProvider: 'factory', workerProviders: ['factory'], workerPreference: 'factory',
      maxConcurrentWorkers: 1, repository: 'https://github.com/example/sprite-test', baseRef: 'main',
      policyRevision: 'v2-default', acceptCriteria: [],
    },
    activeRunIds: [], decisionIds: [], suspendedPhase: null,
    lastObservedAt: '2026-10-06T12:00:00Z', createdAt: '2026-10-06T12:00:00Z', updatedAt: '2026-10-06T12:00:00Z',
  })
  // The emoji's high surrogate sits at index 46, the last unit clip(…, 48) keeps.
  const title = 'a'.repeat(46) + '\u{1F600}' + ' and the rest of the title'
  const state = {
    schemaVersion: 2,
    entity: { schemaVersion: 2, entityId: 'e1', name: 'Spriite', preferencesRevision: '0', createdAt: '2026-10-06T12:00:00Z' },
    missions: [mission('m1', title)],
    runs: {}, outbox: [], decisions: [], cursors: {}, acknowledgedSeq: 0, migratedFromV1: false,
  }
  const brief = buildBriefing({
    state,
    events: [{
      schemaVersion: 2, eventId: 'e1', seq: 1, entityId: 'entity_test', missionId: 'm1',
      type: 'mission_completed', observedAt: '2026-10-06T12:01:00Z', payload: {},
    }],
    journalSeq: 1,
    scope: { kind: 'owner' },
    now: Date.parse('2026-10-06T12:05:00Z'),
  })
  const card = brief.cards.find((c) => c.missionId === 'm1')
  assert(card !== undefined, 'the completed mission produces a card')
  const text = `${card?.headline ?? ''} ${card?.detail ?? ''}`
  assert(/a…/.test(text), `the clipped title ends cleanly before the ellipsis: ${JSON.stringify(card?.headline)}`)
  assert(!lone.test(text), 'no lone surrogate reaches the HUD card')
}

console.log(failures() === 0 ? '\nAll HUD fix tests passed.' : `\n${failures()} HUD fix test(s) FAILED.`)
process.exit(failures() === 0 ? 0 : 1)
