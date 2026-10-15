/** Canonical JSON shared with the broker, without Node/SDK imports. */
export const canonicalNativeJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalNativeJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalNativeJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export async function nativeFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalNativeJson(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
