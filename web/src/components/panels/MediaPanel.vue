<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Download, FileText, Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { viewerId, viewerList } from '@/components/messages/state'
import { chat } from '@/lib/chat'
import { errMsg, formatDate, formatSize } from '@/lib/format'
import type { ChatMessage } from '@/lib/types'

/** Images and files of the active conversation. */
const items = ref<ChatMessage[]>([])
const urls = ref<Record<string, string | null>>({})
const loading = ref(false)

const images = computed(() => items.value.filter((m) => chat.isImage(m)))
/** Images are loaded a page at a time; other files only when downloaded. */
const PAGE = 48
const limit = ref(PAGE)
const visibleImages = computed(() => images.value.slice(0, limit.value))
const files = computed(() => items.value.filter((m) => !chat.isImage(m)))

async function load() {
  const conv = chat.state.active
  items.value = []
  urls.value = {}
  limit.value = PAGE
  if (!conv) return
  loading.value = true
  try {
    const list = await chat.mediaOf(conv)
    if (chat.state.active !== conv) return
    items.value = list
    await loadUrls()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    loading.value = false
  }
}

async function loadUrls() {
  await Promise.all(visibleImages.value.filter((m) => !(m.id in urls.value)).map(async (m) => {
    try {
      urls.value[m.id] = await chat.fileUrl(m)
    } catch {
      urls.value[m.id] = null
    }
  }))
}

function showMore() {
  limit.value += PAGE
  void loadUrls()
}

onMounted(load)
watch(() => chat.state.active, load)

function view(m: ChatMessage) {
  viewerList.value = images.value
  viewerId.value = m.id
}

async function download(m: ChatMessage) {
  try {
    const url = await chat.fileUrl(m)
    if (!url) throw new Error('File unavailable')
    const a = document.createElement('a')
    a.href = url
    a.download = m.file?.name ?? 'file'
    a.click()
  } catch (e) {
    toast.error(errMsg(e))
  }
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading && !items.length" class="flex justify-center p-4"><Loader2 class="size-4 animate-spin text-muted-foreground" /></div>
    <p v-else-if="!items.length" class="well rounded-lg p-4 text-center text-sm text-muted-foreground">No media or files in this chat yet.</p>
    <div v-if="images.length" class="grid grid-cols-3 gap-1.5">
      <button
        v-for="m in visibleImages" :key="m.id" class="relative aspect-square overflow-hidden rounded-md bg-inset outline-none focus-visible:shadow-[var(--glow)]"
        :aria-label="`Open ${m.file?.name}`" :title="m.file?.name" @click="view(m)"
      >
        <img v-if="urls[m.id]" :src="urls[m.id]!" :alt="m.file?.name" class="size-full object-cover">
        <span v-else class="block size-full" :class="loading && 'animate-pulse bg-soft'" />
      </button>
    </div>
    <button v-if="images.length > visibleImages.length" class="btn btn-ghost btn-sm w-full" @click="showMore">Show more ({{ images.length - visibleImages.length }})</button>
    <ul v-if="files.length" class="well space-y-0.5 rounded-lg p-1.5">
      <li v-for="m in files" :key="m.id" class="flex items-center gap-3 rounded-md px-2 py-1.5">
        <FileText class="size-7 shrink-0 text-primary" stroke-width="1.5" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">{{ m.file?.name }}</div>
          <div class="text-xs text-muted-foreground">{{ formatSize(m.file?.size ?? 0) }} · {{ formatDate(m.ts) }}</div>
        </div>
        <button class="btn btn-ghost btn-icon btn-sm shrink-0" title="Download" aria-label="Download" @click="download(m)"><Download /></button>
      </li>
    </ul>
  </div>
</template>
