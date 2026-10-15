import type { FactoryEngine } from '../factory/engine'
import type { FakeSessionControls } from '../factory/fake'
import type { MissionStore } from '../state/mission-store'
import type { SpriiteState } from '../domain/types'

/**
 * WKWebView has no phone-input automation endpoint. In the isolated dev
 * fixture, drive real DOM controls from a local command file, never eval.
 * The production bundle excludes this module and the fake provider.
 */
export function runSessionOptionsProbe(
  engine: () => FactoryEngine,
  controls: FakeSessionControls,
  readHUD: () => {
    uiMode: string
    hudKind: string | null
    history: { open: boolean; page: number; count: number; body: string; contextLabel: string }
  },
  routeSyntheticVoice?: (text: string, messageOnly: boolean) => Promise<void>,
  submitSyntheticX?: () => Promise<void>,
): void {
  // The command file outlives a run. A command written before this page
  // loaded (sequences are the writer's Date.now()) belongs to an earlier
  // run: replaying it at boot would tap rows the new run never asked for.
  let lastSequence = Date.now()
  let busy = false
  /**
   * A control named `label`: its whole text, a bold title (list rows), or a
   * redesigned build row's name (Home and Builds draw the name, status and
   * source in separate spans, so the row's own text is never the name).
   */
  const named = (b: HTMLButtonElement, label: string): boolean =>
    b.textContent?.trim() === label || b.querySelector('b')?.textContent?.trim() === label ||
    b.querySelector('.ph-build-name')?.textContent?.trim() === label
  const visibleButton = (label: string): HTMLButtonElement | null =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => named(b, label) && !b.disabled && b.getClientRects().length > 0) ?? null
  const button = (label: string): HTMLButtonElement => {
    const node = visibleButton(label)
    if (!node) throw new Error(`Visible button not found: ${label}`)
    return node
  }
  /**
   * A card action on the redesigned phone: the build's own actions live on
   * the Mission page behind More actions (REDESIGN-SPEC, Mission). Open the
   * build and the menu the way the owner would, then press the action.
   */
  const cardAction = (label: string): HTMLButtonElement => {
    const direct = visibleButton(label)
    if (direct) return direct
    const open = document.getElementById('ph-open-build') as HTMLButtonElement | null
    if (open && open.getClientRects().length > 0) open.click()
    const menu = document.getElementById('ph-actions')
    if (menu?.hidden) (document.getElementById('ph-more') as HTMLButtonElement | null)?.click()
    return button(label)
  }
  const composer = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('#msg')
  const inspect = () => {
    const current = engine()
    const store = (current as unknown as { supervisor?: { store?: MissionStore<SpriiteState> } }).supervisor?.store
    const snapshot = current.snapshot()
    const view = current.currentView
    const input = composer()
    // A Factory link the owner can reach: one on screen, else the open
    // build's own link behind More actions (REDESIGN-SPEC, Mission).
    const factoryLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((a) =>
      ['Open Factory', 'Open on phone', 'Answer in Factory'].includes(a.textContent ?? ''))
    const missionShown = (document.getElementById('ph-mission')?.getClientRects().length ?? 0) > 0
    const link = factoryLinks.find((a) => a.getClientRects().length > 0) ??
      (missionShown ? factoryLinks.find((a) => a.closest('#ph-actions') !== null) : undefined)
    return {
      sessionId: 'sessionId' in snapshot ? snapshot.sessionId : null,
      phase: 'phase' in snapshot ? snapshot.phase : null,
      awaiting: 'awaiting' in snapshot ? snapshot.awaiting : null,
      pendingPrApproval: 'decisionGate' in snapshot && snapshot.decisionGate && snapshot.decisionKind === 'pr',
      durability: store?.durability,
      checkpointSeq: store?.checkpointSeq,
      checkpointBytes: store ? JSON.stringify(store.current).length : null,
      latestDispatch: store?.current.outbox.at(-1)?.state,
      unresolvedDispatchCount: store?.current.outbox.filter(d => d.state === 'prepared' || d.state === 'sending' || d.state === 'unknown').length,
      prReady: 'prUrl' in snapshot && Boolean(snapshot.prUrl),
      nativeQuestion: 'nativeQuestion' in snapshot && Boolean(snapshot.nativeQuestion),
      mvpScope: 'goal' in snapshot && (snapshot.goal.includes('MVP core workflow') || snapshot.buildDraft?.goal.includes('MVP core workflow')),
      plexoScope: 'goal' in snapshot && snapshot.goal.includes('example/plexo'),
      destinationRetained: 'missionRepo' in snapshot && snapshot.missionRepo === 'https://github.com/example/sprite-test',
      scene: view.type === 'scene' ? {
        kind: view.scene.kind, status: view.scene.status, utterance: view.scene.utterance,
        pose: view.scene.spritePose, actions: view.scene.actions.map((a) => ({ id: a.id, label: a.label })),
      } : { kind: 'selection', title: view.title, items: view.items },
      provider: controls.inspect(),
      deliveryUnconfirmed: 'pendingLeadDelivery' in snapshot && Boolean(snapshot.pendingLeadDelivery),
      buildDraft: 'buildDraft' in snapshot && Boolean(snapshot.buildDraft),
      approvedPlanCount: 'approvedPlan' in snapshot ? snapshot.approvedPlan?.length ?? 0 : 0,
      workerCount: 'jobs' in snapshot ? snapshot.jobs.length : 0,
      launchedWorkers: 'jobs' in snapshot ? snapshot.jobs.filter(job => job.sessionId || job.agentId).length : 0,
      ownsSelectedOutcome: 'goal' in snapshot && snapshot.goal.includes('Rebuild linked product'),
      scopeInHistory: current.chatLog().some(entry => entry.text.includes('Build scope, not started:') &&
        entry.text.includes('Rebuild linked product') && entry.text.includes('Verify - done means')),
      buildTitles: current.listBuilds().map(row => row.title),
      composerFocused: input !== null && document.activeElement === input,
      activeElement: `${document.activeElement?.tagName ?? ''}#${document.activeElement?.id ?? ''}`,
      composerShown: input !== null && input.getClientRects().length > 0,
      composerBlocked: composer()?.disabled ?? false,
      composerValue: input?.value ? 'nonempty' : 'empty',
      factoryLink: link?.href ?? null,
      factoryLinkFocused: document.activeElement instanceof HTMLAnchorElement && document.activeElement.href === link?.href,
      chatHasEnd: current.chatLog().some((entry) => entry.text.includes('HISTORY END')),
      phoneHasEnd: Array.from(document.querySelectorAll('.bubble')).some((node) => node.textContent?.includes('HISTORY END')),
      chatContexts: ['qa-idle', 'qa-running', 'qa-readonly']
        .filter(id => current.chatLog().some(entry => entry.text.includes(`Session ${id}.`))),
      // The redesigned phone: the glasses mirror's title and meta, and the
      // status lines under Start something new and the Mission bar.
      phoneHeader: `${document.getElementById('ph-mirror-title')?.textContent ?? ''} ${document.getElementById('ph-mirror-meta')?.textContent ?? ''}`.trim(),
      phoneOutcome: [document.getElementById('ph-mission-note')?.textContent ?? '', document.getElementById('ph-note')?.textContent ?? '']
        .filter(Boolean).join(' '),
      ...readHUD(),
    }
  }
  let busySince = 0
  const poll = async (): Promise<void> => {
    // The simulator's WKWebView can leave a command-file fetch pending for
    // good (its abort signal never fires). A poll stuck that long is
    // abandoned, or every later command goes unanswered.
    if (busy && Date.now() - busySince < 8000) return
    busy = true
    busySince = Date.now()
    const mine = busySince
    let sequence = 0
    try {
      // WKWebView can reuse a cached resource despite no-store. A unique URL
      // ensures each local command is observed rather than a delayed prior one.
      const res = await Promise.race([
        fetch(`/.screenshots/session-options/control.json?poll=${Date.now()}`, {
          cache: 'no-store', signal: AbortSignal.timeout(5000),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('command poll timed out')), 6000)),
      ])
      if (mine !== busySince) return // an abandoned poll never runs a command
      if (!res.ok) return
      const command = await res.json() as { sequence: number; action: string; value?: string; sessionId?: string }
      sequence = command.sequence
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) return
      lastSequence = sequence
      switch (command.action) {
        case 'inspect': break
        case 'open': {
          // A build row: on Home's Builds card, else on the Builds tab.
          const label = command.value ?? ''
          let row = visibleButton(label)
          if (!row) {
            (document.getElementById('ph-tab-builds') as HTMLElement | null)?.click()
            row = visibleButton(label)
          }
          ;(row ?? button(label)).click()
          break
        }
        case 'message': {
          // The card's Send message (HudRun labels it Message) when the card
          // carries it; the redesigned Mission bar is always there otherwise.
          const action = visibleButton('Send message') ?? visibleButton('Message')
          if (action) action.click()
          else {
            const open = document.getElementById('ph-open-build') as HTMLButtonElement | null
            const openShown = !!open && open.getClientRects().length > 0
            if (openShown) open.click()
            const input = composer()
            if (!input || input.disabled) throw new Error('Session composer unavailable')
            if (input.getClientRects().length === 0) {
              throw new Error(`Session composer not shown (open build ${open ? openShown ? 'pressed' : 'hidden' : 'missing'}, ` +
                `panes ${Array.from(document.querySelectorAll('[id^=ph-pane], #ph-mission')).map((p) => `${p.id}:${(p as HTMLElement).hidden ? 'h' : 'v'}`).join(',')})`)
            }
            input.focus()
          }
          break
        }
        case 'send': {
          // The Mission bar sends on Enter (Mission.dc.html draws no send button).
          const input = composer()
          if (!input || input.disabled) throw new Error('Session composer unavailable')
          input.value = command.value ?? ''
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          break
        }
        case 'continue':
          cardAction('Continue').click()
          break
        case 'home':
          button('Home').click()
          break
        case 'voice_build':
        case 'voice_message':
          if (!routeSyntheticVoice) throw new Error('Synthetic utterance routing unavailable')
          await routeSyntheticVoice(command.value ?? 'Build it', command.action === 'voice_message')
          break
        case 'background_x':
          if (!submitSyntheticX) throw new Error('Synthetic X submission unavailable')
          await submitSyntheticX()
          break
        case 'timeout_next_post':
          controls.timeoutNextPost(command.sessionId ?? '')
          break
        case 'status':
          controls.setStatus(command.sessionId ?? '', command.value ?? 'unknown')
          break
        default: throw new Error('Unsupported session-options command')
      }
      console.log(`[session-options] ${JSON.stringify({ sequence, ok: true, ...inspect() })}`)
    } catch (error) {
      console.error(`[session-options] ${JSON.stringify({ sequence, ok: false, error: error instanceof Error ? error.message : String(error) })}`)
    } finally {
      if (mine === busySince) busy = false
    }
  }
  // The timer callback itself returns at once: the simulator's timer shim
  // can wait on a callback's promise, and one hung command poll must never
  // hold every later tick (or the app's own timers) behind it.
  // Two independent schedules (an interval and a self-renewing timeout):
  // in the simulator a build opened from the phone can leave one of them
  // never firing again, which silenced every later command.
  setInterval(() => { void poll() }, 300)
  const chain = (): void => { void poll(); setTimeout(chain, 350) }
  setTimeout(chain, 350)
  console.log('[session-options] probe ready: synthetic provider, DOM actions only')
}
