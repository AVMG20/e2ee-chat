<script setup lang="ts">
import { ref, watch } from 'vue'

/** An image that, with `still`, shows only its first frame (so animated GIFs don't move). */
const props = defineProps<{ src: string; still?: boolean }>()
const emit = defineEmits<{ error: [] }>()

// First frames by source, shared by every avatar showing the same picture.
const frames = ((globalThis as { __stillFrames?: Map<string, Promise<string | null>> }).__stillFrames ??= new Map())

function firstFrame(src: string): Promise<string | null> {
  let p = frames.get(src)
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const side = Math.min(img.naturalWidth, img.naturalHeight, 256) || 256
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = side
          const s = Math.min(img.naturalWidth, img.naturalHeight)
          canvas.getContext('2d')!.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, side, side)
          resolve(canvas.toDataURL('image/png'))
        } catch {
          resolve(null)
        }
      }
      img.onerror = () => resolve(null)
      img.src = src
    })
    frames.set(src, p)
  }
  return p
}

const shown = ref<string | null>(props.still ? null : props.src)
watch(
  () => [props.src, props.still] as const,
  async ([src, still]) => {
    if (!still) {
      shown.value = src
      return
    }
    const frame = await firstFrame(src)
    if (props.src === src && props.still) shown.value = frame ?? src
  },
  { immediate: true },
)
</script>

<template>
  <img v-if="shown" :src="shown" alt="" draggable="false" @error="emit('error')">
  <span v-else class="block" />
</template>
