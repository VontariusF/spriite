Mission v2 record test vectors (droid 0.227.0 canary, session
`ac657282-a7e8-431b-b98d-6b04d03c55bd`).

- `ac657282/final/` is a verbatim copy of `~/.factory/missionsV2/<id>/` after
  the run (text evidence only).
- `ac657282/approval-checks.json` is `checks.json` as it was at plan approval.
  The orchestrator later rewrote the `deliverable` artifact identity with
  `JSON.stringify(checks, null, 2) + "\n"`; restoring the planning-time
  identity string from the session transcript reproduces the approval
  `checksHash` byte for byte.
- Scrubbed for publication: the capturing account's home directory in the
  recorded artifact paths is replaced with `/home/user`, and the two
  `checksHash` values in `snapshots.json` are recomputed for the scrubbed
  bytes. Everything else is as captured.
- `ac657282/snapshots.json`: `approval` is the observed
  `mission_v2_snapshot_changed` at approval; `final` is what droid's
  `readSnapshot` computes for the final files (not separately observed).
