import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import type { ChatMessage } from '@/lib/types'

/** Draws an image URL onto a canvas and returns it as PNG (the only image type every browser lets you copy). */
function toPng(url: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d')?.drawImage(img, 0, 0)
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the image'))), 'image/png')
    }
    img.onerror = () => reject(new Error('Could not load the image'))
    img.src = url
  })
}

/** Copies an image message's picture to the clipboard. */
export async function copyImage(msg: ChatMessage) {
  try {
    // Safari only allows the write inside the click if the blob is handed over as a promise.
    const png = chat.fileUrl(msg).then((url) => {
      if (!url) throw new Error('The image is not available')
      return toPng(url)
    })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    toast.success('Image copied')
  } catch {
    toast.error("Couldn't copy the image")
  }
}

/** Downloads the image under its original file name. */
export async function saveImage(msg: ChatMessage) {
  try {
    const url = await chat.fileUrl(msg)
    if (!url) throw new Error('The image is not available')
    const a = document.createElement('a')
    a.href = url
    a.download = msg.file?.name ?? 'image'
    document.body.append(a)
    a.click()
    a.remove()
  } catch {
    toast.error("Couldn't save the image")
  }
}
