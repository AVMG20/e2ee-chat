import { ref } from 'vue'

export function initials(name: string): string {
  const parts = name.split(/[\s_.-]+/).filter(Boolean)
  const s = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2)
  return s.toUpperCase()
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Stable hue (0-359) derived from a name, for avatar + name colours. */
export function hueOf(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 360
}

/** Compact timestamp for conversation lists. */
export function relTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return formatClock(ts)
  const y = new Date()
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  const days = Math.floor((now.getTime() - ts) / 86_400_000)
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// ---------- time ----------

export type TimeFormat = '24' | '12'
const TIME_KEY = 'e2ee-chat:timeFormat'

function loadTimeFormat(): TimeFormat {
  try {
    return localStorage.getItem(TIME_KEY) === '12' ? '12' : '24'
  } catch {
    return '24'
  }
}

/** Clock style for all times: 24-hour ("13:05", the default) or 12-hour ("1:05pm"). Per device. */
export const timeFormat = ref<TimeFormat>(loadTimeFormat())

export function setTimeFormat(v: TimeFormat) {
  timeFormat.value = v
  try {
    localStorage.setItem(TIME_KEY, v)
  } catch {
    /* storage unavailable */
  }
}

/** Ticks every 30 s so relative times ("3 min ago") stay current. */
export const now = ref(Date.now())
if (typeof window !== 'undefined') setInterval(() => (now.value = Date.now()), 30_000)

/** "13:05", or "1:05pm" with the 12-hour setting. */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  if (timeFormat.value === '24') return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s/g, '').toLowerCase()
}

/** "19 Nov 13:05" (with the year when it isn't this year). */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString([], {
    day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  })
  return `${date} ${formatClock(ts)}`
}

/** Full date and time, for hover titles. */
export function formatFull(ts: number): string {
  return new Date(ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + formatClock(ts)
}

/**
 * Message times: "just now", "5 min ago" for the first hour, then "14:49" today, "Yesterday at 14:49",
 * "Monday at 14:49" within a week, and "12 Nov 14:49" after that.
 */
export function ago(ts: number): string {
  const n = now.value
  const min = Math.floor(Math.max(0, n - ts) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const d = new Date(ts)
  const today = new Date(n)
  const dayDiff = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000,
  )
  if (dayDiff <= 0) return formatClock(ts)
  if (dayDiff === 1) return `Yesterday at ${formatClock(ts)}`
  if (dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} at ${formatClock(ts)}`
  return formatDateTime(ts)
}
