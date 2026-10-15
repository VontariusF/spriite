// Isolated subprocess crash fixture. Never loads the optional SDK.
import { readFile } from 'node:fs/promises'
import { NativeBroker } from '../broker.mjs'
import { fakeTransport, makeIntent, makeCommand, makeAnswer } from './offline.mjs'
const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const transport = fakeTransport()
if (config.crashAt === 'prepared') transport.preflight = async () => { process.exit(17) }
if (config.crashAt === 'launch') transport.launch = async () => { process.exit(17) }
if (config.crashAt === 'answer') transport.answer = async () => { process.exit(17) }
const broker = await NativeBroker.open({ ...config.options, transport })
if (config.crashAt === 'answer') {
  const snapshot = broker.project('mission-1', config.options.ownerId)
  broker.ingestObservation('mission-1', config.options.ownerId, config.observation)
  const fresh = broker.project('mission-1', config.options.ownerId)
  await broker.command(makeCommand(fresh, 'answer', { commandId: 'crash-answer', answer: makeAnswer(snapshot.attention[0]) }))
} else await broker.prepare(makeIntent())
throw new Error('Crash fixture did not reach invocation')
