/**
 * Phone-side setup (the Setup tab of the plugin page). Keys are typed here,
 * never on the glasses. Every key field is write-only: after saving, the
 * page shows a masked hint, not the key. "Save and test" proves each
 * account with one lightweight authenticated call:
 * - Factory (required): list Droid Computers; the builds run on one.
 * - ElevenLabs (voice): mint one realtime token.
 * - Cursor (optional worker): GET /v1/me, which names the key and account.
 * - GitHub (optional): GET /user.
 *
 * Layout: a readiness checklist on top (required steps first), then one
 * collapsible card per step in the order a new user needs them. The first
 * unfinished required step starts open; finished steps start closed. Saves
 * hot-apply on the glasses through onSaved: no reload.
 */
import { mintToken, ScribeError } from '../voice/scribe'
import { cursorMe, cursorRepositories, CursorError } from '../factory/cursor'
import { factoryComputers, FactoryError } from '../factory/fapi'
import { githubCreateRepo, githubRepos, githubUser, GitHubError } from '../factory/github'
import type { KeyVault } from '../voice/keys'
import { JOB_OPTIONS, WORKER_PREFS, type PrefsVault, type WorkerPref } from '../state/prefs'

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
type StepId = 'factory' | 'repo' | 'voice' | 'cursor' | 'github' | 'prefs'

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

/** A collapsible setup step: title, one-line role, and a status pill. */
function step(id: StepId, title: string, role: string): {
  root: HTMLDetailsElement
  body: HTMLDivElement
  setPill: (text: string, tone: 'ok' | 'warn' | 'err' | '') => void
} {
  const pill = el('span', { className: 'pill' })
  const body = el('div', { className: 'body' })
  const root = el('details', { className: 'card step', id: `sec-${id}` }, [
    el('summary', {}, [
      el('div', { className: 't' }, [el('b', { textContent: title }), el('span', { textContent: role })]),
      pill,
    ]),
    body,
  ])
  return {
    root,
    body,
    setPill: (text, tone) => {
      pill.textContent = text
      pill.className = `pill ${tone}`
    },
  }
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
  const status = el('p', { className: 'msg muted' })
  return {
    input, save, remove, status,
    node: el('div', { className: 'stack' }, [input, el('div', { className: 'btns grow' }, [save, remove]), status]),
  }
}

export interface SetupHandle {
  /** Required steps (Factory, repository) still missing. */
  missingRequired(): number
}

