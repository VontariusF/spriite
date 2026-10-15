/**
 * The Archive step of the Setup tab (VPS-ARCHIVE-SPEC §1, §5, §6, §9): the
 * device key, the mirror's honest state line, Sync now, and Restore from
 * archive behind an explicit confirm. Phone-only; nothing here projects to
 * the HUD or the glasses.
 *
 * The copy stays as honest as the mechanism: the mirror keeps records, it
 * does not run missions; a lost phone restores what was recorded, never a
 * running build; the device key is shown once at generation and never
 * again — the same write-only rule every key field in this app follows.
 */
import { isDeviceKeyShape, type ArchiveClient } from '../state/archive'
import type { PrefsVault } from '../state/prefs'

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/** The failure words a sync can report, as the step says them. */
const FAIL_TEXT: Record<string, string> = {
  off: 'The archive mirror is off.',
  no_key: 'Generate a device key first.',
  no_relay: 'This build has no relay, so there is no archive to talk to.',
  busy: 'A sync is already running.',
  offline: 'The archive could not be reached. The records stay queued and retry on their own.',
  auth: 'The archive rejected this device key. Check the key and save it again.',
  server: 'The archive answered with an error. The records stay queued and retry on their own.',
  storage: 'The restore could not be saved on this phone. Try again.',
}

const failText = (status: string): string =>
  FAIL_TEXT[status] ?? 'The archive could not complete this. Check the connection and try again.'

