/**
 * Phone companion (the plugin page in the Even app). Not a settings screen:
 * full viewership of, and access to, everything we work on.
 *
 * - NOW: what the glasses show right now (phase, status, verified progress,
 *   Spriite's line, every action the glasses offer), a "Tell Spriite" box
 *   for goals, answers, and steering, the builds list (Spriite missions +
 *   Factory sessions + Cursor agents) in a fixed-height scroller with
 *   source filters, and a collapsible activity log.
 * - SETUP: accounts, repository, and preferences (saves hot-apply on the
 *   glasses). The tab shows how many required steps are left.
 *
 * Spriite stays aware of everything done here: the phone page hosts the
 * engine, so every tap and typed line runs through the same orchestrator
 * the glasses drive, and each engine card lands in the activity log.
 */
import type { EngineView } from '../factory/demo'
import type { FactoryEngine } from '../factory/engine'
import { RealOrchestrator } from '../factory/real'
import type { SceneAction } from '../scenes/types'
import type { KeyVault } from '../voice/keys'
import type { PrefsVault } from '../state/prefs'
import { mountSetupPanel } from '../setup/panel'
import { THEME_CSS } from './theme'

const CSS = `
  .sp .live .phase { display: flex; align-items: center; gap: 8px; }
  .sp .live .phase h2 { flex: 1; }
  .sp .live .status { margin-top: 4px; font-size: 13px; color: var(--muted); }
  .sp .bubble {
    margin: 14px 0; padding: 12px 14px; border-radius: 4px 14px 14px 14px;
    background: var(--surface-2); border: 1px solid var(--line-2); font-size: 16px; line-height: 1.5;
  }
  .sp .bubble:empty { display: none; }
  .sp .bar { height: 8px; border-radius: 4px; background: var(--bg); overflow: hidden; display: flex; margin-top: 12px; }
  .sp .bar i { display: block; height: 100%; }
  .sp .bar .acc { background: var(--accent); } .sp .bar .pen { background: var(--warn); }
  .sp .legend { display: flex; gap: 14px; margin-top: 6px; font-size: 12px; color: var(--muted); }
  .sp .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
  .sp .composer { display: flex; gap: 8px; }
  .sp .composer input { flex: 1; }
  .sp .filters { display: flex; gap: 6px; overflow-x: auto; margin: 0 -2px 8px; padding: 0 2px; }
  .sp .filter {
    flex: 0 0 auto; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line-2);
    background: transparent; color: var(--muted); font-size: 13px; font-weight: 600;
  }
  .sp .filter.on { background: var(--accent-soft); color: var(--accent); border-color: #1f5a2c; }
  .sp .scroller {
    max-height: 316px; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
    margin: 0 -16px; padding: 0 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
    mask-image: linear-gradient(to bottom, #000 88%, transparent);
    -webkit-mask-image: linear-gradient(to bottom, #000 88%, transparent);
  }
  .sp .scroller.short { mask-image: none; -webkit-mask-image: none; }
  .sp .empty { padding: 18px 0; text-align: center; color: var(--muted); font-size: 14px; }
  .sp details.log summary {
    list-style: none; display: flex; align-items: center; gap: 8px; cursor: pointer;
  }
  .sp details.log summary::-webkit-details-marker { display: none; }
  .sp details.log summary .eyebrow { flex: 1; }
  .sp details.log summary::after { content: '\\203A'; color: var(--faint); font-size: 18px; transition: transform 0.15s; }
  .sp details.log[open] summary::after { transform: rotate(90deg); }
  .sp .feed { list-style: none; margin: 10px 0 0; padding: 0; }
  .sp .feed li { display: flex; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); }
  .sp .feed time { flex: 0 0 42px; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 1px; }
  .sp .feed .w { flex: 1; min-width: 0; }
  .sp .feed .w b { font-size: 13px; color: var(--text); }
  .sp .feed .w span { display: block; color: var(--muted); font-size: 13px; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
`

type Tab = 'now' | 'setup'
type BuildFilter = 'all' | 'local' | 'factory' | 'cursor'

/** Friendly card labels for the live mirror + activity log. */
const SCENE_LABEL: Record<string, string> = {
  setup_notice: 'Setup needed',
  transcript: 'New goal',
  plan: 'Plan',
  running: 'Working',
  under_review: 'In review',
  repair: 'Fixing',
  factory_error: 'Something failed',
  final: 'Done',
  paused: 'Paused',
  decision: 'Question for you',
  explain: 'Explanation',
  status_answer: 'Spriite replied',
  accepted: 'Verified',
  regression: 'Regression',
}

