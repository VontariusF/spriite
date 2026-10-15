/**
 * Move sender (the Move board): a one-time transfer code and its QR, a live
 * "Works once · expires in m:ss" countdown, and what moves. The offer is made
 * through the pairing client and cancelled when the screen goes away.
 * Expired, failed and moved states are undrawn (recorded in
 * docs/design/deviations/setup.md).
 */
import type { PairingClient, TransferOffer } from '../../pair/types'
import { COPY, TRANSFER_FAILURE } from './copy'
import { attr, button, el, ensureSetupStyles } from './dom'
import { iconEl, qrSvg } from './icons'

export interface MoveScreenDeps { pairing: PairingClient; hostLabel: () => string | null; onBack(): void }

/** m:ss, rounded up so a fresh 10-minute code reads 10:00. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

type Tick = ReturnType<typeof setInterval>

export function mountMoveScreen(root: HTMLElement, deps: MoveScreenDeps): { destroy(): void } {
  ensureSetupStyles()
  const C = COPY.move
  let destroyed = false
  let offer: TransferOffer | null = null
  let tick: Tick | null = null
  let attempt = 0
  const abort = new AbortController()

  const qr = attr(el('div', 'sf-qr'), { role: 'img', 'aria-label': C.qr })
  const code = el('span', 'sf-movecode', [C.making])
  /**
   * Move.dc.html draws the code on one line ('WREN · 41 · OAK', 15
   * characters at 26 px). Words run to six letters, so a longer code steps
   * the size down in proportion and never wraps.
   */
  const fitCode = (): void => {
    const len = (code.textContent ?? '').length
    code.style.fontSize = len > 15 ? `${Math.floor((26 * 15) / len)}px` : ''
  }
  const status = el('span', 'sf-expiry')
  const retry = button('sf-outline-btn', [C.newCode], () => start())
  retry.hidden = true
  const label = deps.hostLabel()

  const screen = el('div', 'sf-screen sf-screen--move', [
    button('sf-back', [iconEl('back')], () => deps.onBack(), { 'aria-label': C.back }),
    el('div', 'sf-copy', [
      el('h1', 'sf-h1 sf-h1--28', [C.title]),
      el('p', 'sf-lead sf-lead--15', [C.lead]),
    ]),
    el('div', 'sf-movecard', [qr, el('span', 'sf-or', [C.or]), code, status, retry]),
    el('div', 'sf-moves', [
      el('span', 'sf-label15', [C.whatMoves]),
      el('div', 'sf-moves-list', [C.moveKeys(label), C.moveDefaults, C.moveHistory]
        .map((t) => el('span', 'sf-moves-item', [iconEl('check'), t]))),
    ]),
    el('div', 'sf-foot-note', [iconEl('lock'), el('span', '', [C.lock])]),
  ])
  const shell = el('div', 'sf-root', [screen])
  root.replaceChildren(shell)

  const stopTick = (): void => {
    if (tick !== null) clearInterval(tick)
    tick = null
  }
  const setStatus = (text: string, kind: '' | 'done' | 'error'): void => {
    status.textContent = text
    status.className = kind ? `sf-expiry sf-expiry--${kind}` : 'sf-expiry'
  }
  const ended = (text: string, kind: 'done' | 'error', canRetry: boolean): void => {
    stopTick()
    setStatus(text, kind)
    retry.hidden = !canRetry
    if (kind === 'error') {
      qr.replaceChildren()
      code.textContent = '— · — · —'
    }
  }
  const paintCountdown = (): void => {
    if (!offer) return
    const left = offer.expiresAt - Date.now()
    if (left <= 0) {
      offer.cancel()
      ended(C.expired, 'error', true)
      offer = null
      return
    }
    setStatus(C.expires(countdown(left)), '')
  }

  const start = (): void => {
    const mine = ++attempt
    offer?.cancel()
    offer = null
    stopTick()
    retry.hidden = true
    qr.replaceChildren()
    code.textContent = C.making
    setStatus('', '')
    deps.pairing.offerTransfer({ signal: abort.signal }).then((res) => {
      if (destroyed || mine !== attempt) {
        if (res.ok) res.offer.cancel()
        return
      }
      if (res.ok === false) {
        ended(TRANSFER_FAILURE[res.reason] ?? TRANSFER_FAILURE.invalid, 'error', true)
        return
      }
      const o = res.offer
      offer = o
      let matrix: boolean[][] = []
      try { matrix = deps.pairing.qrMatrix(o.qrText) } catch { matrix = [] }
      qr.replaceChildren(...(matrix.length ? [qrSvg(matrix, C.qr)] : []))
      code.textContent = o.display || deps.pairing.formatTransferCode(o.code)
      fitCode()
      paintCountdown()
      tick = setInterval(paintCountdown, 1000)
      ;(tick as unknown as { unref?: () => void }).unref?.()
      o.done.then((r) => {
        if (destroyed || mine !== attempt) return
        offer = null
        if (r.ok === false) ended(r.reason === 'expired' ? C.expired : (TRANSFER_FAILURE[r.reason] ?? TRANSFER_FAILURE.invalid), 'error', true)
        else ended(C.moved, 'done', false)
      }, () => {
        if (destroyed || mine !== attempt) return
        offer = null
        ended(TRANSFER_FAILURE.unreachable, 'error', true)
      })
    }, () => {
      if (destroyed || mine !== attempt) return
      ended(TRANSFER_FAILURE.unreachable, 'error', true)
    })
  }
  start()

  return {
    destroy: () => {
      if (destroyed) return
      destroyed = true
      stopTick()
      offer?.cancel()
      offer = null
      abort.abort()
      root.replaceChildren()
    },
  }
}
