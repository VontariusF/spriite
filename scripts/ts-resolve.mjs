/**
 * Dev-only ESM loader registration: lets Node run the app's TypeScript
 * modules directly (the app itself stays extensionless for the bundler)
 * by resolving relative specifiers to their .ts files.
 *
 * Usage: node --import ./scripts/ts-resolve.mjs <script.mjs>
 */
import { register } from 'node:module'

register(new URL('./ts-hooks.mjs', import.meta.url))
