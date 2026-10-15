/**
 * Stable opaque IDs (spec §6). IDs are never derived from user text: two
 * missions with identical goal wording mint distinct IDs, and a renamed
 * goal never changes identity. 20 hex chars of a UUID (80 bits) keeps IDs
 * short for HUD evidence lines while staying collision-safe at any
 * realistic mission count.
 */

export function mintId(prefix: string): string {
  const raw = crypto.randomUUID().replace(/-/g, '')
  return `${prefix}_${raw.slice(0, 20)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}
