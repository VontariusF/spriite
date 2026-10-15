/**
 * What `spriite pair` finds on the Factory computer. Every outside effect is
 * injected (environment, commands, files, fetch, clock), so the tests drive
 * the exact discovery with fakes. Nothing here prints; secrets stay in the
 * returned object and only ever leave inside the PAKE-encrypted bundle.
 */
import { join } from 'node:path'

export const LINUX_UNIT = 'spriite-native-broker.service'
export const MACOS_LABEL = 'ai.spriite.native-broker'
export const DEFAULT_PORT = 47821
export const DEFAULT_SERVE_PORT = 47822
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const FACTORY_KEY = /^fk-[A-Za-z0-9_-]{8,256}$/
const FACTORY_API = 'https://api.factory.ai'

/** Same base dir rules as scripts/install-native-broker.sh. */
export function brokerHome({ env, os, home }) {
  if (env.SPRIITE_HOME) return env.SPRIITE_HOME.replace(/\/+$/, '')
  if (os === 'linux') return join(env.XDG_DATA_HOME || join(home, '.local/share'), 'spriite/native-broker')
  return join(home, 'Library/Application Support/Spriite/native-broker')
}

/** `export NAME='value'` lines written by the installer (no secrets in that file). */
export function parseBrokerEnv(text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    const m = /^export ([A-Z0-9_]+)='([^']*)'$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** The installer's one machine-readable line (scripts/install-native-broker.sh --summary). */
export function parseInstallSummary(output) {
  const line = String(output ?? '').split('\n').reverse().find(l => l.startsWith('SPRIITE_INSTALL_SUMMARY '))
  if (!line) return null
  try {
    const v = JSON.parse(line.slice('SPRIITE_INSTALL_SUMMARY '.length))
    return v && v.v === 1 ? v : null
  } catch { return null }
}

export function hostOs(platform) {
  return platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : null
}

const firstLine = s => String(s ?? '').split('\n')[0].trim()
const trimKey = raw => {
  let k = String(raw ?? '').trim()
  const m = /^(?:export\s+)?FACTORY_API_KEY=(.*)$/m.exec(k)
  if (m) k = m[1].trim()
  return k.replace(/^["']|["']$/g, '')
}

/** A Factory API key from droid's own files, when one is readable there (best effort). */
function droidKey(readFile, home) {
  for (const name of ['auth.json', 'credentials.json', 'config.json', 'settings.json']) {
    const text = readFile(join(home, '.factory', name))
    if (!text) continue
    let value
    try { value = JSON.parse(text) } catch { continue }
    const stack = [value]
    while (stack.length) {
      const v = stack.pop()
      if (typeof v === 'string' && FACTORY_KEY.test(v)) return v
      if (v && typeof v === 'object') stack.push(...Object.values(v))
    }
  }
  return null
}

async function getJson(fetchImpl, url, headers, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal })
    if (!res.ok) return { status: res.status, json: null }
    return { status: res.status, json: await res.json() }
  } catch { return { status: 0, json: null } } finally { clearTimeout(timer) }
}

/**
 * Read the install, start or install the broker when allowed, then discover
 * every bundle field. `ctx`: { env, platform, home, hostname, run, readFile,
 * fetch, sleep, installer, models, dryRun, noInstall }.
 *   run(cmd, args, { env }) -> { status, stdout }  (never a shell string)
 */
