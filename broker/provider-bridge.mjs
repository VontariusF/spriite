/**
 * Attach as provider.options.onEnvelope. The provider persists before invoking
 * this callback. It grants no capabilities and owns no client connection.
 */
export function createNativeProviderBrokerBridge({ broker, missionId, ownerId }) {
  return decoded => {
    if (decoded.kind === 'request' || decoded.kind === 'notification') {
      return broker.ingestProviderEnvelope(missionId, ownerId, decoded.envelope)
    }
  }
}
