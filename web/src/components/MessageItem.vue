<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Clock, CornerUpLeft, Copy, Forward, Pencil, RotateCw, SmilePlus, Star, Trash2, TriangleAlert } from 'lucide-vue-next'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub,
  ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import FileMessage from '@/components/FileMessage.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import EmojiPicker from '@/components/messages/EmojiPicker.vue'
import MessageEditor from '@/components/messages/MessageEditor.vue'
import ReactionBar from '@/components/messages/ReactionBar.vue'
import { QUICK_EMOJI } from '@/components/messages/emoji'
import { useLongPress } from '@/components/messages/longpress'
import { canDeleteMsg, canEditMsg, canForward, deleteMsg, deleteTarget, editingId, flashId, forwardMsg, myId, reactTo, replyTo, retry, toggleStar } from '@/components/messages/state'
import { chat } from '@/lib/chat'
import { formatClock, hueOf } from '@/lib/format'
import { docToText, renderMessageHtml } from '@/lib/render'
import type { ChatMessage } from '@/lib/types'
import { copyText } from '@/lib/ui'

const props = defineProps<{
  msg: ChatMessage
  /** First message of a run from the same sender (shows avatar + name). */
  head: boolean
  animate: boolean
  /** "Seen"/"Sent" line, only passed for my last sent message. */
  receipt?: { text: string; title?: string } | null
}>()
const emit = defineEmits<{ jump: [id: string] }>()

const avatarOf = (id: string) =>
  id === chat.state.account?.id ? chat.state.account.avatar : chat.state.contacts[id]?.avatar ?? null
const mine = computed(() => props.msg.from === myId())
const name = computed(() => (mine.value ? chat.state.account!.username : chat.displayName(props.msg.from)))
const replyName = computed(() => (props.msg.reply ? chat.displayName(props.msg.reply.from) : ''))
const time = computed(() => formatClock(props.msg.ts))
const failed = computed(() => props.msg.status === 'failed')
const settled = computed(() => props.msg.status !== 'failed' && props.msg.status !== 'sending')
const starred = computed(() => chat.isStarred(props.msg))
const editing = computed(() => editingId.value === props.msg.id)
const canEdit = computed(() => canEditMsg(props.msg))
const canDelete = computed(() => canDeleteMsg(props.msg))
const text = computed(() => (props.msg.kind === 'text' ? docToText(props.msg.doc) : ''))

const html = computed(() => {
  if (props.msg.kind !== 'text') return ''
  let h = renderMessageHtml(props.msg.doc)
  if (props.msg.edited) {
    // Static trusted markup appended after the sanitized HTML, inline in the last paragraph.
    const tag = '<span class="ml-1 text-[11px] text-muted-foreground select-none">(edited)</span>'
    h = h.endsWith('</p>') ? `${h.slice(0, -4)}${tag}</p>` : h + tag
  }
  return h
})

const mentionsMe = computed(() => {
  const u = chat.state.account?.username
  return !mine.value && !!u && text.value.toLowerCase().includes(`@${u.toLowerCase()}`)
})

const pickerOpen = ref(false)

// Code blocks: a copy button is added to each <pre> after the HTML renders (click handled by delegation).
const body = ref<HTMLElement | null>(null)
const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

function addCopyButtons() {
  for (const pre of body.value?.querySelectorAll('pre') ?? []) {
    if (pre.querySelector('.copy-code')) continue
    pre.classList.add('group/pre')
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'copy-code absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md bg-popover text-muted-foreground opacity-0 shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-opacity group-hover/pre:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:shadow-[var(--glow)]'
    b.title = 'Copy code'
    b.setAttribute('aria-label', 'Copy code')
    b.innerHTML = ICON_COPY
    pre.prepend(b)
  }
}
onMounted(addCopyButtons)
watch(html, async () => {
  await nextTick()
  addCopyButtons()
})

function onBodyClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.copy-code')
  if (!btn) return
  const code = btn.closest('pre')?.querySelector('code')?.textContent ?? ''
  void copyText(code.replace(/\n$/, ''), 'Code copied')
  btn.innerHTML = ICON_CHECK
  setTimeout(() => (btn.innerHTML = ICON_COPY), 1500)
}

