/**
 * Release flags for the persistent companion (spec §26). A flag turns on by
 * the owner's explicit choice on the phone (or, in dev builds, a `?flags=`
 * override), and a capability that has not been qualified on the owner's
 * device stays off by default. The durable runtime is the one exception: it
 * ships on (see FLAG_DEFAULTS).
 *
 * Dependencies are enforced here, not at each call site: return briefings
 * and X intake need the durable runtime's receipts and journal, so they can
 * never run on the legacy engine (spec §26 "X intake requires the
 * persistent runtime").
 *
 * Flags are read once at boot. Switching the runtime under a live mission
 * would leave two orchestrators with a claim on the same provider work, so
 * a runtime change takes effect on the next launch. X intake can be toggled
 * live once that runtime holds authority; turning it off stops new intake.
 *
 * No runtime imports and erasable-only syntax so Node test scripts load it.
 */

export const FLAG_NAMES = [
  'persistent_runtime_v2',
  'return_briefings',
  'sprite_states_v2',
  'x_owner_intake',
  'archive_mirror',
] as const

export type FlagName = (typeof FLAG_NAMES)[number]
export type Flags = Record<FlagName, boolean>

export const FLAG_DEFAULTS: Flags = {
  // On by default: parallel builds and free switching need it. An install
  // whose owner turned it off stored
  // `false` and keeps it; one that never chose stores nothing and moves on.
  persistent_runtime_v2: true,
  return_briefings: false,
  sprite_states_v2: false,
  x_owner_intake: false,
  archive_mirror: false,
}

/** A flag that may only be on while its prerequisite is on. */
export const FLAG_REQUIRES: Partial<Record<FlagName, FlagName>> = {
  return_briefings: 'persistent_runtime_v2',
  x_owner_intake: 'persistent_runtime_v2',
}

export const FLAG_LABELS: Record<FlagName, { title: string; note: string }> = {
  persistent_runtime_v2: {
    title: 'Durable runtime',
    note: 'Missions keep their own records and run side by side. Takes effect next launch.',
  },
  return_briefings: {
    title: 'Return briefings',
    note: 'A short account of what changed while you were away. Needs the durable runtime.',
  },
  sprite_states_v2: {
    title: 'Mission-aware sprite',
    note: 'The sprite reflects the most urgent mission, not only the one on screen.',
  },
  x_owner_intake: {
    title: 'X requests',
    note: 'Your own posts that mention Spriite become private requests. Needs the durable runtime.',
  },
  archive_mirror: {
    title: 'Archive mirror',
    note: 'Keeps a copy of your records on your own VPS. A lost phone restores them; nothing changes while it is off.',
  },
}

export function isFlagName(s: string): s is FlagName {
  return (FLAG_NAMES as readonly string[]).includes(s)
}

/** Stored flags, then overrides, then dependency rules. Unknown keys ignored. */
export function resolveFlags(stored: unknown, overrides: Partial<Flags> = {}): Flags {
  const out: Flags = { ...FLAG_DEFAULTS }
  if (stored !== null && typeof stored === 'object') {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      if (isFlagName(k) && typeof v === 'boolean') out[k] = v
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (isFlagName(k) && typeof v === 'boolean') out[k] = v
  }
  for (const name of FLAG_NAMES) {
    const need = FLAG_REQUIRES[name]
    if (need !== undefined && !out[need]) out[name] = false
  }
  return out
}

/**
 * `?flags=persistent_runtime_v2,x_owner_intake` turns flags on;
 * `-name` turns one off. Dev builds only (the caller checks).
 */
export function parseFlagParam(param: string | null): Partial<Flags> {
  const out: Partial<Flags> = {}
  if (!param) return out
  for (const raw of param.split(',')) {
    const t = raw.trim()
    const off = t.startsWith('-')
    const name = off ? t.slice(1) : t
    if (isFlagName(name)) out[name] = !off
  }
  return out
}