const SOURCE_LABEL: Record<'local' | 'factory' | 'cursor', string> = {
  local: 'Spriite',
  factory: 'Factory',
  cursor: 'Cursor',
}

interface FeedEntry {
  at: number
  label: string
  text: string
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  for (const c of children) node.append(c)
  return node
}

/** "Factory: building" -> "Building": the source pill already names the account. */
const rowNote = (note: string): string => {
  const word = note.replace(/^(Factory|Cursor):\s*/, '')
  return word.charAt(0).toUpperCase() + word.slice(1)
}

const clock = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface PhoneHandle {
  /** The engine showed a new card; mirror it and log it. */
  notify(view: EngineView): void
  /** Glasses link state for the header pill. */
  setGlasses(connected: boolean | null): void
}

/**
 * Mount the phone companion. The engine accessor is read live (the demo
 * engine swaps in and out); runAction is the app's action router (connect
 * prompts, Talk capture, demo opt-in, restart, engine actions), so phone
 * buttons behave exactly like the focused action on the glasses.
 */
export function mountPhoneApp(
  root: HTMLElement,
  deps: {
    keys: KeyVault
    prefs: PrefsVault
    engine: () => FactoryEngine
    runAction: (action: SceneAction) => void
    onSaved: () => void
  },
): PhoneHandle {
  const style = el('style')
  style.textContent = THEME_CSS + CSS
  document.head.append(style)

  const feed: FeedEntry[] = []
  let filter: BuildFilter = 'all'
  let lastView: EngineView | null = null

  // ------------------------------------------------------------- header

  const glassesDot = el('i', { className: 'dot' })
  const glassesText = el('span', { textContent: 'Checking glasses' })
  const tabNow = el('button', { className: 'seg on', textContent: 'Now' })
  const setupBadge = el('span', { className: 'badge' })
  const tabSetup = el('button', { className: 'seg' }, ['Setup', setupBadge])
  const paneNow = el('div', { className: 'pane on' })
  const paneSetup = el('div', { className: 'pane' })
  const setTab = (t: Tab) => {
    tabNow.classList.toggle('on', t === 'now')
    tabSetup.classList.toggle('on', t === 'setup')
    paneNow.classList.toggle('on', t === 'now')
    paneSetup.classList.toggle('on', t === 'setup')
    window.scrollTo({ top: 0 })
  }
  tabNow.onclick = () => setTab('now')
  tabSetup.onclick = () => setTab('setup')

  // ------------------------------------------------------------ now pane

  const liveCard = el('section', { className: 'card live' })

  const sayInput = el('input', {
    type: 'text', placeholder: 'What should we build?', autocomplete: 'off', spellcheck: true,
  })
  sayInput.enterKeyHint = 'send'
  const saySend = el('button', { className: 'btn', textContent: 'Send' })
  // A goal can start in a brand-new repository (created through the saved
  // GitHub token) instead of the chosen one. The name is optional: Spriite
  // derives it from the goal.
  const sayNewRepoCheck = el('input', { type: 'checkbox' })
  const sayNewRepoName = el('input', {
    type: 'text', placeholder: 'Repository name (optional)', autocomplete: 'off', spellcheck: false,
  })
  sayNewRepoName.style.display = 'none'
  const sayNewRepoRow = el('label', { className: 'check' }, [sayNewRepoCheck, 'Start in a new repository'])
  sayNewRepoCheck.onchange = () => {
    sayNewRepoName.style.display = sayNewRepoCheck.checked ? 'block' : 'none'
    renderComposer()
  }
  const sayHelp = el('p', { className: 'small muted' })
  const sayNote = el('p', { className: 'msg muted' })
  const sayCard = el('section', { className: 'card stack' }, [
    el('div', { className: 'eyebrow', textContent: 'Tell Spriite' }),
    el('div', { className: 'composer' }, [sayInput, saySend]),
    sayNewRepoRow,
    sayNewRepoName,
    sayHelp,
    sayNote,
  ])

  const buildsCount = el('span', { className: 'pill' })
  const newBuild = el('button', { className: 'btn small secondary', textContent: '+ New build' })
  const filterBar = el('div', { className: 'filters' })
  const buildsScroller = el('div', { className: 'scroller' })
  const buildsHint = el('p', { className: 'small muted' })
  const buildsCard = el('section', { className: 'card' }, [
    el('div', { className: 'card-head' }, [
      el('span', { className: 'eyebrow', textContent: 'Builds' }), buildsCount, newBuild,
    ]),
    filterBar,
    buildsScroller,
    buildsHint,
  ])
  buildsHint.style.marginTop = '10px'

  const feedList = el('ul', { className: 'feed' })
  const feedCount = el('span', { className: 'pill' })
  const logCard = el('details', { className: 'card log' }, [
    el('summary', {}, [el('span', { className: 'eyebrow', textContent: 'Activity' }), feedCount]),
    feedList,
  ])

  paneNow.append(liveCard, sayCard, buildsCard, logCard)

  const shell = el('div', { className: 'sp' }, [
    el('header', {}, [
      el('div', { className: 'brand' }, [
        el('h1', { textContent: 'SPRIITE' }),
        el('span', { className: 'link-pill' }, [glassesDot, glassesText]),
      ]),
      el('div', { className: 'segs' }, [tabNow, tabSetup]),
    ]),
    el('main', {}, [paneNow, paneSetup]),
  ])
  root.replaceChildren(shell)

  // The glasses' connect prompts land on the Setup tab; the panel's own
  // listener (registered after this one) then opens and scrolls to the step.
  window.addEventListener('spriite-connect', () => setTab('setup'))
  const setup = mountSetupPanel(paneSetup, deps.keys, deps.prefs, {
    onSaved: deps.onSaved,
    onReadiness: (missing) => {
      setupBadge.textContent = missing > 0 ? String(missing) : ''
      setupBadge.style.display = missing > 0 ? 'inline-block' : 'none'
    },
  })
  // First run: nothing works until Factory is connected, so start there.
  setTab(setup.missingRequired() > 0 && !deps.keys.factory ? 'setup' : 'now')

  // ---------------------------------------------------------- live mirror

  const labelFor = (view: EngineView): string =>
    view.type === 'scene'
      ? SCENE_LABEL[view.scene.kind] ?? view.scene.kind.replace(/_/g, ' ')
      : view.purpose === 'projects' ? 'Home'
      : view.purpose === 'goal' ? 'New build'
      : view.purpose === 'plan_detail' ? 'Milestones'
      : 'Evidence'

  const actionButtons = (actions: SceneAction[]): HTMLElement =>
    el('div', { className: 'btns' }, actions.map((a, i) => {
      const b = el('button', {
        className: `btn ${i === 0 ? '' : 'secondary'}`,
        textContent: a.label,
      })
      b.onclick = () => deps.runAction(a)
      return b
    }))

  const renderLive = (view: EngineView): void => {
    const engine = deps.engine()
    const head = (title: string, pillText: string, pillTone = '') =>
      el('div', { className: 'phase' }, [
        el('h2', { textContent: title }),
        el('span', { className: `pill ${pillTone}`, textContent: pillText }),
      ])
    if (view.type === 'scene') {
      const s = view.scene
      const p = s.progress
      const fault =
        engine instanceof RealOrchestrator ? engine.snapshot().faultDetail : ''
      const accepted = p ? Math.round((100 * p.acceptedWeight) / p.totalWeight) : 0
      const pending = p ? Math.round((100 * p.pendingReviewWeight) / p.totalWeight) : 0
      const failed = s.kind === 'factory_error' || Boolean(fault)
      const parts: HTMLElement[] = [
        el('div', { className: 'eyebrow', textContent: 'On your glasses' }),
        head(labelFor(view), failed ? 'Needs attention' : 'Live', failed ? 'err' : 'ok'),
      ]
      if (s.status) parts.push(el('p', { className: 'status', textContent: s.status }))
      if (p) {
        const acc = el('i', { className: 'acc' })
        const pen = el('i', { className: 'pen' })
        acc.style.width = `${accepted}%`
        pen.style.width = `${pending}%`
        const dotAcc = el('i')
        dotAcc.style.background = 'var(--accent)'
        const dotPen = el('i')
        dotPen.style.background = 'var(--warn)'
        parts.push(
          el('div', { className: 'bar' }, [acc, pen]),
          el('div', { className: 'legend' }, [
            el('span', {}, [dotAcc, `${accepted}% verified`]),
            ...(pending ? [el('span', {}, [dotPen, `${pending}% in review`])] : []),
          ]),
        )
      }
      parts.push(el('p', { className: 'bubble', textContent: s.utterance }))
      if (fault) {
        parts.push(el('div', { className: 'callout err' }, [el('b', { textContent: 'Why it failed' }), fault]))
        parts[parts.length - 1].style.marginBottom = '14px'
      }
      if (s.actions.length > 0) parts.push(actionButtons(s.actions))
      liveCard.replaceChildren(...parts)
    } else if (view.purpose === 'projects') {
      // The home list is the Builds card below; no need to show it twice.
      const n = view.items.length - 1
      liveCard.replaceChildren(
        el('div', { className: 'eyebrow', textContent: 'On your glasses' }),
        head('Home', 'Live', 'ok'),
        el('p', {
          className: 'bubble',
          textContent: n > 0
            ? 'Pick a build below to open it, or tell me what to build next.'
            : 'Tell me what to build, and I will start a Factory build for it.',
        }),
      )
    } else {
      // Other lists (new-goal options, milestones, evidence): tappable here.
      const purpose = view.purpose
      const rows = view.items.map((item, i) => {
        const b = el('button', { className: 'row' }, [
          el('div', { className: 't' }, [el('b', { textContent: item })]),
          el('span', { className: 'chev', textContent: '\u203A' }),
        ])
        b.onclick = () => {
          if (purpose === 'goal') {
            deps.runAction({ id: 'talk', label: 'Talk', kind: 'local_capture' })
            return
          }
          engine.chooseList(i)
        }
        return b
      })
      liveCard.replaceChildren(
        el('div', { className: 'eyebrow', textContent: 'On your glasses' }),
        head(labelFor(view), 'Live', 'ok'),
        el('p', { className: 'status', textContent: view.title }),
        el('div', { className: 'rows' }, rows),
      )
    }
    renderComposer()
  }

  const renderComposer = (): void => {
    const engine = deps.engine()
    const goalMode = !engine.hasPendingDecision && engine.acceptsGoal()
    sayNewRepoRow.style.display = goalMode ? '' : 'none'
    sayNewRepoName.style.display = goalMode && sayNewRepoCheck.checked ? 'block' : 'none'
    if (engine.hasPendingDecision) {
      sayInput.placeholder = 'Answer Spriite'
      sayHelp.textContent = 'Spriite is waiting on your answer. Yes or no works, or reply in your own words.'
    } else if (engine.acceptsGoal()) {
      if (sayNewRepoCheck.checked) {
        sayInput.placeholder = 'Goal for the new repository'
        sayHelp.textContent =
          'Spriite will create a private GitHub repository for this goal and build there. It needs a GitHub token (Setup tab).'
      } else {
        sayInput.placeholder = 'What should we build?'
        sayHelp.textContent = 'Describe a goal and Spriite starts a Factory build. It asks before spending credits.'
      }
    } else {
      sayInput.placeholder = 'Steer the build'
      sayHelp.textContent = 'Your message goes to the build that is running now.'
    }
  }

  // -------------------------------------------------------------- builds

  const renderBuilds = (): void => {
    const engine = deps.engine()
    const builds = engine.listBuilds().map((b, i) => ({ ...b, index: i }))
    const counts = { all: builds.length, local: 0, factory: 0, cursor: 0 }
    for (const b of builds) counts[b.kind]++
    if (filter !== 'all' && counts[filter] === 0) filter = 'all'

    filterBar.replaceChildren(
      ...(['all', 'local', 'factory', 'cursor'] as const)
        .filter((f) => f === 'all' || counts[f] > 0)
        .map((f) => {
          const b = el('button', {
            className: `filter ${filter === f ? 'on' : ''}`,
            textContent: `${f === 'all' ? 'All' : SOURCE_LABEL[f]} ${counts[f]}`,
          })
          b.onclick = () => {
            filter = f
            renderBuilds()
          }
          return b
        }),
    )
    filterBar.style.display = builds.length > 0 ? 'flex' : 'none'
    buildsCount.textContent = String(builds.length)

    const openable = engine.acceptsGoal()
    const shown = builds.filter((b) => filter === 'all' || b.kind === filter)
    const rows = shown.map((b) => {
      const btn = el('button', { className: 'row' }, [
        el('div', { className: 't' }, [
          el('b', { textContent: b.title }),
          el('span', { textContent: rowNote(b.note) }),
        ]),
        el('span', { className: `pill ${b.kind === 'local' ? 'spriite' : b.kind}`, textContent: SOURCE_LABEL[b.kind] }),
      ])
      btn.disabled = !openable
      btn.style.opacity = openable ? '' : '0.55'
      btn.onclick = () => {
        if (!engine.openBuild(b.index)) {
          sayNote.className = 'msg err'
          sayNote.textContent = 'Finish or leave the current build first. Back on the glasses leaves it.'
          return
        }
        sayNote.className = 'msg ok'
        sayNote.textContent = `Opened "${b.title}" on your glasses.`
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
      return btn
    })
    buildsScroller.replaceChildren(
      ...(rows.length > 0
        ? rows
        : [el('p', { className: 'empty', textContent: 'No builds yet. Your Spriite, Factory, and Cursor builds will show up here.' })]),
    )
    buildsScroller.classList.toggle('short', rows.length <= 5)
    buildsHint.textContent = !openable && builds.length > 0
      ? 'A build is open on your glasses. Leave it to open another.'
      : 'Spriite builds resume where they left off. Factory and Cursor builds open in watch mode.'
  }

  newBuild.onclick = () => {
    setTab('now')
    sayInput.focus()
    sayNote.className = 'msg muted'
    sayNote.textContent = deps.engine().acceptsGoal()
      ? 'Type the goal above, or tap Talk on your glasses.'
      : 'Leave the current build first (Back on your glasses), then type the goal.'
  }

  // ---------------------------------------------------------------- feed

  const renderFeed = (): void => {
    feedCount.textContent = String(feed.length)
    feedList.replaceChildren(
      ...feed.slice(0, 20).map((e) =>
        el('li', {}, [
          el('time', { textContent: clock(e.at) }),
          el('div', { className: 'w' }, [
            el('b', { textContent: e.label }),
            el('span', { textContent: e.text }),
          ]),
        ]),
      ),
    )
  }

  // -------------------------------------------------------------- say box

  const send = (): void => {
    const text = sayInput.value.trim()
    if (!text) return
    sayInput.value = ''
    const engine = deps.engine()
    const asNewRepo =
      sayNewRepoCheck.checked &&
      sayNewRepoRow.style.display !== 'none' &&
      engine instanceof RealOrchestrator
    const went = asNewRepo
      ? engine.sayNewRepo(text, sayNewRepoName.value.trim())
      : engine.say(text)
    if (asNewRepo) {
      // One goal, one repository: the option never fires twice by accident.
      sayNewRepoCheck.checked = false
      sayNewRepoName.style.display = 'none'
      sayNewRepoName.value = ''
    }
    if (went === 'goal' && asNewRepo && engine instanceof RealOrchestrator) {
      const blocked = engine.snapshot().blockedStart
      sayNote.className = blocked === 'github' ? 'msg err' : 'msg ok'
      sayNote.textContent = blocked === 'github'
        ? 'Spriite needs a GitHub token to create the repository. Add one on the Setup tab, and this build continues.'
        : 'Got it. Spriite is creating a new repository for this goal, then planning.'
    } else {
      sayNote.className = went === 'none' ? 'msg err' : 'msg ok'
      sayNote.textContent =
        went === 'goal' ? 'Got it. Spriite is starting a Factory build to plan this.'
        : went === 'decision' ? 'Answer sent.'
        : went === 'steer' ? 'Sent. The reply will show on your glasses and in Activity.'
        : 'Spriite cannot take a message right now. Start a build or answer its question first.'
    }
    if (lastView) renderLive(lastView)
  }
  saySend.onclick = send
  sayInput.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') send()
  })

  // ------------------------------------------------------------- handle

  return {
    notify(view: EngineView): void {
      lastView = view
      renderLive(view)
      const label = labelFor(view)
      const text =
        view.type === 'scene'
          ? view.scene.utterance
          : `${view.title} (${view.items.length} items)`
      const last = feed[0]
      if (!last || last.label !== label || last.text !== text) {
        feed.unshift({ at: Date.now(), label, text })
        if (feed.length > 30) feed.length = 30
      }
      renderFeed()
      renderBuilds()
    },
    setGlasses(connected: boolean | null): void {
      glassesDot.className = `dot ${connected === null ? '' : connected ? 'on' : 'off'}`
      glassesText.textContent =
        connected === null ? 'Checking glasses' : connected ? 'Glasses connected' : 'Glasses not connected'
    },
  }
}
