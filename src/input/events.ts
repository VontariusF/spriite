/**
 * Application event model (spec §5.3 "Event normalization"). SDK events are
 * normalized into a small closed set; source metadata is kept where present
 * but never required for core functions.
 */
import type { EventSourceType } from '@evenrealities/even_hub_sdk'

export type InputSource = EventSourceType | 'unknown'

export type AppEvent =
  | { type: 'select'; source: InputSource }
  | { type: 'back'; source: InputSource }
  | { type: 'next'; source: InputSource }
  | { type: 'previous'; source: InputSource }
  | { type: 'list_select'; index: number }
  | { type: 'menu_action'; itemId: number }
  | { type: 'hold_start'; source: InputSource }
  | { type: 'hold_release'; source: InputSource }
  | { type: 'foreground' }
  | { type: 'background' }
  | { type: 'exit'; abnormal: boolean }
