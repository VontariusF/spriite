# X posts driving Factory-native builds: plan

Status: step 1 built, independently reviewed (2 P1 + 4 P2 fixed), qualification 4,235 checks passing.
Native launch stays disabled until the host boundary is qualified (step 2).

Review fixes beyond the contract: posts too long for a native goal (over 4096 characters) get a
durable "too long" receipt instead of stalling intake; held X requests raise a "held, review on
your phone" notice, never "started"; promoted/dismissed requests read as such in Builds and the
briefing, never as faults; approved jobs saved before a crash are prepared at next boot; re-read
receipts reflect the resolution; a changed destination is shown beside launch; a request that
vanishes during review disables launch.

## Principle

An X post is an outside request, never owner authority. In native mode it is saved as a
held, ungranted intent. Only the owner, on the phone, can turn it into a native job, and
only through the existing admission flow (broker preview, holds shown, explicit scope and
High-autonomy consent). The held intent's exact text and context references are carried
unchanged; nothing from the post becomes a permission, credential or repository choice.

## Steps

1. **Phone approval for held X intents (build now).**
   - Runtime lists held native intents and records their origin (`x` or `generic`).
   - "Review as native job" pre-fills the phone admission draft with the held goal
     (read-only, exact) and references. The owner still inspects the broker preview and ticks
     both consents. Launch then *promotes*: one new approved intent (fresh mission/command
     ids) is saved, and the held mission becomes terminal with a
     `native_intent_promoted` event linking the new mission. Promotion is idempotent: a
     second attempt returns the first result and never creates a second job.
   - "Dismiss" makes the held mission terminal with `native_intent_dismissed`.
   - X receipts tell the truth in native mode: "Saved, held for approval on your phone",
     never "started". New-repository posts get a clear refusal explaining native mode
     cannot create repositories.
   - Glasses keep showing held state (read-only); approval never happens on the glasses
     because consent requires reading the scope.
2. **Host boundary qualification (blocked on real host evidence).** Replace the canary's fake
   workspace/lease evidence and send permits with the real host port; qualify; only then can
   `launchEligible` be true for any source.
3. **New-repository X posts (policy decision).** Keep `allowCreateRepository:false` until
   the owner decides; then add destination review to the admission screen.
4. **Delivery (policy decision).** Push/PR/merge stay off; native X builds end in a local
   commit, as in the live canary.

## Contract for step 1

Shared type in `src/native/protocol.ts`:

```ts
export interface HeldNativeIntent {
  missionId: string            // held mission
  origin: 'x' | 'generic'
  goal: string                 // exact, unnormalized
  references: string[]
  repository: string
  createdAt: string            // ISO
}
```

Supervisor (`src/runtime/supervisor.ts`):

- `heldNativeIntents(): HeldNativeIntent[]`: non-terminal factory_native missions whose
  intent lacks scope or High approval, newest first.
- `promoteHeldNativeIntent(heldMissionId: string, intent: NativeIntent): Promise<SubmitReceipt>`:
  requires `intent.goal === held.goal`, every held reference present, both approvals true, and a
  valid bound profile. It commits the new mission and the held mission's terminal transition in
  one store commit. Idempotent.
- `dismissHeldNativeIntent(heldMissionId: string): Promise<boolean>`

Phone (`src/phone/native.ts`) deps:

- `heldNativeIntents?: () => HeldNativeIntent[]`
- `onPromoteHeld?: (heldMissionId: string, request: NativeLaunchRequest) => NativeLaunchOutcome | Promise<NativeLaunchOutcome>`
- `onDismissHeld?: (heldMissionId: string) => boolean | Promise<boolean>`

`main.ts` wires these to the supervisor (generating fresh ids exactly like `onNativeLaunch`).
