import assert from 'node:assert/strict'
import { paginateChat, chatLines, CHAT_PAGE_LINES, chatContextLabel } from '../src/render/chat-pages.ts'
import { SPEAKER_LABEL } from '../src/domain/speaker.ts'

let passed = 0
const check = (name, log) => {
  const result = paginateChat(log)
  const original = log.map(e => `${SPEAKER_LABEL[e.who]}: ${e.text.replace(/\r\n/g, '\n')}`).join('')
  assert.equal(result.pages.join(''), original, 'no text or long-token tail is discarded')
  for (const page of result.pages) {
    assert.ok(page.length <= 950)
    assert.ok(chatLines(page) <= CHAT_PAGE_LINES)
    assert.ok(!/^[\uDC00-\uDFFF]/.test(page), 'no split surrogate pair')
    assert.ok(!/[\uD800-\uDBFF]$/.test(page), 'no split surrogate pair')
  }
  passed++
  console.log(`PASS: ${name}`)
  return result
}
const entry = (who, text) => ({ who, text, at: 1 })
const long = `First paragraph.\n\n${'Readable details and a decision to consider. '.repeat(100)}\nEND OF REPLY`
check('full paragraphs remain readable page by page', [entry('watched', long)])
check('unbroken tokens and Unicode are preserved', [entry('worker', 'https://example.test/' + 'abcdef'.repeat(1000) + '🙂'.repeat(100))])
const result = check('reading opens at the beginning of the latest reply', [
  entry('lead', long), entry('watched', 'LATEST REPLY START\n' + long), entry('you', 'My answer'),
])
assert.match(result.pages[result.latestPage], /LATEST REPLY START/)
assert.equal(paginateChat([]).latestPage, 0)
for (const label of ['SPRIITE', 'CHECKOUT FLOW', 'Cursor']) {
  assert.equal(chatContextLabel({ type: 'scene', scene: { contextLabel: label } }), label)
  assert.equal(chatContextLabel({ type: 'selection', contextLabel: label }), label)
}
passed++
console.log('PASS: History retains the actual session context label')
console.log(`Response reading: ${passed} passed, 0 failed (scenario groups)`)
