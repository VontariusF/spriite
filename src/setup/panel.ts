/**
 * Phone-side setup (the Setup tab of the plugin page). Keys are typed here,
 * never on the glasses. Every key field is write-only: after saving, the
 * page shows a masked hint, not the key. "Save and test" proves each
 * account with one lightweight authenticated call:
 * - Factory (required): list Droid Computers; the builds run on one.
 * - ElevenLabs (voice): mint one realtime token.
 * - Cursor (optional worker): GET /v1/me, which names the key and account.
 * - GitHub (optional): GET /user. A paired host signed in to GitHub stands in
 *   for the token (docs/design/HOST-GITHUB-PLAN.md).
 *
 * Layout: a readiness checklist on top (required steps first), then one
 * collapsible card per step in the order a new user needs them. The first
 * unfinished required step starts open; finished steps start closed. Saves
 * hot-apply on the glasses through onSaved: no reload.
 */
import { mintToken, ScribeError } from '../voice/scribe'
import { cursorMe, cursorRepositories, CursorError } from '../factory/cursor'
import { factoryComputers, FactoryError } from '../factory/fapi'
import { githubCreateRepo, githubRepos, githubUser, GitHubError, selectGitHub, selectGitHubNow, type GitHubHostAccess } from '../factory/github'
import type { KeyVault } from '../voice/keys'
import { FLAG_LABELS } from '../state/flags'
import {
  AUTONOMY_LEVELS,
  INTERACTION_MODES,
  JOB_OPTIONS,
  REASONING_EFFORTS,
  WORKER_PREFS,
  type AutonomyLevel,
  type InteractionMode,
  type PrefsVault,
  type ReasoningEffort,
  type WorkerPref,
} from '../state/prefs'
import type { XConnection } from '../intake/connection'
import type { ArchiveClient } from '../state/archive'
import { mountXPanel, type XPanelOptions } from './x-panel'
import { mountArchivePanel } from './archive-panel'

const CSS = `
  .sp .ready h2 { margin-bottom: 4px; }
  .sp .steps { margin-top: 12px; }
  .sp .step-row .mark {
    flex: 0 0 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
    font-size: 13px; font-weight: 800; border: 1.5px solid var(--line-2); color: var(--faint);
  }
  .sp .step-row.done .mark { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .sp .step-row.done .t b { color: var(--muted); }
  .sp details.step { padding: 0; overflow: hidden; scroll-margin-top: 120px; }
  .sp details.step > summary {
    list-style: none; display: flex; align-items: center; gap: 12px; padding: 14px 16px; cursor: pointer;
  }
  .sp details.step > summary::-webkit-details-marker { display: none; }
  .sp details.step > summary .t { flex: 1; min-width: 0; }
  .sp details.step > summary .t b { display: block; font-size: 16px; }
  .sp details.step > summary .t span { display: block; font-size: 13px; color: var(--muted); margin-top: 1px; }
  .sp details.step > summary::after { content: '\\203A'; color: var(--faint); font-size: 20px; transition: transform 0.15s; }
  .sp details.step[open] > summary::after { transform: rotate(90deg); }
  .sp details.step .body {
    display: flex; flex-direction: column; gap: 12px; padding: 0 16px 16px; border-top: 1px solid var(--line);
    padding-top: 14px;
  }
  .sp details.step.flash { box-shadow: 0 0 0 2px var(--accent); }
  .sp .current {
    padding: 10px 12px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line-2);
    font-size: 14px; word-break: break-all;
  }
  .sp .current b { display: block; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--faint); margin-bottom: 2px; }
  .sp .sub { padding-top: 12px; border-top: 1px dashed var(--line-2); display: flex; flex-direction: column; gap: 10px; }
  .sp .foot { padding: 4px 4px 0; font-size: 13px; color: var(--faint); line-height: 1.5; }
`

type Tone = 'ok' | 'err' | 'muted'
type StepId = 'factory' | 'repo' | 'voice' | 'cursor' | 'github' | 'x' | 'archive' | 'prefs'
type SectionId = StepId | 'pr' | 'models' | 'runtime'
/** 'cards': the legacy one-page layout. 'sheets': each step is the body of a Settings sheet. */
export type PanelLayout = 'cards' | 'sheets'
/** What a Settings connection row says about an account, from the panel's own tests. */
export type AccountHealth = 'off' | 'saved' | 'ok' | 'failed' | 'no_computer'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  for (const c of children) node.append(c)
  return node
}

/** "https://github.com/owner/repo" -> "owner/repo" for labels. */
function repoLabel(url: string): string {
  const parts = url.replace(/\/+$/, '').split('/')
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : url
}

/** A setup link; opens in the phone's browser, never inside the panel. */
function link(label: string, href: string): HTMLAnchorElement {
  const a = el('a', { href, textContent: label })
  a.target = '_blank'
  a.rel = 'noreferrer noopener'
  return a
}

/**
 * A setup step: title, one-line role, and a status pill. The legacy layout
 * draws it as a collapsible card; the sheets layout (the phone's Settings,
 * docs/design/redesign/Settings.dc.html) draws the same parts as the head of
 * a bottom sheet, so a Settings row opens exactly this form.
 */
function step(id: SectionId, title: string, role: string, layout: PanelLayout = 'cards'): {
  root: HTMLElement & { open?: boolean }
  body: HTMLDivElement
  setPill: (text: string, tone: 'ok' | 'warn' | 'err' | '') => void
} {
  const pill = el('span', { className: 'pill' })
  const body = el('div', { className: 'body' })
  const setPill = (text: string, tone: 'ok' | 'warn' | 'err' | '') => {
    pill.textContent = text
    pill.className = `pill ${tone}`
  }
  if (layout === 'sheets') {
    body.className = 'body stack'
    const root = el('section', { className: 'ph-sheet-body stack', id: `sec-${id}` }, [
      el('div', { className: 'ph-sheet-head' }, [
        el('h2', { className: 'ph-sheet-title', textContent: title }),
        el('span', { className: 'ph-sheet-role', textContent: role }),
        pill,
      ]),
      body,
    ])
    return { root, body, setPill }
  }
  const root = el('details', { className: 'card step', id: `sec-${id}` }, [
    el('summary', {}, [
      el('div', { className: 't' }, [el('b', { textContent: title }), el('span', { textContent: role })]),
      pill,
    ]),
    body,
  ])
  return { root, body, setPill }
}

/** Key field + Save/Remove + result line, shared by every account step. */
function keyForm(placeholder: string): {
  input: HTMLInputElement
  save: HTMLButtonElement
  remove: HTMLButtonElement
  status: HTMLParagraphElement
  node: HTMLElement
} {
  const input = el('input', { type: 'password', placeholder, autocomplete: 'off', spellcheck: false })
  const save = el('button', { className: 'btn', textContent: 'Save and test' })
  const remove = el('button', { className: 'btn danger', textContent: 'Remove' })
  // The result of a save is announced, like the phone's own notes: a screen
  // reader must hear whether a key was stored or refused.
  const status = el('p', { className: 'msg muted', role: 'status' })
  return {
    input, save, remove, status,
    node: el('div', { className: 'stack' }, [input, el('div', { className: 'btns grow' }, [save, remove]), status]),
  }
}

