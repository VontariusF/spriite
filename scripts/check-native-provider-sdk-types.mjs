/** Type-only pinned SDK check. Never imports or evaluates the SDK package. */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const sdk = process.argv[2] && resolve(process.argv[2])
const nodeTypeRoot = process.argv[3] ? resolve(process.argv[3]) : join(root, 'node_modules/@types')
if (!sdk || JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version !== '0.9.1') {
  throw new Error('Pass the statically extracted @factory/droid-sdk 0.9.1 directory')
}
const zodTypes = [join(root, 'node_modules/zod/v3/index.d.ts'), join(dirname(dirname(sdk)), 'zod/v3/index.d.ts')]
  .find(existsSync)
if (!zodTypes) throw new Error('Existing non-any Zod 3 declarations are required')
const work = mkdtempSync(join(tmpdir(), 'spriite-native-sdk-types-'))
try {
  // SDK schema types use Zod 3. Use the existing package's compatible v3
  // declarations, not its v4 default and not a permissive any shim.
  const proof = join(work, 'proof.ts')
  writeFileSync(proof, `
import type { InitializeSessionRequestParams, RequestPermissionResult, AskUserResult, DaemonClient } from '@factory/droid-sdk'
import type { SdkInitializeParams } from '${join(root, 'broker/sdk-provider.mjs')}'
type IsAny<T> = 0 extends (1 & T) ? true : false
type Assert<T extends true> = T
type InitNotAny = Assert<IsAny<InitializeSessionRequestParams> extends false ? true : false>
type PermissionNotAny = Assert<IsAny<RequestPermissionResult> extends false ? true : false>
type AskNotAny = Assert<IsAny<AskUserResult> extends false ? true : false>
type Reply = Assert<ReturnType<DaemonClient['sendPermissionResponse']> extends void ? true : false>
type PassiveMessages = Assert<'getSessionMessages' extends keyof DaemonClient ? true : false>
type DaemonInitParams = Parameters<DaemonClient['initializeSession']>[0]
type DaemonNotAny = Assert<IsAny<DaemonInitParams> extends false ? true : false>
type InitFields = Assert<Exclude<keyof SdkInitializeParams, keyof DaemonInitParams> extends never ? true : false>
type MissionFields = Assert<Exclude<keyof SdkInitializeParams['missionSettings'], keyof NonNullable<DaemonInitParams['missionSettings']>> extends never ? true : false>
export type Proof = InitNotAny | PermissionNotAny | AskNotAny | Reply | PassiveMessages | InitFields | MissionFields | DaemonNotAny
`)
  const project = join(work, 'tsconfig.json')
  writeFileSync(project, JSON.stringify({
    compilerOptions: {
      target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'DOM'],
      noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, strict: true,
      baseUrl: root, typeRoots: [nodeTypeRoot], types: ['node'],
      paths: {
        '@factory/droid-sdk': [join(sdk, 'dist/index.d.ts')],
        zod: [zodTypes],
        '@opentelemetry/api': [join(root, 'node_modules/@opentelemetry/api')],
        eventemitter3: [join(root, 'node_modules/eventemitter3')],
      },
    },
    files: [join(root, 'broker/sdk-adapter.ts'), proof],
  }))
  const result = spawnSync(join(root, 'node_modules/.bin/tsc'), ['--project', project], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) process.exitCode = 1
  else console.log('PASS: optional SDK source checked against static 0.9.1 declarations with non-any Zod 3 schema types; SDK not executed')
} finally {
  rmSync(work, { recursive: true, force: true }) // Only this invocation's temporary type project.
}
