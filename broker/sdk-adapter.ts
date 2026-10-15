/**
 * Explicit Node-only lazy loader. Importing this source does not import the SDK.
 * An owned DaemonClient is constructed around the actual guarded transport.
 * No connect, subprocess, controller, loadSession or run() is called; the only
 * handshake is one daemon.authenticate per connection before its first call.
 */
import type { DaemonClient, DaemonClientConfig, DaemonClientTransport } from '@factory/droid-sdk'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fail } from './validation.mjs'
import { createInjectedNativeProvider } from './sdk-provider.mjs'
import type { InjectedNativeProviderOptions, PublicDaemonClientPort } from './sdk-provider.mjs'
import { compileNativePolicy } from './native-policy.mjs'
import { validateWorkspaceProof } from './native-workspace.mjs'
import { validateEnforcementLease } from './native-boundary.mjs'
export { SDK_TRANSPORT_VERSION } from './sdk-wire.mjs'

export const PINNED_SDK_VERSION = '0.9.1'
type WithoutTransport<T> = T extends { transport: unknown } ? Omit<T, 'transport'> : never
export type OptionalDaemonAdapterOptions = Omit<InjectedNativeProviderOptions, 'createClient' | 'policy'> & {
  clientConfig: WithoutTransport<DaemonClientConfig>
}

/** Check installed metadata before evaluating any execution SDK code. */
async function pinnedSdk(): Promise<typeof import('@factory/droid-sdk')> {
  const require = createRequire(import.meta.url)
  let packagePath: string
  try { packagePath = join(dirname(dirname(require.resolve('@factory/droid-sdk'))), 'package.json') }
  catch { return fail('optional_sdk_unavailable', 503) }
  let metadata: { name: string; version: string }
  try { metadata = JSON.parse(readFileSync(packagePath, 'utf8')) }
  catch { return fail('optional_sdk_unavailable', 503) }
  if (metadata.name !== '@factory/droid-sdk' || metadata.version !== PINNED_SDK_VERSION) fail('sdk_version_mismatch', 503)
  return import('@factory/droid-sdk')
}

export async function createOptionalDaemonAdapter(options: OptionalDaemonAdapterOptions) {
  // Caller must separately authorize this loader; standalone server never calls it.
  if (!options.deployment.boundary || !options.transport ||
      (!options.workspaceHost && !options.prospectiveNewRepository) || !options.evidenceAuthority) {
    fail('sdk_host_boundary_missing')
  }
  const sdk = await pinnedSdk()
  return createInjectedNativeProvider({
    ...options,
    policy: { compileNativePolicy, validateWorkspaceProof, validateEnforcementLease },
    createClient(transport): PublicDaemonClientPort {
      const client = new sdk.DaemonClient({
        ...options.clientConfig, transport: transport as DaemonClientTransport,
      })
      // droid >= 0.238 answers "method not found" to every call on a connection
      // that has not authenticated; earlier daemons accept the handshake too.
      // Once per connection, with the same key the session is initialized with.
      let authedConnection: string | null = null
      let authing: Promise<void> | null = null
      const authed = async (): Promise<void> => {
        const connection = client.getConnectionId()
        if (connection !== null && connection === authedConnection) return
        authing ??= (async () => {
          const apiKey = await options.safeExtensionTokenGetter()
          await client.authenticate({ apiKey, caller: 'sdk',
            metadata: { tracing: client.getTracingMetadata(), sdk: { language: 'typescript', version: PINNED_SDK_VERSION } } })
          authedConnection = client.getConnectionId()
        })().finally(() => { authing = null })
        await authing
      }
      // Each delegation uses an actual published method/signature, without the
      // controller's buffer/replay/auto-load layer. Schemas reject bad enums.
      return {
        isConnected: () => client.isConnected(),
        getConnectionId: () => client.getConnectionId(),
        onMessage: handler => client.onMessage(handler),
        onConnectionOpen: handler => client.onConnectionOpen(handler),
        onConnectionClose: handler => client.onConnectionClose(handler),
        onConnectionError: handler => client.onConnectionError(handler),
        initializeSession: async (params, settings) => { await authed(); return client.initializeSession(
          params as Parameters<DaemonClient['initializeSession']>[0], settings,
        ) },
        addUserMessage: async (params, requestId) => { await authed(); return client.addUserMessage(params, requestId) },
        inspectMissionReadiness: async params => { await authed(); return client.inspectMissionReadiness(params) },
        listAvailableSessions: async params => { await authed(); return client.listAvailableSessions(params) },
        getSessionMessages: async params => { await authed(); return client.getSessionMessages(params) },
        sendPermissionResponse: (requestId, result) => {
          // Public result schemas validate the answer payload but strip the
          // daemon-only routing field; send methods require that exact field.
          const parsed = sdk.RequestPermissionResultSchema.parse(result)
          client.sendPermissionResponse(requestId, { ...parsed, sessionId: result.sessionId })
        },
        sendAskUserResponse: (requestId, result) => {
          const parsed = sdk.AskUserResultSchema.parse(result)
          client.sendAskUserResponse(requestId, { ...parsed, sessionId: result.sessionId })
        },
      }
    },
  })
}
