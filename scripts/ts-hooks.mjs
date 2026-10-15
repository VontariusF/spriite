/**
 * Dev-only resolve hook: app modules import each other extensionless
 * (Vite resolves them); when Node runs the engine in dev scripts, append
 * ".ts" so the same sources load unchanged. No app code is altered.
 */
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('.') || specifier.startsWith('/')) && !/\.(ts|mjs|js|json)$/.test(specifier)) {
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await nextResolve(specifier + suffix, context)
      } catch {
        // try the next suffix
      }
    }
  }
  return nextResolve(specifier, context)
}
