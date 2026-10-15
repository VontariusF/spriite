/**
 * Spriite archive mirror, VPS side: docs/VPS-ARCHIVE-SPEC.md §4-§7.
 *
 * SQLite through node:sqlite (zero new dependencies, Node 22+) behind two
 * bearer-authenticated routes, and only on the Node relay: the Cloudflare
 * worker has no SQLite, so worker.js keeps its read-only contract and
 * answers /spriite/* with its usual 404. The phone is the single writer
 * (§2); this module accepts upserts and answers restore pages, nothing
 * else, and every other path falls through to the stateless bridge with
 * today's exact 405/404 matrix.
 *
 *   POST /spriite/sync     upsert a batch of records, answer the cursor
 *   POST /spriite/archive  return one newest-first restore page
 *
 * The wire is the phone client's dialect (src/state/archive.ts), versioned
 * `v: 1`: one flat `records` array where every row carries its `kind`
 * (mission, chat, feed, tag, snapshot), and string cursors where the empty
 * string means "none" — no cursor to continue a restore, no cursor to
 * acknowledge. The relay never needs the batch cursor the phone sends:
 * records are full rows, so upserts are idempotent without a delta.
 *
 * Auth is the sha-256 of the phone's base64url device key, compared in
 * constant time; the relay never holds the key itself, only its hash from
 * the environment (§5). Logs carry status and path only, never headers or
 * bodies, the same rule the OAuth route already follows.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { corsHeaders, readCappedBody, reply } from './worker.js'

/** one minute of archive traffic per window. one owner with a phone
 *  syncing every 30 seconds sits far below this, so a 429 here only ever
 *  means a flood, never honest traffic. the window lives in the archive's
 *  own db (§7 meta), so a relay restart cannot reset it. */
export const ARCHIVE_RATE_PER_MINUTE = 60

/** the same body cap the bridge already refuses (worker.js), so one relay
 *  never buffers more than its other routes do. */
export const ARCHIVE_MAX_BODY_BYTES = 1_000_000

/** rows per table per restore page. the archive is unbounded (§2) while the
 *  phone keeps its caps, so restore walks the history in pages instead of
 *  one answer that could outgrow the body cap. */
export const ARCHIVE_PAGE_SIZE = 200

/** spec §7, columns and keys verbatim; IF NOT EXISTS only makes the file
 *  restartable. the same schema carries the relay's own bookkeeping (the
 *  meta rate window) and one index per restore page order, so a keyset
 *  walk never table-scans — feed needs no index of its own because its
 *  primary key already is its page ordering. node:sqlite is told to enforce
 *  the REFERENCES clauses explicitly, so a chat or snapshot row needs its
 *  mission row in the same batch — the phone's assembler always sends the
 *  whole record. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS missions (
    mission_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,           -- terminal phase word or live word
    repo TEXT,
    origin TEXT NOT NULL,          -- 'phone' | 'x'
    created_at INTEGER NOT NULL,   -- ms epoch
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat (
    mission_id TEXT NOT NULL REFERENCES missions(mission_id),
    seq INTEGER NOT NULL,          -- per-mission monotonic
    who TEXT NOT NULL,             -- 'you' | 'spriite'
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (mission_id, seq)
  );
  CREATE TABLE IF NOT EXISTS feed (
    at INTEGER NOT NULL,
    label TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (at, label, text)  -- same dedupe rule as the phone feed, and the page order too
  );
  CREATE TABLE IF NOT EXISTS tags (              -- X mention receipts
    dedupe_key TEXT PRIMARY KEY,
    logical_post_id TEXT NOT NULL,  -- the post's stable id (first of its edit history)
    revision_id TEXT NOT NULL,      -- the newest revision this receipt was evaluated against
    via TEXT NOT NULL,              -- 'catch_up' | 'stream' | 'import': how it arrived
    status TEXT NOT NULL,           -- the receipt's status word (X_RECEIPT_STATUSES)
    instruction TEXT,
    repository TEXT,
    mission_id TEXT,
    received_at INTEGER NOT NULL,
    deleted_at INTEGER,             -- when the post was deleted on X; NULL while it is live
    posted_at INTEGER,             -- actual post time; NULL for legacy receipts
    proposed_revision_id TEXT       -- an edit observed after dispatch; recorded, never applied
  );
  CREATE TABLE IF NOT EXISTS snapshots (         -- opaque engine state, restore-only
    mission_id TEXT PRIMARY KEY REFERENCES missions(mission_id),
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS missions_page ON missions (updated_at, mission_id);
  CREATE INDEX IF NOT EXISTS chat_page ON chat (at, mission_id, seq);
  CREATE INDEX IF NOT EXISTS tags_page ON tags (received_at, dedupe_key);
  CREATE INDEX IF NOT EXISTS snapshots_page ON snapshots (updated_at, mission_id);
  CREATE TABLE IF NOT EXISTS meta (             -- the relay's rate bookkeeping, never phone records
    bucket TEXT PRIMARY KEY,        -- the configured key hash, or 'unauthenticated' for unknown bearers
    window_start INTEGER NOT NULL,  -- ms epoch, when the current window opened
    hits INTEGER NOT NULL           -- archive requests counted inside the window
  );
`

/** the wire tables, in the order a batch must land: missions first because
 *  chat and snapshot rows reference them. */
