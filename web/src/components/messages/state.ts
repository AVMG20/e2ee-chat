import { ref, shallowReactive, watch } from 'vue'
import type { JSONContent } from '@tiptap/core'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { addRecent } from '@/lib/emoji'
import { errMsg } from '@/lib/format'
import type { ChatMessage, ConvId } from '@/lib/types'

/** Message the composer is replying to. */
export const replyTo = ref<ChatMessage | null>(null)
/** Id of the message being edited inline. */
export const editingId = ref<string | null>(null)
/** Message awaiting delete confirmation. */
export const deleteTarget = ref<ChatMessage | null>(null)
/** Message briefly highlighted after jumping to it. */
export const flashId = ref<string | null>(null)

export const myId = () => chat.state.account?.id ?? ''

// Engine additions that may land after this UI; read them defensively.
export const extra = () => chat.state
export const sendTyping = () => chat.typing()

export async function reactTo(msg: ChatMessage, emoji: string) {
  addRecent(emoji)
  try {
    await chat.react(msg, emoji)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

export async function deleteMsg(msg: ChatMessage) {
  try {
    await chat.deleteMessage(msg)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

export function startEditLast(): boolean {
  for (let i = chat.state.messages.length - 1; i >= 0; i--) {
    const m = chat.state.messages[i]!
    if (canEditMsg(m)) {
      editingId.value = m.id
      return true
    }
  }
  return false
}

export type Draft = { doc: unknown; reply: ChatMessage | null }
/** Unsent text and reply target per conversation. The text is also saved on this device (see below). */
export const drafts = shallowReactive(new Map<ConvId, Draft>())
/** True once the saved drafts of the signed-in account have been loaded into `drafts`. */
export const draftsReady = ref(false)
/** A file waiting in the composer to be sent. */
export interface Queued { key: number; file: File; url: string | null }
/** Queued files per conversation; kept here so they survive the composer unmounting (Friends view). */
export const queues = new Map<ConvId, Queued[]>()

// Load the saved drafts once per signed-in account; wipe everything on sign-out.
watch(() => chat.state.account?.id, async (id) => {
  draftsReady.value = false
  if (!id) {
    drafts.clear()
    for (const q of [...queues.values()].flat()) if (q.url) URL.revokeObjectURL(q.url)
    queues.clear()
    replyTo.value = null
    return
  }
  let saved: Partial<Record<ConvId, JSONContent>> = {}
  try {
    saved = await chat.loadDrafts()
  } catch {
    /* no saved drafts */
  }
  if (chat.state.account?.id !== id) return
  // Whatever was typed while loading wins over the saved copy.
  for (const [c, doc] of Object.entries(saved) as [ConvId, JSONContent][]) if (!drafts.get(c)?.doc) drafts.set(c, { doc, reply: drafts.get(c)?.reply ?? null })
  draftsReady.value = true
}, { immediate: true })

// Save the draft texts on this device whenever they change (the engine debounces and wipes them at sign-out).
watch(drafts, () => {
  if (!draftsReady.value) return
  const out: Partial<Record<ConvId, JSONContent>> = {}
  for (const [c, d] of drafts) if (d.doc) out[c] = d.doc as JSONContent
  chat.saveDrafts(out)
})

/** What the composer offers to the rest of the chat UI (focus it, quote into it). Set by Composer while mounted. */
export const composerApi: { focus: (() => void) | null; quote: ((text: string) => void) | null } = { focus: null, quote: null }

/** True on phones/tablets where focusing a field pops up the on-screen keyboard. */
export const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/** Puts the cursor back in the message box (after a dialog or an edit closes). Not on touch screens. */
export function refocusComposer() {
  if (coarsePointer()) return
  composerApi.focus?.()
}

/** Asks the message list to scroll: Esc in the composer = bottom, PageUp/PageDown = about a screen. */
export const scrollRequest = ref<{ dir: 'bottom' | 'up' | 'down'; n: number } | null>(null)
let scrollN = 0
export const requestScroll = (dir: 'bottom' | 'up' | 'down') => (scrollRequest.value = { dir, n: ++scrollN })

/** Message whose touch action sheet is open. */
export const sheetMsg = ref<ChatMessage | null>(null)
/** Id of the image message shown in the lightbox. */
export const viewerId = ref<string | null>(null)
/** Images the lightbox steps through when it is opened outside the chat (media gallery); null = the loaded messages. */
export const viewerList = ref<ChatMessage[] | null>(null)
watch(viewerId, (v) => {
  if (!v) viewerList.value = null
})
/** Message being forwarded (dialog rendered in MessageList). */
export const forwardMsg = ref<ChatMessage | null>(null)

export async function toggleStar(msg: ChatMessage) {
  try {
    await chat.toggleStar(msg)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

export async function retry(msg: ChatMessage) {
  try {
    await chat.retryMessage(msg)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

export const canForward = (m: ChatMessage) => m.kind === 'text' || (m.kind === 'file' && !!m.file)

const settled = (m: ChatMessage) => m.status !== 'failed' && m.status !== 'sending'
export const canEditMsg = (m: ChatMessage) => m.from === myId() && settled(m) && m.kind === 'text'
/** Failed (and still-queued) messages can be deleted too; the engine refuses if one is already on its way. */
export const canDeleteMsg = (m: ChatMessage) => m.from === myId() && m.kind !== 'system'
