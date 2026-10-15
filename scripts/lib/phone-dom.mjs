/**
 * A minimal DOM shim for mounting the real phone page (mountPhoneApp and
 * its setup panel) inside the Node suites: this repo has no test browser,
 * and the phone page is the product's execution host. It implements only
 * what the phone surface touches — an element tree, class lists, listeners
 * — and ignores CSS and layout entirely.
 */

const textNode = (t) => ({ text: t })
/** Move bookkeeping: a node knows its parent so remove/replaceWith can work. */
const detach = (node) => {
  const parent = node?.parentNode
  if (parent && Array.isArray(parent.children)) parent.children = parent.children.filter((c) => c !== node)
  if (node && typeof node === 'object') node.parentNode = null
}

export function makeElement(tag) {
  const adopt = (node) => {
    if (node && typeof node === 'object' && node.tagName !== undefined) node.parentNode = el
    return node
  }
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    hidden: false,
    open: false,
    onclick: null,
    style: {},
    dataset: {},
    listeners: {},
    _text: '',
    // A select's options are the option children it was given (panel.ts).
    get options() {
      return el.children
    },
    get textContent() {
      return el._text
    },
    // Faithful to the browser here: setting textContent replaces children.
    set textContent(v) {
      el._text = String(v)
      el.children = []
    },
    append(...nodes) {
      for (const n of nodes) el.children.push(adopt(typeof n === 'string' ? textNode(n) : n))
    },
    replaceChildren(...nodes) {
      el.children = nodes.map((n) => adopt(typeof n === 'string' ? textNode(n) : n))
    },
    // Tree moves the native held-request list performs (parent tracked by
    // append/replaceChildren/insertBefore; a node moved here leaves its old parent).
    insertBefore(node, ref) {
      detach(node)
      const at = ref === null || ref === undefined ? -1 : el.children.indexOf(ref)
      if (at === -1) el.children.push(adopt(node))
      else el.children.splice(at, 0, adopt(node))
      return node
    },
    remove() { detach(el) },
    // The few selectors the phone uses: ':scope > tag', 'tag[attr]', 'tag'.
    querySelector(selector) {
      const scoped = /^:scope\s*>\s*([a-z0-9]+)$/i.exec(selector)
      if (scoped) return el.children.find((c) => c?.tagName === scoped[1].toUpperCase()) ?? null
      const m = /^([a-z0-9]+)(?:\[([a-z-]+)\])?$/i.exec(selector)
      if (!m) return null
      const walk = (node) => {
        for (const c of node.children ?? []) {
          if (c?.tagName === m[1].toUpperCase() && (!m[2] || Boolean(c[m[2]]))) return c
          const hit = c?.children ? walk(c) : null
          if (hit) return hit
        }
        return null
      }
      return walk(el)
    },
    replaceWith(node) {
      const parent = el.parentNode
      if (!parent) return
      const at = parent.children.indexOf(el)
      detach(node)
      parent.children.splice(at, 1, node)
      node.parentNode = parent
      el.parentNode = null
    },
    get childElementCount() {
      return el.children.filter((c) => c && c.tagName !== undefined).length
    },
    addEventListener(type, fn) {
      ;(el.listeners[type] ??= []).push(fn)
    },
    setAttribute(name, value) { el[name] = String(value) },
    getAttribute(name) { return el[name] ?? null },
    removeAttribute(name) { delete el[name] },
    classList: null,
    scrollIntoView() {},
    focus() {},
    click() {
      el.onclick?.()
    },
  }
  // Faithful to the browser: className and classList are two views of one
  // set, so a className assignment is visible to contains() and a classList
  // change shows up in className. A shim that let the two drift hid real
  // code paths from every test — the setup panel reads
  // classList.contains('err') to decide whether a standing status line may
  // be replaced, and a drifted set always answered "no".
  const classes = new Set()
  let className = ''
  const sync = () => {
    className = [...classes].join(' ')
  }
  Object.defineProperty(el, 'className', {
    get: () => className,
    set: (v) => {
      classes.clear()
      for (const c of String(v).split(/\s+/)) if (c !== '') classes.add(c)
      sync()
    },
    enumerable: true,
    configurable: true,
  })
  // Faithful to the browser: a text field's value is '' until it is set.
  // Without this a field that was never assigned read as undefined, and the
  // real code paths that read a field before anyone typed (the setup panel
  // re-verifying a saved credential with an untouched token box) crashed on
  // undefined.trim() in the shim while working on a real phone.
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.value === undefined) el.value = ''
  el.classList = {
    add: (...ns) => {
      ns.forEach((n) => classes.add(n))
      sync()
    },
    remove: (...ns) => {
      ns.forEach((n) => classes.delete(n))
      sync()
    },
    contains: (n) => classes.has(n),
    toggle: (n, on) => {
      const next = on === undefined ? !classes.has(n) : Boolean(on)
      if (next) classes.add(n)
      else classes.delete(n)
      sync()
      return next
    },
  }
  return el
}

