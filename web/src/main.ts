import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { initTheme } from './lib/theme'

initTheme()

createApp(App).mount('#app')

// Installable web app (not in the desktop app, which ships its files itself).
if (import.meta.env.PROD && 'serviceWorker' in navigator && !('__TAURI_INTERNALS__' in globalThis)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`/sw.js?v=${__BUILD_ID__}`).catch(() => {})
  })
}