export function mountSetupPanel(
  root: HTMLElement,
  keys: KeyVault,
  prefs: PrefsVault,
  opts: { onSaved?: () => void; onReadiness?: (missingRequired: number) => void } = {},
): SetupHandle {
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

  // -------------------------------------------------------------- steps

  const factory = step('factory', 'Factory', 'Plans, builds, and reviews your work.')
  const repo = step('repo', 'Repository', 'Where the code changes land.')
  const voice = step('voice', 'Voice', 'Speak your goals on the glasses.')
  const cursor = step('cursor', 'Cursor', 'Adds Cursor cloud agents as workers.')
  const github = step('github', 'GitHub', 'Faster repository list and new repositories.')
  const prefsStep = step('prefs', 'Build preferences', 'Which workers build, and how pull requests open.')
  const steps: Record<StepId, ReturnType<typeof step>> = {
    factory, repo, voice, cursor, github, prefs: prefsStep,
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
  window.addEventListener('spriite-connect', (ev) => {
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
    { id: 'factory', done: Boolean(keys.factory) },
    { id: 'repo', done: Boolean(keys.repoUrl) },
  ]
  const missingRequired = () => required().filter((r) => !r.done).length

  const refreshSummary = () => {
    const checklist: Array<{ id: StepId; label: string; note: string; done: boolean }> = [
      { id: 'factory', label: 'Connect Factory', note: 'Required', done: Boolean(keys.factory) },
      { id: 'repo', label: 'Choose a repository', note: keys.repoUrl ? repoLabel(keys.repoUrl) : 'Required', done: Boolean(keys.repoUrl) },
      { id: 'voice', label: 'Turn on voice', note: 'Recommended', done: Boolean(keys.elevenLabsHint) },
      { id: 'cursor', label: 'Add Cursor', note: 'Optional', done: Boolean(keys.cursorHint) },
      { id: 'github', label: 'Add GitHub', note: 'Optional', done: Boolean(keys.githubHint) },
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
      else if (saved) steps[id].setPill('Connected', 'ok')
      else steps[id].setPill(need, need === 'Required' ? 'err' : need === 'Recommended' ? 'warn' : '')
    }
    pill('factory', Boolean(keys.factory), 'Required')
    pill('voice', Boolean(keys.elevenLabsHint), 'Recommended')
    pill('cursor', Boolean(keys.cursorHint), 'Optional')
    pill('github', Boolean(keys.githubHint), 'Optional')
    repo.setPill(keys.repoUrl ? 'Chosen' : 'Required', keys.repoUrl ? 'ok' : 'err')
    opts.onReadiness?.(missing)
    notify() // every panel change hot-applies on the glasses
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
      if (active) {
        await keys.setComputerId(active.id)
        show(fForm.status, `Connected. Builds run on your computer "${active.name}".`, 'ok')
      } else if (computers.length > 0) {
        // Only inactive computers: keep the saved pick (it may come back),
        // never silently point builds at a machine that cannot run them.
        const first = computers[0]
        show(fForm.status,
          `Connected, but your computer "${first.name}" is not active (${first.status}). It must be online to run builds.`,
          'err')
      } else {
        show(fForm.status, 'Connected, but this account has no Droid Computer yet. Open the Factory app on your Mac, or add a cloud computer, so builds can run.', 'err')
      }
    } catch (e) {
      failed.factory = true
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
    await keys.clearFactory()
    failed.factory = false
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
  const repoStatus = el('p', { className: 'msg muted' })
  const repoSelect = el('select')
  repoSelect.style.display = 'none'
  const repoLoad = el('button', { className: 'btn secondary', textContent: 'Choose from my repositories' })
  const repoCreateName = el('input', {
    type: 'text', placeholder: 'new-repository-name', autocomplete: 'off', spellcheck: false,
  })
  const repoCreatePrivate = el('input', { type: 'checkbox' })
  repoCreatePrivate.checked = true
  const repoCreate = el('button', { className: 'btn secondary', textContent: 'Create and use it' })
  const createBox = el('div', { className: 'sub' }, [
    el('div', { className: 'eyebrow', textContent: 'Or start a new repository' }),
    repoCreateName,
    el('label', { className: 'check' }, [repoCreatePrivate, 'Private']),
    repoCreate,
  ])
  const refreshRepo = () => {
    const canList = Boolean(keys.github || keys.cursor)
    repoLoad.disabled = !canList
    createBox.style.display = keys.github ? 'flex' : 'none'
    repoCurrent.replaceChildren(
      el('b', { textContent: 'Current repository' }),
      keys.repoUrl ? repoLabel(keys.repoUrl) : 'None chosen yet',
    )
    if (!canList) {
      show(repoStatus, 'To list your repositories, add a Cursor key or a GitHub token below.', 'muted')
    } else if (!repoStatus.classList.contains('err')) {
      show(repoStatus, keys.github ? '' : 'Add a GitHub token to create new repositories here.', 'muted')
    }
  }
  repoLoad.onclick = async () => {
    const gh = keys.github
    const cur = keys.cursor
    if (!gh && !cur) return show(repoStatus, 'Add a Cursor key or a GitHub token first.', 'err')
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
      show(repoStatus, msg, 'err')
    } finally {
      repoLoad.disabled = !keys.github && !keys.cursor
    }
  }
  repoSelect.onchange = async () => {
    const url = repoSelect.value
    if (!url) return refreshRepo()
    await keys.setRepoUrl(url)
    show(repoStatus, `Builds will land in ${repoLabel(url)}.`, 'ok')
    refreshRepo()
    refreshSummary()
  }
  repoCreate.onclick = async () => {
    const token = keys.github
    if (!token) return show(repoStatus, 'Add a GitHub token below to create repositories.', 'err')
    const name = repoCreateName.value.trim()
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
      return show(repoStatus, 'Use only letters, digits, "-", "_", or "." in the name.', 'err')
    }
    repoCreate.disabled = true
    show(repoStatus, `Creating ${name} on GitHub...`, 'muted')
    try {
      const created = await githubCreateRepo(token, name, repoCreatePrivate.checked)
      await keys.setRepoUrl(created.url)
      repoCreateName.value = ''
      if (repoSelect.style.display !== 'none') {
        repoSelect.prepend(el('option', { value: created.url, textContent: `${created.fullName} (new)` }))
        repoSelect.value = created.url
      }
      show(repoStatus, `Created ${created.fullName}. Builds will land there.`, 'ok')
    } catch (e) {
      const msg = e instanceof GitHubError
        ? (e.kind === 'auth' ? 'GitHub rejected the saved token. Save it again.'
          : e.kind === 'permission' ? 'This token cannot create repositories. It needs the "repo" scope (classic) or "Repository creation" (fine-grained).'
            : e.kind === 'exists' ? 'You already have a repository with that name. Try another.'
              : e.kind === 'quota' ? 'GitHub hit a rate limit. Try again in a minute.'
                : e.kind === 'network' ? 'GitHub could not be reached. Check your connection.'
                  : 'The repository could not be created.')
        : 'The repository could not be created.'
      show(repoStatus, msg, 'err')
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
    show(vForm.status, hint ? `Key ${hint} is saved on this phone.` : 'Without a key, Talk uses a labeled demo transcript.', 'muted')
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
    await keys.clearElevenLabs()
    failed.voice = false
    refreshVoice()
    refreshSummary()
  }
  voice.body.append(
    el('p', { className: 'small muted' }, [
      'Your voice streams straight to ElevenLabs for transcription. Create a key at ',
      link('elevenlabs.io/app/settings/api-keys', 'https://elevenlabs.io/app/settings/api-keys'),
      ', limited to speech-to-text and with a spending cap.',
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
    await keys.clearCursor()
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
    show(gForm.status, hint ? `Token ${hint} is saved on this phone.` : '', 'muted')
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
    await keys.clearGithub()
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

  const prefsStatus = el('p', { className: 'msg muted' })
  const workerSelect = el('select')
  const jobsSelect = el('select')
  const prSelect = el('select')
  const workerHelp = el('p', { className: 'small muted' })
  const refreshPrefs = () => {
    const hasCursor = Boolean(keys.cursor)
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
    const workerLabel = WORKER_PREFS.find((w) => w.id === prefs.worker)?.label ?? 'Auto'
    prefsStep.setPill(workerLabel, '')
    notify()
  }
  const savedPrefs = (ok: boolean) => {
    if (ok) {
      refreshPrefs()
      show(prefsStatus, 'Saved. Changes apply on your glasses right away.', 'ok')
    } else {
      show(prefsStatus, 'The change could not be saved on this phone. Try again.', 'err')
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
  prefsStep.body.append(
    el('label', { className: 'field' }, ['Who builds', workerSelect]),
    workerHelp,
    el('label', { className: 'field' }, ['Large tasks', jobsSelect]),
    el('label', { className: 'field' }, ['Pull requests', prSelect]),
    prefsStatus,
  )

  // -------------------------------------------------------------- mount

  root.replaceChildren(
    readyCard,
    factory.root,
    repo.root,
    voice.root,
    cursor.root,
    github.root,
    prefsStep.root,
    el('p', {
      className: 'foot',
      textContent:
        'On the glasses, tap Talk to speak, or say "Hey Spriite, pause" while it listens. ' +
        'Real builds use your Factory and Cursor credits. The demo never does.',
    }),
  )
  refreshFactory()
  refreshVoice()
  refreshCursor()
  refreshGithub()
  refreshRepo()
  refreshPrefs()
  refreshSummary()
  // Start with the first unfinished required step open.
  const firstMissing = required().find((r) => !r.done)
  if (firstMissing) steps[firstMissing.id].root.open = true
  live = true // construction done; changes hot-apply from here on
  return { missingRequired }
}
