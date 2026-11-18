import { ref } from 'vue'

const KEY = 'e2ee-chat:theme'
export const isDark = ref(true)

function apply() {
  document.documentElement.classList.toggle('dark', isDark.value)
}

export function initTheme() {
  try {
    isDark.value = localStorage.getItem(KEY) !== 'light'
  } catch {
    isDark.value = true
  }
  apply()
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
