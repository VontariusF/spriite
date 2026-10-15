/**
 * Prepack for the `spriite` npm package: copies the native broker (../broker,
 * without fixtures or node_modules) and the installer next to the bin, so a
 * packed `spriite pair` installs the broker without a checkout. `--clean`
 * removes the copies again (postpack). At runtime the bin uses ./broker when
 * packed and ../broker in a checkout (lib/assets.mjs).
 */
import { cpSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = dirname(pkg)
const brokerOut = join(pkg, 'broker'), scriptsOut = join(pkg, 'scripts')
rmSync(brokerOut, { recursive: true, force: true })
rmSync(scriptsOut, { recursive: true, force: true })
if (!process.argv.includes('--clean')) {
  cpSync(join(repo, 'broker'), brokerOut, {
    recursive: true,
    filter: src => !/[\\/](fixtures|node_modules)([\\/]|$)/.test(src.slice(join(repo, 'broker').length)),
  })
  mkdirSync(scriptsOut)
  cpSync(join(repo, 'scripts', 'install-native-broker.sh'), join(scriptsOut, 'install-native-broker.sh'))
  chmodSync(join(scriptsOut, 'install-native-broker.sh'), 0o755)
}
