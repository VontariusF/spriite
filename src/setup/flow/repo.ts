/**
 * The Repo board's chooser: the two radio cards ("A new private repo for
 * each idea" by default, "One repo I choose"), the "Or start from a repo"
 * search and the repo list. The list comes through the selected GitHub (the
 * paired host's sign-in, else the phone's token) when there is one; a pasted GitHub link is always a selectable row, so the step works
 * with no GitHub or Cursor key at all. Choosing a row, or pasting a valid
 * GitHub link, switches to "One repo I choose" with that repo selected.
 */
import { selectGitHub, type GitHubAuth, type GitHubHostAccess, type GitHubRepo } from '../../factory/github'
import type { RepoMode } from '../../pair/types'
import { COPY } from './copy'
import { attr, button, el } from './dom'
import { iconEl } from './icons'
import { parseGithubUrl, repoFullName, repoMeta } from './repo-util'

export interface RepoPickerOptions {
  githubToken: () => string
  /** The paired host's GitHub; selection prefers it over the token. */
  githubHost?: GitHubHostAccess | null
  github: { repos(auth: GitHubAuth): Promise<GitHubRepo[]> }
  initialMode: RepoMode
  initialUrl: string
  now?: () => number
  onChange?(mode: RepoMode, url: string): void
  idPrefix?: string
}

export interface RepoPicker {
  /** The radio group (its own block in the Repo column). */
  readonly radios: HTMLElement
  /** "Or start from a repo": label, search and list. */
  readonly search: HTMLElement
  readonly input: HTMLInputElement
  mode(): RepoMode
  url(): string
  setMode(mode: RepoMode): void
  /** Re-read the token and reload the list. */
  reload(): void
  destroy(): void
}

/** Rows the list shows at once when nothing is typed; the search narrows the rest. */
export const REPO_ROWS_SHOWN = 6

interface Row { url: string; name: string; meta: string }

