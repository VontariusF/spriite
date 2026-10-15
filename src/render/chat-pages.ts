import { measureTextWrap } from '@evenrealities/pretext'
import { SPEAKER_LABEL, type ChatWho } from '../domain/speaker'
import type { EngineView } from '../factory/view'

/** Reading retains the selected provider's label. */
export function chatContextLabel(view: EngineView): string {
  return view.type === 'scene' ? view.scene.contextLabel : view.contextLabel
}

export const CHAT_PAGE_LINES = 6
export const CHAT_PAGE_WIDTH = 528

export function chatLines(text: string): number {
  return text.split('\n').reduce((n, line) => n + (line ? measureTextWrap(line, CHAT_PAGE_WIDTH).lineCount : 1), 0)
}

/** Pixel-bounded pages preserve every character, including unbroken tokens. */
export function paginateChat(log: Array<{ who: ChatWho; text: string; at: number }>): { pages: string[]; latestPage: number } {
  if (log.length === 0) return { pages: ['Nothing said yet. Say a goal, or answer a question, and the conversation lands here.'], latestPage: 0 }
  const blocks = log.map(e => `${SPEAKER_LABEL[e.who] ?? 'Spriite'}: ${e.text.replace(/\r\n/g, '\n')}`)
  let latest = log.length - 1
  while (latest > 0 && log[latest].who === 'you') latest--
  // No reply yet: open on the newest owner turn, not the oldest.
  if (log[latest].who === 'you') latest = log.length - 1
  const pages: string[] = []
  let latestPage = 0
  for (const [index, text] of blocks.entries()) {
    if (index === latest) latestPage = pages.length
    let offset = 0
    while (offset < text.length) {
      let low = 1
      let high = Math.min(950, text.length - offset)
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (chatLines(text.slice(offset, offset + mid)) <= CHAT_PAGE_LINES) low = mid
        else high = mid - 1
      }
      let count = low
      const prefix = text.slice(offset, offset + count)
      const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n'))
      if (offset + count < text.length && boundary > count / 2) count = boundary + 1
      // Never leave half a surrogate pair on either page.
      const end = text.charCodeAt(offset + count - 1)
      if (end >= 0xd800 && end <= 0xdbff && offset + count < text.length) count--
      count = Math.max(1, count)
      pages.push(text.slice(offset, offset + count))
      offset += count
    }
  }
  return { pages, latestPage }
}
