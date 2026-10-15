import type { MissionActor } from './mission'
import type { NativeMissionActor } from './native-mission'

/** Structural actor boundary; snapshot variants remain explicitly distinct. */
export type RuntimeMissionActor = MissionActor | NativeMissionActor
