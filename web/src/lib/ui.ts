import { onBeforeUnmount, ref } from 'vue'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { errMsg, formatClock } from '@/lib/format'
import type { Conversation, ConvId } from '@/lib/types'

/** Legacy trigger: setting this to true opens the Friends view (ChatLayout resets it). */
export const friendsOpen = ref(false)
export const accountOpen = ref(false)
export const paletteOpen = ref(false)
/** When set, the palette searches only this conversation (Ctrl+K clears it). */
export const paletteScope = ref<ConvId | null>(null)
export const starredOpen = ref(false)
/** Media and files dialog for the active conversation. */
export const mediaOpen = ref(false)

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

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } finally {
      ta.remove()
    }
  }
  toast.success(what)
}

/** Copy with a short-lived `copied` flag, for swapping a copy icon to a check. */
export function useCopy(ms = 1500) {
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  async function copy(text: string, what = 'ID copied') {
    await copyText(text, what)
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), ms)
  }
  onBeforeUnmount(() => clearTimeout(timer))
  return { copied, copy }
}
