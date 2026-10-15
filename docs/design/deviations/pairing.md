# Deviations: pairing

Rows for the "Recorded deviations" table in `docs/design/REDESIGN-SPEC.md`.

| Board | Difference | Reason |
|---|---|---|
| SetupCompare (Proposed, step 2), Pair, Settings ("Run npx spriite pair there") | Until the `spriite` npm package is published, the command is `npm run pair` from a checkout of the repository (`npm run pair -- --relay <relay URL>`). README, `docs/SETUP.md` and `docs/NATIVE-BROKER-SETUP.md` say so next to `npx spriite pair`. The package itself (`cli/`) is complete and packs the broker and installer (`npm pack` in `cli/`). | Publishing to the npm registry needs the owner's npm account; a build cannot do it. |
| SetupCompare (Proposed, step 1) | "From Even Hub" is documented as: upload your own build to your own Even Hub project; there is no shared store listing yet. | The Even app reaches only the exact addresses packed into a build, and each owner runs their own relay, so builds are per owner. |
| Pair ("Get the installer for macOS, Linux or Windows") | There is no standalone, Node-free installer, and the Spriite host (native broker) runs on Linux and macOS only. `spriite pair` refuses Windows with the reason. | The broker runs as a systemd user service or a LaunchAgent and drives droid's POSIX sandbox; Windows has neither. A Node-free installer would need a separately built and signed binary per OS. |
| Move ("Every key and the link to studio") | Every key and the host link move except an X token pair held on the old phone. The new phone connects X again from the computer (host sign-in). | X rotates the refresh token on every renewal: a pair copied to a second phone would end the first phone's (or the host reader's) grant. |
| Move ("Build history and chats") | The activity feed and the archive mirror's device key always move (the new phone restores its records from the relay archive); full build records move only when the phone shell passes a history port to `createPairingClient`. History that would push the envelope past the relay's 1 MB mailbox cap is dropped first; if the rest still does not fit, the move fails with `too_large`. | The mission store (frozen) exposes no export of its records; the relay mailbox holds at most 1 MB per message. |
| Ready ("Build from X posts … Sign-in opens on studio") | The owner registers their own X app once: an OAuth 2.0 client id (in Settings or `SPRIITE_X_CLIENT_ID` on the computer) and the callback URL `http://127.0.0.1:47823/x/callback`. | X issues OAuth clients per developer app; Spriite ships no shared X app (bring your own app), and X only redirects to registered callback URLs. |

## Integration requests

Resolved at integration:

- **phone**: the phone passes the archive mirror (`ArchiveClient`, which gained a read-only `deviceKey` getter, a one-line additive change to the frozen `src/state/archive.ts`) to `createPairingClient`, so a move carries the archive device key. No history port is passed: the frozen mission store exposes no export of its records, so the new phone restores build records from the relay archive (row "Move ‘Build history and chats’" above).
- **phone** (X panel): host sign-in leads; once it reports `connected` and the phone holds no pair, "Read X on my Factory host" sends the reader settings to `POST /v1/native/x/handoff` with no `accessToken`/`refreshToken`, and the broker joins the pair its sign-in holds (`scripts/test-host-x-phone.mjs`).
- **setup**: `parseTransferQr` is now a `PairingClient` member and the Move receiver uses it.

Still open (device gate, not a build change): the Paired board's "Keys are stored encrypted on this phone" is kept as drawn; keys live in the Even app's SDK storage like every vault, and whether that storage is encrypted at rest is the §27 "secure credential storage" hardware gate in `scripts/qualify.mjs`.
