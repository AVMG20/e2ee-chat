// Desktop (Tauri) helpers. Tauri packages are imported lazily so the web bundle never loads them eagerly.

export const isDesktop = '__TAURI_INTERNALS__' in globalThis

const isWindows = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)

let lastBadge = -1

/** Draws a small red dot with the count, as PNG bytes (for the Windows taskbar overlay). */
async function overlayPng(count: number): Promise<Uint8Array | undefined> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  ctx.fillStyle = '#e11d48'
  ctx.beginPath()
  ctx.arc(16, 16, 16, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const text = count > 99 ? '99+' : String(count)
  ctx.font = `bold ${text.length > 2 ? 15 : text.length > 1 ? 20 : 24}px sans-serif`
  ctx.fillText(text, 16, 17)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined
}

/** Shows the unread count on the app icon (dock/launcher badge, or taskbar overlay on Windows). No-op on the web. */
export async function setUnreadBadge(count: number): Promise<void> {
  if (!isDesktop || count === lastBadge) return
  lastBadge = count
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    if (isWindows) await win.setOverlayIcon(count > 0 ? await overlayPng(count) : undefined)
    else await win.setBadgeCount(count > 0 ? count : undefined)
  } catch {
    lastBadge = -1 // retry on the next change
  }
}

/** Brings the main window to the front (also from the tray). */
export async function focusWindow(): Promise<void> {
  if (!isDesktop) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    await win.show()
    await win.unminimize()
    await win.setFocus()
  } catch {
    /* ignore */
  }
}

export interface AvailableUpdate {
  version: string
  notes: string
  /** Downloads and installs the update, then restarts the app. */
  install: () => Promise<void>
}

/**
 * Asks GitHub whether a newer desktop app is out (the download is checked against the signing key
 * built into the app). Null on the web, when up to date, or when the check fails.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isDesktop) return null
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return null
    return {
      version: update.version,
      notes: update.body ?? '',
      install: async () => {
        await update.downloadAndInstall()
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      },
    }
  } catch {
    return null
  }
}

/** Calls `cb` when the desktop window gains or loses focus (also when it's hidden). Resolves to an unsubscribe function. */
export async function onWindowFocus(cb: (focused: boolean) => void): Promise<() => void> {
  if (!isDesktop) return () => {}
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    cb(await win.isFocused())
    return await win.onFocusChanged(({ payload }) => cb(payload))
  } catch {
    return () => {}
  }
}
