import type { NativeSnapshot } from '../native/protocol'

/** Focus and render the owner of a background ask before opening the mic.
 * A stale notice is never permission to capture for the currently open task. */
export async function focusCaptureOwner(input: {
  target: string
  pending: (target: string) => boolean
  show: (target: string) => boolean
  render: () => Promise<boolean>
  current: (target: string) => boolean
}): Promise<boolean> {
  if (!input.pending(input.target) || !input.show(input.target)) return false
  if (!await input.render()) return false
  return input.pending(input.target) && input.current(input.target)
}

/** Only presentation fits the transcript; the execution draft stays literal. */
export function canonicalVoiceDraft(body: string): string {
  return body.trim()
}

/** A changed native request or scope cannot inherit an in-flight capture. */
export function nativeCaptureKey(
  mission: string | null,
  native: Pick<NativeSnapshot, 'scopeRevision' | 'attention'> | null | undefined,
): string | null {
  if (!native) return mission
  return JSON.stringify([
    'native', mission, native.scopeRevision,
    native.attention.filter(a => a.state !== 'resolved')
      .map(a => [a.attentionId, a.requestId, a.revision, a.payloadHash, a.state, a.machineId, a.sessionId]),
  ])
}