export function mountArchivePanel(
  root: HTMLElement,
  deps: {
    client: ArchiveClient | null
    prefs: PrefsVault
    onSaved: () => void
    /** Opens the Build preferences card on the durable runtime toggle. */
    onOpenRuntimePrefs: () => void
  },
): () => void {
  const { client, prefs } = deps
  const primary = el('p')
  const enabled = el('input', { type: 'checkbox', checked: prefs.flags.archive_mirror })
  const runtimeNote = el('p', { className: 'small muted' })
  const runtimeOpen = el('button', { className: 'btn secondary', textContent: 'Open the Durable runtime switch' })
  const keyStatus = el('p', { className: 'small muted' })
  const generate = el('button', { className: 'btn', textContent: 'Generate device key' })
  const revealed = el('div', { className: 'stack' })
  const adopt = el('input', {
    type: 'password', placeholder: 'Paste this archive\u2019s device key', autocomplete: 'off', spellcheck: false,
  })
  adopt.setAttribute('aria-label', 'Archive device key')
  const adoptSave = el('button', { className: 'btn secondary', textContent: 'Use this key' })
  const stateLine = el('p', { className: 'small muted' })
  const syncNow = el('button', { className: 'btn', textContent: 'Sync now' })
  const restoreButton = el('button', { className: 'btn danger', textContent: 'Restore from archive' })
  const confirm = el('div', { className: 'sub' })
  const result = el('p', { className: 'msg muted', role: 'status' })
  let working = false
  /** The freshly generated key, shown until the owner hides it (once ever). */
  let shownKey: string | null = null

  runtimeOpen.onclick = () => deps.onOpenRuntimePrefs()

  /** One outcome line: what happened, and whether it is good news. */
  type Line = { text: string; ok: boolean }
  const good = (text: string): Line => ({ text, ok: true })
  const bad = (text: string): Line => ({ text, ok: false })

  const run = async (action: () => Promise<Line>): Promise<void> => {
    if (working) return
    working = true
    refresh()
    result.className = 'msg muted'
    result.textContent = 'Working…'
    try {
      const line = await action()
      result.textContent = line.text
      result.className = `msg ${line.ok ? 'ok' : 'err'}`
    } catch {
      result.className = 'msg err'
      result.textContent = 'The archive could not complete this. Check the connection and try again.'
    } finally {
      working = false
      refresh()
      deps.onSaved()
    }
  }

  const clock = (iso: string | null): string => {
    if (iso === null) return 'never'
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const refresh = () => {
    const flagOn = prefs.flags.archive_mirror
    primary.textContent =
      'Spriite keeps a copy of your records \u2014 missions, their chat, the activity feed, X request receipts \u2014 on your own VPS. A lost, reset, or replaced phone restores them from that copy. The archive never runs missions and never holds a key of yours.'
    // The runtime gate, named and linked like the X step's: mission records
    // live in the durable runtime's store, so with it off there is nothing
    // to mirror yet and nothing to restore into.
    const runtimeOff = client === null
    runtimeNote.hidden = Boolean(client) || !runtimeOff
    runtimeOpen.hidden = runtimeNote.hidden || !runtimeOff
    runtimeNote.textContent = runtimeOff
      ? 'The Durable runtime is off, so there are no mission records to mirror yet. The mirror starts with the next launch that runs the durable runtime.'
      : ''
    // Not while a write is in the air: the box shows the choice the owner
    // just made, and a failed write is where it rolls back honestly.
    if (!working) enabled.checked = flagOn
    enabled.disabled = working
    generate.disabled = working || client === null || client.hasKey()
    adoptSave.disabled = working || client === null
    const hasKey = client?.hasKey() ?? false
    keyStatus.textContent =
      hasKey
        ? `Device key ${client?.keyHint() ?? ''} is saved on this phone. It is the bearer your VPS knows; it is never shown again and never leaves this phone except as the Authorization header.`
        : 'No device key yet. Generate one, or paste the key another phone\u2019s archive answers to.'
    // Shown once: only the freshly generated key renders, and only until
    // the owner hides it. A reload, a re-open, or a later visit shows the
    // hint alone.
    revealed.replaceChildren(
      ...(shownKey === null
        ? []
        : [
            el('b', { textContent: 'This phone\u2019s device key' }),
            el('p', { className: 'small muted', textContent: 'Copy it now. Spriite will not show it again.' }),
            el('input', {
              type: 'text', value: shownKey, readOnly: true, spellcheck: false, autocomplete: 'off',
            }),
            copyRow(shownKey),
            hideRow(),
          ]),
    )
    const s = client?.state()
    if (s === undefined || !flagOn) {
      stateLine.textContent = flagOn
        ? ''
        : 'The archive mirror is off; nothing is being sent.'
    } else {
      const bits = [
        `Last sync ${clock(s.lastSyncAt)}`,
        `${s.pending} pending`,
        ...(s.failed > 0 ? [`${s.failed} failed`] : []),
        ...(s.lastError !== null && s.pending > 0 ? [`last error: ${s.lastError}`] : []),
      ]
      stateLine.textContent = `${bits.join(' \u00B7 ')}${s.syncing ? ' \u00B7 syncing\u2026' : ''}`
    }
    syncNow.disabled = working || client === null
    restoreButton.disabled = working || client === null || !hasKey
    confirm.replaceChildren(...(awaitingConfirm ? [confirmRow()] : []))
  }

  /** The one copy affordance; it degrades to "select it yourself" anywhere
   *  a clipboard is not available (the DOM shim, old webviews). */
  const copyRow = (key: string): HTMLElement => {
    const copy = el('button', { className: 'btn', textContent: 'Copy' })
    const note = el('span', { className: 'small muted' })
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(key)
        note.textContent = 'Copied.'
      } catch {
        note.textContent = 'The clipboard refused; select the key and copy it yourself.'
      }
    }
    return el('div', { className: 'btns grow' }, [copy, note])
  }

  const hideRow = (): HTMLElement => {
    const hide = el('button', { className: 'btn secondary', textContent: 'Done \u2014 hide the key' })
    hide.onclick = () => {
      shownKey = null
      refresh()
    }
    return hide
  }

  /** Restore asks twice on purpose (spec §2: always a deliberate action). */
  let awaitingConfirm = false
  const confirmRow = (): HTMLElement =>
    el('div', { className: 'stack' }, [
      el('b', { textContent: 'Restore now?' }),
      el('p', {
        className: 'small muted',
        textContent:
          'Records newer on this phone stay; everything the archive has that is newer lands here, replacing the older copy. Missions that were running come back paused. This cannot be undone.',
      }),
      el('div', { className: 'btns grow' }, [
        el('button', {
          className: 'btn danger',
          textContent: 'Restore',
          onclick: () => {
            awaitingConfirm = false
            void run(async () => {
              const r = await client!.restore()
              if (r.status === 'restored') {
                // A capped page walk is real but partial: the line says so
                // instead of presenting the records it did fetch as the
                // whole archive (the step never claims more than happened).
                const caveat =
                  ' The archive still holds older records this walk did not reach.'
                return good(
                  `Restored: ${r.missions} mission${r.missions === 1 ? '' : 's'}, ` +
                    `${r.chat} with history, ${r.feed} feed entries, ${r.tags} X receipts ` +
                    `(${r.pages} page${r.pages === 1 ? '' : 's'}).${r.more ? caveat : ''}`,
                )
              }
              return bad(failText(r.status))
            })
          },
        }),
        el('button', {
          className: 'btn secondary',
          textContent: 'Not now',
          onclick: () => {
            awaitingConfirm = false
            refresh()
          },
        }),
      ]),
    ])

  enabled.onchange = () => {
    const on = enabled.checked
    void run(async () => {
      const ok = await prefs.setFlag('archive_mirror', on)
      deps.onSaved()
      if (!ok) return bad('The setting could not be saved.')
      if (on && client === null) {
        return good('Saved. The Durable runtime is off, so the mirror starts with the next launch that runs it.')
      }
      return good(
        on
          ? 'Archive mirror on. Records sync after every save, debounced to one batch every 30 seconds.'
          : 'Archive mirror off. Nothing is being sent.',
      )
    })
  }
  generate.onclick = () =>
    void run(async () => {
      const key = await client!.generateDeviceKey()
      if (key === null) {
        // Two different answers, two different lines: a key is already saved,
        // or the write did not land. A failed write is never reported as
        // something it was not (spec §8).
        return client!.hasKey()
          ? good('A device key is already saved on this phone. It is never shown again.')
          : bad('The device key could not be saved on this phone. Try again.')
      }
      shownKey = key
      return good('Generated. Copy it now: it is shown once.')
    })
  adoptSave.onclick = () =>
    void run(async () => {
      const typed = adopt.value
      adopt.value = '' // never render a saved credential back
      if (!typed.trim()) return bad('Paste the key this archive answers to first.')
      // The shape is the paste's own problem, checked here so it is named as
      // one; a write that did not land is a different fact and says so.
      if (!isDeviceKeyShape(typed.trim())) {
        return bad('That is not a device key. It is 43 or more letters and digits (base64url).')
      }
      if (!(await client!.adoptDeviceKey(typed))) {
        return client!.hasKey()
          ? good(`This phone already has a device key (${client!.keyHint()}). It was left as it is.`)
          : bad('The device key could not be saved on this phone. Try again.')
      }
      return good('Saved. This phone now syncs to and restores from that archive.')
    })
  syncNow.onclick = () =>
    void run(async () => {
      const r = await client!.syncNow()
      if (r.status === 'acked') {
        return good(r.sent > 0 ? `Synced ${r.sent} record${r.sent === 1 ? '' : 's'}.` : 'Everything is already synced.')
      }
      return bad(failText(r.status))
    })
  restoreButton.onclick = () => {
    awaitingConfirm = true
    refresh()
  }

  root.append(
    primary,
    el('p', { className: 'small muted', textContent: 'Your VPS holds the records, not the work: no keys, no live runs, no decisions. If it is unreachable, Spriite runs exactly as it does today and the pending count here says what is waiting.' }),
    runtimeNote,
    runtimeOpen,
    el('label', { className: 'check' }, [enabled, 'Archive mirror (beta, off by default)']),
    keyStatus,
    revealed,
    generate,
    el('div', { className: 'sub' }, [
      el('div', { className: 'eyebrow', textContent: 'Restoring on a new phone?' }),
      el('p', { className: 'small muted', textContent: 'Paste the device key the lost phone used, then Restore from archive. The record of every session comes back; the X binding does not (its token is a credential and never leaves a phone).' }),
      adopt,
      adoptSave,
    ]),
    stateLine,
    el('div', { className: 'btns grow' }, [syncNow, restoreButton]),
    confirm,
    result,
  )
  client?.subscribe(refresh)
  refresh()
  // the setup panel calls this whenever preferences change: the flag gates
  // this step's state line and controls, and the client may have completed a
  // sync while nobody was looking.
  return refresh
}
