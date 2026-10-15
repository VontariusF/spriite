/** Dev-only simulator controls for the offline native fixture. No eval,
 * credentials, arbitrary session IDs or provider calls are accepted. */
import type { NativeAnswer, NativeSnapshot } from '../native/protocol'
import type { EngineView } from '../factory/view'

export function runNativeMissionProbe(get: () => {
  nativeSnapshot?: () => NativeSnapshot | null
  answerNative?: (answer: NativeAnswer) => unknown
  currentView: EngineView
}, settle: () => Promise<void>): () => boolean {
  // A previous fixture process's control file is not a new owner action.
  let last = Date.now()
  let busy = false
  // Simulator webview capture can stall bridge replies for tens of seconds;
  // a store write caught in that window times out and halts durability. The
  // walkthrough pauses scheduling (never the freshness or storage gates).
  let quietUntil = 0
  // Each simulator polls its own control file (?fake-native-channel=<port>),
  // so two fixture simulators never take each other's commands.
  const channel = new URLSearchParams(location.search).get('fake-native-channel')
  const controlFile = channel && /^\d{2,6}$/.test(channel) ? `control-${channel}.json` : 'control.json'
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const res = await fetch(`/.screenshots/native-mission/${controlFile}?at=${Date.now()}`)
      if (!res.ok) return
      const cmd = await res.json() as { sequence?: number; action?: string; attentionId?: string; offset?: unknown; section?: unknown }
      if (!Number.isSafeInteger(cmd.sequence) || cmd.sequence! <= last) return
      last = cmd.sequence!
      const engine = get()
      const snapshot = engine.nativeSnapshot?.()
      if (!snapshot || snapshot.missionId !== 'offline-native-fixture' ||
        snapshot.ownerId !== 'fixture-owner' ||
        snapshot.capabilities.qualificationId !== 'offline-fixture-only') {
        throw new Error('Offline native fixture is not selected')
      }
      if (cmd.action === 'capture_viewport') {
        // Simulator html2canvas otherwise rasterizes the entire long settings
        // document and blocks bridge callbacks. Crop only this synthetic view.
        document.documentElement.style.height = '100%'
        document.documentElement.style.overflow = 'hidden'
        document.body.style.height = '100vh'
        document.body.style.overflow = 'hidden'
        const app = document.getElementById('app')
        if (!app) throw new Error('Offline phone root is unavailable')
        app.style.height = '100vh'
        app.style.overflowY = 'auto'
        app.dataset.nativeCaptureViewport = 'true'
      } else if (cmd.action === 'capture_quiet') {
        quietUntil = Date.now() + 120000
        await settle()
      } else if (cmd.action === 'capture_resume') {
        quietUntil = 0
      } else if (cmd.action === 'phone_top') {
        window.scrollTo(0, 0)
        document.querySelector<HTMLElement>('[data-native-capture-viewport]')?.scrollTo(0, 0)
      } else if (cmd.action === 'phone_admission') {
        const targets = { settings: 'native-modelId', inspection: 'native-inspect-admission', consent: 'native-launch' }
        const target = typeof cmd.section === 'string' && Object.hasOwn(targets, cmd.section)
          ? targets[cmd.section as keyof typeof targets] : null
        const panel = target && document.getElementById(target)
        if (!panel) throw new Error('Offline admission section is unavailable')
        panel.scrollIntoView({ block: 'start' })
      } else if (cmd.action === 'phone_scroll') {
        const panel = document.getElementById('native-request-panel')
        if (!panel) throw new Error('Offline native phone panel is unavailable')
        panel.scrollIntoView({ block: 'start' })
        const offset = typeof cmd.offset === 'number' && Number.isFinite(cmd.offset)
          ? Math.max(0, Math.min(cmd.offset, 12000)) : 0
        const viewport = document.querySelector<HTMLElement>('[data-native-capture-viewport]')
        if (viewport) viewport.scrollBy(0, offset)
        else window.scrollBy(0, offset)
      } else if (cmd.action === 'respond') {
        const attention = snapshot.attention.find(a => a.attentionId === cmd.attentionId && a.state === 'open')
        if (!attention || !engine.answerNative) throw new Error('Fixture request is not available')
        const sent = await engine.answerNative({
          attentionId: attention.attentionId, requestId: attention.requestId,
          sessionId: attention.sessionId, machineId: attention.machineId,
          revision: attention.revision, payloadHash: attention.payloadHash,
          ...(attention.kind === 'ask_user'
            ? { answers: attention.questions.map(q => ({ index: q.index,
              answer: q.multiSelect ? JSON.stringify(q.options.map(o => o.value)) : q.options[0]?.value ?? 'fixture' })) }
            : { selectedOption: 'proceed_once' }),
        })
        if (sent !== true) throw new Error('Offline native response was refused or uncertain')
      } else if (cmd.action !== 'inspect') {
        throw new Error('Unsupported offline native probe action')
      }
      const current = engine.nativeSnapshot?.()
      const view = engine.currentView
      console.log('[native-probe] ' + JSON.stringify({
        sequence: cmd.sequence, ok: true, snapshot: current,
        scene: view.type === 'scene' ? view.scene : { kind: 'selection', items: view.items },
      }))
    } catch (error) {
      console.log('[native-probe] ' + JSON.stringify({
        sequence: last, ok: false, error: error instanceof Error ? error.message : 'Fixture failed',
      }))
    } finally {
      busy = false
    }
  }, 350)
  return () => Date.now() < quietUntil
}