/** The text a browser would show in this subtree. */
export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (node.text !== undefined) return node.text
  if (node.children?.length > 0) return node.children.map(textOf).join('')
  return String(node.textContent ?? '')
}

/**
 * Install the document/window globals the phone page reads. The 2-second
 * refresh beat stays dormant (a real timer would keep the suite's process
 * alive); tests drive renders through the phone handle.
 */
export function phoneDom() {
  globalThis.document = {
    createElement: makeElement,
    head: makeElement('head'),
    visibilityState: 'visible',
  }
  globalThis.window = {
    listeners: {},
    addEventListener(type, fn) {
      ;(this.listeners[type] ??= []).push(fn)
    },
    scrollTo() {},
    setInterval: () => 0,
  }
}

/**
 * What a control is called: its visible text, else its aria-label (the
 * redesign's round icon buttons, Talk and Send, carry only a label).
 */
export function labelOf(node) {
  const text = textOf(node)
  return text !== '' ? text : String(node?.['aria-label'] ?? '')
}

/** Every node under `root` matching `pred`, depth first. */
export function allNodes(root, pred = () => true, out = []) {
  if (root === null || root === undefined || typeof root === 'string') return out
  if (pred(root)) out.push(root)
  for (const c of root.children ?? []) allNodes(c, pred, out)
  return out
}

/** The first button (or link) whose text or aria-label is exactly `label`. */
export function control(root, label) {
  return allNodes(root, (n) => (n.tagName === 'BUTTON' || n.tagName === 'A') && labelOf(n) === label)[0] ?? null
}

/**
 * Fakes for the phone's injection seams (contract C8): the setup package's
 * screens and the pairing client. A suite that is not about first run
 * passes these so the phone never mounts another package's real screens
 * (or touches a network) under the shim. Every call is recorded.
 */
export function phoneFakes(overrides = {}) {
  const calls = { setupFlow: [], moveScreen: [], repoChooser: [], signIn: [] }
  const mountFake = (kind, label) => (host, deps) => {
    calls[kind].push(deps)
    const node = makeElement('div')
    node.id = `fake-${kind}`
    node.textContent = label
    host.append(node)
    let screen = deps.entry ?? 'welcome'
    return {
      get screen() { return screen },
      show(entry) { screen = entry },
      refresh() {},
      destroy() { host.replaceChildren() },
    }
  }
  const pairing = {
    normalizePairCode: (s) => String(s).toUpperCase().replace(/[\s-]/g, '') || null,
    formatPairCode: (c) => `${c.slice(0, 3)}-${c.slice(3)}`,
    parsePairQr: () => null,
    claimPairing: async () => ({ ok: false, reason: 'unreachable' }),
    applyPairingBundle: async () => ({ ok: false, applied: [], failed: [] }),
    normalizeTransferCode: () => null,
    formatTransferCode: (c) => c.split('-').join(' · '),
    parseTransferQr: () => null,
    offerTransfer: async () => ({ ok: false, reason: 'unreachable' }),
    receiveTransfer: async () => ({ ok: false, reason: 'unreachable' }),
    applyMoveBundle: async () => ({ ok: false, applied: [], failed: [] }),
    qrMatrix: () => [],
    hostXSignIn: {
      available: () => false,
      start: async (opts) => { calls.signIn.push(opts); return { state: 'unavailable', reason: 'not_paired' } },
      status: async () => ({ state: 'unavailable', reason: 'not_paired' }),
    },
  }
  return {
    calls,
    setupFlow: mountFake('setupFlow', 'Setup flow (test fake)'),
    moveScreen: mountFake('moveScreen', 'Move screen (test fake)'),
    repoChooser: mountFake('repoChooser', 'Repo chooser (test fake)'),
    pairing,
    ...overrides,
  }
}
