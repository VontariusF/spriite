/**
 * The setup-flow suite's DOM: the phone page's shim (phone-dom.mjs) plus the
 * little the setup screens add — SVG elements (createElementNS) for the
 * boards' icons and QR — and helpers to walk, query and drive a mounted tree
 * (the shim has no querySelector and its click() only calls onclick).
 */
import { phoneDom, makeElement, textOf } from './phone-dom.mjs'

export { makeElement, textOf }

export function setupDom() {
  phoneDom()
  const doc = globalThis.document
  doc.createElementNS = (_ns, tag) => {
    const el = makeElement(tag)
    el.namespaceURI = _ns
    return el
  }
  return doc
}

/** Every element node under (and including) root. */
export function walk(root) {
  const out = []
  const visit = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || n.tagName === undefined) return
    out.push(n)
    for (const c of n.children ?? []) visit(c)
  }
  visit(root)
  return out
}

export const hasClass = (n, cls) => Boolean(n?.classList?.contains?.(cls))
export const byClass = (root, cls) => walk(root).filter((n) => hasClass(n, cls))
export const firstByClass = (root, cls) => byClass(root, cls)[0] ?? null
export const byAction = (root, action) => walk(root).find((n) => n['data-action'] === action) ?? null
export const byAttr = (root, name, value) => walk(root).filter((n) => n[name] === value)
export const byTag = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase())
/** The innermost element whose own text is exactly `text`. */
export const byText = (root, text) => walk(root).filter((n) => textOf(n).trim() === text)
  .sort((a, b) => walk(a).length - walk(b).length)[0] ?? null
/** Visible = neither it nor an ancestor is hidden. */
export function visibleText(root) {
  if (root === null || root === undefined) return ''
  if (typeof root === 'string') return root
  if (root.text !== undefined) return root.text
  if (root.hidden) return ''
  if (root.children?.length > 0) return root.children.map(visibleText).join('')
  return String(root.textContent ?? '')
}

export function fire(el, type, ev = {}) {
  const event = { type, target: el, preventDefault() { this.defaultPrevented = true }, defaultPrevented: false, ...ev }
  for (const fn of el?.listeners?.[type] ?? []) fn(event)
  return event
}
export const click = (el) => fire(el, 'click')
/** Type into a box the way a browser reports it: set value, fire input. */
export function typeInto(el, value) {
  el.value = value
  return fire(el, 'input')
}

export async function flush(n = 6) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

export function memoryGateway(store = new Map()) {
  return {
    store,
    call: (fn) => fn({
      getLocalStorage: async (k) => store.get(k) ?? '',
      setLocalStorage: async (k, v) => {
        store.set(k, v)
        return true
      },
    }),
  }
}

export function setNavigator(nav) {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true })
}