const TABLES = ['missions', 'chat', 'feed', 'tags', 'snapshots']

/** the phone's record kinds map onto those tables. the wire is the client's
 *  dialect (src/state/archive.ts, versioned `v: 1`): one flat `records`
 *  array, each row tagged with its `kind`, never per-table arrays. */
const KIND_TO_TABLE = {
  mission: 'missions',
  chat: 'chat',
  feed: 'feed',
  tag: 'tags',
  snapshot: 'snapshots',
}

/** each kind's own ordering timestamp, for flattening a page into one
 *  newest-first list. */
const KIND_SORT_TS = { mission: 'updated_at', chat: 'at', feed: 'at', tag: 'received_at', snapshot: 'updated_at' }

/** full-row upserts (§6). missions and snapshots keep updated_at monotonic:
 *  the WHERE makes a late replay of an older row a no-op, so re-sends are
 *  harmless even out of order. feed is all key columns — an upsert has
 *  nothing to change, so it lands on the phone's own dedupe rule. tags have
 *  no guard because a receipt's status legitimately moves (held to
 *  submitted) and received_at is when it arrived, not a version. */
const UPSERT_SQL = {
  missions: `
    INSERT INTO missions (mission_id, title, goal, status, repo, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (mission_id) DO UPDATE SET
      title = excluded.title, goal = excluded.goal, status = excluded.status,
      repo = excluded.repo, origin = excluded.origin,
      created_at = excluded.created_at, updated_at = excluded.updated_at
    WHERE excluded.updated_at >= missions.updated_at
  `,
  chat: `
    INSERT INTO chat (mission_id, seq, who, text, at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (mission_id, seq) DO UPDATE SET
      who = excluded.who, text = excluded.text, at = excluded.at
  `,
  feed: `
    INSERT INTO feed (at, label, text)
    VALUES (?, ?, ?)
    ON CONFLICT (at, label, text) DO NOTHING
  `,
  tags: `
    INSERT INTO tags (dedupe_key, logical_post_id, revision_id, via, status, instruction, repository, mission_id, received_at, deleted_at, proposed_revision_id, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (dedupe_key) DO UPDATE SET
      logical_post_id = excluded.logical_post_id, revision_id = excluded.revision_id,
      via = excluded.via, status = excluded.status, instruction = excluded.instruction,
      repository = excluded.repository, mission_id = excluded.mission_id,
      received_at = excluded.received_at, deleted_at = excluded.deleted_at,
      proposed_revision_id = excluded.proposed_revision_id,
      posted_at = COALESCE(excluded.posted_at, tags.posted_at)
  `,
  snapshots: `
    INSERT INTO snapshots (mission_id, json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (mission_id) DO UPDATE SET
      json = excluded.json, updated_at = excluded.updated_at
    WHERE excluded.updated_at >= snapshots.updated_at
  `,
}

