import { ref } from 'vue'
import { chat } from '@/lib/chat'
import type { ConvId } from '@/lib/types'

export type FriendsTab = 'online' | 'all' | 'pending' | 'add'

/** Which page fills the main area. */
export const view = ref<'chats' | 'friends'>('chats')
export const friendsTab = ref<FriendsTab>('online')
/** Narrow screens show either the sidebar or the conversation. */
export const showConv = ref(false)

/** A destructive action waiting for confirmation (rendered once in ChatLayout). */
export const pendingAction = ref<{ kind: 'remove' | 'leave'; id: string } | null>(null)
/** Group whose "add members" dialog is open (rendered once in ChatLayout). */
export const addMembersGroup = ref<string | null>(null)

export function openFriends(tab?: FriendsTab) {
  if (tab) friendsTab.value = tab
  view.value = 'friends'
  showConv.value = true
}

export function showChats() {
  view.value = 'chats'
  showConv.value = false
}

export async function openConversation(id: ConvId) {
  view.value = 'chats'
  showConv.value = true
  await chat.open(id)
}

/** Opens the DM with a friend. */
export const openDm = (userId: string) => openConversation(`dm:${userId}`)