export async function discover(ctx) {
  const { env = {}, platform, home, hostname = 'computer', run, readFile, fetch: fetchImpl, sleep = ms => new Promise(r => setTimeout(r, ms)) } = ctx
  const os = hostOs(platform)
  if (!os) throw Object.assign(new Error('The Spriite host runs on Linux or macOS. Windows is not supported.'), { code: 'unsupported_os' })
  const base = brokerHome({ env, os, home })
  const envFile = join(base, 'broker.env'), tokenFile = join(base, 'bearer-token'), keyFile = join(base, 'secrets', 'factory-api-key')
  const voiceFile = join(base, 'secrets', 'elevenlabs-api-key'), xPairFile = join(base, 'secrets', 'x-pair.json')
  let brokerEnv = parseBrokerEnv(readFile(envFile))
  const install = { base, present: Object.keys(brokerEnv).length > 0, action: 'reuse', note: null, summary: null }

  // Factory key: the environment, the installed broker's key file, droid's own files.
  let apiKey = null, keySource = null
  if (env.FACTORY_API_KEY && FACTORY_KEY.test(env.FACTORY_API_KEY.trim())) { apiKey = env.FACTORY_API_KEY.trim(); keySource = 'env' }
  if (!apiKey) { const k = trimKey(readFile(keyFile)); if (FACTORY_KEY.test(k)) { apiKey = k; keySource = 'install' } }
  if (!apiKey) { const k = droidKey(readFile, home); if (k) { apiKey = k; keySource = 'droid' } }

  const port = () => Number(brokerEnv.SPRIITE_NATIVE_PORT || DEFAULT_PORT)
  const token = () => firstLine(readFile(tokenFile)) || null
  const online = async () => {
    const t = token()
    if (!t || !install.present) return false
    const r = await getJson(fetchImpl, `http://127.0.0.1:${port()}/v1/native/capabilities`, { authorization: `Bearer ${t}` }, 3000)
    return r.status === 200
  }

  let brokerOnline = await online()
  if (install.present && !brokerOnline) {
    install.action = 'start'
    if (!ctx.dryRun) {
      if (os === 'linux') run('systemctl', ['--user', 'restart', LINUX_UNIT])
      else run('launchctl', ['kickstart', '-k', `gui/${ctx.uid ?? process.getuid?.() ?? 0}/${MACOS_LABEL}`])
      for (let i = 0; i < 10 && !brokerOnline; i++) { await sleep(1000); brokerOnline = await online() }
      if (!brokerOnline) install.note = 'The broker service did not answer; check its logs under the broker base dir.'
    }
  } else if (!install.present) {
    const models = ctx.models ?? env.MODELS ?? ''
    if (ctx.noInstall) { install.action = 'skip'; install.note = 'Not installed (--no-install).' }
    else if (!apiKey) { install.action = 'skip'; install.note = 'Needs a Factory key: set FACTORY_API_KEY and run spriite pair again.' }
    else if (!models) { install.action = 'skip'; install.note = "Needs the Factory model ids it may run: MODELS='[\"<model-id>\"]' npx spriite pair" }
    else {
      install.action = 'install'
      if (!ctx.dryRun) {
        const hasTailscale = run('tailscale', ['version']).status === 0
        const result = run('bash', [ctx.installer, '--non-interactive', '--summary'], {
          env: { ...env, MODELS: models, FACTORY_API_KEY: apiKey, EXPOSE: env.EXPOSE || (hasTailscale ? 'tailscale' : 'none') },
        })
        install.summary = parseInstallSummary(result.stdout)
        if (result.status !== 0 || !install.summary) {
          install.action = 'failed'
          install.note = 'The broker installer did not finish; run scripts/install-native-broker.sh to see why.'
        } else {
          brokerEnv = parseBrokerEnv(readFile(envFile))
          install.present = Object.keys(brokerEnv).length > 0
          for (let i = 0; i < 10 && !brokerOnline; i++) { brokerOnline = await online(); if (!brokerOnline) await sleep(1000) }
        }
      }
    }
  }

  // The private host link: tailscale serve, else the installer's https URL, else SPRIITE_BROKER_URL.
  let brokerUrl = '', via = 'none'
  const servePort = Number(env.SERVE_PORT || DEFAULT_SERVE_PORT)
  if (install.present) {
    const serve = run('tailscale', ['serve', 'status', '--json'])
    const status = serve.status === 0 ? run('tailscale', ['status', '--json']) : null
    if (serve.status === 0 && status?.status === 0) {
      try {
        const served = JSON.stringify(JSON.parse(serve.stdout || '{}'))
        const dns = String(JSON.parse(status.stdout).Self?.DNSName ?? '').replace(/\.$/, '')
        if (dns && served.includes(`:${servePort}`)) { brokerUrl = `https://${dns}:${servePort}`; via = 'tailscale' }
      } catch { /* not served */ }
    }
    if (!brokerUrl && typeof install.summary?.brokerUrl === 'string' && /^https:\/\//.test(install.summary.brokerUrl)) {
      brokerUrl = install.summary.brokerUrl; via = install.summary.via === 'tailscale' ? 'tailscale' : 'https'
    }
    if (!brokerUrl && env.SPRIITE_BROKER_URL && /^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(env.SPRIITE_BROKER_URL)) {
      brokerUrl = env.SPRIITE_BROKER_URL.replace(/\/+$/, ''); via = 'https'
    }
  }

  const ownerId = ID.test(brokerEnv.SPRIITE_NATIVE_OWNER_ID ?? '') ? brokerEnv.SPRIITE_NATIVE_OWNER_ID : ''
  let machineId = ID.test(brokerEnv.SPRIITE_NATIVE_MACHINE_ID ?? '') ? brokerEnv.SPRIITE_NATIVE_MACHINE_ID : ''
  if (!machineId) {
    try { const id = JSON.parse(readFile(join(home, '.factory', 'computer.json')) ?? 'null')?.computerId; if (ID.test(id ?? '')) machineId = id } catch {}
  }

  // The Droid computer: the account's computer list, matched to this machine.
  let computer = null
  if (apiKey) {
    const r = await getJson(fetchImpl, `${FACTORY_API}/api/v0/computers`, { authorization: `Bearer ${apiKey}` })
    const list = Array.isArray(r.json?.computers) ? r.json.computers : []
    const short = String(hostname).split('.')[0].toLowerCase()
    computer = list.find(c => machineId && c?.id === machineId) ??
      list.find(c => typeof c?.name === 'string' && c.name.toLowerCase() === short) ?? null
  }

  // GitHub from the GitHub CLI.
  let gh = { token: null, login: null, repoCount: null }
  const ghToken = run('gh', ['auth', 'token'])
  if (ghToken.status === 0 && /^[A-Za-z0-9_]{20,255}$/.test(firstLine(ghToken.stdout))) {
    gh.token = firstLine(ghToken.stdout)
    const user = run('gh', ['api', 'user'])
    if (user.status === 0) {
      try {
        const u = JSON.parse(user.stdout)
        gh.login = typeof u.login === 'string' ? u.login : null
        const pub = Number(u.public_repos), priv = Number(u.total_private_repos ?? u.owned_private_repos ?? 0)
        gh.repoCount = Number.isFinite(pub) ? pub + (Number.isFinite(priv) ? priv : 0) : null
      } catch {}
    }
  }

  const label = (typeof computer?.name === 'string' && computer.name.trim() ? computer.name.trim() : String(hostname).split('.')[0]).slice(0, 64)
  const bearerToken = install.present ? token() : null
  const xReader = brokerEnv.SPRIITE_NATIVE_X_READER === '1'
  return {
    os, label, install, brokerOnline, servePort,
    host: { brokerUrl, via: brokerUrl ? via : 'none', ownerId, machineId, bearerToken },
    factory: {
      apiKey, keySource, computerId: typeof computer?.id === 'string' ? computer.id : null,
      computerName: typeof computer?.name === 'string' ? computer.name : null, computerOnline: computer?.status === 'active',
    },
    github: gh,
    voice: { elevenLabsKey: voiceKey(env.ELEVENLABS_API_KEY) ?? voiceKey(firstLine(readFile(voiceFile))) },
    x: { hostSignIn: xReader && brokerOnline && !!brokerUrl, pair: xPair(readFile(xPairFile)), pairFile: xPairFile },
  }
}

