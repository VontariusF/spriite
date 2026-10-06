/**
 * ElevenLabs Scribe v2 Realtime client (bring-your-own-key).
 *
 * The user's API key never goes on the wire to the realtime socket: it only
 * mints a 15-minute single-use token over HTTPS (the token endpoint allows
 * browser origins), and the WebSocket authenticates with that token. Glasses
 * PCM (16 kHz, s16le, mono) matches `pcm_16000`, so audio streams unconverted.
 *
 * Audio pushed before the socket opens is buffered, so the microphone can
 * start immediately while the token and session are still being set up.
 *
 * No imports and erasable-only syntax: dev scripts load this file with Node.
 */

export type ScribeErrorKind = 'auth' | 'quota' | 'network' | 'service'

export class ScribeError extends Error {
  readonly kind: ScribeErrorKind
  constructor(kind: ScribeErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export interface ScribeOptions {
  /** Words to bias recognition toward (max 50; adds a 20% cost premium). */
  keyterms?: string[]
  /** Silence that ends a phrase (VAD commit). */
  silenceSecs?: number
  languageCode?: string
  /** Short context sent with the first chunk (under ~50 chars works best). */
  previousText?: string
}

export interface ScribeHooks {
  /** Full text so far: committed segments plus the in-progress partial. */
  onPartial?: (fullText: string) => void
  /** A segment settled (VAD silence or explicit commit). */
  onCommit?: (segment: string, fullText: string) => void
  onError?: (e: ScribeError) => void
}

const API = 'https://api.elevenlabs.io'
const WSS = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
const SAMPLE_RATE = 16000
const CHUNK_BYTES = 8000 // 0.25 s of 16 kHz s16 mono: inside the 0.1-1 s guidance
const OPEN_TIMEOUT_MS = 6000

/** Exchange the user's API key for a single-use realtime token. */
export async function mintToken(apiKey: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${API}/v1/single-use-token/realtime_scribe`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
    })
  } catch {
    throw new ScribeError('network', 'voice service unreachable')
  }
  if (res.status === 401 || res.status === 403) throw new ScribeError('auth', 'voice key rejected')
  if (res.status === 429) throw new ScribeError('quota', 'voice service rate or usage limit')
  if (!res.ok) throw new ScribeError('service', `voice service HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null
  if (!body || typeof body.token !== 'string') throw new ScribeError('service', 'no token in response')
  return body.token
}

export function realtimeUrl(token: string, o: ScribeOptions = {}): string {
  const q = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    token,
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    vad_silence_threshold_secs: String(o.silenceSecs ?? 1.2),
    language_code: o.languageCode ?? 'en',
    filter_background_audio: 'true',
  })
  for (const k of (o.keyterms ?? []).slice(0, 50)) q.append('keyterms', k)
  return `${WSS}?${q.toString()}`
}

function errorKind(type: string): ScribeErrorKind {
  if (type === 'auth_error') return 'auth'
  if (
    type === 'quota_exceeded' || type === 'rate_limited' ||
    type === 'session_time_limit_exceeded' || type === 'unaccepted_terms'
  ) return 'quota'
  return 'service'
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x2000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x2000))
  }
  return btoa(s)
}

export class ScribeSession {
  private ws: WebSocket | null = null
  private open = false
  private closed = false
  private sentFirst = false
  private buf: Uint8Array[] = []
  private bufBytes = 0
  private committed: string[] = []
  private partial = ''
  private commitWaiters: Array<() => void> = []
  private failed: ScribeError | null = null
  private options: ScribeOptions = {}
  private readonly hooks: ScribeHooks

  constructor(hooks: ScribeHooks = {}) {
    this.hooks = hooks
  }

  get error(): ScribeError | null {
    return this.failed
  }

  /** Mint a token and open the realtime socket. Rejects with ScribeError. */
  async start(getToken: () => Promise<string>, options: ScribeOptions = {}): Promise<void> {
    this.options = options
    try {
      const token = await getToken()
      if (this.closed) return
      await this.connect(token)
    } catch (e) {
      const err = e instanceof ScribeError ? e : new ScribeError('service', String(e))
      this.fail(err)
      throw err
    }
  }

  /** Queue glasses PCM; sent in 0.25 s chunks once the session is open. */
  push(pcm: Uint8Array): void {
    if (this.closed || this.failed || pcm.byteLength === 0) return
    this.buf.push(pcm)
    this.bufBytes += pcm.byteLength
    if (this.open) this.flush(false)
  }

