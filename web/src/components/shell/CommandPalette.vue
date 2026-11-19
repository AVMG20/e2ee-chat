<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Hash, Loader2, MessageSquare, Search } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg, relTime } from '@/lib/format'
import { openConversation } from '@/lib/nav'
import type { ConvId, SearchHit } from '@/lib/types'

const open = defineModel<boolean>('open', { required: true })
const convAvatar = (id: ConvId) => chat.state.conversations.find((c) => c.id === id)?.avatar ?? null

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

// Message search (history on this device), debounced.
const hits = ref<SearchHit[]>([])
const searching = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

function runSearch(q: string) {
  clearTimeout(timer)
  const my = ++seq
  if (!q.trim()) {
    hits.value = []
    searching.value = false
    return
  }
  searching.value = true
  timer = setTimeout(async () => {
    let found: SearchHit[] = []
    try {
      found = await chat.search(q)
    } catch {
      /* not signed in / search unavailable */
    }
    if (my !== seq) return
    hits.value = found
    searching.value = false
  }, 200)
}

watch(open, (o) => {
  if (o) {
    query.value = ''
    index.value = 0
  } else {
    seq++
    clearTimeout(timer)
    hits.value = []
  }
})
watch(query, (q) => {
  index.value = 0
  runSearch(q)
})

const total = computed(() => results.value.length + hits.value.length)

/** A short excerpt around the first matching word, split into plain and matched parts. */
function snippet(hit: SearchHit): { t: string; m: boolean }[] {
  const text = chat.previewText(hit.msg).replace(/\s+/g, ' ')
  const terms = query.value.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  const first = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), text.length)
  const start = Math.max(0, first - 24)
  const cut = (start > 0 ? '…' : '') + text.slice(start, start + 110) + (text.length > start + 110 ? '…' : '')
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return terms.length ? cut.split(re).filter(Boolean).map((t) => ({ t, m: terms.includes(t.toLowerCase()) })) : [{ t: cut, m: false }]
}

async function chooseHit(h: SearchHit | undefined) {
  if (!h) return
  open.value = false
  try {
    await openConversation(h.conv, h.msg.id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

function choose2(n: number) {
  if (n < results.value.length) return choose(results.value[n])
  return chooseHit(hits.value[n - results.value.length])
}

function move(d: number) {
  const n = total.value
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
      <DialogDescription class="sr-only">Jump to a friend, direct message or group, or search messages.</DialogDescription>
      <div class="field-icon border-b border-line p-3">
        <Search class="!left-6" />
        <input
          v-model="query" class="field !h-10" :placeholder="'Search chats and messages'" aria-label="Search conversations" autocomplete="off" spellcheck="false"
          @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter.prevent="choose2(index)"
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
            <img v-if="it.group && convAvatar(it.id)" :src="convAvatar(it.id)!" alt="" class="size-8 shrink-0 rounded-full object-cover">
            <div v-else-if="it.group" class="flex size-8 shrink-0 items-center justify-center rounded-full bg-soft"><Hash class="size-4" /></div>
            <UserAvatar v-else :name="it.title" :id="it.userId" :src="it.userId ? chat.state.contacts[it.userId]?.avatar : null" :size="32" :online="chat.state.contacts[it.userId!]?.online" />
            <span class="min-w-0 flex-1 truncate text-[15px] font-medium">{{ it.title }}</span>
            <span v-if="it.sub" class="text-xs text-muted-foreground">{{ it.sub }}</span>
            <span v-if="it.unread > 0" class="unread shrink-0">{{ it.unread > 99 ? '99+' : it.unread }}</span>
          </button>
        </li>
        <li v-if="!results.length && !hits.length && !searching" class="px-3 py-8 text-center text-sm text-muted-foreground">No matches.</li>
        <template v-if="hits.length || searching">
          <li class="eyebrow flex items-center gap-2 px-2 pt-3 pb-1" role="presentation">Messages<Loader2 v-if="searching" class="size-3 animate-spin" /></li>
          <li v-for="(h, n) in hits" :key="h.msg.conv + h.msg.id" role="option" :aria-selected="results.length + n === index">
            <button
              class="row flex w-full items-start gap-3 rounded-md px-2 py-2 text-left outline-none"
              :data-active="results.length + n === index" :data-selected="results.length + n === index"
              @mousemove="index = results.length + n" @click="chooseHit(h)"
            >
              <span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-soft"><MessageSquare class="size-4" /></span>
              <span class="min-w-0 flex-1 leading-tight">
                <span class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ h.title }}</span>
                  <span class="shrink-0 text-[11px] font-normal text-muted-foreground">{{ relTime(h.msg.ts) }}</span>
                </span>
                <span class="mt-0.5 line-clamp-2 block break-words text-xs text-muted-foreground">
                  <span class="font-medium text-foreground/80">{{ chat.displayName(h.msg.from) }}: </span><template v-for="(s, i) in snippet(h)" :key="i"><mark v-if="s.m" class="rounded-sm bg-primary/25 text-foreground">{{ s.t }}</mark><template v-else>{{ s.t }}</template></template>
                </span>
              </span>
            </button>
          </li>
        </template>
      </ul>
      <div class="flex items-center gap-4 border-t border-line px-3 py-2 text-xs text-muted-foreground">
        <span><kbd class="font-sans font-semibold">↑↓</kbd> navigate</span>
        <span><kbd class="font-sans font-semibold">Enter</kbd> open</span>
        <span><kbd class="font-sans font-semibold">Esc</kbd> close</span>
      </div>
    </DialogContent>
  </Dialog>
</template>
