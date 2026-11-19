import { ref, watch } from 'vue'
import { chat } from '@/lib/chat'
import type { ConvId } from '@/lib/types'
import { openConversation, view } from '@/lib/nav'
import { focusWindow, isDesktop, onWindowFocus, setUnreadBadge } from '@/lib/desktop'

const NOTIFY_KEY = 'e2ee-chat:notify'
const SOUND_KEY = 'e2ee-chat:sound'
const BASE_TITLE = 'E2EE Chat'

const read = (k: string) => {
  try {
    return localStorage.getItem(k) === '1'
  } catch {
    return false
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
export const soundEnabled = ref(read(SOUND_KEY))
/** Set when the browser has blocked notifications, so the UI can explain. */
export const notifyDenied = ref(!isDesktop && notifySupported && Notification.permission === 'denied')

// Desktop: the real permission state is async, so restore the saved preference once it is known.
if (isDesktop && read(NOTIFY_KEY)) {
  loadPlugin()
    .then((p) => p.isPermissionGranted())
    .then((ok) => {
      notifyEnabled.value = ok
    })
    .catch(() => {})
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
function blip() {
  try {
    audio ??= new AudioContext()
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

async function showDesktop(title: string, body: string, conv: ConvId) {
  try {
    const p = await loadPlugin()
    // Click events are only delivered for notifications shown while a listener exists.
    actionListener ??= p
      .onAction((e) => {
        const id = e.notification?.extra?.conv
        void focusWindow()
        if (typeof id === 'string') void openConversation(id as ConvId)
      })
      .catch(() => {})
    await actionListener
    p.sendNotification({ title, body, extra: { conv } })
  } catch {
    /* notifications unavailable */
  }
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
    if (!notifyEnabled.value || !notifySupported) return
    const sender = chat.displayName(m.from)
    const title = conv?.kind === 'group' ? `${sender} in ${conv.title}` : sender
    if (isDesktop) {
      void showDesktop(title, chat.previewText(m), m.conv)
      return
    }
    if (Notification.permission !== 'granted') return
    try {
      const n = new Notification(title, { body: chat.previewText(m), tag: m.conv })
      n.onclick = () => {
        window.focus()
        n.close()
        void openConversation(m.conv)
      }
    } catch {
      /* some webviews don't allow constructing notifications */
    }
  })

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
    stopFocus()
    document.title = BASE_TITLE
    void setUnreadBadge(0)
  }
}
