import type { KeyObject } from 'node:crypto'
import type { NativeCapabilities } from '../src/native/protocol.js'
import type { BrokerTransport } from './index.js'

export declare const QUALIFICATION_GATES: readonly [
  'initialization_workspace', 'proposal_start_scope', 'root_child_attention',
  'owner_machine_routing', 'restart_resolution', 'replay_containment',
  'effective_settings_policy_cost', 'snapshot_completeness', 'readonly_finalization',
]
export declare function unavailableCapabilities(transportVersion?: string): NativeCapabilities

export interface NativeQualificationManifest {
  version: 1
  qualificationId: string
  ownerId: string
  machineId: string
  transportVersion: string
  issuedAt: string
  expiresAt: string
  gates: Array<{ name: string; evidencePath: string; sha256: string; verifiedAt: string }>
  controls: { pause: boolean; resume: boolean; cancel: boolean }
}
export type NativeQualificationRecord = NativeQualificationManifest & { manifestHash: string }

export declare function loadQualification(options?: {
  path?: string
  publicKey?: KeyObject | string | Buffer
  ownerId?: string
  machineId?: string
  transportVersion?: string
  now?: number
}): Promise<NativeQualificationRecord | null>

export declare const HOST_QUALIFICATION_CHECKS: readonly ['containment_probes', 'mission_delivery', 'revocation']
export declare function publicKeySha256(key: KeyObject | string | Buffer): string

export interface NativeHostQualificationManifest {
  version: 1
  kind: 'host_qualification'
  qualificationId: string
  machineId: string
  deploymentDigest: string
  hostPublicKeySha256: string
  droidVersion: string
  issuedAt: string
  expiresAt: string
  checks: Array<{ name: string; passed: boolean; evidenceSha256: string; verifiedAt: string }>
}
/** WeakSet-branded: only a record returned by verify/loadHostQualification counts. */
export type NativeHostQualificationRecord = Readonly<NativeHostQualificationManifest & { manifestHash: string }>
export interface NativeSignedEnvelope<M> {
  manifest: M
  signature: string
}

export declare function verifyHostQualification(envelope: NativeSignedEnvelope<NativeHostQualificationManifest>, expected: {
  publicKey: KeyObject | string | Buffer
  deploymentDigest: string
  hostPublicKey: KeyObject | string | Buffer
  machineId: string
  now?: number
}): NativeHostQualificationRecord
export declare function loadHostQualification(options: {
  path?: string
  publicKey: KeyObject | string | Buffer
  deploymentDigest: string
  hostPublicKey: KeyObject | string | Buffer
  machineId: string
  now?: number
}): Promise<NativeHostQualificationRecord | null>
export declare function isHostQualificationFor(record: unknown, expected: {
  deploymentDigest: string
  hostPublicKey: KeyObject | string | Buffer
  now?: number
}): record is NativeHostQualificationRecord

export declare function capabilitiesFor(
  qualification: NativeQualificationRecord | null,
  transport: Pick<BrokerTransport, 'version' | 'support'> | null | undefined,
  now?: number,
): NativeCapabilities
