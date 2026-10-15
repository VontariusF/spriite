import assert from 'node:assert/strict'
import { checkXLive } from './check-x-live.mjs'

const ownerId = '123'
const mentionHandle = 'fixture_bot'
const token = 'synthetic-access-value'
let groups = 0

for (const [status, kind] of [[401, 'auth'], [402, 'credits'], [403, 'forbidden'], [429, 'quota']]) {
  const calls = []
  const report = await checkXLive({ token, ownerId, mentionHandle, fetch: async (url, init) => {
    calls.push({ url, init })
    return new Response(null, { status })
  } })
  assert.equal(report.outcome, 'blocked')
  assert.equal(report.errorKind, kind)
  assert.equal(calls.length, 1, 'blocked owner checks stop immediately')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.redirect, 'error', 'credentials cannot follow redirects')
  assert.ok(!JSON.stringify(report).includes(token))
  groups++
  console.log(`PASS: live X probe stops safely on HTTP ${status}`)
}

{
  const calls = []
  const report = await checkXLive({ token, ownerId, mentionHandle, fetch: async (url, init) => {
    calls.push({ url, init })
    const path = url.pathname
    const data = path === '/2/users/me' ? { id: ownerId } :
      path.startsWith('/2/users/by/') ? { id: '456' } :
      path.endsWith('/tweets') ? [{ id: '789', author_id: ownerId, text: 'synthetic private post body' }] :
      { id: '789', author_id: ownerId, text: 'synthetic private post body' }
    return Response.json({ data })
  } })
  assert.equal(report.outcome, 'passed')
  assert.equal(calls.length, 4)
  assert.ok(calls.every(({ init }) => init.method === 'GET'))
  assert.equal(calls[2].url.searchParams.get('max_results'), '5', 'paid timeline reads are bounded')
  assert.equal(report.checks.singlePostMatches, true)
  assert.ok(!JSON.stringify(report).includes('synthetic'), 'report excludes token and post text')
  groups++
  console.log('PASS: live X probe bounds reads and omits private content')
}

{
  let calls = 0
  const report = await checkXLive({ token, ownerId, mentionHandle, fetch: async () => {
    calls++
    return Response.json({ data: { id: '999' } })
  } })
  assert.equal(report.outcome, 'owner_mismatch')
  assert.equal(calls, 1, 'wrong owner prevents further requests')
  groups++
  console.log('PASS: live X probe stops on owner mismatch')
}

{
  const report = await checkXLive({ token, ownerId, mentionHandle, fetch: async () => {
    throw new Error(`Untrusted exception: ${token}`)
  } })
  assert.equal(report.outcome, 'blocked')
  assert.ok(!JSON.stringify(report).includes(token), 'arbitrary exception contents stay private')
  groups++
  console.log('PASS: live X probe does not expose exception contents')
}

console.log(`LIVE X PROBE TEST PASSED: ${groups} scenario groups`)
