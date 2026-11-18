import { ref } from 'vue'
import { toast } from 'vue-sonner'

/** Shared open-state for the Friends dialog (opened from the sidebar and the empty state). */
export const friendsOpen = ref(false)

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
