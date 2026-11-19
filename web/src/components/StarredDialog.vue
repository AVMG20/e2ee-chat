<script setup lang="ts">
import { ref, watch } from 'vue'
import { Loader2, Star } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { chat } from '@/lib/chat'
import { errMsg, relTime } from '@/lib/format'
import { openConversation } from '@/lib/nav'
import type { SearchHit } from '@/lib/types'

const open = defineModel<boolean>('open', { required: true })
const hits = ref<SearchHit[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    hits.value = await chat.starredMessages()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    loading.value = false
  }
}

watch(open, (o) => o && load())
// Unstarring elsewhere keeps the list current while it is open.
watch(() => Object.keys(chat.state.starred).length, () => open.value && load())

async function choose(h: SearchHit) {
  open.value = false
  try {
    await openConversation(h.conv, h.msg.id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <div class="mb-2 flex size-11 items-center justify-center rounded-lg text-white [background:var(--grad)]"><Star class="size-5" /></div>
        <DialogTitle>Starred messages</DialogTitle>
        <DialogDescription>Only you can see your stars.</DialogDescription>
      </DialogHeader>
      <ul class="well max-h-[min(24rem,55dvh)] space-y-0.5 overflow-y-auto rounded-lg p-1.5">
        <li v-if="loading && !hits.length" class="flex justify-center p-4"><Loader2 class="size-4 animate-spin text-muted-foreground" /></li>
        <li v-else-if="!hits.length" class="p-3 text-center text-sm text-muted-foreground">No starred messages yet.</li>
        <li v-for="h in hits" :key="h.conv + h.msg.id">
          <button class="row flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left outline-none focus-visible:shadow-[var(--glow)]" @click="choose(h)">
            <span class="flex items-baseline gap-2">
              <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ h.title }}</span>
              <span class="shrink-0 text-[11px] text-muted-foreground">{{ relTime(h.msg.ts) }}</span>
            </span>
            <span class="line-clamp-2 break-words text-xs text-muted-foreground">
              <span class="font-medium text-foreground/80">{{ chat.displayName(h.msg.from) }}: </span>{{ chat.previewText(h.msg) }}
            </span>
          </button>
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>
