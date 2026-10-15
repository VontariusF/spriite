/**
 * Which engine a launch runs, and what it may resume (spec §26 rollback).
 *
 * Two authorities never share one store:
 *  - the durable runtime runs only when its flag is on AND it acquired
 *    authority (its boot succeeded). A failed boot is not a reason to hand
 *    the same records to the legacy engine as if nothing had happened;
 *  - once a generation has written durable records (the marker), the legacy
 *    engine may still run — rollback keeps the app usable — but it must not
 *    resume those missions from its own snapshot, and it must not present
 *    the pre-runtime vault as its projects either (the vault's missions are
 *    the ones the migration already imported: showing both would double
 *    every record on the home).
 *
 * Pure and exported so the launch matrix is testable without a device.
 */

export type BootPlan =
  | { engine: 'runtime' }
  | {
      engine: 'legacy'
      /** `list` reads the pre-runtime vault; `none` hides it (durable records exist). */
      projects: 'list' | 'none'
      /** `refused` means durable records exist: never resume the legacy snapshot. */
      resume: 'fresh' | 'refused'
    }

export interface BootInputs {
  /** The persistent_runtime_v2 flag, resolved for this launch. */
  runtimeFlag: boolean
  /** The runtime booted and holds authority. */
  runtimeReady: boolean
  /** A previous generation wrote durable runtime records (its marker). */
  durableRecordsExist: boolean
  /** `?fresh=1` (dev/test): start from a clean story. */
  fresh: boolean
}

export function planBoot(i: BootInputs): BootPlan {
  if (i.runtimeFlag && i.runtimeReady) return { engine: 'runtime' }
  if (i.durableRecordsExist) return { engine: 'legacy', projects: 'none', resume: 'refused' }
  if (i.fresh) return { engine: 'legacy', projects: 'list', resume: 'fresh' }
  return { engine: 'legacy', projects: 'list', resume: 'fresh' }
}
