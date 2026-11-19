<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { viewerId, viewerList } from '@/components/messages/state'
import { chat } from '@/lib/chat'
import { formatSize } from '@/lib/format'

/** Full-screen lightbox over the images currently loaded in the conversation. */
const images = computed(() => (viewerList.value ?? chat.state.messages).filter((m) => m.kind === 'file' && chat.isImage(m)))
const idx = computed(() => images.value.findIndex((m) => m.id === viewerId.value))
const cur = computed(() => images.value[idx.value] ?? null)
const open = computed({
  get: () => !!viewerId.value,
  set: (v) => {
    if (!v) viewerId.value = null
  },
})

const url = ref<string | null>(null)
const failed = ref(false)

watch(cur, async (m) => {
  url.value = null
  failed.value = false
  if (!m) return
  try {
    const u = await chat.fileUrl(m)
    if (cur.value?.id === m.id) {
      url.value = u
      failed.value = !u
    }
  } catch {
    if (cur.value?.id === m.id) failed.value = true
  }
  // Warm the neighbours so arrow keys feel instant.
  for (const n of [images.value[idx.value - 1], images.value[idx.value + 1]]) if (n) void chat.fileUrl(n).catch(() => {})
}, { immediate: true })

// An open image whose message disappeared (deleted, chat switched) closes the viewer.
watch(idx, (i) => {
  if (i < 0) viewerId.value = null
})

function go(d: number) {
  const n = images.value[idx.value + d]
  if (n) viewerId.value = n.id
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') go(-1)
  else if (e.key === 'ArrowRight') go(1)
  else return
  e.preventDefault()
}
watch(open, (o) => (o ? window.addEventListener('keydown', onKey) : window.removeEventListener('keydown', onKey)))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const nav = 'absolute top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white outline-none backdrop-blur hover:bg-white/20 focus-visible:shadow-[var(--glow)]'
const bar = 'flex size-10 items-center justify-center rounded-full bg-white/10 text-white outline-none hover:bg-white/20 focus-visible:shadow-[var(--glow)]'
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :show-close-button="false" aria-describedby=""
      class="inset-0 top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 !rounded-none !border-0 !bg-black/90 !p-0 !shadow-none sm:max-w-none"
      @click="open = false"
    >
      <DialogTitle class="sr-only">{{ cur?.file?.name ?? 'Image' }}</DialogTitle>
      <DialogDescription class="sr-only">Full-size image viewer. Use the arrow keys to move between images.</DialogDescription>

      <div v-if="cur?.file" class="absolute inset-x-0 top-0 z-10 flex items-center gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white" @click.stop>
        <div class="min-w-0 flex-1 text-sm">
          <div class="truncate font-medium">{{ cur.file.name }}</div>
          <div class="text-xs text-white/60">{{ formatSize(cur.file.size) }}<template v-if="images.length > 1"> · {{ idx + 1 }} of {{ images.length }}</template></div>
        </div>
        <a v-if="url" :href="url" :download="cur.file.name" :class="bar" title="Download" aria-label="Download"><Download class="size-5" /></a>
        <button type="button" :class="bar" title="Close (Esc)" aria-label="Close" @click="open = false"><X class="size-5" /></button>
      </div>

      <button v-if="idx > 0" type="button" :class="[nav, 'left-3']" title="Previous (←)" aria-label="Previous image" @click.stop="go(-1)"><ChevronLeft class="size-6" /></button>
      <button v-if="idx >= 0 && idx < images.length - 1" type="button" :class="[nav, 'right-3']" title="Next (→)" aria-label="Next image" @click.stop="go(1)"><ChevronRight class="size-6" /></button>

      <img v-if="url && cur?.file" :key="cur.id" :src="url" :alt="cur.file.name" class="absolute inset-0 m-auto max-h-full max-w-full object-contain p-2 pt-16 pb-6">
      <div v-else class="absolute inset-0 flex items-center justify-center text-white/60">
        <ImageOff v-if="failed" class="size-8" />
        <span v-else class="size-8 animate-pulse rounded-full bg-white/20" />
      </div>
    </DialogContent>
  </Dialog>
</template>