const press = useLongPress(() => props.msg, () => (settled.value || failed.value) && !editing.value)

function askDelete(e?: MouseEvent) {
  if (e?.shiftKey) void deleteMsg(props.msg)
  else deleteTarget.value = props.msg
}
</script>

<template>
  <div v-if="msg.kind === 'system'" class="my-2 px-4 text-center text-xs text-muted-foreground">{{ msg.text }}</div>

  <ContextMenu v-else>
    <ContextMenuTrigger as-child>
      <div
        :data-mid="msg.id"
        class="msg-row group relative px-4 py-0.5 pr-6 transition-colors duration-500 [-webkit-touch-callout:none]"
        v-bind="press.bind"
        :class="[
          press.pressing.value && 'select-none',
          head ? 'mt-4' : '',
          animate && 'msg-in',
          mentionsMe && 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)] hover:!bg-primary/15',
          flashId === msg.id && '!bg-primary/25',
          editing && 'bg-hover',
        ]"
      >
        <!-- Reply quote -->
        <button
          v-if="msg.reply" type="button"
          class="mb-0.5 ml-5 flex max-w-full items-center gap-1.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:shadow-[var(--glow)]"
          title="Jump to original message" @click="emit('jump', msg.reply.id)"
        >
          <span class="mt-2 h-2.5 w-8 shrink-0 rounded-tl-md border-t-2 border-l-2 border-muted-foreground/40" />
          <CornerUpLeft class="size-3 shrink-0" />
          <span class="hue-text shrink-0 font-semibold" :style="{ '--h': hueOf(msg.reply.from) }">{{ replyName }}</span>
          <span class="truncate">{{ msg.reply.preview }}</span>
        </button>

        <div class="flex gap-4">
          <div class="w-10 shrink-0 pt-0.5">
            <UserAvatar v-if="head" :name="name" :id="msg.from" :src="avatarOf(msg.from)" :size="40" />
            <span v-else class="hidden pt-1 text-right text-[10px] text-muted-foreground group-hover:block">{{ time }}</span>
          </div>

          <div class="min-w-0 flex-1" :class="failed && 'opacity-60'">
            <div v-if="head" class="flex items-baseline gap-2 leading-snug">
              <span class="hue-text text-[15px] font-semibold" :style="{ '--h': hueOf(msg.from) }">{{ name }}</span>
              <span class="text-[11px] text-muted-foreground">{{ time }}</span>
              <Clock v-if="msg.status === 'sending'" class="size-3 text-muted-foreground" aria-label="Sending" />
              <Star v-if="starred" class="size-3 self-center fill-current text-amber-500" aria-label="Starred" title="Starred" />
            </div>
            <div v-if="msg.forwarded" class="flex items-center gap-1 text-xs text-muted-foreground"><Forward class="size-3" />Forwarded</div>
            <MessageEditor v-if="editing" :msg="msg" />
            <div
              v-else-if="msg.kind === 'text'" ref="body" class="prose-like text-[15px] text-foreground/90 [&_pre]:relative [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line [&_pre]:bg-inset [&_pre]:px-3 [&_pre]:py-2 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-[1.45] [&_pre_code]:leading-[1.45] [&_pre[data-lang]]:before:mb-1 [&_pre[data-lang]]:before:block [&_pre[data-lang]]:before:text-[10px] [&_pre[data-lang]]:before:font-semibold [&_pre[data-lang]]:before:tracking-wide [&_pre[data-lang]]:before:text-muted-foreground [&_pre[data-lang]]:before:uppercase [&_pre[data-lang]]:before:content-[attr(data-lang)] [&_pre_code]:bg-transparent"
              @click="onBodyClick" v-html="html"
            />
            <FileMessage v-else-if="msg.kind === 'file' && msg.file" :msg="msg" />
            <div v-if="failed" class="mt-0.5 flex items-center gap-2 text-xs font-medium text-destructive opacity-100">
              <TriangleAlert class="size-3.5" />Not sent
              <button type="button" class="btn btn-soft btn-sm !h-6 !px-2" @click="retry(msg)"><RotateCw class="!size-3" />Retry</button>
            </div>
            <Clock v-if="msg.status === 'sending' && !head" class="mt-0.5 size-3 text-muted-foreground" aria-label="Sending" />
            <Star v-if="starred && !head" class="mt-0.5 size-3 fill-current text-amber-500" aria-label="Starred" title="Starred" />
            <ReactionBar :msg="msg" />
            <div v-if="receipt && !failed" class="mt-0.5 text-right text-xs text-muted-foreground" :title="receipt.title">{{ receipt.text }}</div>
          </div>
        </div>

        <!-- Hover toolbar -->
        <div
          v-if="settled && !editing"
          class="absolute -top-3.5 right-4 z-10 flex items-center rounded-md bg-popover p-0.5 opacity-0 shadow-[var(--shadow-sm),inset_0_0_0_1px_var(--line)] transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          :class="pickerOpen && '!opacity-100'"
        >
          <EmojiPicker v-model:open="pickerOpen" quick @pick="(e) => reactTo(msg, e)">
            <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Add reaction" aria-label="Add reaction"><SmilePlus /></button>
          </EmojiPicker>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Reply" aria-label="Reply" @click="replyTo = msg"><CornerUpLeft /></button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" :title="starred ? 'Unstar' : 'Star'" :aria-label="starred ? 'Unstar' : 'Star'" @click="toggleStar(msg)"><Star :class="starred && 'fill-current text-amber-500'" /></button>
          <button v-if="canForward(msg)" type="button" class="btn btn-ghost btn-icon btn-sm" title="Forward" aria-label="Forward" @click="forwardMsg = msg"><Forward /></button>
          <button v-if="canEdit" type="button" class="btn btn-ghost btn-icon btn-sm" title="Edit" aria-label="Edit" @click="editingId = msg.id"><Pencil /></button>
          <button
            v-if="canDelete" type="button" class="btn btn-ghost btn-icon btn-sm hover:!text-destructive"
            title="Delete (shift-click to skip confirmation)" aria-label="Delete" @click="askDelete"
          >
            <Trash2 />
          </button>
        </div>
      </div>
    </ContextMenuTrigger>

    <ContextMenuContent v-if="failed" class="w-48">
      <ContextMenuItem @select="retry(msg)"><RotateCw />Retry</ContextMenuItem>
      <ContextMenuItem v-if="text" @select="copyText(text, 'Copied')"><Copy />Copy text</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" @select="askDelete()"><Trash2 />Delete message</ContextMenuItem>
    </ContextMenuContent>
    <ContextMenuContent v-else-if="settled" class="w-48">
      <ContextMenuSub>
        <ContextMenuSubTrigger><SmilePlus />Add reaction</ContextMenuSubTrigger>
        <ContextMenuSubContent class="w-auto">
          <div class="grid grid-cols-4 gap-0.5 p-0.5">
            <ContextMenuItem v-for="e in QUICK_EMOJI" :key="e" class="size-9 justify-center !p-0 text-xl" @select="reactTo(msg, e)">{{ e }}</ContextMenuItem>
          </div>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem @select="replyTo = msg"><CornerUpLeft />Reply</ContextMenuItem>
      <ContextMenuItem v-if="canForward(msg)" @select="forwardMsg = msg"><Forward />Forward</ContextMenuItem>
      <ContextMenuItem @select="toggleStar(msg)"><Star :class="starred && 'fill-current'" />{{ starred ? 'Unstar' : 'Star' }}</ContextMenuItem>
      <ContextMenuItem v-if="text" @select="copyText(text, 'Copied')"><Copy />Copy text</ContextMenuItem>
      <template v-if="canEdit || canDelete">
        <ContextMenuSeparator />
        <ContextMenuItem v-if="canEdit" @select="editingId = msg.id"><Pencil />Edit message</ContextMenuItem>
        <ContextMenuItem v-if="canDelete" variant="destructive" @select="askDelete()"><Trash2 />Delete message</ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>
</template>
