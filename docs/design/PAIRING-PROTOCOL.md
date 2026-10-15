# Pairing and transfer protocol

How `npx spriite pair` hands a computer's keys to a phone, and how "Move to another phone" hands a
phone's keys, defaults and history to a new phone, without the relay ever reading them and without
a code that can be guessed offline. Code: `broker/pair-protocol.mjs` (both ends), `relay/pair.mjs`
(mailbox), `cli/` (host), `src/pair/client.ts` (phone). Tests: `scripts/test-pairing.mjs`,
`scripts/test-transfer.mjs`, `scripts/test-host-x-signin.mjs`.

## Codes

| | Pair (`spriite pair`) | Move (old phone to new phone) |
|---|---|---|
| Form | 6 Crockford base32 characters, shown `K7Q-2MF` | `WORD-NN-WORD` from a 256-word list, shown `WREN · 41 · OAK` |
| Typed input | case-free; `O` reads as `0`, `I` and `L` as `1`; spaces and dashes ignored | case-free; any separators (`wren 41 oak`) |
| Public mailbox slot | the first 2 characters (10 bits) | the first word (8 bits) |
| Secret part | the last 4 characters (20 bits) | the number and the second word (about 14.6 bits) |
| QR | `spriite:pair?c=<code>&s=<16-byte secret>&r=<relay>` | `spriite:move?c=<code>&s=<secret>&r=<relay>` |
| Life | one claim, 10 minutes | one claim, 10 minutes |

The host role is the computer for pairing and the old phone for a move. The new phone always takes
the claiming role.

## Key exchange: CPace over ristretto255

We use CPace (draft-irtf-cfrg-cpace) on ristretto255 with SHA-512, through `@noble/curves` and
`@noble/hashes` (exact versions pinned in `package.json` and `cli/package.json`).

1. **Open.** The host draws a code, a 16-byte QR secret `s` and a 16-byte session id `sid`, and
   computes two generators:
   - `g_code = calculate_generator(PRS_code, CI, sid)`, with `PRS_code = "spriite/<kind>/v1/code:" || code`;
   - `g_qr = calculate_generator(PRS_qr, CI, sid)`, with `PRS_qr = "spriite/<kind>/v1/qr:" || code || ":" || s`.

   `CI = "spriite-<kind>"`, and `calculate_generator` is the draft's
   `ristretto255(SHA-512(lv_cat(DSI, PRS, zpad, CI, sid)))`. With fresh scalars `ya1` and `ya2` it
   posts `Ya_code = ya1·g_code` and `Ya_qr = ya2·g_qr` to the mailbox slot. If the slot already has
   an open session, the relay answers `409 slot_taken` and the host draws a new code (up to 8
   times).
2. **Claim.** The phone posts the slot. The relay hands out `sid`, both shares and a claim token,
   exactly once per session. The phone picks the variant it has (`qr` when it scanned the code,
   `code` when it was typed), computes the matching generator, a fresh `yb`, `Yb = yb·g`,
   `K = yb·Ya_variant` (refusing the identity or a malformed point) and
   `ISK = SHA-512(lv_cat(DSI || "_ISK", sid, K) || lv_cat(Ya, ADa) || lv_cat(Yb, ADb))` with
   `ADa = kind` and `ADb = variant`. It declares the variant in `ADb`, so a variant switch changes
   the key.
3. **Key schedule.** `HKDF-SHA256(ISK, salt = sid, info = "spriite/pake/v1/keys")` gives 96 bytes:
   confirmation key A, confirmation key B and the AES-256-GCM key.
4. **Phone confirms first.** The phone posts `Yb`, the variant and
   `tagB = HMAC(confB, lv_cat("B", Ya, Yb, ADb))`.
5. **Host checks, then releases.** The host computes the same keys and compares `tagB` in constant
   time. A mismatch means a wrong code: the host posts `wrong_code`, closes the session as burned,
   and (for `spriite pair`) shows a new code. Only after a good `tagB` does it post
   `tagA = HMAC(confA, lv_cat("A", Ya, Yb, ADb, tagB))` and the bundle sealed with AES-256-GCM
   (WebCrypto, 12-byte random IV, AAD `lv_cat("spriite/pake/v1/bundle", kind, sid)`).
6. **Phone checks, opens, closes.** The phone checks `tagA`, decrypts, validates the bundle shape
   (anything malformed is refused whole, never half-applied), checks the bundle's `createdAt` is
   within the code's life, then closes the session as done. The host sees done and finishes.

