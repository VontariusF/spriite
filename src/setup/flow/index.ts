/**
 * Setup flow API (docs/design/REDESIGN-PLAN.md C6): the first-run flow
 * (Welcome, Pair, Paired, Repo, Ready, Move receiver), the Move sender, and
 * the Repo board's chooser for Settings.
 */
import { githubRepos } from '../../factory/github'
import type { KeyVault } from '../../voice/keys'
import type { PrefsVault } from '../../state/prefs'
import type { RepoMode } from '../../pair/types'
import { attr, el, ensureSetupStyles } from './dom'
import { COPY } from './copy'
import { createRepoPicker } from './repo'
import type { SetupFlowDeps } from './flow'

export {
  mountSetupFlow,
  reviewRows,
  defaultTestFactoryKey,
  type SetupEntry,
  type SetupScreenId,
  type SetupFlowDeps,
  type SetupFlowHandle,
  type ExtraNote,
  type ReviewRow,
} from './flow'
export { mountMoveScreen, countdown, type MoveScreenDeps } from './move'
export { parseGithubUrl, repoAge, repoMeta } from './repo-util'
export { SETUP_CSS } from './styles'

export interface RepoChooserDeps {
  keys: KeyVault
  prefs: PrefsVault
  github?: SetupFlowDeps['github']
  githubHost?: SetupFlowDeps['githubHost']
  onSaved(): void
  onChange?(mode: RepoMode, repoUrl: string): void
}

/**
 * The Repo board's radio group, search and list for Settings › How builds
 * run. Every choice saves at once (mode, and the repo when one is chosen).
 */
export function mountRepoChooser(root: HTMLElement, deps: RepoChooserDeps): { refresh(): void; destroy(): void } {
  ensureSetupStyles()
  let destroyed = false
  let writes: Promise<unknown> = Promise.resolve()
  const make = () => createRepoPicker({
    githubToken: () => deps.keys.github,
    githubHost: deps.githubHost ?? null,
    github: deps.github ?? { repos: githubRepos },
    initialMode: deps.keys.repoMode,
    initialUrl: deps.keys.repoUrl,
    idPrefix: 'sf-chooser-',
    onChange: (mode, url) => {
      // "One repo I choose" with no repo is not saved (the same guard as
      // the setup flow): the saved mode stays until a repo is picked.
      const missing = mode === 'one' && !url
      guard.hidden = !missing
      if (missing) return
      writes = writes.then(async () => {
        if (destroyed) return
        await deps.keys.setRepoMode(mode)
        if (mode === 'one' && url && url !== deps.keys.repoUrl) await deps.keys.setRepoUrl(url)
        if (destroyed) return
        deps.onSaved()
        deps.onChange?.(mode, url)
      }).catch(() => undefined)
    },
  })
  const guard = attr(el('p', 'sf-error', [COPY.repo.pickRepo]), { role: 'alert' })
  guard.hidden = true
  let picker = make()
  const wrap = el('div', 'sf-root sf-chooser', [picker.radios, picker.search, guard])
  root.replaceChildren(wrap)
  return {
    refresh: () => {
      if (destroyed) return
      picker.destroy()
      picker = make()
      guard.hidden = true
      wrap.replaceChildren(picker.radios, picker.search, guard)
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      picker.destroy()
      root.replaceChildren()
    },
  }
}
