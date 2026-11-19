<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { errMsg, relTime } from '@/lib/format'
import { openConversation } from '@/lib/nav'
import { closePanelOnNarrow, starredScope } from '@/lib/ui'
import type { SearchHit } from '@/lib/types'

const all = ref<SearchHit[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    all.value = await chat.starredMessages()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    loading.value = false
  }
}

const hits = computed(() =>
  starredScope.value === 'chat' && chat.state.active ? all.value.filter((h) => h.conv === chat.state.active) : all.value,
)

onMounted(load)
// Unstarring elsewhere keeps the list current while it is open.
watch(() => Object.keys(chat.state.starred).length, load)

async function choose(h: SearchHit) {
  closePanelOnNarrow()
  try {
    await openConversation(h.conv, h.msg.id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="chat.state.active" class="well flex gap-1 rounded-md p-1" role="group" aria-label="Starred scope">
      <button class="btn btn-sm flex-1" :class="starredScope === 'chat' ? 'btn-soft' : 'btn-ghost'" :aria-pressed="starredScope === 'chat'" @click="starredScope = 'chat'">This chat</button>
      <button class="btn btn-sm flex-1" :class="starredScope === 'all' ? 'btn-soft' : 'btn-ghost'" :aria-pressed="starredScope === 'all'" @click="starredScope = 'all'">All chats</button>
    </div>
    <p class="text-xs text-muted-foreground">Only you can see your stars.</p>
    <div v-if="loading && !hits.length" class="flex justify-center p-4"><Loader2 class="size-4 animate-spin text-muted-foreground" /></div>
    <p v-else-if="!hits.length" class="well rounded-lg p-3 text-center text-sm text-muted-foreground">No starred messages yet.</p>
    <ul v-if="hits.length" class="space-y-0.5">
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
  </div>
</template>
