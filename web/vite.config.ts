import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  // Tauri expects a fixed port and relative asset paths work for both targets.
  server: {
    port: 5173,
    strictPort: true,
    // In dev, the websocket goes to the Rust server.
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
  clearScreen: false,
})