Both ends stop at the deadline the relay set (`expiresAt - now` from the relay's own clock, so
clock skew between the ends does not stretch it), and the relay itself forgets the session 10
minutes after it opened.

## Threat model

What each party can see or do:

- **A passive observer of the relay (or the relay's operator reading its storage)** sees the slot,
  `sid`, the four public points, two HMAC tags and ciphertext. CPace's security means none of this
  lets anyone test a guessed code: each guess would need a discrete logarithm. **Offline guessing
  is impossible.** The code, the QR secret, the keys and the bundle never cross the relay in the
  clear (`scripts/test-pairing.mjs` and `scripts/test-transfer.mjs` check the recorded traffic).
- **An active relay (or anyone who claims the slot first)** can run the protocol with one guessed
  code. A wrong guess fails the host's check of `tagB`, the host releases nothing and burns the
  session, and the claim it spent was the only one. **An active attacker gets one online guess per
  code**: about 1 in 2^20 for a typed pair code and about 1 in 25,600 for a typed transfer code,
  and the owner sees the failure (the phone shows the wrong code, the computer prints a new one).
  A scanned QR folds a 16-byte secret into the password, so a scanned pairing has full strength.
- **Denial of service**: an attacker who can reach the relay can claim open slots and burn
  sessions (a per-client claim rate limit of 10 a minute slows this down). The owner then sees a
  failed code and starts again; no secret is exposed.
- **A lost or shoulder-surfed code** is useless after one claim or 10 minutes.
- **The relay URL in the QR** is informational; the phone always uses the relay built into it, and
  a hostile relay could not open the bundle anyway.

Not covered: a compromised phone or computer (they hold the keys by design), and a relay that
refuses service.

## What travels

**Pair** (`PairingBundle`, `src/pair/types.ts`): the host label, owner and machine ids, broker URL
and how it is reached (`tailscale`, `https`, `none`), the OS; the Factory key, the Droid computer
id, name and status; the GitHub token, login and repo count; the broker bearer token; the
ElevenLabs key; whether host X sign-in is possible; and the Factory-native profile fields (broker
URL, owner, machine, base ref; the checkout path is left empty). The phone writes them through the
existing vault setters: Factory key; the computer id only when builds run on the computer; GitHub
token; the broker token bound to the canonical broker URL; the ElevenLabs key; the paired host,
where builds run and `setupPath = 'paired'`; and it fills only the **empty** Factory-native fields,
never overwriting one the owner filled.

**Move** (`MoveBundle`): every key in the key vault except the X token pair (X rotates its refresh
token on every renewal, so a pair copied to a second phone would end one side's grant; X is
connected again from the computer), every preference (they hold no secret; the new phone puts them
through the same restore validation), the activity feed, and build history as far as the phone
shell provides it: the archive mirror's device key (so the new phone can restore its records from
the relay archive) and, when the shell passes a history port, the records themselves. History that
would push the envelope past the mailbox's 1 MB cap is dropped first; a bundle that still does not
fit fails with `too_large`. A moved phone counts as set up (`setupPath = 'moved'`).

## Relay mailbox

`relay/pair.mjs`, dispatched before the bridge by `relay/worker.js` (Cloudflare, one Durable
Object `PairMailbox`, strongly consistent claim-once) and `relay/node.mjs` (in memory with a
30-second sweep). Routes `POST /pair/v1/{open,claim,put,poll,get,close}` with JSON bodies and
capability tokens in the body. One open session per slot, one claim, one message per side, body cap
1 MB, records gone 10 minutes after opening (plus a one-minute data-free tombstone that answers
"expired"), ciphertext dropped on close, the bridge's CORS policy, no logs.

## Host X sign-in

Separate from pairing but part of "no secret typed on the phone": `broker/x-signin.mjs` runs OAuth
2.0 PKCE on the paired computer. The phone posts `POST /v1/native/x/signin` (bearer-authenticated)
with an optional client id; the host opens the system browser on X's authorize page with an S256
challenge and a random state, receives the redirect on `http://127.0.0.1:47823/x/callback`
(`SPRIITE_X_SIGNIN_PORT`), checks the state in constant time, exchanges the code with the verifier,
reads `/2/users/me`, and stores the pair through the existing `x-credential` store when the host X
reader already has an enabled configuration (then resumes the reader). Otherwise the pair waits in
memory until the phone sends its reader settings as a handoff without tokens. Scopes: `tweet.read
users.read offline.access`. The phone only ever sees `idle`, `pending`, `connected` (with the
handle), `failed` or `unavailable`.
