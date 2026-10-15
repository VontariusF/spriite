/**
 * Setup completion (docs/design/REDESIGN-PLAN.md C4). Setup is complete once
 * the owner tapped "Finish setup" on the Repo step, or when the install
 * already holds a working setup from before the redesign (a Factory key plus
 * a repository, or a Factory key with a new repository per idea): an
 * existing install never sees Welcome again.
 *
 * No runtime imports beyond realSetupWorks, erasable-only syntax, so Node
 * test scripts load it.
 */
import { realSetupWorks } from '../voice/keys'
import type { RepoMode } from '../pair/types'

export function isSetupComplete(
  keys: { factory: string; repoUrl: string; repoMode?: RepoMode },
  prefs: { setupCompletedAt: number },
): boolean {
  return prefs.setupCompletedAt > 0 || realSetupWorks(keys)
}
