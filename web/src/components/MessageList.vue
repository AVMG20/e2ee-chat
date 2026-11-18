<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import MessageItem from '@/components/MessageItem.vue'
import { chat } from '@/lib/chat'
import { formatDate } from '@/lib/format'

defineProps<{ topPad: number; bottomPad: number }>()

const scroller = ref<HTMLElement | null>(null)
let stick = true
// Only animate messages that arrive after the conversation finished loading.
const animate = ref(false)
let animTimer: ReturnType<typeof setTimeout> | undefined

const GROUP_MS = 5 * 60 * 1000
const showSender = computed(() => chat.state.active?.startsWith('g:') ?? false)

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
    if (!stick && last?.from !== chat.state.account?.name) return
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
    const n = ms[i + 1]
    const date = !p || !sameDay(p.ts, m.ts)
    const joins = (a: typeof m | undefined, b: typeof m) =>
      !!a && a.kind !== 'system' && b.kind !== 'system' && a.from === b.from && Math.abs(b.ts - a.ts) <= GROUP_MS && sameDay(a.ts, b.ts)
    return { m, date, head: !joins(p, m), tail: !n || !joins(m, n) }
  })
})
</script>

<template>
  <div
    ref="scroller"
    class="absolute inset-0 overflow-y-auto px-3 sm:px-6"
    :style="{ paddingTop: `${topPad + 12}px`, paddingBottom: `${bottomPad + 8}px` }"
    @scroll="onScroll"
    @load.capture="onMediaLoad"
  >
    <div class="mx-auto max-w-3xl">
      <div v-if="!rows.length" class="py-20 text-center text-sm text-muted-foreground">
        No messages yet. Say hello!
      </div>
      <template v-for="r in rows" :key="r.m.id">
        <div v-if="r.date" class="my-5 flex items-center gap-3">
          <span class="h-px flex-1 bg-gradient-to-r from-transparent to-line" />
          <span class="eyebrow rounded-full bg-inset px-3 py-1 shadow-[inset_0_0_0_1px_var(--line)]">{{ formatDate(r.m.ts) }}</span>
          <span class="h-px flex-1 bg-gradient-to-l from-transparent to-line" />
        </div>
        <MessageItem :msg="r.m" :head="r.head" :tail="r.tail" :show-sender="showSender" :animate="animate" />
      </template>
    </div>
  </div>
</template>
