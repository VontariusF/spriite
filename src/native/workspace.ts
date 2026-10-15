import type { NativeIntent, NativeLaunchProfile, NativeWorkspace } from './protocol'
import { validGithubAccount, validRepositoryName } from './delivery'

/** POSIX canonical spelling, consistent with the broker's workspace rule.
 * No normalization, traversal, tilde expansion, root directory or path aliases.
 * Physical realpath/containment remains the host's responsibility.
 */
export function canonicalNativeHostRoot(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1800 && value.startsWith('/') &&
    value !== '/' && !/[\x00-\x1f\x7f\\]/.test(value) &&
    value.split('/').slice(1).every(part => part !== '' && part !== '.' && part !== '..') &&
    value === value.trim()
}

export function nativeProfileWorkspaceFields(raw: Record<string, unknown>): Partial<NativeLaunchProfile> | null {
  if (raw.workspaceMode === undefined) return raw.hostRoot === undefined ? {} : null
  if (raw.workspaceMode !== 'host_managed' || !canonicalNativeHostRoot(raw.hostRoot)) return null
  return { workspaceMode: 'host_managed', hostRoot: raw.hostRoot }
}

/** Exact job allocation, not a prefix authorization. IDs are a single safe segment. */
export function nativeJobCheckout(profile: NativeLaunchProfile, missionId: string): string | null {
  if (profile.workspaceMode !== 'host_managed' || !canonicalNativeHostRoot(profile.hostRoot) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(missionId)) return null
  return `${profile.hostRoot}/jobs/${missionId}/work`
}

export function nativeWorkspaceMatchesProfile(profile: NativeLaunchProfile, workspace: NativeWorkspace,
  missionId: string): boolean {
  const expected = profile.workspaceMode === 'host_managed' ? nativeJobCheckout(profile, missionId) : profile.cwd
  return expected !== null && workspace.cwd === expected &&
    workspace.machineId === profile.machineId && workspace.baseRef === profile.baseRef
}

export function nativeDestinationRepository(profile: NativeLaunchProfile,
  destination: NonNullable<NativeIntent['destination']>): string {
  return profile.workspaceMode === 'host_managed' && destination.kind === 'new_repository'
    ? `${destination.account}/${destination.name}` : `https://github.com/${destination.account}/${destination.name}`
}

/** Frozen records use the same exact path and managed-new identity on every restore route. */
export function nativeIntentMatchesProfile(profile: NativeLaunchProfile, intent: NativeIntent): boolean {
  return intent.ownerId === profile.ownerId && nativeWorkspaceMatchesProfile(profile, intent.workspace, intent.missionId) &&
    !(profile.workspaceMode === 'host_managed' && intent.destination?.kind === 'new_repository' &&
      intent.workspace.repository !== nativeDestinationRepository(profile, intent.destination))
}

/** Convert only an explicitly named managed NEW destination; never infer from references. */
export function allocateNativeWorkspace(profile: NativeLaunchProfile, missionId: string,
  workspace: NativeWorkspace, destination?: NativeIntent['destination']): NativeWorkspace | null {
  if (profile.workspaceMode !== 'host_managed') return { ...workspace }
  const cwd = nativeJobCheckout(profile, missionId)
  if (!cwd) return null
  let repository = workspace.repository
  if (destination?.kind === 'new_repository') {
    if (!validGithubAccount(destination.account) || !validRepositoryName(destination.name) ||
      destination.visibility !== 'private' || destination.initialization !== 'empty' || destination.sourceUrl) return null
    const expected = nativeDestinationRepository(profile, destination)
    if (repository !== expected && repository !== `https://github.com/${expected}`) return null
    repository = expected
  }
  return { ...workspace, cwd, repository }
}
