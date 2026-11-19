import { ref, watch } from 'vue'
import { chat } from '@/lib/chat'
import type { ConvId } from '@/lib/types'
import { toast } from 'vue-sonner'
import { openConversation, openDm, openFriends, view } from '@/lib/nav'
import { focusWindow, isDesktop, onWindowFocus, setUnreadBadge } from '@/lib/desktop'

const NOTIFY_KEY = 'e2ee-chat:notify'
const SOUND_KEY = 'e2ee-chat:sound'
const CONTENT_KEY = 'e2ee-chat:notify-content'
const DISMISS_KEY = 'e2ee-chat:notify-prompt-dismissed'
const BASE_TITLE = 'E2EE Chat'

/** Stored on/off preference; `fallback` when the user never chose. */
const read = (k: string, fallback = false) => {
  try {
    const v = localStorage.getItem(k)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
const chosen = (k: string) => {
  try {
    return localStorage.getItem(k) !== null
  } catch {
    return true
  }
}
const write = (k: string, v: boolean) => {
  try {
    localStorage.setItem(k, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

type NotificationPlugin = typeof import('@tauri-apps/plugin-notification')
const loadPlugin = (): Promise<NotificationPlugin> => import('@tauri-apps/plugin-notification')

export const notifySupported = isDesktop || typeof Notification !== 'undefined'
export const notifyEnabled = ref(
  !isDesktop && read(NOTIFY_KEY) && notifySupported && Notification.permission === 'granted',
)
/** The desktop app has sound on until the user turns it off; the web asks first. */
export const soundEnabled = ref(read(SOUND_KEY, isDesktop))

/** What a notification reveals: the message, only who it is from, or nothing at all. */
export type NotifyContent = 'full' | 'name' | 'none'
export const notifyContent = ref<NotifyContent>(
  (() => {
    try {
      const v = localStorage.getItem(CONTENT_KEY)
      return v === 'name' || v === 'none' ? v : 'full'
    } catch {
      return 'full'
    }
  })(),
)
export function setNotifyContent(v: NotifyContent) {
  notifyContent.value = v
  try {
    localStorage.setItem(CONTENT_KEY, v)
  } catch {
    /* storage unavailable */
  }
}

/** Web: the user closed the "get notified" banner. */
export const notifyPromptDismissed = ref(read(DISMISS_KEY))
export function dismissNotifyPrompt() {
  notifyPromptDismissed.value = true
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* storage unavailable */
  }
}
/** Set when the browser has blocked notifications, so the UI can explain. */
export const notifyDenied = ref(!isDesktop && notifySupported && Notification.permission === 'denied')

// Desktop: the real permission state is async, so restore the saved preference once it is known.
// Never chosen yet means on: ask for permission now (nothing is stored unless it is granted).
if (isDesktop) {
  const never = !chosen(NOTIFY_KEY)
  if (never || read(NOTIFY_KEY)) {
    loadPlugin()
      .then(async (p) => {
        let ok = await p.isPermissionGranted()
        if (!ok && never) ok = (await p.requestPermission()) === 'granted'
        notifyEnabled.value = ok
        if (ok && never) write(NOTIFY_KEY, true)
      })
      .catch(() => {})
  }
}

async function setNotifyDesktop(on: boolean): Promise<boolean> {
  if (!on) return false
  try {
    const p = await loadPlugin()
    let granted = await p.isPermissionGranted()
    if (!granted) granted = (await p.requestPermission()) === 'granted'
    notifyDenied.value = !granted
    return granted
  } catch {
    return false
  }
}

/** Turns desktop notifications on (asking permission if needed) or off. Resolves to the new state. */
export async function setNotify(on: boolean): Promise<boolean> {
  if (isDesktop) {
    on = await setNotifyDesktop(on)
  } else if (on && notifySupported) {
    let perm = Notification.permission
    if (perm === 'default') perm = await Notification.requestPermission()
    notifyDenied.value = perm === 'denied'
    on = perm === 'granted'
  } else if (on) {
    on = false
  }
  notifyEnabled.value = on
  write(NOTIFY_KEY, on)
  return on
}

export function setSound(on: boolean) {
  soundEnabled.value = on
  write(SOUND_KEY, on)
  if (on) blip()
}

let audio: AudioContext | undefined
function audioCtx(): AudioContext {
  audio ??= new AudioContext()
  if (audio.state === 'suspended') void audio.resume().catch(() => {})
  return audio
}
// WebKit keeps a context created outside a user gesture suspended: unlock it on the first interaction.
if (typeof document !== 'undefined') {
  const unlock = () => {
    try {
      audioCtx()
    } catch {
      /* audio unavailable */
    }
    document.removeEventListener('pointerdown', unlock, true)
    document.removeEventListener('keydown', unlock, true)
  }
  document.addEventListener('pointerdown', unlock, { capture: true })
  document.addEventListener('keydown', unlock, { capture: true })
}

function blip() {
  try {
    const audio = audioCtx()
    const t = audio.currentTime
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, t)
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    osc.connect(gain).connect(audio.destination)
    osc.start(t)
    osc.stop(t + 0.2)
  } catch {
    /* audio unavailable */
  }
}

let actionListener: Promise<unknown> | undefined

/** What a notification's click should open: a conversation or the pending friend requests. */
type Target = { conv: ConvId } | { friends: 'pending' }

async function showDesktop(title: string, body: string, target: Target) {
  try {
    const p = await loadPlugin()
    // Click events are only delivered for notifications shown while a listener exists.
    actionListener ??= p
      .onAction((e) => {
        const extra = e.notification?.extra
        void focusWindow()
        if (typeof extra?.conv === 'string') void openConversation(extra.conv as ConvId)
        else if (extra?.friends === 'pending') openFriends('pending')
      })
      .catch(() => {})
    await actionListener
    p.sendNotification({ title, body, extra: { ...target } })
  } catch {
    /* notifications unavailable */
  }
}

/** Shows a system notification (desktop app or browser) if they are on, honouring the privacy setting. */
function showSystem(title: string, body: string, target: Target, tag: string, message = true) {
  if (!notifyEnabled.value || !notifySupported) return
  // Friend notifications only name a person; the privacy setting still hides who with "Nothing".
  if (notifyContent.value === 'none') {
    title = BASE_TITLE
    body = message ? 'New message' : 'Friends update'
  } else if (notifyContent.value === 'name' && message) {
    body = 'New message'
  }
  if (isDesktop) {
    void showDesktop(title, body, target)
    return
  }
  if (Notification.permission !== 'granted') return
  try {
    const n = new Notification(title, { body, tag })
    n.onclick = () => {
      window.focus()
      n.close()
      if ('conv' in target) void openConversation(target.conv)
      else openFriends(target.friends)
    }
  } catch {
    /* some webviews don't allow constructing notifications */
  }
}

/**
 * Friend requests: toasts (and a system notification) for new incoming requests, and for people who
 * accept mine. Whatever is there at startup or arrives while history downloads stays quiet.
 */
function watchFriends(): () => void {
  const incoming = new Set<string>()
  let outgoing = new Set<string>()
  const friends = new Set<string>()
  const snapshot = () => ({
    inc: chat.state.requests.incoming.map((r) => r.id),
    out: chat.state.requests.outgoing.map((r) => r.id),
    fr: Object.values(chat.state.contacts).filter((c) => c.friend).map((c) => c.id),
    syncing: chat.state.syncing,
  })
  const alert = (title: string, body: string, target: Target, tag: string) => {
    if (chat.state.account?.status === 'dnd') return
    if (soundEnabled.value) blip()
    showSystem(title, body, target, tag, false)
  }
  const first = snapshot()
  first.inc.forEach((id) => incoming.add(id))
  first.fr.forEach((id) => friends.add(id))
  outgoing = new Set(first.out)
  return watch(snapshot, (now) => {
    const quiet = now.syncing
    for (const r of chat.state.requests.incoming) {
      if (incoming.has(r.id)) continue
      incoming.add(r.id)
      if (quiet) continue
      toast(`${r.name} wants to be friends`, { action: { label: 'View', onClick: () => openFriends('pending') } })
      alert(r.name, 'Wants to be friends', { friends: 'pending' }, `friend:${r.id}`)
    }
    for (const id of [...incoming]) if (!now.inc.includes(id)) incoming.delete(id)
    for (const id of now.fr) {
      if (friends.has(id)) continue
      friends.add(id)
      if (quiet || !outgoing.has(id)) continue
      const name = chat.displayName(id)
      toast(`${name} accepted your friend request`, { action: { label: 'Message', onClick: () => void openDm(id) } })
      alert(name, 'Accepted your friend request', { conv: `dm:${id}` }, `friend:${id}`)
    }
    for (const id of [...friends]) if (!now.fr.includes(id)) friends.delete(id)
    outgoing = new Set(now.out)
  }, { deep: true })
}

/** Wires incoming messages to notifications/sound and the unread count to the tab title. Returns a cleanup function. */
export function startNotifications(): () => void {
  // A window hidden in the tray can still look visible to the page: use the window's own focus state.
  let stopFocus = () => {}
  if (isDesktop) void onWindowFocus((active) => chat.setWindowActive(active)).then((un) => (stopFocus = un))
  const off = chat.onIncoming((m) => {
    const watching = chat.isWatching() && view.value === 'chats' && chat.state.active === m.conv
    if (watching) return
    const conv = chat.state.conversations.find((c) => c.id === m.conv)
    if (!chat.shouldNotify(m)) return
    if (soundEnabled.value) blip()
    const sender = chat.displayName(m.from)
    const title = conv?.kind === 'group' ? `${sender} in ${conv.title}` : sender
    showSystem(title, chat.previewText(m), { conv: m.conv }, m.conv)
  })

  const stopFriends = watchFriends()
  const stop = watch(
    () => chat.state.conversations.reduce((n, c) => (c.muted ? n : n + c.unread), 0),
    (n) => {
      document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${BASE_TITLE}` : BASE_TITLE
      void setUnreadBadge(n)
    },
    { immediate: true },
  )

  return () => {
    off()
    stop()
    stopFriends()
    stopFocus()
    document.title = BASE_TITLE
    void setUnreadBadge(0)
  }
}
