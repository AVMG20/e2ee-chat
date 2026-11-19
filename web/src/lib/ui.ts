import { onBeforeUnmount, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { errMsg, formatClock } from '@/lib/format'
import { addMembersGroup, friendsTab, pendingAction, renameGroupId, showConv, view } from '@/lib/nav'
import type { Contact, Conversation, ConvId } from '@/lib/types'

/** Legacy trigger: setting this to true opens the Friends view (ChatLayout resets it). */
export const friendsOpen = ref(false)
export const accountOpen = ref(false)
export const paletteOpen = ref(false)
/** Right-hand panel of the conversation view; stays open when switching chats. */
export type SidePanel = 'info' | 'search' | 'media' | 'starred'
export const sidePanel = ref<SidePanel | null>(null)
/** User whose profile the Info panel shows (instead of the chat's own info). Cleared when the chat changes. */
export const panelUser = ref<string | null>(null)
watch(() => chat.state.active, () => (panelUser.value = null))

// A different account (or none) must not inherit the previous one's open panels and dialogs.
watch(() => chat.state.account?.id, (id, prev) => {
  if (id === prev) return
  sidePanel.value = null
  panelUser.value = null
  starredScope.value = 'chat'
  view.value = 'chats'
  friendsTab.value = 'online'
  showConv.value = false
  pendingAction.value = null
  addMembersGroup.value = null
  renameGroupId.value = null
  paletteOpen.value = false
  accountOpen.value = false
})

export type FriendState = 'friend' | 'outgoing' | 'incoming' | 'blocked' | 'none'

/** Where a user stands with me: friend, request pending either way, blocked, or nothing. */
export function friendState(id: string): FriendState {
  const s = chat.state
  if (s.blocked.some((b) => b.id === id)) return 'blocked'
  if (s.contacts[id]?.friend) return 'friend'
  if (s.requests.incoming.some((r) => r.id === id)) return 'incoming'
  if (s.requests.outgoing.some((r) => r.id === id)) return 'outgoing'
  return 'none'
}

/** Sends a friend request and toasts the right outcome (it auto-accepts if they had already asked). Throws on failure. */
export async function sendFriendRequestToast(id: string, name?: string) {
  const wasIncoming = friendState(id) === 'incoming'
  await chat.sendFriendRequest(id)
  const n = name ?? chat.displayName(id)
  toast.success(wasIncoming || chat.state.contacts[id]?.friend ? `You're now friends with ${n}` : `Friend request sent to ${n}`)
}

/** Click on a person: me opens account settings, anyone else opens their profile in the Info panel. */
export function openUser(id: string) {
  if (id === chat.state.account?.id) {
    accountOpen.value = true
    return
  }
  const active = chat.state.active
  panelUser.value = active && active === `dm:${id}` ? null : id
  sidePanel.value = 'info'
}

/** Starred panel: only the open chat, or every chat. */
export const starredScope = ref<'chat' | 'all'>('chat')

/** Below lg the panel covers the conversation, so close it after jumping to a message. */
export function closePanelOnNarrow() {
  if (!window.matchMedia('(min-width: 1024px)').matches) sidePanel.value = null
}

/** Accept the contact's new key (after the user has checked it). */
export async function trustNewKey(c: Contact | null) {
  if (!c) return
  if (!c.pendingFingerprint) {
    toast.error('The new key is not available yet. Try again in a moment.')
    return
  }
  try {
    await chat.trustNewKey(c.id, c.pendingFingerprint)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

export const MUTE_OPTIONS = [
  { label: 'Mute for 1 hour', ms: 3600_000 },
  { label: 'Mute for 8 hours', ms: 8 * 3600_000 },
  { label: 'Mute for 1 week', ms: 7 * 24 * 3600_000 },
  { label: 'Mute until I turn it back on', ms: 0 },
]

export async function setPrefs(id: ConvId, p: { muted?: boolean; mutedUntil?: number; mentionsOnly?: boolean; pinned?: boolean; archived?: boolean }) {
  try {
    await chat.setConvPrefs(id, p)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

/** Mute for `ms` (0 = until turned back on). */
export const muteFor = (id: ConvId, ms: number) => setPrefs(id, ms ? { muted: true, mutedUntil: Date.now() + ms } : { muted: true })

/** Tooltip text for the muted/mentions-only indicators, or '' when neither applies. */
export function muteTitle(c: Conversation): string {
  if (c.muted) {
    if (!c.mutedUntil) return 'Muted'
    const day = new Date(c.mutedUntil).toDateString() === new Date().toDateString()
    return `Muted until ${day ? '' : new Date(c.mutedUntil).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' '}${formatClock(c.mutedUntil)}`
  }
  return c.mentionsOnly ? 'Only notifies for mentions' : ''
}

/** Copies text; resolves true if it reached the clipboard. Toasts the result. */
export async function copyText(text: string, what = 'Copied'): Promise<boolean> {
  const ok = await writeClipboard(text)
  if (ok) toast.success(what)
  else toast.error("Couldn't copy to the clipboard")
  return ok
}

async function writeClipboard(text: string): Promise<boolean> {
  // Desktop: the native clipboard (the webview's own API isn't always available there).
  if ('__TAURI_INTERNALS__' in globalThis) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
      await writeText(text)
      return true
    } catch {
      /* fall through */
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fall through */
  }
  // Last resort: answer a copy event ourselves (works even while a menu or dialog holds focus).
  let done = false
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', text)
    e.preventDefault()
    done = !!e.clipboardData
  }
  document.addEventListener('copy', onCopy, { capture: true, once: true })
  try {
    document.execCommand('copy')
  } catch {
    /* unsupported */
  } finally {
    document.removeEventListener('copy', onCopy, { capture: true })
  }
  return done
}

/** Copy with a short-lived `copied` flag, for swapping a copy icon to a check. */
export function useCopy(ms = 1500) {
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  async function copy(text: string, what = 'ID copied') {
    if (!(await copyText(text, what))) return
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), ms)
  }
  onBeforeUnmount(() => clearTimeout(timer))
  return { copied, copy }
}
