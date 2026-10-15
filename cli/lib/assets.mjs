/**
 * Where the bin finds the broker and its installer: ./broker and
 * ./scripts/install-native-broker.sh inside the packed package (prepack
 * copies them), ../broker and ../scripts in a checkout.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export function resolveAssets(pkg = PACKAGE_DIR, exists = existsSync) {
  for (const root of [pkg, dirname(pkg)]) {
    const broker = join(root, 'broker'), installer = join(root, 'scripts', 'install-native-broker.sh')
    if (exists(join(broker, 'pair-protocol.mjs')) && exists(installer)) return { root, broker, installer, packed: root === pkg }
  }
  throw new Error('spriite: the broker files are missing (reinstall the package, or run from a Spriite checkout)')
}

export async function loadProtocol(assets = resolveAssets()) {
  return import(pathToFileURL(join(assets.broker, 'pair-protocol.mjs')).href)
}