export interface SetupHandle {
  /** Required steps (Factory, repository) still missing. */
  missingRequired(): number
  /** Refresh preference controls after an external voice command. */
  refreshPrefs(): void
  /**
   * Every step's root (`#sec-<id>`), for a host that places them itself (the
   * phone's Settings sheets). In the cards layout they are already mounted.
   */
  readonly sections: Readonly<Record<StepId, HTMLElement>>
  /**
   * The build preferences split the way Settings > How builds run draws them:
   * who builds and how many workers (`#sec-prefs`), pull requests, models and
   * session settings, and the durable runtime switch. Each is a step-shaped
   * section; in the cards layout they all sit inside the one prefs card.
   */
  readonly prefsParts: Readonly<{ workers: HTMLElement; pullRequests: HTMLElement; models: HTMLElement; runtime: HTMLElement }>
  /** What each account's last save-and-test proved (Settings connection health). */
  health(): Readonly<Record<'factory' | 'voice' | 'cursor' | 'github', AccountHealth>>
  /** Re-read the X step (a host sign-in finished elsewhere). */
  refreshX(): void
  /** A live check (Settings' health probe) proved this about a saved key. */
  noteLive(id: 'factory', result: 'ok' | 'failed' | 'no_computer'): void
}

export function mountSetupPanel(
  root: HTMLElement,
  keys: KeyVault,
  prefs: PrefsVault,
  opts: {
    onSaved?: () => void
    onReadiness?: (missingRequired: number) => void
    xConnection?: XConnection | null
    archive?: ArchiveClient | null
    /** 'sheets' builds each step as a Settings sheet body and mounts none of them. */
    layout?: PanelLayout
    /** Fired after every summary refresh (a save, a test, a state notification). */
    onChange?: () => void
    /** Host-run X sign-in (contract C7), passed through to the X step. */
    hostXSignIn?: XPanelOptions['hostXSignIn']
    /** The paired computer's name, for the X step's "Sign in on <host>". */
    hostLabel?: () => string | null
    /** Sheets layout: where the X and archive steps' runtime links go. */
    onOpenRuntime?: () => void
    /** The paired host's GitHub sign-in; selection prefers it over the token. */
    githubHost?: (GitHubHostAccess & { onChange?(listener: () => void): () => void }) | null
  } = {},
): SetupHandle {
  const layout: PanelLayout = opts.layout ?? 'cards'
  const style = el('style')
  style.textContent = CSS
  document.head.append(style)

  const show = (node: HTMLElement, text: string, t: Tone) => {
    node.textContent = text
    node.className = `msg ${t}`
  }
  // A saved account/preference hot-applies on the glasses: the app
  // reconfigures the engine in place (no reload, no re-scan). Silent during
  // the panel's own construction; live from the first user change on.
  let live = false
  const notify = () => {
    if (live) opts.onSaved?.()
  }
  // Last test result per account: a saved key that failed its test shows a
  // warning pill instead of "Connected".
  const failed: Partial<Record<StepId, boolean>> = {}
  // The last Factory test found no active Droid Computer: the key works, but
  // no build can run until one is online, so the step is not "Connected" and
  // setup is not "Ready to build" (a later test that finds one clears it).
  let noActiveComputer = false

  // -------------------------------------------------------------- steps

  // The sheets layout names each step the way its Settings row does.
  const sheets = layout === 'sheets'
  const factory = step('factory', 'Factory', sheets ? 'Account and Droid computer' : 'Plans, builds, and reviews your work.', layout)
  const repo = step('repo', 'Repository', 'Where the code changes land.', layout)
  const voice = step('voice', sheets ? 'Spoken replies' : 'Voice', sheets ? 'ElevenLabs' : 'Speak your goals on the glasses.', layout)
  const cursor = step('cursor', 'Cursor', sheets ? 'Extra workers' : 'Adds Cursor cloud agents as workers.', layout)
  const github = step('github', 'GitHub', sheets ? 'Can create and push repos' : 'Faster repository list and new repositories.', layout)
  const x = step('x', 'X requests', 'Owner-only mentions, with private receipts.', layout)
  const archive = step('archive', sheets ? 'Back up build history' : 'Archive mirror', sheets ? 'Encrypted, to your relay' : 'A copy of your records on your own VPS.', layout)
  const prefsStep = step('prefs', sheets ? 'Workers for big tasks' : 'Build preferences', sheets ? 'Who writes the code, and how many workers share a big task.' : 'Which workers build, and how pull requests open.', layout)
  const prStep = step('pr', 'Pull requests', 'When a finished build opens its pull request.', layout)
  const modelsStep = step('models', 'Models', 'The lead and worker sessions your next build starts with.', layout)
  const runtimeStep = step('runtime', 'Durable runtime', 'How Spriite keeps missions between launches.', layout)
  const steps: Record<StepId, ReturnType<typeof step>> = {
    factory, repo, voice, cursor, github, x, archive, prefs: prefsStep,
  }

  const open = (id: StepId, flash = false) => {
    const target = steps[id].root
    target.open = true
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (flash) {
      target.classList.add('flash')
      setTimeout(() => target.classList.remove('flash'), 1600)
    }
  }

  // The glasses' connect prompts land here: open, scroll, and flash the step.
  // In the sheets layout the phone shell owns the event (it opens the sheet).
  if (!sheets) window.addEventListener('spriite-connect', (ev) => {
    const detail = (ev as CustomEvent<string>).detail
    if (detail === 'factory' || detail === 'repo' || detail === 'github' || detail === 'voice') {
      open(detail, true)
    }
  })

  // ---------------------------------------------------------- readiness

  const readyTitle = el('h2')
  const readyText = el('p', { className: 'small muted' })
  const stepRows = el('div', { className: 'rows steps' })
  const readyCard = el('section', { className: 'card ready' }, [
    el('div', { className: 'eyebrow', textContent: 'Setup' }),
    readyTitle,
    readyText,
    stepRows,
  ])
  readyTitle.style.marginTop = '6px'

  const required = (): Array<{ id: StepId; done: boolean }> => [
    { id: 'factory', done: Boolean(keys.factory) && !noActiveComputer },
    { id: 'repo', done: Boolean(keys.repoUrl) },
  ]
  const missingRequired = () => required().filter((r) => !r.done).length
  const accountHealth = (id: 'factory' | 'voice' | 'cursor' | 'github', saved: boolean): AccountHealth =>
    !saved ? 'off'
      : failed[id] === true ? 'failed'
        : id === 'factory' && noActiveComputer ? 'no_computer'
          : failed[id] === false ? 'ok' : 'saved'

  const refreshSummary = (announce = true) => {
    const checklist: Array<{ id: StepId; label: string; note: string; done: boolean }> = [
      {
        id: 'factory', label: 'Connect Factory',
        note: keys.factory && noActiveComputer ? 'No active computer yet' : 'Required',
        done: Boolean(keys.factory) && !noActiveComputer,
      },
      { id: 'repo', label: 'Choose a repository', note: keys.repoUrl ? repoLabel(keys.repoUrl) : 'Required', done: Boolean(keys.repoUrl) },
      { id: 'voice', label: 'Turn on voice', note: 'Recommended', done: Boolean(keys.elevenLabsHint) },
      { id: 'cursor', label: 'Add Cursor', note: 'Optional', done: Boolean(keys.cursorHint) },
      { id: 'github', label: 'Add GitHub', note: 'Optional', done: Boolean(keys.githubHint) },
      { id: 'x', label: 'Connect X', note: 'Optional', done: Boolean(opts.xConnection?.active) },
    ]
    const missing = missingRequired()
    readyTitle.textContent = missing === 0 ? 'Ready to build' : missing === 1 ? '1 step left' : `${missing} steps left`
    readyText.textContent = missing === 0
      ? `Spriite builds on ${repoLabel(keys.repoUrl)}. Your keys stay on this phone.`
      : 'Finish the required steps to run real builds. Your keys stay on this phone.'
    stepRows.replaceChildren(
      ...checklist.map((c, i) => {
        const row = el('button', { className: `row step-row ${c.done ? 'done' : ''}` }, [
          el('span', { className: 'mark', textContent: c.done ? '\u2713' : String(i + 1) }),
          el('div', { className: 't' }, [el('b', { textContent: c.label }), el('span', { textContent: c.note })]),
          el('span', { className: 'chev', textContent: '\u203A' }),
        ])
        row.onclick = () => open(c.id)
        return row
      }),
    )
    const pill = (id: StepId, saved: boolean, need: 'Required' | 'Recommended' | 'Optional') => {
      if (saved && failed[id]) steps[id].setPill('Check key', 'warn')
      else if (saved && id === 'factory' && noActiveComputer) steps[id].setPill('Check computer', 'warn')
      // Connected only once a test proved it; a key never tested is Saved.
      else if (saved && failed[id] === false) steps[id].setPill('Connected', 'ok')
      else if (saved) steps[id].setPill('Saved', '')
      else steps[id].setPill(need, need === 'Required' ? 'err' : need === 'Recommended' ? 'warn' : '')
    }
    pill('factory', Boolean(keys.factory), 'Required')
    pill('voice', Boolean(keys.elevenLabsHint), 'Recommended')
    pill('cursor', Boolean(keys.cursorHint), 'Optional')
    pill('github', Boolean(keys.githubHint), 'Optional')
    repo.setPill(keys.repoUrl ? 'Chosen' : 'Required', keys.repoUrl ? 'ok' : 'err')
    // x readiness is live like the other steps: the pill names the next
    // blocker on the path (runtime relaunch, the requests switch) or rests
    // at Optional. A token counts as engagement; without one the step is
    // untouched, whatever the runtime flag says.
    const xh = opts.xConnection?.health()
    if (opts.xConnection?.active) x.setPill('Ready', 'ok')
    else if (xh && xh.state !== 'unbound') x.setPill('Turn on X requests', 'warn')
    else if (keys.xHint && (!prefs.flags.persistent_runtime_v2 || !opts.xConnection)) x.setPill('Needs relaunch', 'warn')
    else x.setPill('Optional', '')
    // The archive step carries its own state; the pill names its next
    // blocker the way the X step's does (flag, runtime relaunch, key).
    if (!prefs.flags.archive_mirror) archive.setPill('Optional', '')
    else if (!opts.archive) archive.setPill('Needs relaunch', 'warn')
    else if (!opts.archive.hasKey()) archive.setPill('Needs key', 'warn')
    else if ((opts.archive.state().failed ?? 0) > 0) archive.setPill('Retrying', 'warn')
    else archive.setPill('On', 'ok')
    opts.onReadiness?.(missing)
    opts.onChange?.()
    // every panel change hot-applies on the glasses; a state notification
    // from a sub-panel does not (see the subscriptions at the mount below)
    if (announce) notify()
  }

  // ----------------------------------------------------------- factory

  const fForm = keyForm('Paste your Factory API key')
  const refreshFactory = () => {
    const hint = keys.factoryHint
    show(fForm.status, hint ? `Key ${hint} is saved on this phone.` : '', 'muted')
    fForm.remove.hidden = !hint
  }
  fForm.save.onclick = async () => {
    const typed = fForm.input.value.trim()
    const key = typed || keys.factory
    if (!key) return show(fForm.status, 'Paste a key first.', 'err')
    if (typed) {
      if (!(await keys.setFactory(typed))) return show(fForm.status, 'The key could not be saved on this phone. Try again.', 'err')
      fForm.input.value = ''
    }
    fForm.save.disabled = true
    show(fForm.status, 'Testing with Factory...', 'muted')
    try {
      const computers = await factoryComputers(key)
      const active = computers.find((c) => c.status === 'active')
      failed.factory = false
      noActiveComputer = !active
      if (active) {
        // The key tested fine; the computer pick must also land in storage,
        // or the next build would not know where to run (spec §8: a failed
        // write is never reported as accepted).
        const saved = await keys.setComputerId(active.id)
        show(fForm.status, saved ? `Connected. Builds run on your computer "${active.name}".` : `Connected, but the computer choice could not be saved on this phone. Save it again.`, saved ? 'ok' : 'err')
      } else if (computers.length > 0) {
        // Only inactive computers: keep the saved pick (it may come back),
        // never silently point builds at a machine that cannot run them.
        const first = computers[0]
        show(fForm.status,
          `Connected, but your computer "${first.name}" is not active (${first.status}). It must be online to run builds.`,
          'err')
      } else {
        show(fForm.status, 'Connected, but this account has no Droid Computer yet. Open the Factory app or run droid on a computer, or add a cloud computer, so builds can run.', 'err')
      }
    } catch (e) {
      failed.factory = true
      // The key itself failed: its pill says so; no computer verdict stands.
      noActiveComputer = false
      const msg = e instanceof FactoryError
        ? (e.kind === 'auth' ? 'Saved, but Factory rejected this key. Check it and save again.'
          : e.kind === 'forbidden' ? 'Saved, but Factory sessions are not enabled on this account yet.'
            : e.kind === 'quota' ? 'Saved, but Factory hit a rate limit. Test again in a minute.'
              : e.kind === 'network' ? 'Saved, but Factory could not be reached. Test again once you are online.'
                : 'Saved, but the key could not be verified. Test again.')
        : 'Saved, but the key could not be verified. Test again.'
      show(fForm.status, msg, 'err')
    } finally {
      fForm.save.disabled = false
      fForm.remove.hidden = !keys.factory
      refreshSummary()
    }
  }
  fForm.remove.onclick = async () => {
    // A failed removal leaves the key saved: the refresh shows the truth,
    // and the status says why it is still there.
    if (!(await keys.clearFactory())) return show(fForm.status, 'The key could not be removed from this phone. Try again.', 'err')
    failed.factory = false
    noActiveComputer = false
    refreshFactory()
    refreshSummary()
  }
  factory.body.append(
    el('p', { className: 'small muted' }, [
      'Factory runs your builds in your own account: it plans the work, builds it on your computer, and reviews each step. ',
      'Create a key at ',
      link('app.factory.ai/settings/api-keys', 'https://app.factory.ai/settings/api-keys'),
      '.',
    ]),
    el('p', { className: 'small muted' }, [
      'Builds reach that computer through its Droid daemon, so keep it online: leave the Factory app open on it with Settings \u2192 Droid Computers \u2192 Remote Access on, or run "droid daemon --remote-access" in a terminal. ',
      'If builds fail with "could not reach the computer", that daemon is the thing to start.',
    ]),
    fForm.node,
  )

  // ------------------------------------------------------------- repo

  const repoCurrent = el('div', { className: 'current' })
  const repoStatus = el('p', { className: 'msg muted', role: 'status' })
  /**
   * The credential a standing repository error belongs to. A message about a
   * token is only true while that token is the one in hand: once it is
   * replaced or removed, keeping the line would claim a failure the current
   * account does not have.
   */
  let repoErr: { credential: 'github' | 'cursor'; value: string } | null = null
  const repoSelect = el('select')
  repoSelect.style.display = 'none'
  const repoLoad = el('button', { className: 'btn secondary', textContent: 'Choose from my repositories' })
  const repoCreateName = el('input', {
    type: 'text', placeholder: 'new-repository-name', autocomplete: 'off', spellcheck: false,
  })
  const repoCreatePrivate = el('input', { type: 'checkbox' })
  repoCreatePrivate.checked = true
  const repoCreatePrivateLabel = el('label', { className: 'check' }, [repoCreatePrivate, 'Private'])
  const repoCreate = el('button', { className: 'btn secondary', textContent: 'Create and use it' })
  const createBox = el('div', { className: 'sub' }, [
    el('div', { className: 'eyebrow', textContent: 'Or start a new repository' }),
    repoCreateName,
    repoCreatePrivateLabel,
    repoCreate,
  ])
  const githubHost = opts.githubHost ?? null
  /** The paired host provides GitHub, as last known (no network). */
  const githubViaHost = (): boolean => selectGitHubNow(githubHost, '')?.via === 'host'
  /** GitHub through the host or the token: selection, without waiting on a probe. */
  const githubOn = (): boolean => Boolean(keys.github) || githubViaHost()
  /** The selection for a call: the host is asked first only when there is one. */
  const githubFor = async () => githubHost ? selectGitHub(githubHost, keys.github) : selectGitHubNow(null, keys.github)
  const refreshRepo = () => {
    const canList = Boolean(githubOn() || keys.cursor)
    repoLoad.disabled = !canList
    createBox.style.display = githubOn() ? 'flex' : 'none'
    // The host creates private repositories only.
    repoCreatePrivateLabel.hidden = githubViaHost()
    repoCurrent.replaceChildren(
      el('b', { textContent: 'Current repository' }),
      keys.repoUrl ? repoLabel(keys.repoUrl) : 'None chosen yet',
    )
    // A standing error tied to a credential dies with it (a token that was
    // replaced or removed is not the one that failed); every other standing
    // error keeps its line until the next real attempt replaces it.
    const named = repoErr === null ? '' : repoErr.credential === 'github' ? keys.github : keys.cursor
    const stale = repoErr !== null && named !== repoErr.value
    if (stale) repoErr = null
    if (!canList) {
      show(repoStatus, 'To list your repositories, add a Cursor key or a GitHub token below.', 'muted')
    } else if (stale || !repoStatus.classList.contains('err')) {
      show(repoStatus, githubOn() ? '' : 'Add a GitHub token to create new repositories here.', 'muted')
    }
  }
  repoLoad.onclick = async () => {
    const chosen = githubHost ? await githubFor() : selectGitHubNow(null, keys.github)
    const gh = chosen?.auth ?? ''
    const cur = keys.cursor
    if (!gh && !cur) {
      repoErr = { credential: 'github', value: '' }
      return show(repoStatus, 'Add a Cursor key or a GitHub token first.', 'err')
    }
    repoLoad.disabled = true
    show(repoStatus, gh ? 'Loading your repositories from GitHub...' : 'Loading your repositories from Cursor...', 'muted')
    try {
      const repos = gh
        ? (await githubRepos(gh)).map((r) => ({ url: r.url, label: `${r.fullName}${r.private ? ' (private)' : ''}` }))
        : (await cursorRepositories(cur)).map((u) => ({ url: u, label: repoLabel(u) }))
      if (repos.length === 0) {
        show(repoStatus,
          gh ? 'This account has no repositories yet. Create one below.'
            : 'Cursor lists no repositories. Connect GitHub in your Cursor dashboard, or add a GitHub token here.',
          gh ? 'muted' : 'err')
        return
      }
      repoSelect.replaceChildren(
        el('option', { value: '', textContent: `Choose one of ${repos.length} repositories` }),
        ...repos.map((r) => el('option', { value: r.url, textContent: r.label })),
      )
      if (keys.repoUrl && repos.some((r) => r.url === keys.repoUrl)) repoSelect.value = keys.repoUrl
      repoSelect.style.display = 'block'
      repoErr = null
      show(repoStatus, '', 'muted')
    } catch (e) {
      const msg = e instanceof GitHubError
        ? (e.kind === 'auth' ? 'GitHub rejected the saved token. Save it again.'
          : e.kind === 'quota' ? 'GitHub hit a rate limit. Try again in a minute.'
            : e.kind === 'network' ? 'GitHub could not be reached. Check your connection.'
              : 'Your repositories could not be listed.')
        : e instanceof CursorError
          ? (e.kind === 'auth' ? 'Cursor rejected the saved key. Save it again.'
            : e.kind === 'quota' ? 'Cursor allows one repository list per minute. Wait a moment, or add a GitHub token for an instant list.'
              : e.kind === 'network' ? 'Cursor could not be reached. Check your connection.'
                : 'Your repositories could not be listed.')
          : 'Your repositories could not be listed.'
      repoErr = { credential: gh ? 'github' : 'cursor', value: gh ? keys.github : cur }
      show(repoStatus, chosen?.via === 'host' && e instanceof GitHubError && e.kind === 'auth'
        ? `${chosen.hostLabel ?? 'Your computer'} is not signed in to GitHub. Run gh auth login there, or add a GitHub token below.` : msg, 'err')
    } finally {
      repoLoad.disabled = !githubOn() && !keys.cursor
    }
  }
  repoSelect.onchange = async () => {
    const url = repoSelect.value
    if (!url) return refreshRepo()
    const saved = await keys.setRepoUrl(url)
    // A failed write must not read as a chosen repository (spec §8): the
    // select falls back to what is actually stored and the status says so.
    if (!saved) {
      repoSelect.value = keys.repoUrl || ''
      show(repoStatus, 'The repository could not be saved on this phone. Choose it again.', 'err')
    } else {
      show(repoStatus, `Builds will land in ${repoLabel(url)}.`, 'ok')
    }
    refreshRepo()
    refreshSummary()
  }
  repoCreate.onclick = async () => {
    const chosen = githubHost ? await githubFor() : selectGitHubNow(null, keys.github)
    const token = keys.github
    if (!chosen) {
      repoErr = { credential: 'github', value: '' }
      return show(repoStatus, 'Add a GitHub token below to create repositories.', 'err')
    }
    const name = repoCreateName.value.trim()
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
      // The name is wrong, not the token — but the message still belongs to
      // the token in hand: a later replacement is a different account, and
      // this line must not be read as its failure.
      repoErr = { credential: 'github', value: token }
      return show(repoStatus, 'Use only letters, digits, "-", "_", or "." in the name.', 'err')
    }
    repoCreate.disabled = true
    show(repoStatus, `Creating ${name} on GitHub...`, 'muted')
    try {
      const created = await githubCreateRepo(chosen.auth, name, chosen.via === 'host' || repoCreatePrivate.checked)
      const saved = await keys.setRepoUrl(created.url)
      repoCreateName.value = ''
      if (repoSelect.style.display !== 'none') {
        repoSelect.prepend(el('option', { value: created.url, textContent: `${created.fullName} (new)` }))
        repoSelect.value = created.url
      }
      // The repository exists on GitHub either way; only the choice of it is
      // in question, so the failure says exactly that (spec §8).
      repoErr = null
      show(
        repoStatus,
        saved ? `Created ${created.fullName}. Builds will land there.` : `Created ${created.fullName}, but it could not be saved as the build repository. Choose it again.`,
        saved ? 'ok' : 'err',
      )
    } catch (e) {
      const msg = e instanceof GitHubError
        ? (e.kind === 'auth' ? 'GitHub rejected the saved token. Save it again.'
          : e.kind === 'permission' ? 'This token cannot create repositories. It needs the "repo" scope (classic) or "Repository creation" (fine-grained).'
            : e.kind === 'exists' ? 'You already have a repository with that name. Try another.'
              : e.kind === 'quota' ? 'GitHub hit a rate limit. Try again in a minute.'
                : e.kind === 'network' ? 'GitHub could not be reached. Check your connection.'
                  : 'The repository could not be created.')
        : 'The repository could not be created.'
      repoErr = { credential: 'github', value: token }
      show(repoStatus, chosen.via === 'host' && e instanceof GitHubError && e.kind === 'auth'
        ? `${chosen.hostLabel ?? 'Your computer'} is not signed in to GitHub. Run gh auth login there, or add a GitHub token below.` : msg, 'err')
    } finally {
      repoCreate.disabled = false
      refreshRepo()
      refreshSummary()
    }
  }
  repo.body.append(
    el('p', { className: 'small muted', textContent: 'Spriite\u2019s workers clone this repository, push their changes to it, and open the pull request there.' }),
    repoCurrent,
    repoLoad,
    repoSelect,
    repoStatus,
    createBox,
  )

  // ------------------------------------------------------------ voice

  const vForm = keyForm('Paste your ElevenLabs API key')
  const refreshVoice = () => {
    const hint = keys.elevenLabsHint
    show(vForm.status, hint ? `Key ${hint} is saved on this phone.` : 'Without a key, Talk cannot hear your goals. Add one to speak them.', 'muted')
    vForm.remove.hidden = !hint
  }
  vForm.save.onclick = async () => {
    const typed = vForm.input.value.trim()
    const key = typed || keys.elevenLabs
    if (!key) return show(vForm.status, 'Paste a key first.', 'err')
    if (typed) {
      // Save first, then test: a failed test never loses the key.
      if (!(await keys.setElevenLabs(typed))) return show(vForm.status, 'The key could not be saved on this phone. Try again.', 'err')
      vForm.input.value = ''
    }
    vForm.save.disabled = true
    show(vForm.status, 'Testing with ElevenLabs...', 'muted')
    try {
      await mintToken(key)
      failed.voice = false
      show(vForm.status, 'Connected. Tap Talk on your glasses to speak a goal.', 'ok')
    } catch (e) {
      failed.voice = true
      const msg = e instanceof ScribeError
        ? (e.kind === 'auth' ? 'Saved, but ElevenLabs rejected this key. Check it and save again.'
          : e.kind === 'quota' ? 'Saved, but ElevenLabs hit a usage or rate limit. Try again later.'
            : e.kind === 'network' ? 'Saved, but ElevenLabs could not be reached. Test again once you are online.'
              : 'Saved, but the key could not be verified. Test again.')
        : 'Saved, but the key could not be verified. Test again.'
      show(vForm.status, msg, 'err')
    } finally {
      vForm.save.disabled = false
      vForm.remove.hidden = !keys.elevenLabs
      refreshSummary()
    }
  }
  vForm.remove.onclick = async () => {
    if (!(await keys.clearElevenLabs())) return show(vForm.status, 'The key could not be removed from this phone. Try again.', 'err')
    failed.voice = false
    refreshVoice()
    refreshSummary()
  }
  voice.body.append(
    el('p', { className: 'small muted' }, [
      'Talk streams your voice straight to ElevenLabs for transcription, and spoken replies are read aloud by ElevenLabs. Create a key at ',
      link('elevenlabs.io/app/settings/api-keys', 'https://elevenlabs.io/app/settings/api-keys'),
      ' with speech-to-text and text-to-speech access, and a spending cap.',
    ]),
    vForm.node,
  )

  // ----------------------------------------------------------- cursor

  const cForm = keyForm('Paste your Cursor user API key')
  const refreshCursor = () => {
    const hint = keys.cursorHint
    show(cForm.status, hint ? `Key ${hint} is saved on this phone.` : '', 'muted')
    cForm.remove.hidden = !hint
  }
  cForm.save.onclick = async () => {
    const typed = cForm.input.value.trim()
    const key = typed || keys.cursor
    if (!key) return show(cForm.status, 'Paste a key first.', 'err')
    if (typed) {
      if (!(await keys.setCursor(typed))) return show(cForm.status, 'The key could not be saved on this phone. Try again.', 'err')
      cForm.input.value = ''
    }
    cForm.save.disabled = true
    show(cForm.status, 'Testing with Cursor...', 'muted')
    try {
      const me = await cursorMe(key)
      failed.cursor = false
      show(cForm.status, `Connected as ${me.email || me.apiKeyName || 'your Cursor account'}.`, 'ok')
    } catch (e) {
      failed.cursor = true
      const msg = e instanceof CursorError
        ? (e.kind === 'auth' ? 'Saved, but Cursor rejected this key. Check it and save again.'
          : e.kind === 'quota' ? 'Saved, but Cursor hit a rate limit. Test again in a minute.'
            : e.kind === 'network' ? 'Saved, but Cursor could not be reached. Test again once you are online.'
              : 'Saved, but the key could not be verified. Test again.')
        : 'Saved, but the key could not be verified. Test again.'
      show(cForm.status, msg, 'err')
    } finally {
      cForm.save.disabled = false
      cForm.remove.hidden = !keys.cursor
      refreshRepo()
      refreshPrefs() // worker options depend on the Cursor key
      refreshSummary()
    }
  }
  cForm.remove.onclick = async () => {
    if (!(await keys.clearCursor())) return show(cForm.status, 'The key could not be removed from this phone. Try again.', 'err')
    failed.cursor = false
    refreshCursor()
    refreshRepo()
    refreshPrefs()
    refreshSummary()
  }
  cursor.body.append(
    el('p', { className: 'small muted' }, [
      'Cursor cloud agents build in Cursor\u2019s cloud, alongside Factory. They push through Cursor\u2019s GitHub connection, so connect GitHub once at ',
      link('cursor.com/dashboard/integrations', 'https://cursor.com/dashboard/integrations'),
      '. Create a user API key at ',
      link('cursor.com/dashboard/api', 'https://cursor.com/dashboard/api'),
      '.',
    ]),
    cForm.node,
  )

  // ----------------------------------------------------------- github

  const gForm = keyForm('Paste a GitHub token')
  const refreshGithub = () => {
    const hint = keys.githubHint
    const through = githubViaHost() ? selectGitHubNow(githubHost, '')?.hostLabel ?? null : null
    show(gForm.status, through
      ? `Through ${through}: it uses its own GitHub sign-in, so this phone needs no token.${hint ? ` Token ${hint} stays saved as the fallback.` : ''}`
      : hint ? `Token ${hint} is saved on this phone.` : '', 'muted')
    gForm.remove.hidden = !hint
    refreshRepo()
  }
  gForm.save.onclick = async () => {
    const typed = gForm.input.value.trim()
    const token = typed || keys.github
    if (!token) return show(gForm.status, 'Paste a token first.', 'err')
    if (typed) {
      if (!(await keys.setGithub(typed))) return show(gForm.status, 'The token could not be saved on this phone. Try again.', 'err')
      gForm.input.value = ''
    }
    gForm.save.disabled = true
    show(gForm.status, 'Testing with GitHub...', 'muted')
    try {
      const user = await githubUser(token)
      failed.github = false
      show(gForm.status, `Connected as ${user.login}. You can now create repositories in the Repository step.`, 'ok')
    } catch (e) {
      failed.github = true
      const msg = e instanceof GitHubError
        ? (e.kind === 'auth' ? 'Saved, but GitHub rejected this token. Check it and save again.'
          : e.kind === 'permission' ? 'Saved, but this token is missing permissions. It needs the "repo" scope (classic) or "Repository creation" (fine-grained).'
            : e.kind === 'quota' ? 'Saved, but GitHub hit a rate limit. Try again in a minute.'
              : e.kind === 'network' ? 'Saved, but GitHub could not be reached. Test again once you are online.'
                : 'Saved, but the token could not be verified. Test again.')
        : 'Saved, but the token could not be verified. Test again.'
      show(gForm.status, msg, 'err')
    } finally {
      gForm.save.disabled = false
      gForm.remove.hidden = !keys.github
      refreshRepo()
      refreshSummary()
    }
  }
  gForm.remove.onclick = async () => {
    if (!(await keys.clearGithub())) return show(gForm.status, 'The token could not be removed from this phone. Try again.', 'err')
    failed.github = false
    refreshGithub()
    refreshSummary()
  }
  github.body.append(
    el('p', { className: 'small muted' }, [
      'Not needed to build. A token gives an instant repository list and lets you create repositories here. Create one at ',
      link('github.com/settings/tokens', 'https://github.com/settings/tokens'),
      ' with the "repo" scope (classic) or "Repository creation" (fine-grained).',
    ]),
    gForm.node,
  )

  // ------------------------------------------------------ preferences

  const prefsStatus = el('p', { className: 'msg muted', role: 'status', id: 'pref-status' })
  // The sheets layout shows the same outcome line under each preferences sheet.
  const prefsStatusCopies = [0, 1, 2].map(() => el('p', { className: 'msg muted', role: 'status' }))
  const showPrefs = (text: string, t: Tone) => {
    show(prefsStatus, text, t)
    for (const copy of prefsStatusCopies) show(copy, text, t)
  }
  const workerSelect = el('select')
  const jobsSelect = el('select')
  const prSelect = el('select')
  const workerHelp = el('p', { className: 'small muted' })
  // Session defaults, split the way a build actually runs: the LEAD session
  // (the orchestrator the glasses talk to) and the WORKER sessions that write
  // the code. Frozen per build — the API's update schema cannot carry the
  // extra instructions or the tool policy, and Factory never reports settings
  // back — so a save here reaches the next build, never a running one.
  const modeSelect = el('select', { id: 'pref-mode' })
  const specModelInput = el('input', {
    id: 'pref-spec-model', type: 'text', placeholder: 'Account default', autocomplete: 'off', spellcheck: false,
  })
  const specEffortSelect = el('select', { id: 'pref-spec-effort' })
  const specFields = el('div', { className: 'sub' })
  const leadModelInput = el('input', {
    id: 'pref-lead-model', type: 'text', placeholder: 'Account default', autocomplete: 'off', spellcheck: false,
  })
  const leadEffortSelect = el('select', { id: 'pref-lead-effort' })
  const autonomySelect = el('select', { id: 'pref-autonomy' })
  const workerModelInput = el('input', {
    id: 'pref-worker-model', type: 'text', placeholder: 'Account default', autocomplete: 'off', spellcheck: false,
  })
  const workerEffortSelect = el('select', { id: 'pref-worker-effort' })
  const instructionsInput = el('textarea', {
    id: 'pref-worker-instructions', rows: 3,
    placeholder: 'Optional. Added to the worker\'s own instructions, never replacing them.',
  })
  const enabledToolsInput = el('input', {
    id: 'pref-worker-enabled-tools', type: 'text', placeholder: 'Read, ApplyPatch', autocomplete: 'off', spellcheck: false,
  })
  const disabledToolsInput = el('input', {
    id: 'pref-worker-disabled-tools', type: 'text', placeholder: 'Execute', autocomplete: 'off', spellcheck: false,
  })
  const restrictToolsInput = el('input', {
    id: 'pref-worker-restrict-tools', type: 'text', placeholder: 'Only these, if set', autocomplete: 'off', spellcheck: false,
  })
  /** '' means Factory's account default; the rest are Factory's own values. */
  const effortOptions = (current: '' | ReasoningEffort) => [
    el('option', { value: '', textContent: 'Account default', ...(current ? {} : { selected: true }) }),
    ...REASONING_EFFORTS.map((r) =>
      el('option', { value: r, textContent: r[0].toUpperCase() + r.slice(1), ...(current === r ? { selected: true } : {}) }),
    ),
  ]
  specFields.append(
    el('label', { className: 'field' }, ['Plan model', specModelInput]),
    el('label', { className: 'field' }, ['Plan reasoning effort', specEffortSelect]),
  )
  // The durable runtime (spec §26). Flags are read once at boot: switching the
  // engine under a live mission would leave two orchestrators claiming the same
  // provider work, so this is the one preference that waits for the next launch.
  const runtimeToggle = el('input', { type: 'checkbox' })
  const refreshPrefs = (applySaved = true) => {
    const hasCursor = Boolean(keys.cursor)
    runtimeToggle.checked = prefs.flags.persistent_runtime_v2
    workerSelect.replaceChildren(
      ...WORKER_PREFS.map((w) =>
        el('option', { value: w.id, textContent: w.label, ...(w.id === prefs.worker ? { selected: true } : {}) }),
      ),
    )
    for (const opt of Array.from(workerSelect.options)) {
      const id = opt.value as WorkerPref
      opt.disabled = !hasCursor && (id === 'cursor' || id === 'mix')
      if (opt.disabled && prefs.worker === id) workerSelect.value = 'auto'
    }
    workerHelp.textContent = hasCursor
      ? 'Factory always leads and reviews. This picks who writes the code.'
      : 'Factory always leads and reviews. Add Cursor to choose Cursor agents as workers.'
    jobsSelect.replaceChildren(
      ...JOB_OPTIONS.map((n) =>
        el('option', {
          value: String(n),
          textContent: n === 1 ? 'One worker at a time' : `Split across ${n} workers`,
          ...(n === prefs.jobs ? { selected: true } : {}),
        }),
      ),
    )
    prSelect.replaceChildren(
      el('option', {
        value: 'auto', textContent: 'Open automatically after review',
        ...(prefs.askBeforePr ? {} : { selected: true }),
      }),
      el('option', {
        value: 'ask', textContent: 'Ask me first',
        ...(prefs.askBeforePr ? { selected: true } : {}),
      }),
    )
    modeSelect.replaceChildren(
      el('option', {
        value: '', textContent: 'Account default',
        ...(prefs.interactionMode ? {} : { selected: true }),
      }),
      ...INTERACTION_MODES.map((m) =>
        el('option', {
          value: m,
          textContent: m === 'auto' ? 'Normal (auto)' : 'Plan first (spec)',
          ...(prefs.interactionMode === m ? { selected: true } : {}),
        }),
      ),
    )
    if (document.activeElement !== leadModelInput) leadModelInput.value = prefs.leadModel
    if (document.activeElement !== workerModelInput) workerModelInput.value = prefs.workerModel
    if (document.activeElement !== specModelInput) specModelInput.value = prefs.specModel
    if (document.activeElement !== instructionsInput) instructionsInput.value = prefs.workerInstructions
    if (document.activeElement !== enabledToolsInput) enabledToolsInput.value = prefs.workerEnabledTools.join(', ')
    if (document.activeElement !== disabledToolsInput) disabledToolsInput.value = prefs.workerDisabledTools.join(', ')
    if (document.activeElement !== restrictToolsInput) restrictToolsInput.value = prefs.workerRestrictTools.join(', ')
    leadEffortSelect.replaceChildren(...effortOptions(prefs.leadReasoningEffort))
    workerEffortSelect.replaceChildren(...effortOptions(prefs.workerReasoningEffort))
    specEffortSelect.replaceChildren(...effortOptions(prefs.specReasoningEffort))
    // Spec-mode settings are inert in any other mode: showing them would
    // offer a choice the build would not use.
    specFields.hidden = prefs.interactionMode !== 'spec'
    autonomySelect.replaceChildren(
      el('option', {
        value: '', textContent: 'Account default',
        ...(prefs.autonomyLevel ? {} : { selected: true }),
      }),
      ...AUTONOMY_LEVELS.map((a) =>
        el('option', {
          value: a,
          textContent: a === 'off' ? 'Ask every step (off)' : a === 'high' ? 'Full (high)' : a[0].toUpperCase() + a.slice(1),
          ...(prefs.autonomyLevel === a ? { selected: true } : {}),
        }),
      ),
    )
    // The pill names who will actually build. The engine's own fallback
    // (src/factory/real.ts jobModes) runs every worker on Factory sessions
    // when no Cursor key is stored, so a saved Cursor choice is not the
    // worker this phone will use — the stored value stays (it returns when
    // the key does), the summary says the truth.
    const workerId = prefs.worker
    const effectiveWorker: WorkerPref =
      !hasCursor && (workerId === 'cursor' || workerId === 'mix') ? 'factory' : workerId
    const workerLabel = WORKER_PREFS.find((w) => w.id === effectiveWorker)?.label ?? 'Auto'
    prefsStep.setPill(workerLabel, '')
    if (applySaved) notify()
    // a flag change gates the X step, and with no live connection there is
    // nothing on the X side that would hear about it on its own.
    refreshX()
    // the same flag write gates the Archive step's state line and controls.
    refreshArchive()
  }
  const savedPrefs = (ok: boolean) => {
    if (ok) {
      refreshPrefs()
      showPrefs( 'Saved. Changes apply on your glasses right away.', 'ok')
    } else {
      showPrefs( 'The change could not be saved on this phone. Try again.', 'err')
    }
  }
  workerSelect.onchange = async () => {
    const value = workerSelect.value as WorkerPref
    if ((value === 'cursor' || value === 'mix') && !keys.cursor) {
      refreshPrefs() // no Cursor key: the option stays out of reach
      return
    }
    savedPrefs(await prefs.setWorker(value))
  }
  jobsSelect.onchange = async () => savedPrefs(await prefs.setJobs(Number(jobsSelect.value) || 1))
  prSelect.onchange = async () => savedPrefs(await prefs.setAskBeforePr(prSelect.value === 'ask'))
  // Session settings commit on blur/enter ("change"), not per keystroke: a
  // half-typed model id or tool list must never be what a build freezes.
  // They are reported with their own line, because unlike a worker choice
  // they do NOT reach a build that is already running.
  const savedSettings = (ok: boolean) => {
    if (ok) {
      refreshPrefs()
      showPrefs( 'Saved. Your next build uses these settings.', 'ok')
    } else {
      showPrefs( 'The change could not be saved on this phone. Try again.', 'err')
    }
  }
  modeSelect.onchange = async () =>
    savedSettings(await prefs.setInteractionMode(modeSelect.value as InteractionMode | ''))
  specModelInput.onchange = async () => savedSettings(await prefs.setSpecModel(specModelInput.value))
  specEffortSelect.onchange = async () =>
    savedSettings(await prefs.setSpecReasoningEffort(specEffortSelect.value as ReasoningEffort | ''))
  leadModelInput.onchange = async () => savedSettings(await prefs.setLeadModel(leadModelInput.value))
  leadEffortSelect.onchange = async () =>
    savedSettings(await prefs.setLeadReasoningEffort(leadEffortSelect.value as ReasoningEffort | ''))
  workerModelInput.onchange = async () => savedSettings(await prefs.setWorkerModel(workerModelInput.value))
  workerEffortSelect.onchange = async () =>
    savedSettings(await prefs.setWorkerReasoningEffort(workerEffortSelect.value as ReasoningEffort | ''))
  instructionsInput.onchange = async () => savedSettings(await prefs.setWorkerInstructions(instructionsInput.value))
  enabledToolsInput.onchange = async () =>
    savedSettings(await prefs.setWorkerEnabledTools(enabledToolsInput.value))
  disabledToolsInput.onchange = async () =>
    savedSettings(await prefs.setWorkerDisabledTools(disabledToolsInput.value))
  restrictToolsInput.onchange = async () =>
    savedSettings(await prefs.setWorkerRestrictTools(restrictToolsInput.value))
  autonomySelect.onchange = async () =>
    savedSettings(await prefs.setAutonomy(autonomySelect.value as AutonomyLevel | ''))
  runtimeToggle.onchange = async () => {
    const ok = await prefs.setFlag('persistent_runtime_v2', runtimeToggle.checked)
    refreshPrefs()
    showPrefs(
      ok
        ? 'Saved. The next time Spriite launches, it uses the settings you just chose.'
        : 'The change could not be saved on this phone. Try again.',
      ok ? 'ok' : 'err',
    )
  }
  // The four parts the Settings sheets show one at a time; in the cards
  // layout they stack inside the one Build preferences card, as before.
  const workerPart = [
    el('label', { className: 'field' }, ['Who builds', workerSelect]),
    workerHelp,
    el('label', { className: 'field' }, ['Large tasks', jobsSelect]),
  ]
  const prPart = [el('label', { className: 'field' }, ['Pull requests', prSelect])]
  const modelsPart = [
    el('div', { className: 'sub' }, [
      el('p', { className: 'small muted', id: 'pref-scope' }, [
        'A build freezes its settings the moment it starts, so a change here applies to your next build. ' +
          'Clearing a value uses your account default.',
      ]),
      el('label', { className: 'field' }, ['How it works', modeSelect]),
      specFields,
      el('label', { className: 'field' }, ['Lead model', leadModelInput]),
      el('label', { className: 'field' }, ['Lead reasoning effort', leadEffortSelect]),
      el('label', { className: 'field' }, ['Autonomy', autonomySelect]),
      el('p', { className: 'small muted' }, [
        'Approved Factory workers run in Auto. Your chosen autonomy applies to the lead and workers. Tool approvals may still need Factory.',
      ]),
      el('p', { className: 'small muted' }, [
        'The lead session plans, reviews, and answers the glasses. It keeps Factory\'s own instructions, so the cards you already read stay the same.',
      ]),
    ]),
    el('div', { className: 'sub' }, [
      el('p', { className: 'small muted' }, [
        'Workers write the code. Each worker gets these settings when it starts.',
      ]),
      el('label', { className: 'field' }, ['Worker model', workerModelInput]),
      el('label', { className: 'field' }, ['Worker reasoning effort', workerEffortSelect]),
      el('label', { className: 'field' }, ['Extra instructions', instructionsInput]),
      el('p', { className: 'small muted' }, [
        'Added to the worker\'s own instructions, never replacing them. Keep it short: it travels with every worker.',
      ]),
      el('label', { className: 'field' }, ['Tools to enable', enabledToolsInput]),
      el('label', { className: 'field' }, ['Tools to disable', disabledToolsInput]),
      el('label', { className: 'field' }, ['Restrict to these tools', restrictToolsInput]),
      el('p', { className: 'small muted' }, [
        'Tool ids, separated by commas. Empty means Factory decides. Factory publishes no list of ids, so these are typed by hand.',
      ]),
    ]),
  ]
  const runtimePart = [
    el('div', { className: 'sub' }, [
      el('label', { className: 'check' }, [runtimeToggle, `${FLAG_LABELS.persistent_runtime_v2.title} (beta)`]),
      el('p', { className: 'small muted' }, [FLAG_LABELS.persistent_runtime_v2.note]),
      el('p', { className: 'small muted' }, [
        'Off by default, and it changes how Spriite starts rather than how it looks. ' +
          'Let a running mission finish before turning it off: Spriite can keep records of a ' +
          'mission that the older engine is not able to pick up.',
      ]),
    ]),
  ]
  if (sheets) {
    prefsStep.body.append(...workerPart, prefsStatus)
    prStep.body.append(...prPart, prefsStatusCopies[0])
    modelsStep.body.append(...modelsPart, prefsStatusCopies[1])
    runtimeStep.body.append(...runtimePart, prefsStatusCopies[2])
  } else {
    prefsStep.body.append(...workerPart, ...prPart, ...modelsPart, ...runtimePart, prefsStatus)
  }

  // -------------------------------------------------------------- mount

  const refreshX = mountXPanel(x.body, {
    connection: opts.xConnection ?? null,
    keys, prefs,
    hostXSignIn: opts.hostXSignIn,
    hostLabel: opts.hostLabel,
    githubHost: opts.githubHost ?? null,
    // an X save or flag write is also a preference change: keep the prefs
    // controls, the readiness checklist, and the glasses in step with it.
    onSaved: () => { refreshPrefs(); refreshSummary() },
    // the X step's runtime link lands on the toggle itself, not the card title.
    onOpenRuntimePrefs: () => {
      if (sheets) opts.onOpenRuntime?.()
      else open('prefs', true)
      runtimeToggle.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
  })

  const refreshArchive = mountArchivePanel(archive.body, {
    client: opts.archive ?? null,
    prefs,
    // an archive save or flag write is a preference change too: the
    // checklist pill and the prefs controls follow it.
    onSaved: () => { refreshPrefs(); refreshSummary() },
    onOpenRuntimePrefs: () => {
      if (sheets) opts.onOpenRuntime?.()
      else open('prefs', true)
      runtimeToggle.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
  })

  // The X and archive pills read state that moves on its own: a check, a
  // sync failure, a key minted while the step was closed. Both sub-panels
  // already subscribe; the summary listens to the same notifications, or the
  // checklist rests on a step's old truth until the owner taps something.
  // Silent on purpose: a notification is not an owner save, and the engines
  // must not reconfigure on every check.
  opts.xConnection?.subscribe(() => refreshSummary(false))
  opts.archive?.subscribe(() => refreshSummary(false))

  if (!sheets) root.replaceChildren(
    readyCard,
    factory.root,
    repo.root,
    voice.root,
    cursor.root,
    github.root,
    x.root,
    archive.root,
    prefsStep.root,
    el('p', {
      className: 'foot',
      textContent:
        'On the glasses, tap Talk to speak, or say "Hey Spriite, pause" while it listens. ' +
        'Builds use your Factory and Cursor credits.',
    }),
  )
  refreshFactory()
  refreshVoice()
  refreshCursor()
  refreshGithub()
  refreshRepo()
  refreshPrefs()
  refreshSummary()
  // The host's GitHub answer arrives later: the GitHub and Repo steps follow it.
  githubHost?.onChange?.(() => { refreshGithub(); refreshSummary() })
  // Start with the first unfinished required step open.
  const firstMissing = required().find((r) => !r.done)
  if (firstMissing && !sheets) steps[firstMissing.id].root.open = true
  live = true // construction done; changes hot-apply from here on
  return {
    missingRequired,
    refreshPrefs: () => refreshPrefs(false),
    sections: Object.fromEntries(Object.entries(steps).map(([id, st]) => [id, st.root])) as Record<StepId, HTMLElement>,
    prefsParts: { workers: prefsStep.root, pullRequests: prStep.root, models: modelsStep.root, runtime: runtimeStep.root },
    health: () => ({
      factory: accountHealth('factory', Boolean(keys.factory)),
      voice: accountHealth('voice', Boolean(keys.elevenLabsHint)),
      cursor: accountHealth('cursor', Boolean(keys.cursorHint)),
      github: accountHealth('github', Boolean(keys.githubHint)),
    }),
    refreshX: () => refreshX(),
    noteLive: (id, result) => {
      failed[id] = result === 'failed'
      if (id === 'factory') noActiveComputer = result === 'no_computer'
      refreshSummary(false)
    },
  }
}
