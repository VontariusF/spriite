/**
 * Layout definitions (spec §6.1 geometry). Three layouts: conversation,
 * selection (list), and listening (local capture). Container budgets stay
 * well inside the platform ceilings: 12 total, 8 text/list, 4 image.
 */
import {
  ImageContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'

export type LayoutName = 'conversation' | 'selection' | 'listening'

/** Fixed container IDs and names (names must be <= 16 chars). */
export const CT = {
  ctx: { id: 1, name: 'ctx' },
  say: { id: 2, name: 'say' },
  status: { id: 3, name: 'status' },
  bar: { id: 4, name: 'bar' },
  sprite: { id: 5, name: 'sprite' },
  actions: { id: 6, name: 'actions' },
  list: { id: 7, name: 'list' },
  hint: { id: 8, name: 'hint' },
  timer: { id: 9, name: 'timer' },
  note: { id: 10, name: 'note' },
} as const

/** Contextual menu verbs (spec §5.4). Availability is version-gated. */
export const MENU_ITEMS = [
  new MenuItemProperty({ itemID: 1, itemName: 'Talk' }),
  new MenuItemProperty({ itemID: 2, itemName: 'Pause or resume' }),
  new MenuItemProperty({ itemID: 3, itemName: 'Restart demo' }),
  new MenuItemProperty({ itemID: 4, itemName: 'Spriite motion' }),
]

function menu(): MenuContainerProperty {
  return new MenuContainerProperty({ menuItems: MENU_ITEMS })
}

export interface ImageSlot {
  id: number
  name: string
  w: number
  h: number
  role: 'bar' | 'sprite'
}

/** The page payload sent to createStartUpPageContainer / rebuildPageContainer. */
export interface PagePayload {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  imageObject: ImageContainerProperty[]
  menuObject: MenuContainerProperty
}

export interface Layout {
  name: LayoutName
  payload: PagePayload
  captureTextId: number
  images: ImageSlot[]
  hasProgress: boolean
}

export interface ConversationContent {
  contextLabel: string
  utterance: string
  status: string
  actionsText: string
  hasProgress: boolean
}

export function conversationLayout(c: ConversationContent): Layout {
  return {
    name: 'conversation',
    captureTextId: CT.actions.id,
    hasProgress: c.hasProgress,
    images: [
      { id: CT.bar.id, name: CT.bar.name, w: 256, h: 20, role: 'bar' },
      { id: CT.sprite.id, name: CT.sprite.name, w: 64, h: 64, role: 'sprite' },
    ],
    payload: {
      containerTotalNum: 6,
      textObject: [
        new TextContainerProperty({
          xPosition: 24, yPosition: 16, width: 528, height: 32,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.ctx.id, containerName: CT.ctx.name, zOrderIndex: 1,
          content: c.contextLabel, isEventCapture: 0, textColor: 3,
        }),
        new TextContainerProperty({
          xPosition: 112, yPosition: 56, width: 440, height: 112,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.say.id, containerName: CT.say.name, zOrderIndex: 2,
          content: c.utterance, isEventCapture: 0,
        }),
        new TextContainerProperty({
          xPosition: 112, yPosition: 172, width: 440, height: 32,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.status.id, containerName: CT.status.name, zOrderIndex: 3,
          content: c.status, isEventCapture: 0, textColor: 3,
        }),
        new TextContainerProperty({
          xPosition: 24, yPosition: 242, width: 528, height: 42,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.actions.id, containerName: CT.actions.name, zOrderIndex: 6,
          content: c.actionsText, isEventCapture: 1,
        }),
      ],
      imageObject: [
        new ImageContainerProperty({
          xPosition: 112, yPosition: 210, width: 256, height: 20,
          containerID: CT.bar.id, containerName: CT.bar.name, zOrderIndex: 4,
        }),
        new ImageContainerProperty({
          xPosition: 24, yPosition: 72, width: 64, height: 64,
          containerID: CT.sprite.id, containerName: CT.sprite.name, zOrderIndex: 5,
        }),
      ],
      menuObject: menu(),
    },
  }
}

export interface SelectionContent {
  contextLabel: string
  title: string
  items: string[]
}

export function selectionLayout(s: SelectionContent): Layout {
  return {
    name: 'selection',
    captureTextId: CT.list.id,
    hasProgress: false,
    images: [{ id: CT.sprite.id, name: CT.sprite.name, w: 64, h: 64, role: 'sprite' }],
    payload: {
      containerTotalNum: 4,
      textObject: [
        new TextContainerProperty({
          xPosition: 24, yPosition: 16, width: 528, height: 32,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.ctx.id, containerName: CT.ctx.name, zOrderIndex: 1,
          content: s.contextLabel, isEventCapture: 0, textColor: 3,
        }),
        new TextContainerProperty({
          xPosition: 112, yPosition: 56, width: 440, height: 54,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.say.id, containerName: CT.say.name, zOrderIndex: 2,
          content: s.title, isEventCapture: 0,
        }),
      ],
      listObject: [
        new ListContainerProperty({
          xPosition: 24, yPosition: 124, width: 528, height: 164,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.list.id, containerName: CT.list.name, zOrderIndex: 6,
          isEventCapture: 1,
          itemContainer: new ListItemContainerProperty({
            itemCount: s.items.length,
            itemWidth: 0,
            isItemSelectBorderEn: 1,
            itemName: s.items,
          }),
        }),
      ],
      imageObject: [
        new ImageContainerProperty({
          xPosition: 24, yPosition: 52, width: 64, height: 64,
          containerID: CT.sprite.id, containerName: CT.sprite.name, zOrderIndex: 5,
        }),
      ],
      menuObject: menu(),
    },
  }
}

export interface ListeningContent {
  contextLabel: string
  hint: string
  timerText: string
  noteText: string
}

export function listeningLayout(l: ListeningContent): Layout {
  return {
    name: 'listening',
    captureTextId: CT.hint.id,
    hasProgress: false,
    images: [{ id: CT.sprite.id, name: CT.sprite.name, w: 64, h: 64, role: 'sprite' }],
    payload: {
      containerTotalNum: 5,
      textObject: [
        new TextContainerProperty({
          xPosition: 24, yPosition: 16, width: 528, height: 32,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.ctx.id, containerName: CT.ctx.name, zOrderIndex: 1,
          content: l.contextLabel, isEventCapture: 0, textColor: 3,
        }),
        new TextContainerProperty({
          xPosition: 112, yPosition: 84, width: 440, height: 60,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.hint.id, containerName: CT.hint.name, zOrderIndex: 2,
          content: l.hint, isEventCapture: 1,
        }),
        new TextContainerProperty({
          xPosition: 112, yPosition: 164, width: 440, height: 32,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.timer.id, containerName: CT.timer.name, zOrderIndex: 3,
          content: l.timerText, isEventCapture: 0, textColor: 3,
        }),
        new TextContainerProperty({
          xPosition: 24, yPosition: 242, width: 528, height: 42,
          borderWidth: 0, paddingLength: 0,
          containerID: CT.note.id, containerName: CT.note.name, zOrderIndex: 6,
          content: l.noteText, isEventCapture: 0, textColor: 2,
        }),
      ],
      imageObject: [
        new ImageContainerProperty({
          xPosition: 24, yPosition: 72, width: 64, height: 64,
          containerID: CT.sprite.id, containerName: CT.sprite.name, zOrderIndex: 5,
        }),
      ],
      menuObject: menu(),
    },
  }
}
