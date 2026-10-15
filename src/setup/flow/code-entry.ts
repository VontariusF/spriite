/**
 * The Pair board's code entry: one box per part, a dash where the board
 * draws one, auto-advance, backspace into the previous box, and a pasted (or
 * autofilled) whole code spread across the boxes. Border states follow the
 * board: a filled box 1.5px accent, the next empty one 1.5px muted, later
 * empty ones 1px line.
 *
 * Used twice: the 6-character pairing code (K7Q-2MF) and the three-part
 * transfer code (WREN-41-OAK) on the Move receiver.
 */
import { attr, el } from './dom'

export interface CodeSlot {
  kind: 'char' | 'word' | 'num'
  /** Longest value the box takes (1 for a char box). */
  max: number
  /** Draw the board's dash after this box. */
  dashAfter?: boolean
  label: string
}

export interface CodeEntryOptions {
  slots: CodeSlot[]
  /** Whole-code normalizer (the pairing client's); null when it is not a full code. */
  normalize(text: string): string | null
  /** Split a normalized code into one value per slot. */
  split(code: string): string[]
  /** Join the box values into the text the normalizer reads. */
  join(values: string[]): string
  onChange?(): void
  idPrefix: string
}

export interface CodeEntry {
  readonly el: HTMLElement
  readonly inputs: HTMLInputElement[]
  values(): string[]
  /** The normalized full code, or null while incomplete. */
  code(): string | null
  fill(code: string): boolean
  clear(): void
  focus(): void
  setDisabled(on: boolean): void
  /** What Return/Enter in a box does (the screen's Connect). */
  onSubmit(fn: () => void): void
}

type KeyEv = { key?: string; preventDefault?: () => void }
type PasteEv = { clipboardData?: { getData(t: string): string } | null; preventDefault?: () => void }

export function createCodeEntry(opts: CodeEntryOptions): CodeEntry {
  const { slots } = opts
  const inputs: HTMLInputElement[] = []
  let submit: () => void = () => {}
  const row = el('div', 'sf-coderow')

  const clean = (slot: CodeSlot, raw: string): string => {
    const up = raw.toUpperCase()
    const kept = slot.kind === 'num' ? up.replace(/[^0-9]/g, '')
      : slot.kind === 'word' ? up.replace(/[^A-Z]/g, '')
        : up.replace(/[^0-9A-Z]/g, '')
    return kept.slice(0, slot.max)
  }

  const paint = (): void => {
    let nextMarked = false
    inputs.forEach((input) => {
      input.classList.remove('sf-codebox--filled', 'sf-codebox--next')
      if (input.value !== '') input.classList.add('sf-codebox--filled')
      else if (!nextMarked) {
        input.classList.add('sf-codebox--next')
        nextMarked = true
      }
    })
  }

  const changed = (): void => {
    paint()
    opts.onChange?.()
  }

  const focusAt = (i: number): void => {
    const target = inputs[Math.max(0, Math.min(inputs.length - 1, i))]
    target?.focus()
    try { target?.select?.() } catch { /* not every input selects */ }
  }

  const fill = (code: string): boolean => {
    const parts = opts.split(code)
    if (parts.length !== slots.length) return false
    parts.forEach((p, i) => { inputs[i].value = clean(slots[i], p) })
    changed()
    focusAt(slots.length - 1)
    return true
  }

  /** Several characters landed in box i: a paste, an autofill, a fast typist. */
  const spread = (text: string, i: number): void => {
    const whole = opts.normalize(text)
    if (whole && fill(whole)) return
    if (slots[i].kind === 'char') {
      const chars = clean({ kind: 'char', max: 64, label: '' }, text).split('')
      let j = i
      for (const c of chars) {
        if (j >= inputs.length) break
        inputs[j].value = c
        j++
      }
      changed()
      focusAt(Math.min(j, inputs.length - 1))
      return
    }
    // Word/number boxes: separators move to the next box.
    const pieces = text.split(/[\s\-·.,_/]+/).filter(Boolean)
    let j = i
    for (const p of pieces) {
      if (j >= inputs.length) break
      inputs[j].value = clean(slots[j], p)
      j++
    }
    changed()
    focusAt(Math.min(j, inputs.length - 1))
  }

  slots.forEach((slot, i) => {
    const input = el('input', slot.kind === 'char' ? 'sf-codebox'
      : slot.kind === 'num' ? 'sf-codebox sf-codebox--num' : 'sf-codebox sf-codebox--word')
    attr(input, {
      id: `${opts.idPrefix}${i + 1}`,
      'aria-label': slot.label,
      autocomplete: i === 0 ? 'one-time-code' : 'off',
      autocapitalize: 'characters',
      autocorrect: 'off',
      spellcheck: 'false',
      inputmode: slot.kind === 'num' ? 'numeric' : 'text',
    })
    input.value = ''
    input.addEventListener('input', () => {
      const raw = input.value
      const tooLong = slot.kind === 'char' ? raw.length > 1 : /[\s\-·.,_/]/.test(raw) || raw.length > slot.max
      if (tooLong) {
        input.value = ''
        spread(raw, i)
        return
      }
      input.value = clean(slot, raw)
      changed()
      if (input.value.length >= slot.max && i < inputs.length - 1) focusAt(i + 1)
    })
    input.addEventListener('keydown', (ev: Event) => {
      const e = ev as unknown as KeyEv
      if (e.key === 'Backspace' && input.value === '' && i > 0) {
        e.preventDefault?.()
        inputs[i - 1].value = ''
        changed()
        focusAt(i - 1)
      } else if (e.key === 'ArrowLeft' && i > 0 && input.value === '') {
        focusAt(i - 1)
      } else if (e.key === 'Enter') {
        e.preventDefault?.()
        submit()
      }
    })
    input.addEventListener('paste', (ev: Event) => {
      const e = ev as unknown as PasteEv
      const text = e.clipboardData?.getData('text') ?? ''
      if (!text) return
      e.preventDefault?.()
      spread(text, i)
    })
    inputs.push(input)
    row.append(input)
    if (slot.dashAfter) row.append(el('span', 'sf-codedash'))
  })
  paint()

  return {
    el: row,
    inputs,
    values: () => inputs.map((x) => x.value),
    code: () => {
      const vals = inputs.map((x) => x.value)
      if (vals.some((v, i) => v === '' || (slots[i].kind === 'char' && v.length !== 1))) return null
      return opts.normalize(opts.join(vals))
    },
    fill,
    clear: () => {
      for (const x of inputs) x.value = ''
      changed()
    },
    focus: () => {
      const firstEmpty = inputs.findIndex((x) => x.value === '')
      focusAt(firstEmpty === -1 ? inputs.length - 1 : firstEmpty)
    },
    setDisabled: (on) => {
      for (const x of inputs) x.disabled = on
    },
    onSubmit: (fn) => { submit = fn },
  }
}
