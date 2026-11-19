import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { initTheme } from './lib/theme'

initTheme()

// A tab opened before a new version was deployed asks for files that are gone: reload once to get the new version.
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('e2ee-chat.reloaded') ?? 0)
    if (Date.now() - last < 30_000) return // just reloaded: let the error show instead of looping
    sessionStorage.setItem('e2ee-chat.reloaded', String(Date.now()))
  } catch {
    /* storage unavailable: still reload */
  }
  event.preventDefault()
  location.reload()
})

createApp(App).mount('#app')

// Installable web app (not in the desktop app, which ships its files itself).
if (import.meta.env.PROD && 'serviceWorker' in navigator && !('__TAURI_INTERNALS__' in globalThis)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`/sw.js?v=${__BUILD_ID__}`).catch(() => {})
  })
}
