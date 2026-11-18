import { ref } from 'vue'

const KEY = 'e2ee-chat:theme'
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

function apply() {
  document.documentElement.classList.toggle('dark', isDark.value)
}

/** Stored choice wins; otherwise follow the system preference (and its changes). */
export function initTheme() {
  const s = stored()
  isDark.value = s ? s === 'dark' : (media()?.matches ?? true)
  apply()
  media()?.addEventListener('change', (e) => {
    if (stored()) return
    isDark.value = e.matches
    apply()
  })
}

export function toggleTheme() {
  isDark.value = !isDark.value
  try {
    localStorage.setItem(KEY, isDark.value ? 'dark' : 'light')
  } catch {
    /* storage unavailable */
  }
  apply()
}
