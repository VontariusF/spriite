import type { NativeBroker } from './index.js'
import type { DecodedSdkEnvelope } from './sdk-wire.mjs'
export declare function createNativeProviderBrokerBridge(options: {
  broker: NativeBroker; missionId: string; ownerId: string
}): (decoded: DecodedSdkEnvelope) => void
