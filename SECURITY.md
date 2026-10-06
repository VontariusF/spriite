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
  Factory and Cursor only through the self-hosted relay in `relay/`, which
  forwards to those two APIs on their API paths, passes only the
  `Authorization`, `Content-Type`, and `Accept` headers, follows no
  redirects, caps bodies at 1 MB, and stores nothing.
- **Rendering** uses `textContent` and DOM APIs only; no `innerHTML`, so text
  from services (session replies, repository names) cannot inject markup.
- **Agent output is untrusted.** Replies from the Factory lead session and
  workers are parsed for a small protocol (plan, VERDICT, DECISION, SUMMARY,
  PR URL) and shown as text. Consequential steps (spending credits, opening
  a pull request when set to ask) still require your confirmation.
- **Dev server only:** the Vite proxy and request logs exist only under
  `npm run dev`. The proxy log prints status and error bodies, never request
  headers.

## Recommendations for users

Scope keys tightly: ElevenLabs speech-to-text only with a spending cap, a
fine-grained GitHub token limited to the repositories you build on with an
expiry, and revoke any key you stop using.
