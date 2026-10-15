/**
 * The phone's icons, copied path for path from the redesign boards
 * (docs/design/redesign/Home, Mission, Ask, Settings). Each one renders as a
 * span holding the board's inline SVG, so the Node DOM shim (no SVG
 * namespace) mounts it as an ordinary element.
 */

const svg = (size: number, body: string, opts: { fill?: boolean; stroke?: string; width?: number; join?: boolean } = {}): string =>
  opts.fill
    ? `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`
    : `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${opts.stroke ?? 'currentColor'}" stroke-width="${opts.width ?? 2}" stroke-linecap="round"${opts.join === false ? '' : ' stroke-linejoin="round"'} aria-hidden="true">${body}</svg>`

export const ICONS = {
  /** Bottom nav, Home board. */
  home: svg(22, '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"></path>'),
  builds: svg(22, '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9h10M7 13h6"></path>'),
  /** The Settings tab as Home.dc.html draws it (not the current tab). */
  settings: svg(22, '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>'),
  /** The Settings tab as Settings.dc.html draws it (the current tab). */
  settingsActive: svg(22, '<circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"></path>'),
  /** Composer chips and buttons, Home board. */
  plus: svg(14, '<path d="M12 5v14M5 12h14"></path>', { join: false }),
  mic: svg(20, '<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>'),
  micSmall: svg(18, '<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>'),
  send: svg(20, '<path d="M12 19V5M5 12l7-7 7 7"></path>', { width: 2.2 }),
  /** Mission board. */
  back: svg(22, '<path d="M15 18l-6-6 6-6"></path>'),
  more: svg(20, '<circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle>', { fill: true }),
  pause: svg(18, '<rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect>', { fill: true }),
  /** Settings rows. */
  chevron: svg(16, '<path d="M9 6l6 6-6 6"></path>'),
  chevronMuted: svg(16, '<path d="M9 6l6 6-6 6"></path>', { stroke: '#9AB1A0' }),
} as const

export type IconName = keyof typeof ICONS

/** A span holding one board icon. */
export function icon(name: IconName, className = 'ph-ico'): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = className
  span.setAttribute('aria-hidden', 'true')
  span.innerHTML = ICONS[name]
  return span
}
