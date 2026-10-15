#!/usr/bin/env node
/**
 * spriite: pair Spriite on your phone with this Factory computer.
 *   npx spriite pair [--relay URL] [--dry-run] [--no-install]
 *   npx spriite help
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { resolveAssets, loadProtocol } from '../lib/assets.mjs'
import { runPair } from '../lib/pair.mjs'
import { HELP } from '../lib/terminal.mjs'

const [major] = process.versions.node.split('.').map(Number)
if (major < 22) {
  process.stderr.write(`spriite needs Node.js 22 or newer (this is ${process.version}).\n`)
  process.exit(1)
}

const [command, ...rest] = process.argv.slice(2)
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(HELP)
  process.exit(0)
}
if (command !== 'pair') {
  process.stderr.write(`spriite: unknown command "${command}"\n\n${HELP}`)
  process.exit(2)
}

const assets = resolveAssets()
const protocol = await loadProtocol(assets)
/** Commands run without a shell; a missing tool is a non-zero status, never a throw. */
const run = (cmd, args, { env } = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
  return { status: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? '' }
}
const readFile = path => { try { return readFileSync(path, 'utf8') } catch { return null } }
const ask = async question => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return await rl.question(question) } finally { rl.close() }
}
// Ctrl+C closes the open session on the relay before exiting.
let current = null
process.once('SIGINT', () => {
  if (!current) process.exit(130)
  current.cancel().finally(() => process.exit(130))
})

const code = await runPair(rest, {
  env: process.env, platform: process.platform, home: homedir(), hostname: hostname(), uid: process.getuid?.(),
  run, readFile, removeFile: path => rmSync(path, { force: true }), fetch: globalThis.fetch, now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  out: text => process.stdout.write(text), err: text => process.stderr.write(text),
  ask, isTTY: !!process.stdin.isTTY, color: !!process.stdout.isTTY && !process.env.NO_COLOR,
  protocol, installer: assets.installer, onSession: s => { current = s },
})
process.exit(code)
