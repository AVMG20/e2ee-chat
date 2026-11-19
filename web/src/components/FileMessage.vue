<script setup lang="ts">
import { ref, watch } from 'vue'
import { Download, FileText, ImageOff, Maximize2 } from 'lucide-vue-next'
import { viewerId } from '@/components/messages/state'
import { chat } from '@/lib/chat'
import { formatSize } from '@/lib/format'
import type { ChatMessage, FileInfo } from '@/lib/types'

const props = defineProps<{ msg: ChatMessage }>()
const url = ref<string | null>(null)
const loading = ref(true)

const file = (): FileInfo => props.msg.file as FileInfo
const isImage = () => chat.isImage(props.msg)

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
  <!-- Image: inline, rounded, click for lightbox -->
  <div v-if="isImage()" class="mt-1">
    <button
      v-if="url"
      class="group/img relative block w-fit cursor-zoom-in overflow-hidden rounded-lg bg-inset outline-none focus-visible:shadow-[var(--glow)]" style="max-width: min(400px, 100%)"
      :aria-label="`Open ${file().name}`" @click="viewerId = msg.id"
    >
      <img :src="url" :alt="file().name" class="block h-auto max-h-80 min-h-12 w-auto max-w-full min-w-12 object-contain">
      <span class="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md bg-black/50 text-white opacity-0 transition-opacity group-hover/img:opacity-100"><Maximize2 class="size-3.5" /></span>
    </button>
    <div v-else class="well flex h-36 w-56 items-center justify-center rounded-lg text-muted-foreground" :class="loading && 'animate-pulse'">
      <ImageOff v-if="!loading" class="size-6 opacity-60" />
    </div>
  </div>

  <!-- Other files: attachment card -->
  <div v-else class="mt-1 flex w-max max-w-full items-center gap-3 rounded-lg bg-card p-3 shadow-[inset_0_0_0_1px_var(--line)]">
    <FileText class="size-9 shrink-0 text-primary" stroke-width="1.5" />
    <div class="min-w-0">
      <a v-if="url" :href="url" :download="file().name" class="block max-w-52 truncate text-sm font-medium text-[var(--link)] hover:underline sm:max-w-72">{{ file().name }}</a>
      <div v-else class="max-w-52 truncate text-sm font-medium sm:max-w-72">{{ file().name }}</div>
      <div class="text-xs text-muted-foreground">{{ formatSize(file().size) }}<template v-if="!url"> · {{ loading ? 'loading…' : 'unavailable' }}</template></div>
    </div>
    <a v-if="url" :href="url" :download="file().name" title="Download" aria-label="Download" class="btn btn-ghost btn-icon ml-1 shrink-0"><Download /></a>
  </div>
</template>
