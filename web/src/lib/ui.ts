import { onBeforeUnmount, ref } from 'vue'
import { toast } from 'vue-sonner'

/** Legacy trigger: setting this to true opens the Friends view (ChatLayout resets it). */
export const friendsOpen = ref(false)
export const accountOpen = ref(false)
export const paletteOpen = ref(false)

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } finally {
      ta.remove()
    }
  }
  toast.success(what)
}

/** Copy with a short-lived `copied` flag, for swapping a copy icon to a check. */
export function useCopy(ms = 1500) {
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  async function copy(text: string, what = 'ID copied') {
    await copyText(text, what)
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), ms)
  }
  onBeforeUnmount(() => clearTimeout(timer))
  return { copied, copy }
}
