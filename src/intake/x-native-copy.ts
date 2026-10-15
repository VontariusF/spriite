/** Owner-facing X receipt reasons for native mode, shared by intake and runtime. */
import type { Mission } from '../domain/types'

export const X_NATIVE_HELD_REASON = 'Saved, held for approval on your phone. Nothing has started.'
export const X_NATIVE_PROMOTED_REASON = 'Approved on your phone as a new native job.'
export const X_NATIVE_DISMISSED_REASON = 'Dismissed on your phone.'
export const X_NATIVE_NO_NEW_REPO_REASON =
  'Native mode cannot create repositories. Name an existing repository in the post, or choose one on the phone.'
export const X_NATIVE_NEW_REPO_NAME_REASON =
  'Name the new repository in the post, for example "new repo called habit-log". Nothing was saved.'
export const X_NATIVE_NEW_REPO_ACCOUNT_REASON =
  'Set your GitHub repository on the phone first, so a new private repository has an owner. Nothing was saved.'
export const X_NATIVE_NO_DESTINATION_REASON =
  'This post names no repository, and an X build never runs in an existing one it did not name. ' +
  'Allow new private repositories for native jobs, name a repository in the post, or choose one on the phone.'
export const NATIVE_GOAL_LIMIT = 4096
export const xNativeTooLongReason = (n: number): string =>
  `Too long for a native job (${n} of ${NATIVE_GOAL_LIMIT} characters). Shorten the post or use the standard build mode.`

/** The receipt reason that matches the held mission's current resolution. */
export function xNativeReceiptReason(mission: Mission | undefined): string {
  const r = mission?.config.nativeHeldResolution
  return r?.outcome === 'promoted' ? X_NATIVE_PROMOTED_REASON
    : r?.outcome === 'dismissed' ? X_NATIVE_DISMISSED_REASON : X_NATIVE_HELD_REASON
}
