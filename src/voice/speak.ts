/**
 * Spoken replies (C8, Ready board "spoken replies"): ElevenLabs text to
 * speech, played on the phone. The key is the owner's own ElevenLabs key
 * (the same one Scribe uses); it goes only to api.elevenlabs.io, which the
 * app manifest already whitelists. Nothing is spoken on the glasses: the
 * audio plays through the phone's WebView.
 *
 * speakReply resolves true only when the reply played to its end; false when
 * there was nothing to say, the platform cannot play audio, the service
 * refused, or the caller aborted (the signal stops playback at once).
 *
 * No imports and erasable-only syntax: Node test scripts load this file.
 */

const API = 'https://api.elevenlabs.io'
/** A stock ElevenLabs voice ("Rachel"), available on every account. */
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
/** The low-latency multilingual model. */
export const TTS_MODEL_ID = 'eleven_flash_v2_5'
/** Longest reply spoken in one request (characters); longer text is cut at a sentence. */
export const MAX_SPOKEN_CHARS = 900

/** The audio sink the reply plays through (an HTMLAudioElement in the WebView). */
export interface ReplyPlayer {
  play(src: string, signal: AbortSignal): Promise<boolean>
}

export interface SpeakOptions {
  signal?: AbortSignal
  /** Test seams; default to the WebView's fetch and an HTMLAudioElement. */
  fetchImpl?: typeof fetch
  player?: ReplyPlayer | null
  voiceId?: string
}

/** Can this WebView play a spoken reply at all? */
export function canPlayReplies(): boolean {
  return typeof Audio !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
}

/** The text actually sent: whitespace folded, cut at a sentence end under the cap. */
export function spokenText(text: string): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= MAX_SPOKEN_CHARS) return flat
  const head = flat.slice(0, MAX_SPOKEN_CHARS)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '))
  return end > MAX_SPOKEN_CHARS / 3 ? head.slice(0, end + 1) : `${head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : head.length)}...`
}

/** The default player: an Audio element on a blob URL, stopped by the signal. */
function audioPlayer(): ReplyPlayer | null {
  if (!canPlayReplies()) return null
  return {
    play: (src, signal) => new Promise<boolean>((resolve) => {
      let done = false
      const audio = new Audio(src)
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', onAbort)
        try { audio.pause() } catch { /* already stopped */ }
        resolve(ok)
      }
      const onAbort = () => finish(false)
      if (signal.aborted) return finish(false)
      signal.addEventListener('abort', onAbort)
      audio.addEventListener('ended', () => finish(true))
      audio.addEventListener('error', () => finish(false))
      audio.play().catch(() => finish(false)) // autoplay refused: nothing played
    }),
  }
}

/**
 * Speak `text` with the owner's ElevenLabs key. Abortable; never throws.
 */
export async function speakReply(text: string, key: string, opts: SpeakOptions = {}): Promise<boolean> {
  const words = spokenText(text)
  if (!words || !key) return false
  const signal = opts.signal ?? new AbortController().signal
  if (signal.aborted) return false
  const player = opts.player === undefined ? audioPlayer() : opts.player
  if (player === null) return false // the WebView cannot play audio
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (fetchImpl === null) return false
  let res: Response
  try {
    res = await fetchImpl(`${API}/v1/text-to-speech/${encodeURIComponent(opts.voiceId ?? DEFAULT_VOICE_ID)}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: words, model_id: TTS_MODEL_ID }),
      signal,
    })
  } catch {
    return false // offline, aborted, or refused by the WebView
  }
  if (!res.ok || signal.aborted) return false
  let url = ''
  try {
    const blob = await res.blob()
    if (signal.aborted) return false
    url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(blob) : ''
    if (!url) return false
    return await player.play(url, signal)
  } catch {
    return false
  } finally {
    if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
  }
}
