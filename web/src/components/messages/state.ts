import { ref } from 'vue'
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
export const drafts = new Map<ConvId, Draft>()
