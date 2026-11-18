<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import MessageItem from '@/components/MessageItem.vue'
import { chat } from '@/lib/chat'
import { formatDate } from '@/lib/format'

const scroller = ref<HTMLElement | null>(null)
let stick = true
// Only animate messages that arrive after the conversation finished loading.
const animate = ref(false)
let animTimer: ReturnType<typeof setTimeout> | undefined

const GROUP_MS = 5 * 60 * 1000

function onScroll() {
  const el = scroller.value
  if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

function toBottom() {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => chat.state.active,
  async () => {
    stick = true
    animate.value = false
    clearTimeout(animTimer)
    animTimer = setTimeout(() => (animate.value = true), 500)
    await nextTick()
    toBottom()
  },
  { immediate: true },
)

watch(
  () => chat.state.messages.length,
  async () => {
    const last = chat.state.messages[chat.state.messages.length - 1]
    if (!stick && last?.from !== chat.state.account?.id) return
    await nextTick()
    toBottom()
  },
  { flush: 'post' },
)

function onMediaLoad() {
  if (stick) toBottom()
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

const rows = computed(() => {
  const ms = chat.state.messages
  return ms.map((m, i) => {
    const p = ms[i - 1]
    const date = !p || !sameDay(p.ts, m.ts)
    const joins = !!p && !date && p.kind !== 'system' && m.kind !== 'system' && p.from === m.from && m.ts - p.ts <= GROUP_MS
    return { m, date, head: !joins }
  })
})
</script>

<template>
  <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto pt-2 pb-4" @scroll="onScroll" @load.capture="onMediaLoad">
    <div v-if="!rows.length" class="px-6 py-16 text-center text-sm text-muted-foreground">
      This is the start of the conversation. Say hello!
    </div>
    <template v-for="r in rows" :key="r.m.id">
      <div v-if="r.date" class="mx-4 my-3 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
        <span class="h-px flex-1 bg-line" />{{ formatDate(r.m.ts) }}<span class="h-px flex-1 bg-line" />
      </div>
      <MessageItem :msg="r.m" :head="r.head" :animate="animate" />
    </template>
  </div>
</template>
