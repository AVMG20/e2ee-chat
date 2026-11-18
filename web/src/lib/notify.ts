import { ref, watch } from 'vue'
import { chat } from '@/lib/chat'
import { openConversation, view } from '@/lib/nav'

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

export const notifySupported = typeof Notification !== 'undefined'
export const notifyEnabled = ref(read(NOTIFY_KEY) && notifySupported && Notification.permission === 'granted')
export const soundEnabled = ref(read(SOUND_KEY))
/** Set when the browser has blocked notifications, so the UI can explain. */
export const notifyDenied = ref(notifySupported && Notification.permission === 'denied')

/** Turns desktop notifications on (asking permission if needed) or off. Resolves to the new state. */
export async function setNotify(on: boolean): Promise<boolean> {
  if (on && notifySupported) {
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

/** Wires incoming messages to notifications/sound and the unread count to the tab title. Returns a cleanup function. */
export function startNotifications(): () => void {
  const off = chat.onIncoming((m) => {
    const watching = !document.hidden && document.hasFocus() && view.value === 'chats' && chat.state.active === m.conv
    if (watching) return
    if (soundEnabled.value) blip()
    if (!notifyEnabled.value || !notifySupported || Notification.permission !== 'granted') return
    const conv = chat.state.conversations.find((c) => c.id === m.conv)
    const sender = chat.displayName(m.from)
    const title = conv?.kind === 'group' ? `${sender} in ${conv.title}` : sender
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
    () => chat.state.conversations.reduce((n, c) => n + c.unread, 0),
    (n) => {
      document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${BASE_TITLE}` : BASE_TITLE
    },
    { immediate: true },
  )

  return () => {
    off()
    stop()
    document.title = BASE_TITLE
  }
}
