# spriite

Pair Spriite (the voice-first companion for HUD smart glasses) with your Factory computer.

```sh
npx spriite pair
```

Run it in a terminal on the computer where Factory's `droid` is signed in. It installs or starts the
Spriite native broker, finds what it can (Factory key, Droid computer, GitHub CLI token, the private
host link, the broker token, owner and machine ids, an ElevenLabs key), and shows a 6-character code
and a QR code. Type the code in Spriite on your phone; everything comes over end-to-end encrypted
through your relay. The code works once and expires after 10 minutes. Anything it could not find is
marked "Later" and can be added in Spriite's Settings.

```
spriite pair [--relay URL] [--dry-run] [--no-install]
spriite help
```

- `--relay URL`: your Spriite relay (otherwise `SPRIITE_RELAY`, or the saved host config).
- `--dry-run`: print the plan with every secret redacted; change nothing.
- `--no-install`: never install the broker; use an existing install only.

The protocol and its threat model: `docs/design/PAIRING-PROTOCOL.md` in the Spriite repository.
