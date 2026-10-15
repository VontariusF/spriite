/**
 * `spriite pair`: discover, show the code and QR, deliver the encrypted
 * PairingBundle, then print the Found / Later summary. Outside effects come
 * in through `io` so the tests run it end to end against a local relay.
 * Secrets are never written to `io.out` or `io.err`.
 */
import { discover, dryRunPlan, summaryRows, toBundle } from './discover.mjs'
import { bigCode, minutesLeft, summaryTable, terminalQr } from './terminal.mjs'
import { chooseRelay, configPath, readConfig, relayUrl, writeConfig } from './config.mjs'

export const MAX_ATTEMPTS = 3

export function parsePairArgs(argv) {
  const opts = { relay: null, dryRun: false, noInstall: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run' || a === '-n') opts.dryRun = true
    else if (a === '--no-install') opts.noInstall = true
    else if (a === '--relay') { opts.relay = argv[++i] ?? ''; if (!opts.relay) return { error: '--relay needs a URL' } }
    else if (a.startsWith('--relay=')) opts.relay = a.slice('--relay='.length)
    else return { error: `unknown option: ${a}` }
  }
  return { opts }
}

/**
 * io: { env, platform, home, hostname, run, readFile, fetch, sleep, now,
 *       out(text), err(text), ask(question) -> Promise<string|null>, isTTY,
 *       protocol (broker/pair-protocol.mjs), installer, saveConfig?, loadConfig? }
 */
export async function runPair(argv, io) {
  const parsed = parsePairArgs(argv)
  if (parsed.error) { io.err(`spriite pair: ${parsed.error} (try: spriite help)\n`); return 2 }
  const { opts } = parsed
  const os = io.platform === 'linux' ? 'linux' : io.platform === 'darwin' ? 'macos' : null
  if (!os) { io.err('spriite pair: the Spriite host runs on Linux or macOS. Windows is not supported.\n'); return 1 }

  const cfgPath = configPath({ env: io.env, os, home: io.home })
  const saved = (io.loadConfig ?? readConfig)(cfgPath)
  let relay = chooseRelay({ flag: opts.relay, env: io.env, saved })
  if (opts.relay && !relayUrl(opts.relay)) { io.err('spriite pair: --relay must be an https URL (for example https://relay.example.com)\n'); return 2 }
  if (!relay && !opts.dryRun) {
    const answer = io.isTTY ? await io.ask('Your Spriite relay URL (for example https://relay.example.com): ') : null
    relay = relayUrl(answer ?? '')
    if (!relay) { io.err('spriite pair: no relay. Pass --relay https://relay.example.com or set SPRIITE_RELAY.\n'); return 2 }
  }
  if (relay && !opts.dryRun && relay !== relayUrl(saved?.relay ?? '')) {
    try { (io.saveConfig ?? writeConfig)(cfgPath, { relay }) } catch { /* saving is a convenience only */ }
  }

  let models = null
  const needsModels = !io.env.MODELS && !opts.noInstall && !opts.dryRun &&
    !(io.readFile(`${(await import('./discover.mjs')).brokerHome({ env: io.env, os, home: io.home })}/broker.env`))
  if (needsModels && io.isTTY) {
    const answer = await io.ask('First install: which Factory model ids may builds use? (comma separated, as droid lists them): ')
    const ids = String(answer ?? '').split(/[\s,]+/).filter(s => /^[A-Za-z0-9][A-Za-z0-9._:\/@-]*$/.test(s))
    if (ids.length) models = JSON.stringify(ids)
  }

  io.out('Spriite pair\n\nLooking around this computer…\n')
  let d
  try {
    d = await discover({ env: io.env, platform: io.platform, home: io.home, hostname: io.hostname, run: io.run, readFile: io.readFile,
      fetch: io.fetch, sleep: io.sleep, installer: io.installer, models, dryRun: opts.dryRun, noInstall: opts.noInstall, uid: io.uid })
  } catch (error) {
    io.err(`spriite pair: ${error?.code === 'unsupported_os' ? error.message : 'discovery failed'}\n`)
    return 1
  }
  if (opts.dryRun) { io.out(`${dryRunPlan(d, { relay })}\n\n${summaryTable(summaryRows(d))}\n`); return 0 }
  io.out(`\n${summaryTable(summaryRows(d))}\n`)

  const P = io.protocol
  const client = P.createRelayClient({ base: `${relay}/pair/v1`, fetchImpl: io.fetch })
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let session
    try {
      session = await P.openHostSession({ kind: 'pair', relay: client, relayLabel: relay, now: io.now, sleep: io.sleep,
        onClaimed: () => io.out('\nYour phone found this computer. Sending everything, encrypted…\n') })
    } catch (error) {
      io.err(`\nspriite pair: the relay at ${relay} did not answer (${error?.reason ?? 'unreachable'}). Check the URL and try again.\n`)
      return 1
    }
    io.out(`\nOn your phone, open Spriite and type this code:\n\n${bigCode(session.display)}\n\n  ${session.display}\n\n`)
    io.out(`Or scan it:\n\n${terminalQr(P.qrMatrix(session.qrText), { color: io.color !== false })}\n\n`)
    io.out(`Works once · expires in ${minutesLeft(session.expiresAt, io.now())}\nListening for your phone…\n`)
    io.onSession?.(session)
    const result = await session.finish(() => toBundle(d, io.now()))
    if (result.ok) {
      // The phone now holds the X pair; a host copy would die on its first renewal.
      if (d.x.pair && d.x.pairFile) { try { io.removeFile?.(d.x.pairFile) } catch {} }
      io.out(`\nPaired with “${d.label}”. Here is what came over:\n\n${summaryTable(summaryRows(d))}\n\nAnything marked Later can be added in Spriite › Settings.\n`)
      return 0
    }
    if (result.reason === 'wrong_code' && attempt < MAX_ATTEMPTS) {
      io.out('\nThat code did not match, so it no longer works. Here is a new one.\n')
      continue
    }
    const why = { expired: 'The code expired after 10 minutes.', wrong_code: 'The code did not match three times.',
      cancelled: 'Pairing was cancelled.', used: 'The code was already used.' }[result.reason] ?? 'The relay stopped answering.'
    io.err(`\n${why} Run npx spriite pair again for a new code.\n`)
    return 1
  }
  return 1
}