/** the tables whose rows carry an updated_at: only those advance the
 *  acknowledged cursor, because the phone's delta is mission records keyed
 *  by (id, updated_at) (§6), not chat or feed timestamps. */
const CURSOR_TABLES = new Set(['missions', 'snapshots'])

/** newest-first keyset paging per table (§6): each table pages by its own
 *  sort key, so what a page holds never depends on another table's row
 *  count, and rows that share a millisecond still page exactly once. */
const PAGE_SPECS = [
  {
    name: 'missions',
    cols: ['mission_id', 'title', 'goal', 'status', 'repo', 'origin', 'created_at', 'updated_at'],
    order: ['updated_at', 'mission_id'],
    kinds: ['n', 's'],
  },
  {
    name: 'chat',
    cols: ['mission_id', 'seq', 'who', 'text', 'at'],
    order: ['at', 'mission_id', 'seq'],
    kinds: ['n', 's', 'n'],
  },
  { name: 'feed', cols: ['at', 'label', 'text'], order: ['at', 'label', 'text'], kinds: ['n', 's', 's'] },
  {
    name: 'tags',
    cols: ['dedupe_key', 'logical_post_id', 'revision_id', 'via', 'status', 'instruction', 'repository', 'mission_id', 'received_at', 'deleted_at', 'proposed_revision_id', 'posted_at'],
    order: ['received_at', 'dedupe_key'],
    kinds: ['n', 's'],
  },
  { name: 'snapshots', cols: ['mission_id', 'json', 'updated_at'], order: ['updated_at', 'mission_id'], kinds: ['n', 's'] },
]

const pageSql = (p, after) => `
  SELECT ${p.cols.join(', ')} FROM ${p.name}
  ${after ? `WHERE (${p.order.join(', ')}) < (${p.order.map(() => '?').join(', ')})` : ''}
  ORDER BY ${p.order.map((c) => `${c} DESC`).join(', ')}
  LIMIT ?
`

/** a payload that does not fit its row. the whole batch is refused, never
 *  half-applied: the phone keeps its outbox and retries (§6). */
class BadBatch extends Error {}

/** field readers. they name the field, never echo its value, so the refusal
 *  text stays free of anything the phone sent. integers are checked against
 *  the safe range because sqlite reads an oversized one back with a RangeError. */