const ELEVEN_KEY = /^[\x21-\x7e]{8,256}$/
const voiceKey = raw => (typeof raw === 'string' && ELEVEN_KEY.test(raw.trim()) ? raw.trim() : null)
const X_PAIR_TOKEN = /^[\x21-\x7e]{1,4096}$/, X_PAIR_CLIENT = /^[A-Za-z0-9._~-]{1,256}$/
/**
 * The owner's X app client id and token pair, saved on the host
 * (secrets/x-pair.json, 0600) so pairing hands it to the phone. X rotates the
 * pair on every renewal, so a successful pair consumes the file.
 */
function xPair(text) {
  try {
    const v = JSON.parse(text ?? 'null')
    if (!v || !X_PAIR_CLIENT.test(v.clientId ?? '') || !X_PAIR_TOKEN.test(v.accessToken ?? '') ||
        !X_PAIR_TOKEN.test(v.refreshToken ?? '') || v.accessToken === v.refreshToken) return null
    return { clientId: v.clientId, accessToken: v.accessToken, refreshToken: v.refreshToken }
  } catch { return null }
}

/** The PairingBundle (src/pair/types.ts) for a discovery. */
export function toBundle(d, now = Date.now()) {
  const linked = !!(d.host.brokerUrl && d.host.bearerToken && d.host.ownerId && d.host.machineId)
  return {
    v: 1, kind: 'pair', createdAt: now,
    host: {
      label: d.label, machineId: d.host.machineId || 'unknown', ownerId: d.host.ownerId || 'unknown',
      brokerUrl: d.host.brokerUrl, via: d.host.via, os: d.os, online: d.brokerOnline,
    },
    factory: { apiKey: d.factory.apiKey, computerId: d.factory.computerId, computerName: d.factory.computerName, computerOnline: d.factory.computerOnline },
    github: { token: d.github.token, login: d.github.login, repoCount: d.github.repoCount },
    broker: { bearerToken: linked ? d.host.bearerToken : null },
    voice: { elevenLabsKey: d.voice.elevenLabsKey },
    x: { hostSignIn: d.x.hostSignIn, clientId: d.x.pair?.clientId ?? null,
      accessToken: d.x.pair?.accessToken ?? null, refreshToken: d.x.pair?.refreshToken ?? null },
    native: linked ? { brokerUrl: d.host.brokerUrl, ownerId: d.host.ownerId, machineId: d.host.machineId, cwd: '', baseRef: 'refs/heads/main' } : null,
  }
}

