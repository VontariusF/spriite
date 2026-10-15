/**
 * The phone's bottom sheet (docs/design/redesign/Ask.dc.html): a scrim
 * (#030805) over the screen and a sheet with 24 px top corners and a handle.
 * The Ask sheet and every Settings sheet use it. Each sheet is mounted once
 * and stays in the page while closed, so its form keeps what was typed.
 */
export interface Sheet {
  /** The overlay (scrim) element; hidden while the sheet is closed. */
  readonly el: HTMLElement
  /** The sheet's content box (under the handle). */
  readonly body: HTMLElement
  readonly isOpen: boolean
  open(): void
  close(): void
}

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  for (const c of children) node.append(c)
  return node
}

export function createSheet(
  host: HTMLElement,
  opts: { id: string; label: string; onClose?: () => void; onOpen?: () => void },
): Sheet {
  const body = make('div', { className: 'ph-sheet-content stack' })
  // The board draws only the handle. On a phone that is not enough to get
  // out: the bar pins the handle and a visible Close above the content, so a
  // sheet always closes without saving, with the keyboard up or scrolled.
  const handle = make('button', { className: 'ph-handle', type: 'button' })
  handle.setAttribute('aria-label', 'Close')
  const closeBtn = make('button', { className: 'ph-sheet-close', type: 'button', textContent: 'Close' })
  const top = make('div', { className: 'ph-sheet-top' }, [handle, closeBtn])
  const sheet = make('div', { className: 'ph-sheet' }, [top, body])
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-label', opts.label)
  const overlay = make('div', { className: 'ph-overlay', id: opts.id }, [sheet])
  overlay.hidden = true
  let isOpen = false
  /** What opening made inert (the page behind the sheet), restored on close. */
  let inerted: HTMLElement[] = []
  let returnFocus: HTMLElement | null = null
  /** Android Back closes the sheet: opening pushes one history entry for it. */
  const hist = typeof history !== 'undefined' && typeof history.pushState === 'function' ? history : null
  let pushed = false
  let closeFromBack = false
  const api: Sheet = {
    el: overlay,
    body,
    get isOpen() { return isOpen },
    open() {
      if (isOpen) return
      isOpen = true
      overlay.hidden = false
      // Modal: everything beside the sheets leaves the tab order and the
      // accessibility tree, and focus moves into the sheet (Escape closes).
      const parent = (host.parentElement ?? host.parentNode) as ParentNode | null
      const siblings = parent?.children ? Array.from(parent.children) as HTMLElement[] : []
      for (const node of siblings) {
        if (node !== host && !node.inert) {
          node.inert = true
          inerted.push(node)
        }
      }
      const active = typeof document !== 'undefined' ? document.activeElement : null
      returnFocus = active && typeof (active as HTMLElement).focus === 'function' ? active as HTMLElement : null
      closeBtn.focus?.()
      if (hist) {
        try { hist.pushState({ ...(hist.state ?? {}), spriiteSheet: opts.id }, ''); pushed = true } catch { pushed = false }
      }
      opts.onOpen?.()
    },
    close() {
      if (!isOpen) return
      isOpen = false
      overlay.hidden = true
      for (const node of inerted) node.inert = false
      inerted = []
      returnFocus?.focus?.()
      returnFocus = null
      // A close from the page (not Back) takes its history entry back out.
      if (pushed && !closeFromBack && hist?.state?.spriiteSheet === opts.id) {
        try { hist.back() } catch {}
      }
      pushed = false
      closeFromBack = false
      opts.onClose?.()
    },
  }
  handle.onclick = () => api.close()
  closeBtn.onclick = () => api.close()
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('popstate', () => {
      if (!isOpen || !pushed) return
      closeFromBack = true
      api.close()
    })
  }
  // Swipe down on the top bar closes, the way a sheet does.
  let dragFrom: number | null = null
  top.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent
    dragFrom = typeof e.clientY === 'number' && (Number(sheet.scrollTop) || 0) <= 0 ? e.clientY : null
  })
  top.addEventListener('pointerup', (ev) => {
    const e = ev as PointerEvent
    if (dragFrom !== null && typeof e.clientY === 'number' && e.clientY - dragFrom > 80) api.close()
    dragFrom = null
  })
  top.addEventListener('pointercancel', () => { dragFrom = null })
  // A tap on the scrim (outside the sheet) closes it, the way a sheet does.
  overlay.addEventListener('click', (ev) => {
    if ((ev as Event | undefined)?.target === overlay) api.close()
  })
  overlay.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent | undefined)?.key === 'Escape') api.close()
  })
  host.append(overlay)
  return api
}
