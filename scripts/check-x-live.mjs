// Explicit, read-only qualification of the actual X transport. Never refresh,
// print credentials/post text, mutate the token file, or dispatch a build.
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createXTransport, XTransportError } from '../src/intake/x-transport.ts'

export async function checkXLive({ token, ownerId, mentionHandle, fetch: doFetch = fetch }) {
  if (!token || !/^\d{1,20}$/.test(ownerId) || !/^[A-Za-z0-9_]{1,15}$/.test(mentionHandle)) {
    throw new Error('Invalid live-check inputs')
  }
  const report = {
    mode: 'read-only, no refresh, no build dispatch',
    requests: [],
    checks: {},
  }
  const transport = createXTransport({
    token,
    base: 'https://api.x.com',
    // Deliberately do not supply the transport's refresh hook.
    fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://api.x.com' || (init?.method ?? 'GET') !== 'GET' ||
          !/^\/2\/(?:users\/me|users\/by\/username\/[A-Za-z0-9_]{1,15}|users\/\d{1,20}\/tweets|tweets\/\d{1,20})$/.test(url.pathname)) {
        throw new Error('Read-only request boundary rejected')
      }
      // Preserve the production query fields but bound paid timeline reads.
      if (/\/users\/\d+\/tweets$/.test(url.pathname)) url.searchParams.set('max_results', '5')
      const request = { path: url.pathname, status: null }
      report.requests.push(request)
      const response = await doFetch(url, { ...init, redirect: 'error' })
      request.status = response.status
      return response
    },
  })
  let stage = 'owner'
  try {
    const owner = await transport.me()
    report.checks.ownerMatches = owner.id === ownerId
    if (!report.checks.ownerMatches) return { ...report, outcome: 'owner_mismatch' }
    stage = 'mention'
    const mention = await transport.userByUsername(mentionHandle)
    report.checks.mentionResolved = /^\d{1,20}$/.test(mention.id)
    if (!report.checks.mentionResolved) return { ...report, outcome: 'invalid_mention_id' }
    stage = 'timeline'
    const since = new Date(Date.now() - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const page = await transport.ownerPosts(ownerId, since)
    report.checks.timelineCount = page.posts.length
    report.checks.timelineAuthorsMatch = page.posts.every((post) => post.author_id === ownerId)
    if (!report.checks.timelineAuthorsMatch) return { ...report, outcome: 'timeline_owner_mismatch' }
    if (page.posts.length > 0) {
      stage = 'post'
      const id = page.posts[0].id
      const found = await transport.post(id)
      report.checks.singlePostFound = found !== null
      report.checks.singlePostMatches = found !== null && found.post.id === id && found.post.author_id === ownerId
      if (!report.checks.singlePostMatches) return { ...report, outcome: 'post_unavailable_or_mismatched' }
    } else {
      report.checks.singlePostSkipped = 'No posts in the bounded 24-hour window'
    }
    return { ...report, outcome: 'passed' }
  } catch (error) {
    // Do not emit provider bodies, exception messages, URLs with queries,
    // headers, token JSON, post contents, or arbitrary thrown values.
    const kind = error instanceof XTransportError ? error.kind : 'unexpected'
    return { ...report, outcome: 'blocked', blockedStage: stage, errorKind: kind }
  }
}

async function main() {
  const [file, ownerId, mentionHandle] = process.argv.slice(2)
  if (!file || !isAbsolute(file) || !ownerId || !mentionHandle) {
    console.error('Usage: node --import ./scripts/ts-resolve.mjs scripts/check-x-live.mjs /absolute/token.json OWNER_ID MENTION_HANDLE')
    process.exitCode = 1
    return
  }
  let token
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed.access_token !== 'string' || !parsed.access_token.trim()) throw new Error()
    token = parsed.access_token
  } catch {
    console.error('Could not load an access token from the supplied JSON file')
    process.exitCode = 1
    return
  }
  let report
  try {
    report = await checkXLive({ token, ownerId, mentionHandle })
  } catch {
    console.error('Invalid live-check arguments')
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.outcome !== 'passed') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main()
}