/** The Found / Later rows, in the order the phone's Review screen shows them. */
export function summaryRows(d) {
  const linked = !!(d.host.brokerUrl && d.host.bearerToken)
  const repos = d.github.repoCount === null ? '' : ` · ${d.github.repoCount} repo${d.github.repoCount === 1 ? '' : 's'}`
  return [
    { name: 'Factory account', found: !!d.factory.apiKey, detail: d.factory.apiKey ? `Signed in on ${d.label}` : 'No Factory key found' },
    { name: 'Droid computer', found: !!d.factory.computerId,
      detail: d.factory.computerId ? `${d.factory.computerName ?? d.label} · ${d.factory.computerOnline ? 'online' : 'offline'}` : 'No Droid computer found' },
    { name: 'Spriite host', found: linked,
      detail: linked ? (d.host.via === 'tailscale' ? 'Private link over Tailscale' : 'Private link over HTTPS') : (d.install.note ?? 'No private link found') },
    { name: 'GitHub', found: !!d.github.token, detail: d.github.token ? `From the GitHub CLI${repos}` : 'No GitHub CLI sign-in found' },
    { name: 'Voice replies', found: !!d.voice.elevenLabsKey, detail: d.voice.elevenLabsKey ? 'ElevenLabs key from this computer' : 'No ElevenLabs key found' },
    { name: 'X requests', found: !!d.x.pair, detail: d.x.pair ? 'X app and token from this computer' : d.x.hostSignIn ? 'Connect from your computer later' : 'Needs the Spriite host' },
  ]
}

/** --dry-run: the plan with every secret redacted. */
export function dryRunPlan(d, { relay }) {
  const r = v => (v ? '•••• (found)' : '(not found)')
  const lines = [
    'spriite pair --dry-run: nothing is changed and no code is shown.',
    '',
    `relay:          ${relay || '(not set: pass --relay https://relay.example.com)'}`,
    `broker base:    ${d.install.base}`,
    `broker:         ${{ reuse: 'reuse the running install', start: 'start the installed service', install: 'install with scripts/install-native-broker.sh --non-interactive', skip: 'skip', failed: 'install failed' }[d.install.action]}${d.install.note ? ` (${d.install.note})` : ''}`,
    `host link:      ${d.host.brokerUrl || '(none)'} via ${d.host.via}`,
    `owner / machine: ${d.host.ownerId || '(none)'} / ${d.host.machineId || '(none)'}`,
    `broker token:   ${r(d.host.bearerToken)}`,
    `Factory key:    ${r(d.factory.apiKey)}${d.factory.keySource ? ` from ${d.factory.keySource}` : ''}`,
    `Droid computer: ${d.factory.computerId ? `${d.factory.computerName ?? d.label} (${d.factory.computerOnline ? 'online' : 'offline'})` : '(not found)'}`,
    `GitHub token:   ${r(d.github.token)}${d.github.login ? ` for ${d.github.login}` : ''}`,
    `ElevenLabs key: ${r(d.voice.elevenLabsKey)}`,
    `X token pair:   ${r(d.x.pair)}`,
    `X sign-in:      ${d.x.hostSignIn ? 'available on this computer' : 'not available yet'}`,
  ]
  return lines.join('\n')
}
