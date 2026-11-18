<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Hash, Search } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { openConversation } from '@/lib/nav'
import type { ConvId } from '@/lib/types'

const open = defineModel<boolean>('open', { required: true })

interface Item { id: ConvId; title: string; group: boolean; userId?: string; unread: number; sub: string; haystack: string }

/** Conversations (newest first), then friends that have no conversation yet. */
const items = computed<Item[]>(() => {
  const out: Item[] = chat.state.conversations.map((c) => {
    const userId = c.kind === 'dm' ? c.id.slice(3) : undefined
    return {
      id: c.id, title: c.title, group: c.kind === 'group', userId, unread: c.unread,
      sub: c.kind === 'group' ? 'Group' : '', haystack: `${c.title} ${userId ?? ''}`.toLowerCase(),
    }
  })
  const seen = new Set(out.map((i) => i.id))
  const rest = Object.values(chat.state.contacts)
    .filter((c) => c.friend && !seen.has(`dm:${c.id}`))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const c of rest) {
    out.push({ id: `dm:${c.id}`, title: c.name, group: false, userId: c.id, unread: 0, sub: '', haystack: `${c.name} ${c.id}`.toLowerCase() })
  }
  return out
})

/** Substring match ranks above a scattered (subsequence) match; -1 = no match. */
function score(hay: string, q: string): number {
  const i = hay.indexOf(q)
  if (i >= 0) return 1000 - i
  let at = -1
  for (const ch of q) {
    at = hay.indexOf(ch, at + 1)
    if (at < 0) return -1
  }
  return 100 - at
}

const query = ref('')
const index = ref(0)
const list = ref<HTMLElement | null>(null)

const results = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/-/g, '')
  if (!q) return items.value
  return items.value
    .map((it, n) => ({ it, s: score(it.haystack.replace(/-/g, ''), q), n }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s || a.n - b.n)
    .map((r) => r.it)
})

watch(open, (o) => {
  if (o) {
    query.value = ''
    index.value = 0
  }
})
watch(query, () => (index.value = 0))

function move(d: number) {
  const n = results.value.length
  if (!n) return
  index.value = (index.value + d + n) % n
  void nextTick(() => list.value?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
}

async function choose(it: Item | undefined) {
  if (!it) return
  open.value = false
  try {
    await openConversation(it.id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :show-close-button="false" class="top-[16%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg">
      <DialogTitle class="sr-only">Quick switcher</DialogTitle>
      <DialogDescription class="sr-only">Jump to a friend, direct message or group.</DialogDescription>
      <div class="field-icon border-b border-line p-3">
        <Search class="!left-6" />
        <input
          v-model="query" class="field !h-10" placeholder="Where would you like to go?" aria-label="Search conversations" autocomplete="off" spellcheck="false"
          @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter.prevent="choose(results[index])"
        >
      </div>
      <ul ref="list" class="max-h-[min(22rem,50dvh)] overflow-y-auto p-1.5" role="listbox">
        <li v-for="(it, n) in results" :key="it.id" role="option" :aria-selected="n === index">
          <button
            class="row flex h-11 w-full items-center gap-3 rounded-md px-2 text-left outline-none"
            :data-active="n === index" :data-selected="n === index" :data-unread="it.unread > 0"
            style="--dot-ring: var(--popover)"
            @mousemove="index = n" @click="choose(it)"
          >
            <div v-if="it.group" class="flex size-8 shrink-0 items-center justify-center rounded-full bg-soft"><Hash class="size-4" /></div>
            <UserAvatar v-else :name="it.title" :id="it.userId" :size="32" :online="chat.state.contacts[it.userId!]?.online" />
            <span class="min-w-0 flex-1 truncate text-[15px] font-medium">{{ it.title }}</span>
            <span v-if="it.sub" class="text-xs text-muted-foreground">{{ it.sub }}</span>
            <span v-if="it.unread > 0" class="unread shrink-0">{{ it.unread > 99 ? '99+' : it.unread }}</span>
          </button>
        </li>
        <li v-if="!results.length" class="px-3 py-8 text-center text-sm text-muted-foreground">No matches.</li>
      </ul>
      <div class="flex items-center gap-4 border-t border-line px-3 py-2 text-xs text-muted-foreground">
        <span><kbd class="font-sans font-semibold">↑↓</kbd> navigate</span>
        <span><kbd class="font-sans font-semibold">Enter</kbd> open</span>
        <span><kbd class="font-sans font-semibold">Esc</kbd> close</span>
      </div>
    </DialogContent>
  </Dialog>
</template>
