import { cardsForSurface, requiresAcknowledgement } from './build'
import type { BriefingCard, BriefingRecord } from '../domain/types'

/** A surface account never says that delivery or acknowledgement is reading. */
export interface BriefingSurface {
  brief: BriefingRecord
  cards: BriefingCard[]
  index: number
  confirming: boolean
}

export function briefingSurface(brief: BriefingRecord): BriefingSurface {
  return { brief, cards: cardsForSurface(brief, 'glasses'), index: 0, confirming: false }
}

export function briefingText(surface: BriefingSurface): { body: string; status: string; acknowledge: boolean } {
  const omitted = Math.max(0, surface.brief.cards.length - surface.cards.length)
  if (surface.confirming) {
    return {
      body: `Acknowledge this account?${omitted ? ` Includes ${omitted} cards not shown here.` : ''} Questions stay open. This does not mean every item was read.`,
      status: 'Account only, not an answer',
      acknowledge: true,
    }
  }
  const card = surface.cards[surface.index]
  return {
    body: card ? [card.headline, card.detail].filter(Boolean).join(' ') : 'No changes to account for.',
    status: `Card ${surface.index + 1} of ${surface.cards.length || 1}${omitted ? `; ${omitted} not shown` : ''}`,
    acknowledge: requiresAcknowledgement(surface.brief),
  }
}
