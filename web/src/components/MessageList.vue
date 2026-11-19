<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-vue-next'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ForwardDialog from '@/components/ForwardDialog.vue'
import ImageViewer from '@/components/messages/ImageViewer.vue'
import MessageItem from '@/components/MessageItem.vue'
import MessageSheet from '@/components/messages/MessageSheet.vue'
import { deleteMsg, deleteTarget, editingId, extra, flashId, sheetMsg, viewerId } from '@/components/messages/state'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { errMsg, formatDate } from '@/lib/format'

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
  checkUnread()
  if (el.scrollTop < 300) void loadMore()
}

// ---------- "New messages" pill ----------
const unreadAbove = ref(false)
let unreadSeen = false

/** Shows the pill while the New divider is above the visible area; hides for good once it was on screen. */
function checkUnread() {
  const sc = scroller.value
  const el = sc?.querySelector<HTMLElement>('[data-unread-divider]')
  if (!sc || !el || unreadSeen) {
    unreadAbove.value = false
    return
  }
  const r = el.getBoundingClientRect()
  const top = sc.getBoundingClientRect()
  unreadAbove.value = r.bottom < top.top
  if (!unreadAbove.value && r.top < top.bottom) unreadSeen = true
}

function goToUnread() {
  const el = scroller.value?.querySelector<HTMLElement>('[data-unread-divider]')
  if (!el) return
  stick = false
  el.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

// ---------- paging ----------
const loadingOlder = ref(false)
async function loadMore() {
  const el = scroller.value
  if (!el || loadingOlder.value || !chat.state.hasOlder || !chat.state.active) return
  loadingOlder.value = true
  const conv = chat.state.active
  const prevH = el.scrollHeight
  const prevTop = el.scrollTop
  try {
    await chat.loadOlder()
  } catch (e) {
    toast.error(errMsg(e))
    loadingOlder.value = false
    return
  }
  if (chat.state.active === conv) {
    await nextTick()
    // Prepended rows push content down; compensate so the view stays put.
    el.scrollTop = prevTop + (el.scrollHeight - prevH)
  }
  loadingOlder.value = false
  // Short pages may still leave us near the top.
  if (el.scrollTop < 300 && chat.state.hasOlder) void loadMore()
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

/** Scrolls to a loaded message and flashes it. Returns false if it isn't on screen. */
function reveal(id: string): boolean {
  const el = find(id)
  if (!el) return false
  stick = false
  el.scrollIntoView({ block: 'center' })
  flashId.value = id
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashId.value = null), 1600)
  return true
}

async function jump(id: string) {
  if (reveal(id)) return
  const conv = chat.state.active
  if (!conv) return
  try {
    await chat.open(conv, id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

watch(
  [() => chat.state.highlight, () => chat.state.messages.length],
  async () => {
    const id = chat.state.highlight
    if (!id) return
    await nextTick()
    if (reveal(id)) chat.state.highlight = null
  },
  { flush: 'post', immediate: true },
)


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
    unreadSeen = false
    unreadAbove.value = false
    animate.value = false
    pendingUnread = true
    clearTimeout(unreadTimer)
    unreadTimer = setTimeout(() => (pendingUnread = false), 1500)
    clearTimeout(animTimer)
    animTimer = setTimeout(() => (animate.value = true), 500)
    await nextTick()
    toBottom()
    settleUnread()
    checkUnread()
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
    checkUnread()
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

// "Seen" line under my last sent message.
const receipt = computed<{ id: string; text: string; title?: string } | null>(() => {
  const me = chat.state.account?.id
  const ms = chat.state.messages
  const last = [...ms].reverse().find((m) => m.kind !== 'system' && m.from === me)
  if (!me || !last || last.status === 'sending' || last.status === 'failed') return null
  const conv = chat.state.active ?? ''
  const members = conv.startsWith('g:') ? chat.state.groups[conv.slice(2)]?.members ?? [] : [conv.slice(3)]
  const seen = members.filter((u) => u !== me && (chat.state.reads[u] ?? 0) >= last.ts)
  if (!seen.length) return { id: last.id, text: 'Sent' }
  if (!conv.startsWith('g:')) return { id: last.id, text: 'Seen' }
  const names = seen.map((u) => chat.displayName(u))
  return { id: last.id, text: names.length <= 3 ? `Seen by ${names.join(', ')}` : `Seen by ${names.length}`, title: names.join(', ') }
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
  sheetMsg.value = null
  viewerId.value = null
})
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <TooltipProvider :delay-duration="200">
      <div ref="scroller" class="h-full overflow-y-auto pt-4 pb-4 [overflow-anchor:none]" @scroll="onScroll">
        <div ref="content">
          <div v-if="loadingOlder" class="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground" role="status">
            <Loader2 class="size-3.5 animate-spin" />Loading…
          </div>
          <div v-else-if="!chat.state.hasOlder && rows.length > 20" class="py-2 text-center text-[11px] text-muted-foreground/70">Beginning of the conversation</div>
          <div v-if="!rows.length" class="px-6 py-16 text-center text-sm text-muted-foreground">
            This is the start of the conversation. Say hello!
          </div>
          <template v-for="r in rows" :key="r.m.id">
            <div v-if="r.date" class="mx-4 mt-4 mb-1 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
              <span class="h-px flex-1 bg-line" />{{ formatDate(r.m.ts) }}<span class="h-px flex-1 bg-line" />
            </div>
            <div v-if="r.unread" data-unread-divider class="mx-3 mt-3 flex items-center" role="separator" aria-label="New messages">
              <span class="h-px flex-1 bg-destructive/70" />
              <span class="rounded-sm bg-destructive px-1.5 py-px text-[10px] leading-4 font-bold text-white uppercase">New</span>
            </div>
            <MessageItem :msg="r.m" :head="r.head" :animate="animate" :receipt="receipt?.id === r.m.id ? receipt : null" @jump="jump" />
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

    <Transition
      enter-active-class="transition duration-150" enter-from-class="-translate-y-2 opacity-0"
      leave-active-class="transition duration-150" leave-to-class="-translate-y-2 opacity-0"
    >
      <button
        v-if="unreadAbove"
        class="btn btn-primary btn-sm absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-[var(--shadow-md)]"
        @click="goToUnread"
      >
        <ArrowUp />New messages
      </button>
    </Transition>

    <MessageSheet />
    <ForwardDialog />
    <ImageViewer />
    <ConfirmDialog
      v-model:open="confirmOpen" title="Delete message?" confirm-label="Delete"
      description="This removes the message for everyone in the conversation. Tip: hold Shift while clicking delete to skip this prompt."
      @confirm="confirmDelete"
    />
  </div>
</template>
