<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown } from 'lucide-vue-next'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import MessageItem from '@/components/MessageItem.vue'
import { deleteMsg, deleteTarget, editingId, extra, flashId } from '@/components/messages/state'
import { TooltipProvider } from '@/components/ui/tooltip'
import { chat } from '@/lib/chat'
import { formatDate } from '@/lib/format'

const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const atBottom = ref(true)
let stick = true
// Only animate messages that arrive after the conversation finished loading.
const animate = ref(false)
let animTimer: ReturnType<typeof setTimeout> | undefined
let flashTimer: ReturnType<typeof setTimeout> | undefined
let pendingUnread = false
let unreadTimer: ReturnType<typeof setTimeout> | undefined

const GROUP_MS = 5 * 60 * 1000

function onScroll() {
  const el = scroller.value
  if (!el) return
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  atBottom.value = stick
}

function toBottom(smooth = false) {
  const el = scroller.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

function latest() {
  stick = true
  toBottom(true)
}

function find(id: string): HTMLElement | null {
  return scroller.value?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`) ?? null
}

function jump(id: string) {
  const el = find(id)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flashId.value = id
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashId.value = null), 1600)
}

/** On open: if the first unread message is above the fold, scroll to it. */
function settleUnread() {
  const id = extra().firstUnread
  if (!pendingUnread || !id) return
  const el = find(id)
  const sc = scroller.value
  if (!el || !sc) return
  pendingUnread = false
  if (el.getBoundingClientRect().top < sc.getBoundingClientRect().top) {
    el.scrollIntoView({ block: 'start' })
    stick = false
    atBottom.value = false
  }
}

watch(
  () => chat.state.active,
  async () => {
    stick = true
    atBottom.value = true
    animate.value = false
    pendingUnread = true
    clearTimeout(unreadTimer)
    unreadTimer = setTimeout(() => (pendingUnread = false), 1500)
    clearTimeout(animTimer)
    animTimer = setTimeout(() => (animate.value = true), 500)
    await nextTick()
    toBottom()
    settleUnread()
  },
  { immediate: true },
)

watch(
  [() => chat.state.messages.length, () => extra().firstUnread],
  async () => {
    const last = chat.state.messages[chat.state.messages.length - 1]
    if (last?.from === chat.state.account?.id && last.status === 'sending') stick = true
    await nextTick()
    if (stick) toBottom()
    settleUnread()
  },
  { flush: 'post' },
)

// Keep pinned when content grows (images loading, reactions, edits).
let ro: ResizeObserver | undefined
onMounted(() => {
  if (content.value) {
    ro = new ResizeObserver(() => {
      if (stick) toBottom()
    })
    ro.observe(content.value)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  clearTimeout(animTimer)
  clearTimeout(flashTimer)
  clearTimeout(unreadTimer)
})

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

const rows = computed(() => {
  const ms = chat.state.messages
  const unreadId = extra().firstUnread
  return ms.map((m, i) => {
    const p = ms[i - 1]
    const date = !p || !sameDay(p.ts, m.ts)
    const joins =
      !!p && !date && p.kind !== 'system' && m.kind !== 'system' && p.from === m.from
      && m.ts - p.ts <= GROUP_MS && !m.reply && m.id !== unreadId
    return { m, date, head: !joins, unread: m.id === unreadId }
  })
})

const confirmOpen = computed({
  get: () => !!deleteTarget.value,
  set: (v) => {
    if (!v) deleteTarget.value = null
  },
})

function confirmDelete() {
  const m = deleteTarget.value
  deleteTarget.value = null
  if (m) void deleteMsg(m)
}

// Selected edit/delete targets belong to one conversation.
watch(() => chat.state.active, () => {
  editingId.value = null
  deleteTarget.value = null
  flashId.value = null
})
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <TooltipProvider :delay-duration="200">
      <div ref="scroller" class="h-full overflow-y-auto pt-4 pb-4" @scroll="onScroll">
        <div ref="content">
          <div v-if="!rows.length" class="px-6 py-16 text-center text-sm text-muted-foreground">
            This is the start of the conversation. Say hello!
          </div>
          <template v-for="r in rows" :key="r.m.id">
            <div v-if="r.date" class="mx-4 mt-4 mb-1 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
              <span class="h-px flex-1 bg-line" />{{ formatDate(r.m.ts) }}<span class="h-px flex-1 bg-line" />
            </div>
            <div v-if="r.unread" class="mx-3 mt-3 flex items-center" role="separator" aria-label="New messages">
              <span class="h-px flex-1 bg-destructive/70" />
              <span class="rounded-sm bg-destructive px-1.5 py-px text-[10px] leading-4 font-bold text-white uppercase">New</span>
            </div>
            <MessageItem :msg="r.m" :head="r.head" :animate="animate" @jump="jump" />
          </template>
        </div>
      </div>
    </TooltipProvider>

    <Transition
      enter-active-class="transition duration-150" enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150" leave-to-class="translate-y-2 opacity-0"
    >
      <button
        v-if="!atBottom"
        class="btn btn-primary btn-sm absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-[var(--shadow-md)]"
        @click="latest"
      >
        <ArrowDown />Jump to latest
      </button>
    </Transition>

    <ConfirmDialog
      v-model:open="confirmOpen" title="Delete message?" confirm-label="Delete"
      description="This removes the message for everyone in the conversation. Tip: hold Shift while clicking delete to skip this prompt."
      @confirm="confirmDelete"
    />
  </div>
</template>
