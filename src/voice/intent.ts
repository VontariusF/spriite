/**
 * Voice phrase parsing: strips the "Hey Spriite" wake phrase and maps the
 * rest onto a small, fixed command grammar. Anything outside the grammar is
 * free text (a goal, or something Spriite cannot act on yet). Commands with
 * consequences are confirmed by the caller before they run.
 *
 * Speech services spell the name in many ways ("Sprite", "Spryte", "Spright"),
 * so the wake pattern matches the sound, not the spelling.
 *
 * No imports and erasable-only syntax: dev scripts load this file with Node.
 */

export const WAKE_NAME = 'Spriite'

/** Biasing terms for the recognizer: the name, its phrase, and product words. */
export const VOICE_KEYTERMS = ['Spriite', 'Hey Spriite', 'Cursor', 'Factory', 'Futarchists']

export type VoiceCommand =
  | 'cancel' | 'pause' | 'resume' | 'status' | 'explain' | 'use_it' | 'restart' | 'demo'

/** Commands that change mission state irreversibly enough to need a readback. */
export const CONFIRM_COMMANDS: readonly VoiceCommand[] = ['use_it', 'restart']

export interface ParsedUtterance {
  /** The utterance started with the name ("Spriite, ..."). */
  wake: boolean
  /** The name was preceded by a greeting ("Hey Spriite"). */
  greeting: boolean
  /** Text after the wake phrase, original casing. */
  body: string
  command: VoiceCommand | null
}

const NAME = String.raw`(?:spr+[iy]+e?te?s?|spr[iy]+ght|sprigh?t)`
const WAKE = new RegExp(
  String.raw`^\s*(?:((?:hey|hi|hello|ok(?:ay)?)[\s,]+))?${NAME}\b[\s,.!?:;-]*`,
  'i',
)

const COMMANDS: [VoiceCommand, RegExp][] = [
  ['cancel', /^(cancel|never ?mind|forget it|nothing)$/],
  ['pause', /^(pause|hold on|stop)( (the )?(build|work|everything|it))?( for now)?$/],
  ['resume', /^(resume|unpause|keep going|carry on|continue|start (it )?again)( (the )?(build|work|everything|it))?( for now)?$/],
  ['status', /\b(status|progress|how('?s| is) (it|the build|everything|work) going|where are we|what'?s happening|how far along)\b/],
  ['explain', /^(explain( (that|it|this))?|why|what happened|tell me more|more details?|details)$/],
  ['use_it', /^(yes )?(use it|use the verified (period|data)|approve( it)?|go with (it|that)|accept( it)?)$/],
  ['restart', /^(restart|start over|reset)( (the )?(demo|everything))?$/],
  // Anchored whole-utterance: a goal like "add a demo screen" is free text.
  ['demo', /^(run|play|show)? ?(the )?demo( mode)?$/],
]

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(please |can you |could you |would you )+/, '')
    .replace(/ for now$/, '')
    .replace(/( please| now| thanks| thank you)+$/, '')
    .trim()
}

export function matchCommand(body: string): VoiceCommand | null {
  const n = normalize(body)
  if (!n) return null
  for (const [cmd, re] of COMMANDS) if (re.test(n)) return cmd
  return null
}

export function parseUtterance(text: string): ParsedUtterance {
  const raw = text.replace(/\s+/g, ' ').trim()
  const m = WAKE.exec(raw)
  const body = (m ? raw.slice(m[0].length) : raw).trim()
  return {
    wake: m !== null,
    greeting: Boolean(m?.[1]),
    body,
    command: matchCommand(body),
  }
}

/** Make free speech safe for an utterance line: no "%" (status owns numbers). */
export function sanitizeSpoken(text: string): string {
  const t = text
    .replace(/(\d+)\s*%/g, '$1 percent')
    .replace(/%/g, ' percent')
    .replace(/\s+/g, ' ')
    .trim()
  return t ? t[0].toUpperCase() + t.slice(1) : t
}
