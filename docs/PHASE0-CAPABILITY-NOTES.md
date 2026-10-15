# Phase 0 — Capability probe notes (Persistent Companion spec §26 phase 0)

Observed limits of the storage host the persistent runtime builds on,
plus the gates that stay open until they are qualified on hardware.

## Storage probe (`?probe=storage` · simulator · 7 October 2026)

Harness: `npm run dev` + `npm run sim:probe` + `npm run probe:storage`
(implementation: `src/probe/storage.ts`, `scripts/probe-storage.mjs`).

| Probe | Result |
|---|---|
| Largest verified value | 1,048,576 chars written and read back byte-exact |
| Oversized write (5,000,000 chars) | accepted; read back byte-exact |
| Read-after-write | consistent at every probed size (immediate match) |
| Key isolation | one write never disturbs another key |
| Overwrite | the second value fully replaces the first |
| Missing key | `getLocalStorage` answers `''` (empty string, not null) |
| JSON envelope roundtrip (~40 KB) | exact |
| Latency (simulator IPC) | <= 24 ms per large write; <= 5 ms typical |

## What this proves — and what it does not

The probe ran in the desktop simulator: Electron IPC, not the phone's
Flutter WebView over the BLE-linked bridge. It proves the SDK's string-KV
contract holds for arbitrarily large values with byte-exact reads, so the
MissionStore checkpoint design (40,000-char chunks, alternating slots,
manifest-after-chunks, advisory head) operates with wide margin there.

It does **not** prove:

- interruption behavior mid-write on hardware — defended by design instead
  (the manifest is written after its chunks; recovery validates both slots
  and the newest valid envelope wins; a torn head pointer discards
  nothing);
- write-acknowledgement truth on hardware — `setLocalStorage` returning
  `true` is request acceptance, not proof of permanent storage (spec §8);
  the store never reports a commit accepted until the host acks, and a
  failed ack leaves the store `broken` until `reload()` revalidates;
- value-size ceilings on the phone;
- headless/foreground WebView migration on the phone — the store's
  single-writer lifecycle needs explicit re-entry tests (spec §8, §22).

Phone-first feasibility stands: the durable-receipt design needs only the
string-KV semantics the SDK documents. Unattended intake stays disabled
until the hardware gates below pass (spec §27).

## Open hardware gates

| Gate | Method |
|---|---|
| Storage commit truth | write a large envelope, force-quit mid-cycle, restart, verify slot recovery picks the newest valid envelope |
| Max value size on the phone | binary-search probe sizes on-device |
| 8-hour locked/background runtime | safe test mission; record observed lifecycle per OS (spec §25.27) |
| Force-quit during a worker run | restart reconciles the same run without duplicate dispatch (§25.28) |
| Double `__restoreState` / headless re-entry | drive the host protocol repeatedly in dev; assert one runtime owns writes (§22) |
