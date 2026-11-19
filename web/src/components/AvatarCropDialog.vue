<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'

const props = defineProps<{ file: File | null }>()
const open = defineModel<boolean>('open', { required: true })

const BOX = 280 // crop frame size on screen (px)
const url = ref('')
const nat = ref({ w: 0, h: 0 })
const zoom = ref(1) // 1 = the crop is as large as possible
const cx = ref(0) // crop centre in natural px
const cy = ref(0)
const busy = ref(false)

const maxSize = computed(() => Math.min(nat.value.w, nat.value.h))
const size = computed(() => maxSize.value / zoom.value)
const scale = computed(() => BOX / (size.value || 1)) // screen px per natural px

function clamp() {
  const half = size.value / 2
  cx.value = Math.min(Math.max(cx.value, half), Math.max(nat.value.w - half, half))
  cy.value = Math.min(Math.max(cy.value, half), Math.max(nat.value.h - half, half))
}

watch(() => [open.value, props.file] as const, ([o, f]) => {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = ''
  nat.value = { w: 0, h: 0 }
  if (!o || !f) return
  url.value = URL.createObjectURL(f)
  const img = new Image()
  const u = url.value
  img.onload = () => {
    if (u !== url.value) return
    nat.value = { w: img.naturalWidth, h: img.naturalHeight }
    zoom.value = 1
    cx.value = img.naturalWidth / 2
    cy.value = img.naturalHeight / 2
  }
  img.onerror = () => {
    if (u !== url.value) return
    toast.error("Couldn't open this picture.")
    open.value = false
  }
  img.src = u
}, { immediate: true })

watch(zoom, clamp)

const imgStyle = computed(() => ({
  width: `${nat.value.w * scale.value}px`,
  height: `${nat.value.h * scale.value}px`,
  left: `${BOX / 2 - cx.value * scale.value}px`,
  top: `${BOX / 2 - cy.value * scale.value}px`,
}))

let drag: { x: number; y: number } | null = null
function down(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag = { x: e.clientX, y: e.clientY }
}
function move(e: PointerEvent) {
  if (!drag) return
  cx.value -= (e.clientX - drag.x) / scale.value
  cy.value -= (e.clientY - drag.y) / scale.value
  drag = { x: e.clientX, y: e.clientY }
  clamp()
}
function up() {
  drag = null
}
function wheel(e: WheelEvent) {
  zoom.value = Math.min(4, Math.max(1, zoom.value * (e.deltaY < 0 ? 1.08 : 1 / 1.08)))
}

async function save() {
  if (!props.file) return
  busy.value = true
  try {
    const s = Math.round(size.value)
    await chat.setAvatar(props.file, {
      x: Math.max(0, Math.round(cx.value - size.value / 2)),
      y: Math.max(0, Math.round(cy.value - size.value / 2)),
      size: s,
    })
    open.value = false
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Profile picture</DialogTitle>
        <DialogDescription>Drag to move the picture. Use the slider to zoom.</DialogDescription>
      </DialogHeader>

      <div class="flex justify-center">
        <div
          class="relative touch-none overflow-hidden rounded-lg bg-black select-none"
          :style="{ width: `${BOX}px`, height: `${BOX}px`, maxWidth: '100%' }"
          @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @wheel.prevent="wheel"
        >
          <div v-if="!nat.w" class="absolute inset-0 flex items-center justify-center text-white"><Loader2 class="size-6 animate-spin" /></div>
          <img v-else :src="url" alt="" draggable="false" class="pointer-events-none absolute max-w-none" :style="imgStyle">
          <div class="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_999px_rgba(0,0,0,0.55)] ring-2 ring-white/80" />
        </div>
      </div>

      <input
        v-model.number="zoom" type="range" min="1" max="4" step="0.01" class="w-full accent-[var(--primary)]"
        aria-label="Zoom" title="Zoom" :disabled="!nat.w"
      >

      <DialogFooter>
        <button class="btn btn-soft" :disabled="busy" @click="open = false">Cancel</button>
        <button class="btn btn-primary" :disabled="busy || !nat.w" @click="save">
          <Loader2 v-if="busy" class="animate-spin" />Save
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