export function createRepoPicker(opts: RepoPickerOptions): RepoPicker {
  const now = opts.now ?? (() => Date.now())
  const C = COPY.repo
  let mode: RepoMode = opts.initialMode
  let selected = opts.initialUrl
  /** The selection came from a pasted link (cleared when the link is edited away). */
  let fromPaste = false
  let repos: GitHubRepo[] = []
  let load: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle'
  let generation = 0
  let destroyed = false

  const radio = (value: RepoMode, title: string, desc: string): HTMLButtonElement => {
    const b = button('sf-radio', [
      el('span', 'sf-radio-dot', [el('span', 'sf-radio-dot-inner')]),
      el('span', 'sf-radio-body', [
        el('span', 'sf-radio-title', [title]),
        el('span', 'sf-radio-desc', [desc]),
      ]),
    ], () => {
      mode = value
      paintRadios()
      opts.onChange?.(mode, selected)
      renderList()
    }, { role: 'radio', 'data-value': value })
    return b
  }
  const perIdea = radio('per_idea', C.perIdea, C.perIdeaDesc)
  const one = radio('one', C.one, C.oneDesc)
  const radios = attr(el('div', 'sf-radios', [perIdea, one]), { role: 'radiogroup', 'aria-label': C.group })
  const paintRadios = (): void => {
    perIdea.setAttribute('aria-checked', String(mode === 'per_idea'))
    one.setAttribute('aria-checked', String(mode === 'one'))
  }

  const inputId = `${opts.idPrefix ?? 'sf-'}repoSearch`
  const input = el('input', 'sf-search-input')
  attr(input, {
    id: inputId, placeholder: C.searchPlaceholder, autocomplete: 'off', autocapitalize: 'none',
    autocorrect: 'off', spellcheck: 'false', inputmode: 'url', type: 'text',
  })
  input.value = ''
  const list = el('div', 'sf-list sf-list--14')
  const label = attr(el('label', 'sf-search-label', [C.searchLabel]), { for: inputId })
  const search = el('div', 'sf-search', [
    label,
    el('div', 'sf-search-wrap', [input, iconEl('search', 'sf-search-icon')]),
    list,
  ])

  const rowsFor = (): { rows: Row[]; note: string } => {
    const text = input.value.trim()
    const pasted = parseGithubUrl(text)
    const ofRepo = (r: GitHubRepo): Row => ({ url: r.url, name: r.fullName, meta: repoMeta(r, now()) })
    const same = (a: string, b: string): boolean => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()
    const rows: Row[] = []
    if (pasted) {
      const known = repos.find((r) => same(r.url, pasted))
      rows.push(known ? ofRepo(known) : { url: pasted, name: repoFullName(pasted), meta: C.pastedMeta })
      return { rows, note: '' }
    }
    const q = text.toLowerCase()
    const matches = repos.filter((r) => q === '' || r.fullName.toLowerCase().includes(q))
    if (q === '' && selected && !repos.some((r) => same(r.url, selected))) {
      rows.push({ url: selected, name: repoFullName(selected), meta: C.savedMeta })
    }
    for (const r of matches) {
      if (rows.length >= REPO_ROWS_SHOWN && q === '') break
      rows.push(ofRepo(r))
    }
    let note = ''
    if (load === 'loading' && rows.length === 0) note = C.loading
    else if (load === 'failed' && rows.length === 0) note = C.loadFailed
    else if (q !== '' && rows.length === 0) note = C.noMatch
    return { rows, note }
  }

  const renderList = (): void => {
    const { rows, note } = rowsFor()
    const nodes: Node[] = rows.map((r) => {
      const isSel = mode === 'one' && selected !== '' &&
        selected.replace(/\/+$/, '').toLowerCase() === r.url.replace(/\/+$/, '').toLowerCase()
      return button('sf-repo-row', [
        el('span', 'sf-repo-text', [
          el('span', 'sf-repo-name', [r.name]),
          el('span', 'sf-repo-meta', [r.meta]),
        ]),
        iconEl(isSel ? 'check' : 'chevron', 'sf-repo-mark'),
      ], () => {
        selected = r.url
        fromPaste = false
        mode = 'one'
        paintRadios()
        opts.onChange?.(mode, selected)
        renderList()
      }, { 'aria-pressed': String(isSel), 'data-url': r.url })
    })
    if (note) nodes.push(el('div', 'sf-repo-note', [note]))
    list.replaceChildren(...nodes)
    list.hidden = nodes.length === 0
  }

  const reload = (): void => {
    const token = opts.githubToken()
    const mine = ++generation
    const host = opts.githubHost ?? null
    if (!token && (!host || host.known() === false)) {
      repos = []
      load = 'idle'
      renderList()
      return
    }
    load = 'loading'
    renderList()
    const listed = host
      ? selectGitHub(host, token).then((chosen) => chosen ? opts.github.repos(chosen.auth) : null)
      : opts.github.repos(token)
    listed.then((found) => {
      if (destroyed || mine !== generation) return
      if (found === null) {
        // The host answered no GitHub and there is no token: nothing to list.
        repos = []
        load = 'idle'
        renderList()
        return
      }
      repos = Array.isArray(found) ? found : []
      load = 'loaded'
      renderList()
    }, () => {
      if (destroyed || mine !== generation) return
      repos = []
      load = 'failed'
      renderList()
    })
  }

  // A valid pasted (or typed) GitHub link chooses itself: it becomes the
  // selected repo and the mode turns to "One repo I choose", so Finish saves
  // it without another tap (spec behaviour 3).
  const adoptPasted = (): void => {
    const pasted = parseGithubUrl(input.value.trim())
    if (!pasted) {
      // The pasted link was edited away: its selection goes with it, so
      // Finish never saves a repo the screen no longer shows.
      if (fromPaste) {
        fromPaste = false
        selected = ''
        paintRadios()
        opts.onChange?.(mode, selected)
      }
      return
    }
    const known = repos.find((r) => r.url.replace(/\/+$/, '').toLowerCase() === pasted.replace(/\/+$/, '').toLowerCase())
    const url = known ? known.url : pasted
    if (mode === 'one' && selected === url) return
    selected = url
    fromPaste = true
    mode = 'one'
    paintRadios()
    opts.onChange?.(mode, selected)
  }
  const onTyped = (): void => {
    adoptPasted()
    renderList()
  }
  input.addEventListener('input', onTyped)
  input.addEventListener('paste', () => setTimeout(() => { if (!destroyed) onTyped() }, 0))

  paintRadios()
  reload()

  return {
    radios,
    search,
    input,
    mode: () => mode,
    url: () => selected,
    setMode: (m) => {
      mode = m
      paintRadios()
      renderList()
    },
    reload,
    destroy: () => {
      destroyed = true
      generation++
    },
  }
}
