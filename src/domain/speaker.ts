/**
 * Who said a chat line. The log used to know only "you" and "spriite", so
 * the lead's replies, a watched build's messages, and Spriite's own notes
 * all read as "Spriite" (the owner's report). Stored lines from before the
 * split carry 'spriite' and keep reading that way.
 */
export type ChatWho = 'you' | 'spriite' | 'lead' | 'worker' | 'watched'

export const CHAT_WHO: readonly ChatWho[] = ['you', 'spriite', 'lead', 'worker', 'watched']

export function isChatWho(v: unknown): v is ChatWho {
  return typeof v === 'string' && (CHAT_WHO as readonly string[]).includes(v)
}

/** The owner-facing name of each speaker. */
export const SPEAKER_LABEL: Record<ChatWho, string> = {
  you: 'You',
  spriite: 'Spriite',
  lead: 'Lead',
  worker: 'Worker',
  watched: 'Watched build',
}

export interface ChatLine {
  who: ChatWho
  text: string
  at: number
}
