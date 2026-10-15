# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
**Security > Report a vulnerability** form on this repository rather than in
a public issue. Include steps to reproduce and the affected version. You can
expect an acknowledgement within a week.

## Model

- **Bring your own keys.** Keys are typed on the phone, kept in the
  companion app's per-app storage, masked in the UI, never sent to the
  glasses, and never logged. No key is ever bundled into a build.
- **Voice** uses a 15-minute single-use ElevenLabs token for the realtime
  socket; the long-lived key is only sent to the token endpoint.
- **Network** is limited by the `app.json` whitelist. Installed builds reach
  Factory, Cursor, and X only through the self-hosted relay in `relay/`,
  which forwards to those three APIs on their API paths, passes only the
  `Authorization`, `Content-Type`, and `Accept` headers, follows no
  redirects, caps bodies at 1 MB, and stores nothing. The X route carries the
  four owner-intake lookups (GET/HEAD) plus one fixed `POST /2/oauth2/token`
  that renews the owner's own token pair, so nothing can post, reply, like,
  or repost on X through it.
- **Rendering** uses `textContent` and DOM APIs only; no `innerHTML`, so text
  from services (session replies, repository names) cannot inject markup.
- **Agent output is untrusted.** Replies from the Factory lead session and
  workers are parsed for a small protocol (plan, VERDICT, DECISION, SUMMARY,
  PR URL) and shown as text. Consequential steps (spending credits, opening
  a pull request when set to ask) still require your confirmation.
- **X intake is owner-only and read-only for content.** A post triggers work only when
  its author is the bound owner's numeric user id and it carries a verified
  mention of the bound Spriite account. Other users, quoted text, thread
  replies, and screenshots are context, never triggers. Receipts and
  clarifications stay private to the phone. The owner's token pair is stored
  in the phone key vault; when a refresh token is present Spriite renews the
  pair through the relay's single OAuth token route and saves the rotation.
- **Dev server only:** the Vite proxy and request logs exist only under
  `npm run dev`. The proxy log prints status and error bodies, never request
  headers.

## Recommendations for users

Scope keys tightly: ElevenLabs speech-to-text only with a spending cap, a
fine-grained GitHub token limited to the repositories you build on with an
expiry, and revoke any key you stop using.
