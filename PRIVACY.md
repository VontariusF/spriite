# Privacy

Spriite has no backend, no analytics, and no accounts of its own. Everything
it does runs on your phone inside your glasses' companion app and talks only to
services you connect with your own keys.

## Permissions

| Permission | Used for |
|---|---|
| Microphone (`g2-microphone` on Even G2) | Tap-to-talk. Audio is captured only while the listening card shows (30 s cap) and streams straight to ElevenLabs for transcription. It is not recorded or stored. |
| `network` | Calls to the services below, and nothing else. |

## Where data goes

| Service | What is sent | When |
|---|---|---|
| ElevenLabs (`api.elevenlabs.io`) | Your ElevenLabs key (to mint a single-use token), then microphone audio over a WebSocket authenticated with that token | Only when you tap Talk with a voice key saved |
| Factory (`api.factory.ai`) | Your Factory key, your goal, plan and review messages, the repository URL, the chosen computer | Only with a Factory key saved |
| Cursor (`api.cursor.com`) | Your Cursor key, build instructions, the repository URL | Only with a Cursor key saved |
| GitHub (`api.github.com`) | Your GitHub token, repository list requests, new repository names | Only with a GitHub token saved |
| Your relay (installed builds only) | Factory and Cursor requests, including those keys, in transit | Whenever Factory or Cursor is called |

Each service's own privacy policy governs what it does with that data.

The relay is code in this repository (`relay/`) that you deploy yourself. It
forwards requests to Factory and Cursor only, and stores and logs nothing.
Whoever operates the relay a build points at can see the traffic it carries,
so only use a build whose relay you run or trust.

## What stays on your phone

Keys, the chosen repository and computer, preferences, and recent missions
are kept in the companion app's local storage for Spriite. Keys are never
shown in full (only a short hint), never sent to the glasses, and never
written to logs. Removing a key in Setup deletes it from that storage.

## Contact

Open an issue in this repository for privacy questions. For anything
sensitive, see [SECURITY.md](SECURITY.md).
