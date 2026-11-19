import { ref } from 'vue'

const KEY = 'e2ee-chat:theme'
export type ThemeChoice = 'light' | 'dark' | 'system'
export const isDark = ref(true)

const media = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null)

function stored(): 'light' | 'dark' | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

/** The user's choice: light, dark, or system (nothing stored: follow the OS, live). */
export const themeChoice = ref<ThemeChoice>('system')

function apply() {
  document.documentElement.classList.toggle('dark', isDark.value)
}

/** Stored choice wins; otherwise follow the system preference (and its changes). */
export function initTheme() {
  const s = stored()
  themeChoice.value = s ?? 'system'
  isDark.value = s ? s === 'dark' : (media()?.matches ?? true)
  apply()
  media()?.addEventListener('change', (e) => {
    if (stored()) return
    isDark.value = e.matches
    apply()
  })
}

/** Picks light, dark, or system. System forgets the stored choice and follows the OS from now on. */
export function setTheme(choice: ThemeChoice) {
  themeChoice.value = choice
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    /* storage unavailable */
  }
  isDark.value = choice === 'system' ? (media()?.matches ?? true) : choice === 'dark'
  apply()
}

/** Quick toggle between light and dark (an explicit choice). */
export function toggleTheme() {
  setTheme(isDark.value ? 'light' : 'dark')
}
