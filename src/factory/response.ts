/** Display text is not execution evidence and never contains protocol tokens. */
export function readableReply(text: string): string {
  return text.replace(/\r\n/g, '\n')
    .replace(/^REQUEST:\s*\S+\s*$/gm, '')
    .replace(/^(?:PLAN_READY|WORK_READY|VERDICT_READY)\s*$/gm, '')
    .replace(/^DECISION:\s*/i, '')
    .replace(/https?:\/\/[^\s<>]+/g, (value) => {
      try {
        const url = new URL(value)
        return url.username || url.password || url.search || url.hash ? '[private link omitted]' : value
      } catch { return value }
    })
    .trim()
}

export function readableQuestionnaire(text: string): string {
  return readableReply(text)
    .replace(/^(\d+)\.\s*\[question\]\s*/gm, '$1. ')
    .replace(/^\[topic\].*(?:\n|$)/gm, '')
    .replace(/^\[option\]\s*/gm, '- ')
    .trim()
}

/**
 * Appended to an owner's answer while the build is still planning: the
 * answer may change the plan, so the Lead sends the complete plan back with
 * its marker (a bare answer leaves Start build waiting on a plan that never
 * comes).
 */
export const PLAN_AGAIN_LINE = 'Then reply with the complete plan, updated for this answer: the numbered plan lines in the format asked for, then a final line exactly PLAN_READY.'

/**
 * A provider reply as the HUD shows it: the readable reply without its
 * protocol markers (SUMMARY:, VERDICT:, BRANCH:, PR:, OPTIONS:, the *_READY
 * lines), whitespace flattened. Falls back to the readable text when the
 * reply was nothing but markers.
 */
export function hudReply(text: string): string {
  const readable = readableReply(text)
    .replace(/^OPTIONS:.*$/gim, '')
    .replace(/^(?:BRANCH|PR):\s*\S+\s*$/gim, '')
    .replace(/\s+/g, ' ')
    .trim()
  const out = readable
    .replace(/\s*\bOPTIONS:\s.*$/, '')
    .replace(/\s*\b(?:BRANCH|PR):\s*\S+/g, '')
    .replace(/\s*\bREQUEST:\s*\S+/g, '')
    .replace(/\s*\b(?:PLAN_READY|WORK_READY|VERDICT_READY)\b/g, '')
    .replace(/^DECISION:\s*/i, '')
    .replace(/^SUMMARY:\s*/i, '')
    .replace(/^VERDICT:\s*PASS\b[\s:.,-]*/i, 'Review passed. ')
    .replace(/^VERDICT:\s*FAIL\b[\s:.,-]*/i, 'Review failed. ')
    .trim()
  return out || readable
}

/**
 * An owner turn as the chat shows it: the words the owner chose or said,
 * without the protocol line Spriite appended ("Then reply with the complete
 * plan ...") or the answer envelope ("The owner chose: ").
 */
export function ownerWords(text: string): string {
  return text.replace(/\r\n/g, '\n')
    .split('\n').filter((line) => line.trim() !== PLAN_AGAIN_LINE).join('\n')
    .replace(/^The owner chose:\s*/i, '')
    .trim()
}

/**
 * A provider reply as the chat (History, the phone's Latest) shows it: the
 * readable reply with its protocol tags turned into plain words. SUMMARY:
 * drops, a verdict reads "Review passed." / "Review failed.", and an
 * OPTIONS: line lists the choices.
 */
export function chatReply(text: string): string {
  return readableReply(text)
    .replace(/^SUMMARY:\s*/gim, '')
    .replace(/^VERDICT:\s*PASS\b[\s:.,-]*/gim, 'Review passed. ')
    .replace(/^VERDICT:\s*FAIL\b[\s:.,-]*/gim, 'Review failed. ')
    .replace(/^OPTIONS:\s*(.+)$/gim, (_line, list: string) =>
      `Options: ${list.split('|').map((o) => o.trim()).filter(Boolean).join(', ')}`)
    .trim()
}
