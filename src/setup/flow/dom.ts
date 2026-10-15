/**
 * Small DOM helpers for the setup flow: plain elements like the other panels
 * build, the one-time stylesheet, the step header, and the board's sprite.
 */
import { createSpriteView, type SpriteView } from '../../sprite/dom'
import type { ScenePose } from '../../sprite/poses'
import { SETUP_CSS, SETUP_STYLE_ID } from './styles'
import { iconEl } from './icons'

type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  children: Child[] = [],
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  if (cls) node.className = cls
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c)
  return node
}

export function attr<E extends Element>(node: E, attrs: Record<string, string>): E {
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

export function button(cls: string, children: Child[], onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = el('button', cls, children, { type: 'button' })
  attr(b, attrs)
  b.addEventListener('click', () => {
    if (!b.disabled) onClick()
  })
  return b
}

let stylesInjected = false
/** Inject the `sf-` stylesheet once per document. */
export function ensureSetupStyles(): void {
  if (stylesInjected || typeof document === 'undefined' || !document.head) return
  const style = document.createElement('style')
  style.setAttribute('id', SETUP_STYLE_ID)
  style.textContent = SETUP_CSS
  document.head.append(style)
  stylesInjected = true
}

/** Back button + 3-segment step bar + "n of 3" (Pair, Paired, Repo). */
export function stepHeader(step: 0 | 1 | 2 | 3, onBack: () => void, backLabel = 'Back'): HTMLElement {
  const back = button('sf-back', [iconEl('back')], onBack, { 'aria-label': backLabel })
  if (step === 0) return el('div', 'sf-stephead', [back])
  const segs = [1, 2, 3].map((i) => el('div', i <= step ? 'sf-step sf-step--on' : 'sf-step'))
  return el('div', 'sf-stephead', [
    back,
    el('div', 'sf-steps', segs),
    el('span', 'sf-steplabel', [`${step} of 3`]),
  ])
}

/** A sprite view that is torn down with its screen. */
export interface SpriteSlot { el: HTMLElement; destroy(): void }

export function sprite(pose: ScenePose, px: number): SpriteSlot {
  let view: SpriteView | null = null
  try {
    view = createSpriteView({ pose, px })
  } catch {
    view = null
  }
  const node = view?.el ?? attr(el('div', 'spr'), { role: 'img', 'aria-label': `Spriite, ${pose}` })
  return { el: node, destroy: () => view?.destroy() }
}

export function setText(node: HTMLElement, text: string): void {
  node.textContent = text
}
