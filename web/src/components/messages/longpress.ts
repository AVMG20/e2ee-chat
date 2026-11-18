import { onBeforeUnmount, ref } from 'vue'
import { sheetMsg } from '@/components/messages/state'
import type { ChatMessage } from '@/lib/types'

const HOLD_MS = 450
const SLOP_PX = 10

/**
 * Touch long-press on a message opens the action sheet. Spread `bind` on the message row.
 * Only touch pointers take part; mouse keeps the hover toolbar and right-click menu.
 */
export function useLongPress(msg: () => ChatMessage, enabled: () => boolean) {
  const pressing = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let x = 0
  let y = 0
  let lastTouch = 0
  let swallowUntil = 0

  function cancel() {
    clearTimeout(timer)
    timer = undefined
    pressing.value = false
    window.removeEventListener('scroll', cancel, true)
  }

  function fire() {
    cancel()
    swallowUntil = Date.now() + 600 // the release would otherwise click whatever is under the finger
    navigator.vibrate?.(10)
    sheetMsg.value = msg()
  }

  onBeforeUnmount(cancel)

  const bind = {
    onPointerdownCapture(e: PointerEvent) {
      if (e.pointerType !== 'touch') return
      lastTouch = Date.now()
      if (!enabled() || (e.target as HTMLElement).closest('a, input, textarea, [contenteditable], .copy-code')) return
      // Keep the library context menu's own (longer) touch timer from also starting.
      e.stopPropagation()
      cancel()
      x = e.clientX
      y = e.clientY
      pressing.value = true
      window.addEventListener('scroll', cancel, true)
      timer = setTimeout(fire, HOLD_MS)
    },
    onPointermove(e: PointerEvent) {
      if (timer && Math.hypot(e.clientX - x, e.clientY - y) > SLOP_PX) cancel()
    },
    onPointerup: cancel,
    onPointercancel: cancel,
    // Android fires a native contextmenu after a touch hold; never let it through.
    onContextmenuCapture(e: MouseEvent) {
      if (Date.now() - lastTouch < 1500) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    onClickCapture(e: MouseEvent) {
      if (Date.now() < swallowUntil) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }

  return { bind, pressing }
}