const text = (row, key) => {
  const v = row?.[key]
  if (typeof v !== 'string' || v === '') throw new BadBatch(`${key} must be a non-empty string`)
  return v
}
const optionalText = (row, key) => {
  const v = row?.[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new BadBatch(`${key} must be a string or null`)
  return v
}
const int = (row, key) => {
  const v = row?.[key]
  if (!Number.isSafeInteger(v)) throw new BadBatch(`${key} must be an integer`)
  return v
}
/** a column the schema added late: absent or null is a live post / no
 * proposed change, never a zero epoch that would read as deleted in 1970. */
const optionalInt = (row, key) => {
  const v = row?.[key]
  if (v === undefined || v === null) return null
  if (!Number.isSafeInteger(v)) throw new BadBatch(`${key} must be an integer`)
  return v
}

/** rows to bind, in schema column order. unknown keys in a record are simply
 *  not bound: the archive's schema is the whole boundary, so a
 *  credential-shaped field has no column to land in (§5) — credentials are
 *  excluded at the assembler, not filtered here. */
const optionalPostTime = (r) => {
  const value = optionalInt(r, 'posted_at')
  if (value !== null && Math.abs(value) > 8.64e15) throw new BadBatch('posted_at must be a representable epoch')
  return value
}

const BIND = {
  missions: (r) => [
    text(r, 'mission_id'), text(r, 'title'), text(r, 'goal'), text(r, 'status'),
    optionalText(r, 'repo'), text(r, 'origin'), int(r, 'created_at'), int(r, 'updated_at'),
  ],
  chat: (r) => [text(r, 'mission_id'), int(r, 'seq'), text(r, 'who'), text(r, 'text'), int(r, 'at')],
  feed: (r) => [int(r, 'at'), text(r, 'label'), text(r, 'text')],
  tags: (r) => [
    text(r, 'dedupe_key'), text(r, 'logical_post_id'), text(r, 'revision_id'), text(r, 'via'),
    text(r, 'status'), optionalText(r, 'instruction'),
    optionalText(r, 'repository'), optionalText(r, 'mission_id'), int(r, 'received_at'),
    optionalInt(r, 'deleted_at'), optionalText(r, 'proposed_revision_id'), optionalPostTime(r),
  ],
  snapshots: (r) => [text(r, 'mission_id'), text(r, 'json'), int(r, 'updated_at')],
}

/** the archive file sits beside the relay by default, owner-only on disk
 *  (§4). */
export function defaultArchiveDbPath() {
  return fileURLToPath(new URL('./spriite-archive.db', import.meta.url))
}

/**
 * §7 grew the tags table after the first deploy (deleted_at, proposed_
 * revision_id — a deleted post and an edit-after-dispatch are receipt facts
 * the archive must mirror, spec §2). a fresh file gets the columns from
 * SCHEMA; a LIVE deployed file already has the table, so CREATE TABLE IF NOT
 * EXISTS is a no-op there and the guarded ALTERs below are how it catches
 * up: each is checked against PRAGMA table_info, so it runs at most once and
 * never assumes the file is fresh. both columns are nullable, so rows written
 * before the migration restore as live posts with no proposed change — the
 * same absence the phone's own receipts carry.
 */
function ensureTagColumns(db) {
  const present = new Set(db.prepare('PRAGMA table_info(tags)').all().map((c) => c.name))
  if (!present.has('posted_at')) db.exec('ALTER TABLE tags ADD COLUMN posted_at INTEGER')
  if (!present.has('deleted_at')) db.exec('ALTER TABLE tags ADD COLUMN deleted_at INTEGER')
  if (!present.has('proposed_revision_id')) db.exec('ALTER TABLE tags ADD COLUMN proposed_revision_id TEXT')
}

/** open the archive: WAL so the single writer never blocks a reader, the
 *  schema from spec §7, and 0600 on the file and its journal because
 *  sqlite's default mode would let other local accounts read the archive. */
export function openArchiveDb(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  const ownerOnly = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${path}${suffix}`, 0o600)
      } catch {
        // not created yet: the journal appears with the first write
      }
    }
  }
  // owner-only from the first byte: chmod before the schema lands, and once
  // more after in case a journal file appeared in between
  ownerOnly()
  db.exec(SCHEMA)
  ensureTagColumns(db) // a live deployed db joins the grown §7 schema here
  ownerOnly()
  return db
}

/** read one body, capped before it is buffered: the declared length is
 *  checked first so a huge upload never lands in memory, and the streamed
 *  length is counted as it arrives because a header can lie or be absent
 *  (the bridge's own reader, worker.js). */
async function readBody(request, maxBytes) {
  const read = await readCappedBody(request, maxBytes)
  if (read.tooLarge) return { tooLarge: true }
  if (read.failed) return { failed: true }
  return { text: read.bytes === null ? '' : new TextDecoder().decode(read.bytes) }
}

/** a json response, same CORS policy as the bridge's replies. */
function jsonResponse(value, cors) {
  const headers = new Headers(cors)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(value), { status: 200, headers })
}

/** the page cursor is the last row's sort key per table, base64url: opaque
 *  to the phone, exact for the relay, and never a row offset (rows move as
 *  new records land). a null position parks a table that has run out. */
function encodeCursor(positions) {
  return Buffer.from(JSON.stringify(positions), 'utf8').toString('base64url')
}
function decodeCursor(token) {
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (Object.keys(parsed).length !== PAGE_SPECS.length) return null
  const positions = {}
  for (const p of PAGE_SPECS) {
    const v = parsed[p.name]
    if (v === null) {
      positions[p.name] = null
      continue
    }
    const wellFormed = Array.isArray(v) && v.length === p.order.length
      && v.every((x, i) => (p.kinds[i] === 'n' ? Number.isSafeInteger(x) : typeof x === 'string'))
    if (!wellFormed) return null
    positions[p.name] = v
  }
  return positions
}

const emptyPage = () => ({ v: 1, records: [], cursor: '' })

/**
 * Build the archive: one sqlite file, one expected key hash, one rate
 * window. `handle(request, env)` answers the two archive routes and returns
 * null for everything else, so the caller falls through to the bridge.
 */
export function createArchive({
  dbPath,
  keyHash = '',
  ratePerMinute = ARCHIVE_RATE_PER_MINUTE,
  maxBodyBytes = ARCHIVE_MAX_BODY_BYTES,
  pageSize = ARCHIVE_PAGE_SIZE,
  log = () => {},
} = {}) {
  if (!dbPath) throw new Error('createArchive needs a dbPath (set SPRIITE_ARCHIVE_DB)')
  const db = openArchiveDb(dbPath)
  const limit = Number.isSafeInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 500) : ARCHIVE_PAGE_SIZE
  const window = Number.isSafeInteger(ratePerMinute) && ratePerMinute > 0 ? ratePerMinute : ARCHIVE_RATE_PER_MINUTE

  const upserts = {}
  for (const table of TABLES) upserts[table] = db.prepare(UPSERT_SQL[table])
  const tagFacts = db.prepare('SELECT deleted_at, proposed_revision_id FROM tags WHERE dedupe_key = ?')
  const pages = {}
  for (const p of PAGE_SPECS) {
    pages[p.name] = { first: db.prepare(pageSql(p, false)), after: db.prepare(pageSql(p, true)) }
  }

  // sha-256 of the base64url key, compared in constant time; the relay only
  // ever holds the hash (§5). no hash configured means no known bearer, so
  // every archive request fails closed with 401.
  function bearerOk(request) {
    const expected = Buffer.from(String(keyHash).trim().toLowerCase(), 'hex')
    const header = request.headers.get('authorization') ?? ''
    const presented = /^Bearer (.+)$/.exec(header)?.[1] ?? ''
    const digest = createHash('sha256').update(presented).digest()
    return expected.length === 32 && timingSafeEqual(digest, expected)
  }

  // the rate window persists in the archive's own db (§7 meta): a relay
  // restart cannot reset it, and a second process over the same file cannot
  // race it, because the read, the decision, and the write all happen inside
  // one transaction per archive request. the bucket is the configured key
  // hash — the hash the relay already holds in its environment (§5), never
  // the key itself — so one relay configuration owns one window. requests
  // that do not present that key count in a window of their own: unknown
  // bearers are still rate limited (§5), but a stranger who can reach the
  // url cannot spend the owner's window and lock their sync and restore
  // out. the second bucket is not hex, so it can never collide with a hash.
  const rateBucket = String(keyHash).trim().toLowerCase()
  const unauthBucket = 'unauthenticated'
  const rateRead = db.prepare('SELECT window_start, hits FROM meta WHERE bucket = ?')
  const rateWrite = db.prepare(`
    INSERT INTO meta (bucket, window_start, hits) VALUES (?, ?, ?)
    ON CONFLICT (bucket) DO UPDATE SET
      window_start = excluded.window_start, hits = excluded.hits
  `)
  /** one archive request's verdict: 'ok' inside the window, 'over' past it,
   *  or 'unreadable' when the db state cannot be read or written. the last
   *  fails closed the way the first two count: no request goes through
   *  uncounted. */
  function rateCheck(bucket) {
    const now = Date.now()
    try {
      db.exec('BEGIN IMMEDIATE')
      const row = rateRead.get(bucket)
      if (row !== undefined && (!Number.isSafeInteger(row.window_start) || !Number.isSafeInteger(row.hits))) {
        throw new Error('rate state malformed')
      }
      let windowStart = row?.window_start ?? 0
      let hits = row?.hits ?? 0
      if (now - windowStart >= 60_000) {
        windowStart = now
        hits = 0
      }
      hits += 1
      rateWrite.run(bucket, windowStart, hits)
      db.exec('COMMIT')
      return hits > window ? 'over' : 'ok'
    } catch {
      try {
        db.exec('ROLLBACK')
      } catch {
        // the failed statement already unwound the transaction
      }
      return 'unreadable'
    }
  }

  function upsertBatch(records) {
    // group by kind, then land in TABLES order: the chat and snapshot rows
    // reference their mission row, and a batch carries the whole record
    const groups = {}
    for (const table of TABLES) groups[table] = []
    for (const record of records) {
      const table = KIND_TO_TABLE[record?.kind]
      if (!table) throw new BadBatch('every record needs a known kind')
      groups[table].push(record)
    }
    let cursor = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of TABLES) {
        for (const row of groups[table]) {
          const args = BIND[table](row)
          if (table === 'tags') {
            // Receipt arrival is not a version for later deletion/edit facts.
            // A late replay cannot resurrect a post or roll its proposal back.
            const prior = tagFacts.get(args[0])
            if (prior) {
              const deleted = [prior.deleted_at, args[9]].filter((v) => v !== null)
              args[9] = deleted.length ? Math.min(...deleted) : null
              const proposed = [prior.proposed_revision_id, args[10]]
                .filter((v) => typeof v === 'string' && /^\d{1,20}$/.test(v))
                .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
              args[10] = proposed.length ? proposed[proposed.length - 1] : null
            }
          }
          upserts[table].run(...args)
          if (CURSOR_TABLES.has(table)) cursor = Math.max(cursor, args[args.length - 1])
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // the failed statement already unwound the transaction
      }
      throw e
    }
    return cursor
  }

  async function sync(request, cors) {
    const body = await readBody(request, maxBodyBytes)
    if (body.tooLarge) return reply(413, 'body too large', cors)
    if (body.failed) return reply(400, 'bad batch', cors)
    let batch
    try {
      batch = JSON.parse(body.text || 'null')
    } catch {
      return reply(400, 'bad batch: not json', cors)
    }
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
      return reply(400, 'bad batch: not an object', cors)
    }
    // the phone's dialect is versioned; a future client is refused rather
    // than mis-parsed into rows it never meant to send
    if (batch.v !== 1) return reply(400, 'bad batch: unsupported version', cors)
    if (!Array.isArray(batch.records)) return reply(400, 'bad batch: records must be an array', cors)
    try {
      // the acknowledged cursor is the max updated_at the archive saw in
      // this batch. a batch with none (empty, or chat/feed/tag rows only)
      // acknowledges the empty cursor, which the phone reads as "keep
      // your watermark": an ack is a floor, never an assignment
      const cursor = upsertBatch(batch.records)
      return jsonResponse({ v: 1, cursor: cursor ? String(cursor) : '' }, cors)
    } catch (e) {
      if (e instanceof BadBatch) return reply(400, `bad batch: ${e.message}`, cors)
      // a constraint refusal is the payload's fault, not the relay's
      if (e?.code === 'ERR_SQLITE_ERROR') return reply(400, 'bad batch: record rejected', cors)
      throw e
    }
  }

  async function restore(request, cors) {
    const body = await readBody(request, maxBodyBytes)
    if (body.tooLarge) return reply(413, 'body too large', cors)
    // an empty body is the first page: `curl -X POST /spriite/archive` with
    // the key asks for the newest records. a body that carries bytes must
    // still be the client's dialect, and a future version is refused rather
    // than answered with rows it cannot read back
    let parsed = {}
    if (body.failed) return reply(400, 'bad request', cors)
    if (body.text.trim() !== '') {
      try {
        parsed = JSON.parse(body.text)
      } catch {
        return reply(400, 'bad request: not json', cors)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reply(400, 'bad request: not an object', cors)
      }
      if (parsed.v !== 1) return reply(400, 'bad request: unsupported version', cors)
    }
    // the empty cursor is the phone's "first page" (and its "done" marker in
    // every reply); the archive treats it the same way
    const asked = typeof parsed.cursor === 'string' && parsed.cursor !== '' ? parsed.cursor : null
    const positions = asked ? decodeCursor(asked) : {}
    // an unreadable cursor is a failure, never a silent "done": the phone
    // reads an empty cursor as "the walk is complete", so answering one here
    // would report a partial restore as success. 400 makes the client fail
    // honestly and restart the walk from its first page instead.
    if (asked && !positions) return reply(400, 'bad request: unreadable cursor', cors)

    const page = {}
    const next = {}
    for (const p of PAGE_SPECS) {
      const from = positions[p.name]
      // undefined is the first page (page from the top); null is a table that
      // ran dry on an earlier page and stays empty — a plain truthiness check
      // would wrongly restart it
      let rows = []
      if (from === undefined) rows = pages[p.name].first.all(limit)
      else if (from !== null) rows = pages[p.name].after.all(...from, limit)
      page[p.name] = rows
      // a short page means the table is done; null parks it for good
      next[p.name] = rows.length < limit ? null : p.order.map((c) => rows[rows.length - 1][c])
    }
    // one flat list, newest-first across kinds, each row re-tagged with the
    // kind the phone's records carry
    const records = []
    for (const [kind, table] of Object.entries(KIND_TO_TABLE)) {
      for (const row of page[table]) records.push({ kind, ...row })
    }
    records.sort((a, b) => b[KIND_SORT_TS[b.kind]] - a[KIND_SORT_TS[a.kind]])
    const more = Object.values(next).some((v) => v !== null)
    return jsonResponse({ v: 1, records, cursor: more ? encodeCursor(next) : '' }, cors)
  }

  /** the node relay's write routes; the source-grep test counts these, so
   *  every write route this process serves is declared here in this shape. */
  const routes = [
    { method: 'POST', path: /^\/spriite\/sync$/, to: sync },
    { method: 'POST', path: /^\/spriite\/archive$/, to: restore },
  ]

  async function handle(request, env = {}) {
    const url = new URL(request.url)
    const route = routes.find((r) => r.path.test(url.pathname))
    if (!route) return null // not an archive path: the bridge answers as it does today
    if (request.method === 'OPTIONS') return null // preflight answers through the bridge, like every other path
    const cors = corsHeaders(request, env)
    let response
    if (request.method !== route.method) {
      response = reply(405, 'archive route is POST only', cors)
    } else {
      // the rate window lives in the db (§7 meta), so it survives restarts.
      // a window the relay cannot read fails closed: the request is refused
      // as unavailable, never let through uncounted. the bearer is checked
      // first only to pick the window: every request is still counted, and
      // an unknown bearer is counted apart from the owner's key.
      const authed = bearerOk(request)
      const rate = rateCheck(authed ? rateBucket : unauthBucket)
      if (rate === 'unreadable') response = reply(503, 'archive unavailable', cors)
      else if (rate === 'over') response = reply(429, 'rate limited', cors)
      else if (!authed) response = reply(401, 'unauthorized', cors)
      else response = await route.to(request, cors)
    }
    // status and path only: no method, no headers, no bodies, no keys (§5)
    log(`[archive] ${response.status} ${url.pathname}`)
    return response
  }

  return { handle, close: () => db.close() }
}
