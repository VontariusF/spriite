/**
 * The phone KV adapter for MissionStore (spec §8): the SDK's companion-app
 * storage reached through the serialized bridge.
 *
 * Contract nuance this adapter owns: `getLocalStorage` returns '' for a
 * missing key, while the gateway returns null on a transport failure or
 * timeout. Those are different facts — a missing key is absence, a null is
 * an UNKNOWN read. An unknown read must surface as an error, never silently
 * as absence: recovery deciding between checkpoints on a "missing" key that
 * actually timed out could pick the wrong envelope. One retry absorbs a
 * transient blip; a second failure throws.
 */
import type { BridgeGateway } from '../bridge/bridge'
import type { KVBackend } from './mission-store'

const GET_TIMEOUT_MS = 8000
const SET_TIMEOUT_MS = 8000

export class BridgeKVBackend implements KVBackend {
  private readonly gateway: BridgeGateway

  constructor(gateway: BridgeGateway) {
    this.gateway = gateway
  }

  async get(key: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.gateway.call((b) => b.getLocalStorage(key), `kv.get:${key}`, GET_TIMEOUT_MS)
      if (raw !== null) return raw === '' ? null : raw
    }
    throw new Error(`storage read unavailable: ${key}`)
  }

  async set(key: string, value: string): Promise<boolean> {
    const ok = await this.gateway.call((b) => b.setLocalStorage(key, value), `kv.set:${key}`, SET_TIMEOUT_MS)
    return ok === true
  }
}
