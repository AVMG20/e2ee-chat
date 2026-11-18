<script setup lang="ts">
import { ref, watch } from 'vue'
import { Clock, Download, FileText, ImageOff, Maximize2 } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { chat } from '@/lib/chat'
import { formatSize } from '@/lib/format'
import type { ChatMessage, FileInfo } from '@/lib/types'

const props = defineProps<{ msg: ChatMessage; mine: boolean; time: string; sending: boolean }>()
const url = ref<string | null>(null)
const loading = ref(true)
const zoom = ref(false)

const file = (): FileInfo => props.msg.file as FileInfo
const isImage = () => file().mime.startsWith('image/')

watch(
  () => props.msg.id,
  async () => {
    loading.value = true
    try {
      url.value = await chat.fileUrl(props.msg)
    } catch {
      url.value = null
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <!-- Image: media card + lightbox -->
  <div v-if="isImage()" class="relative">
    <button
      v-if="url"
      class="group/img relative block cursor-zoom-in overflow-hidden rounded-[1.25rem] bg-inset shadow-[0_0_0_1px_var(--line),var(--shadow-md)] outline-none focus-visible:shadow-[var(--glow)]"
      :aria-label="`Open ${file().name}`" @click="zoom = true"
    >
      <img :src="url" :alt="file().name" class="block max-h-80 min-h-12 min-w-12 object-contain transition duration-300 group-hover/img:scale-[1.02]" style="max-width: min(320px, 100%)">
      <span class="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur transition-opacity group-hover/img:opacity-100"><Maximize2 class="size-3.5" /></span>
    </button>
    <div v-else class="well flex h-36 w-56 items-center justify-center rounded-[1.25rem] text-muted-foreground" :class="loading && 'animate-pulse'">
      <ImageOff v-if="!loading" class="size-6 opacity-60" />
    </div>
    <span class="absolute right-2 bottom-2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] tabular-nums text-white backdrop-blur">
      <Clock v-if="sending" class="size-3" />{{ time }}
    </span>
    <Dialog v-model:open="zoom">
      <DialogContent class="w-auto max-w-[96vw] gap-3 p-3 sm:max-w-[92vw]" :show-close-button="true">
        <DialogTitle class="sr-only">{{ file().name }}</DialogTitle>
        <DialogDescription class="sr-only">Full-size image</DialogDescription>
        <img v-if="url" :src="url" :alt="file().name" class="max-h-[78vh] max-w-full rounded-2xl object-contain">
        <div class="flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
          <span class="truncate">{{ file().name }} · {{ formatSize(file().size) }}</span>
          <a v-if="url" :href="url" :download="file().name" class="btn btn-soft btn-sm shrink-0 !text-foreground"><Download />Save</a>
        </div>
      </DialogContent>
    </Dialog>
  </div>

  <!-- Other files: attachment card -->
  <div v-else class="flex items-center gap-3 py-1">
    <div
      class="flex size-11 shrink-0 items-center justify-center rounded-2xl"
      :class="mine ? 'bg-white/20' : 'text-white [background:var(--grad)]'"
    >
      <FileText class="size-5" />
    </div>
    <div class="min-w-0">
      <div class="max-w-44 truncate text-sm font-semibold sm:max-w-56">{{ file().name }}</div>
      <div class="text-xs opacity-70">{{ formatSize(file().size) }}</div>
    </div>
    <a
      v-if="url" :href="url" :download="file().name" title="Download" aria-label="Download"
      class="btn btn-icon ml-1 shrink-0" :class="mine ? 'bg-white/20 hover:bg-white/30' : 'btn-soft'"
    >
      <Download />
    </a>
    <span v-else class="ml-1 text-xs opacity-70">{{ loading ? 'Loading…' : 'Unavailable' }}</span>
  </div>
</template>
