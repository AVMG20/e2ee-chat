<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2, Search } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { errMsg, relTime } from '@/lib/format'
import { openConversation } from '@/lib/nav'
import { closePanelOnNarrow } from '@/lib/ui'
import type { SearchHit } from '@/lib/types'

const query = ref('')
const hits = ref<SearchHit[]>([])
const searching = ref(false)
const searched = ref('')
const input = ref<HTMLInputElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

function runSearch() {
  clearTimeout(timer)
  const my = ++seq
  const q = query.value
  const conv = chat.state.active
  if (!q.trim() || !conv) {
    hits.value = []
    searching.value = false
    return
  }
  searching.value = true
  timer = setTimeout(async () => {
    let found: SearchHit[] = []
    try {
      found = await chat.search(q, { conv })
    } catch {
      /* search unavailable */
    }
    if (my !== seq) return
    hits.value = found
    searched.value = q
    searching.value = false
  }, 200)
}

watch(query, runSearch)
watch(() => chat.state.active, runSearch)
// New or deleted messages change the results; deleted ones drop out right away.
watch(() => chat.state.messages.length, () => {
  const live = new Set(chat.state.messages.map((m) => m.id))
  const cur = chat.state.active
  hits.value = hits.value.filter((h) => h.conv !== cur || live.has(h.msg.id))
  runSearch()
})
onMounted(() => input.value?.focus())
onBeforeUnmount(() => {
  seq++
  clearTimeout(timer)
})

/** A short excerpt around the first matching word, split into plain and matched parts. */
function snippet(hit: SearchHit): { t: string; m: boolean }[] {
  const text = chat.previewText(hit.msg).replace(/\s+/g, ' ')
  const terms = searched.value.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  const first = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), text.length)
  const start = Math.max(0, first - 24)
  const cut = (start > 0 ? '…' : '') + text.slice(start, start + 140) + (text.length > start + 140 ? '…' : '')
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return terms.length ? cut.split(re).filter(Boolean).map((t) => ({ t, m: terms.includes(t.toLowerCase()) })) : [{ t: cut, m: false }]
}

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
    <div class="field-icon">
      <Search />
      <input ref="input" v-model="query" class="field" placeholder="Search this chat" aria-label="Search this chat" autocomplete="off" spellcheck="false">
    </div>
    <div v-if="searching && !hits.length" class="flex justify-center p-4"><Loader2 class="size-4 animate-spin text-muted-foreground" /></div>
    <p v-else-if="query.trim() && !searching && !hits.length" class="p-3 text-center text-sm text-muted-foreground">No messages found.</p>
    <p v-else-if="!query.trim()" class="p-3 text-center text-sm text-muted-foreground">Type to search the messages in this chat.</p>
    <ul v-if="hits.length" class="space-y-0.5">
      <li v-for="h in hits" :key="h.msg.conv + h.msg.id">
        <button class="row flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left outline-none focus-visible:shadow-[var(--glow)]" @click="choose(h)">
          <span class="flex items-baseline gap-2">
            <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ chat.displayName(h.msg.from) }}</span>
            <span class="shrink-0 text-[11px] text-muted-foreground">{{ relTime(h.msg.ts) }}</span>
          </span>
          <span class="line-clamp-3 break-words text-xs text-muted-foreground"><template v-for="(s, i) in snippet(h)" :key="i"><mark v-if="s.m" class="rounded-sm bg-primary/25 text-foreground">{{ s.t }}</mark><template v-else>{{ s.t }}</template></template></span>
        </button>
      </li>
    </ul>
  </div>
</template>