  /**
   * End the utterance: send what is buffered with a commit, wait briefly for
   * the settled transcript, then close. Returns the best available text.
   */
  async finish(timeoutMs = 3500): Promise<string> {
    if (this.closed) return this.text()
    if (this.open && !this.failed) {
      const settled = new Promise<void>((r) => this.commitWaiters.push(r))
      this.flush(true)
      await Promise.race([settled, new Promise((r) => setTimeout(r, timeoutMs))])
    }
    this.close()
    return this.text()
  }

  abort(): void {
    this.close()
  }

  /** Committed text plus any unsettled partial (used if a commit times out). */
  text(): string {
    return [...this.committed, this.partial].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }

  private connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(realtimeUrl(token, this.options))
      this.ws = ws
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new ScribeError('network', 'voice session did not start'))
        ws.close()
      }, OPEN_TIMEOUT_MS)
      ws.onmessage = (ev) => {
        let msg: { message_type?: string; text?: string; error?: string; message?: string }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        const type = msg.message_type ?? ''
        if (type === 'session_started') {
          this.open = true
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve()
          }
          this.flush(false)
          return
        }
        if (type === 'partial_transcript') {
          this.partial = (msg.text ?? '').trim()
          this.hooks.onPartial?.(this.text())
          return
        }
        if (type === 'committed_transcript') {
          const seg = (msg.text ?? '').trim()
          if (seg) this.committed.push(seg)
          this.partial = ''
          if (seg) this.hooks.onCommit?.(seg, this.text())
          const waiters = this.commitWaiters
          this.commitWaiters = []
          for (const w of waiters) w()
          return
        }
        if (type.endsWith('_error') || type === 'error' || type === 'quota_exceeded' ||
          type === 'rate_limited' || type === 'unaccepted_terms' ||
          type === 'session_time_limit_exceeded' || type === 'invalid_request' ||
          type === 'commit_throttled' || type === 'queue_overflow' ||
          type === 'resource_exhausted' || type === 'chunk_size_exceeded' ||
          type === 'insufficient_audio_activity') {
          if (type === 'commit_throttled') return // non-fatal
          const err = new ScribeError(errorKind(type), msg.error ?? msg.message ?? type)
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(err)
          }
          this.fail(err)
        }
      }
      ws.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new ScribeError('network', 'voice connection failed'))
        }
      }
      ws.onclose = () => {
        this.open = false
        const waiters = this.commitWaiters
        this.commitWaiters = []
        for (const w of waiters) w()
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new ScribeError('network', 'voice connection closed'))
        }
      }
    })
  }

  private flush(final: boolean): void {
    const ws = this.ws
    if (!ws || !this.open || ws.readyState !== 1) return
    while (this.bufBytes >= CHUNK_BYTES || (final && this.bufBytes > 0)) {
      const n = Math.min(CHUNK_BYTES, this.bufBytes)
      const chunk = this.take(n)
      const last = final && this.bufBytes === 0
      this.send(chunk, last)
    }
    // A commit needs a chunk to ride on; send a short silence if nothing is left.
    if (final && this.bufBytes === 0 && this.lastSentWasNotCommit) this.send(new Uint8Array(640), true)
  }

  private lastSentWasNotCommit = true

  private send(chunk: Uint8Array, commit: boolean): void {
    const msg: Record<string, unknown> = {
      message_type: 'input_audio_chunk',
      audio_base_64: toBase64(chunk),
      commit,
      sample_rate: SAMPLE_RATE,
    }
    if (!this.sentFirst && this.options.previousText) msg.previous_text = this.options.previousText
    this.sentFirst = true
    this.lastSentWasNotCommit = !commit
    this.ws?.send(JSON.stringify(msg))
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let off = 0
    while (off < n) {
      const head = this.buf[0]
      const need = n - off
      if (head.byteLength <= need) {
        out.set(head, off)
        off += head.byteLength
        this.buf.shift()
      } else {
        out.set(head.subarray(0, need), off)
        this.buf[0] = head.subarray(need)
        off += need
      }
    }
    this.bufBytes -= n
    return out
  }

  private fail(err: ScribeError): void {
    if (this.failed) return
    this.failed = err
    this.hooks.onError?.(err)
    this.close()
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.open = false
    this.buf = []
    this.bufBytes = 0
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
    this.ws = null
  }
}
