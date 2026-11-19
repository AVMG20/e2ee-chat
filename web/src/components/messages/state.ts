import { ref, shallowReactive, watch } from 'vue'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
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
  const me = myId()
  for (let i = chat.state.messages.length - 1; i >= 0; i--) {
    const m = chat.state.messages[i]!
    if (m.from === me && m.kind === 'text' && m.status !== 'failed') {
      editingId.value = m.id
      return true
    }
  }
  return false
}

export type Draft = { doc: unknown; reply: ChatMessage | null }
/** In-memory only (never persisted): unsent text and reply target per conversation. */
export const drafts = shallowReactive(new Map<ConvId, Draft>())
watch(() => chat.state.account, (a) => {
  if (!a) {
    drafts.clear()
    replyTo.value = null
  }
})

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
