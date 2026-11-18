<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import {
  Bold, Check, Code, Code2, FileText, Italic, Link as LinkIcon, List, ListOrdered, Paperclip, Quote,
  SendHorizontal, Smile, Strikethrough, X,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import EmojiPicker from '@/components/messages/EmojiPicker.vue'
import { drafts, extra, myId, replyTo, sendTyping, startEditLast } from '@/components/messages/state'
import { chat } from '@/lib/chat'
import { fencesToCodeBlocks } from '@/lib/code/fences'
import { editorExtensions } from '@/lib/editor'
import { errMsg, formatSize } from '@/lib/format'
import { isEmptyDoc } from '@/lib/render'
import { MAX_FILE_BYTES } from '@/lib/types'
import type { ConvId } from '@/lib/types'

const props = defineProps<{ disabled?: boolean }>()

interface Queued { key: number; file: File; url: string | null }

const fileInput = ref<HTMLInputElement | null>(null)
const sending = ref(false)
const toolsOpen = ref(false)
const empty = ref(true)
const linkOpen = ref(false)
const linkUrl = ref('')
const queue = ref<Queued[]>([])
let nextKey = 1

const canSend = computed(() => !empty.value || queue.value.length > 0)
const replyName = computed(() => (replyTo.value ? (replyTo.value.from === myId() ? 'yourself' : chat.displayName(replyTo.value.from)) : ''))
const replyPreview = computed(() => (replyTo.value ? chat.previewText(replyTo.value) : ''))

// ---------- file queue ----------
function addFiles(files: File[]) {
  if (props.disabled) return
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      toast.error(`"${f.name}" is too large (${formatSize(f.size)}). The limit is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`)
      continue
    }
    queue.value.push({ key: nextKey++, file: f, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null })
  }
  editor.value?.commands.focus()
}

function unqueue(q: Queued) {
  if (q.url) URL.revokeObjectURL(q.url)
  queue.value = queue.value.filter((x) => x !== q)
}

// ---------- sending ----------
async function send() {
  const ed = editor.value
  if (!ed || props.disabled || sending.value) return
  const doc = fencesToCodeBlocks(ed.getJSON())
  const hasText = !isEmptyDoc(doc)
  if (!hasText && !queue.value.length) return
  sending.value = true
  let reply = replyTo.value
  try {
    if (hasText) {
      await chat.sendText(doc, reply)
      reply = null
      replyTo.value = null
      ed.commands.clearContent(true)
      empty.value = true
    }
    for (const q of [...queue.value]) {
      await chat.sendFile(q.file, reply)
      reply = null
      replyTo.value = null
      unqueue(q)
    }
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    sending.value = false
  }
}

// ---------- @mentions (groups) ----------
const mention = ref<{ query: string; from: number; to: number } | null>(null)
const mentionIdx = ref(0)

const candidates = computed(() => {
  const m = mention.value
  const id = chat.state.active
  if (!m || !id?.startsWith('g:')) return []
  const g = chat.state.groups[id.slice(2)]
  const q = m.query.toLowerCase()
  return (g?.members ?? [])
    .filter((u) => u !== myId())
    .map((u) => ({ id: u, name: chat.displayName(u) }))
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 6)
})

function updateMention() {
  const ed = editor.value
  if (!ed || !chat.state.active?.startsWith('g:')) {
    mention.value = null
    return
  }
  const { $from, empty: collapsed } = ed.state.selection
  if (!collapsed) {
    mention.value = null
    return
  }
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const m = /(?:^|\s)@([^\s@]{0,32})$/.exec(before)
  if (!m) {
    mention.value = null
    return
  }
  const query = m[1]!
  mention.value = { query, from: $from.pos - query.length - 1, to: $from.pos }
  mentionIdx.value = Math.min(mentionIdx.value, 5)
}

function pickMention(i = mentionIdx.value) {
  const m = mention.value
  const c = candidates.value[i]
  if (!m || !c) return false
  editor.value?.chain().focus().insertContentAt({ from: m.from, to: m.to }, `@${c.name} `).run()
  mention.value = null
  return true
}

// ---------- typing indicator ----------
const typingNames = computed(() => {
  const id = chat.state.active
  const ids = (id && extra().typing?.[id]) || []
  return ids.filter((u) => u !== myId()).map((u) => chat.displayName(u))
})
const typingText = computed(() => {
  const n = typingNames.value
  if (n.length === 0) return ''
  if (n.length === 1) return `${n[0]} is typing`
  if (n.length === 2) return `${n[0]} and ${n[1]} are typing`
  return 'Several people are typing'
})

// ---------- editor ----------
const Keys = Extension.create({
  name: 'composerKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    const menu = () => mention.value && candidates.value.length > 0
    return {
      Enter: () => {
        if (menu() && pickMention()) return true
        // In a code block Enter is a newline; Ctrl/Cmd+Enter or the button sends.
        if (this.editor.isActive('codeBlock')) return false
        void send()
        return true
      },
      'Mod-Enter': () => (void send(), true),
      Tab: () => (menu() ? pickMention() : false),
      ArrowUp: () => {
        if (menu()) {
          mentionIdx.value = (mentionIdx.value + candidates.value.length - 1) % candidates.value.length
          return true
        }
        if (empty.value && !queue.value.length && !props.disabled) return startEditLast()
        return false
      },
      ArrowDown: () => {
        if (!menu()) return false
        mentionIdx.value = (mentionIdx.value + 1) % candidates.value.length
        return true
      },
      Escape: () => {
        if (mention.value) mention.value = null
        else if (replyTo.value) replyTo.value = null
        else return false
        return true
      },
    }
  },
})

const editor = useEditor({
  extensions: [...editorExtensions(), Placeholder.configure({ placeholder: 'Message' }), Keys],
  editable: !props.disabled,
  onUpdate: ({ editor: ed }) => {
    const doc = ed.getJSON()
    empty.value = isEmptyDoc(doc)
    if (!empty.value) sendTyping()
    updateMention()
  },
  onSelectionUpdate: updateMention,
  onBlur: () => setTimeout(() => (mention.value = null), 150),
  editorProps: {
    attributes: { class: 'composer-editor prose-like', 'aria-label': 'Message' },
    handlePaste: (_view, event) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (!files.length) return false
      event.preventDefault()
      addFiles(files)
      return true
    },
    // Files dropped on the editor are handled by the conversation pane.
    handleDrop: (_view, event) => Boolean(event.dataTransfer?.files.length),
  },
})

watch(() => props.disabled, (d) => editor.value?.setEditable(!d))

// Per-conversation drafts: text, reply target and queued files.
const queues = new Map<ConvId, Queued[]>()
watch(
  () => chat.state.active,
  (now, old) => {
    const ed = editor.value
    if (!ed) return
    if (old) {
      drafts.set(old, { doc: isEmptyDoc(ed.getJSON()) ? null : ed.getJSON(), reply: replyTo.value })
      queues.set(old, queue.value)
    }
    const d = now ? drafts.get(now) : undefined
    ed.commands.setContent((d?.doc as object | null) ?? '', { emitUpdate: false })
    replyTo.value = d?.reply ?? null
    queue.value = (now && queues.get(now)) || []
    empty.value = isEmptyDoc(ed.getJSON())
    mention.value = null
    if (now) ed.commands.focus('end')
  },
)

watch(replyTo, (r) => {
  if (r) editor.value?.commands.focus()
})

onBeforeUnmount(() => {
  editor.value?.destroy()
  for (const q of [...queue.value, ...[...queues.values()].flat()]) if (q.url) URL.revokeObjectURL(q.url)
})

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  addFiles(files)
}

function insertEmoji(e: string) {
  editor.value?.chain().focus().insertContent(e).run()
}

function openLink() {
  const ed = editor.value
  if (!ed) return
  linkUrl.value = (ed.getAttributes('link').href as string | undefined) ?? ''
  linkOpen.value = true
}

function applyLink() {
  const ed = editor.value
  if (!ed) return
  const raw = linkUrl.value.trim()
  if (!raw) {
    ed.chain().focus().extendMarkRange('link').unsetLink().run()
  } else {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
    if (!/^(https?:|mailto:)/i.test(url)) {
      toast.error('Only http(s) and mailto links are allowed.')
      return
    }
    ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }
  linkOpen.value = false
}

interface Tool { title: string; icon: typeof Bold; mark: string; run: () => void }
defineExpose({ addFiles })

const tools: Tool[] = [
  { title: 'Bold', icon: Bold, mark: 'bold', run: () => editor.value?.chain().focus().toggleBold().run() },
  { title: 'Italic', icon: Italic, mark: 'italic', run: () => editor.value?.chain().focus().toggleItalic().run() },
  { title: 'Strikethrough', icon: Strikethrough, mark: 'strike', run: () => editor.value?.chain().focus().toggleStrike().run() },
  { title: 'Inline code', icon: Code, mark: 'code', run: () => editor.value?.chain().focus().toggleCode().run() },
  { title: 'Code block', icon: Code2, mark: 'codeBlock', run: () => editor.value?.chain().focus().toggleCodeBlock().run() },
  { title: 'Bullet list', icon: List, mark: 'bulletList', run: () => editor.value?.chain().focus().toggleBulletList().run() },
  { title: 'Numbered list', icon: ListOrdered, mark: 'orderedList', run: () => editor.value?.chain().focus().toggleOrderedList().run() },
  { title: 'Quote', icon: Quote, mark: 'blockquote', run: () => editor.value?.chain().focus().toggleBlockquote().run() },
]

</script>

<template>
  <div class="relative">
    <!-- @mention suggestions -->
    <ul
      v-if="candidates.length" role="listbox" aria-label="Mention a member"
      class="dialog absolute right-0 bottom-full left-0 z-20 mb-1.5 overflow-hidden rounded-lg p-1 text-sm"
    >
      <li v-for="(c, i) in candidates" :key="c.id" role="option" :aria-selected="i === mentionIdx">
        <button
          type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
          :class="i === mentionIdx ? 'bg-active' : 'hover:bg-hover'" @mousedown.prevent="pickMention(i)"
        >
          <span class="font-medium">{{ c.name }}</span>
        </button>
      </li>
    </ul>

    <div class="composer-shell overflow-hidden rounded-lg" :class="disabled && 'opacity-60'">
      <!-- Reply bar -->
      <div v-if="replyTo" class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted-foreground">
        <span class="shrink-0">Replying to <strong class="font-semibold text-foreground">{{ replyName }}</strong></span>
        <span class="min-w-0 flex-1 truncate">{{ replyPreview }}</span>
        <button type="button" class="btn btn-ghost btn-icon !size-6" title="Cancel reply (Esc)" aria-label="Cancel reply" @click="replyTo = null"><X class="!size-3.5" /></button>
      </div>

      <!-- Queued files -->
      <ul v-if="queue.length" class="flex gap-2 overflow-x-auto border-b border-line px-3 py-2.5" aria-label="Files to send">
        <li v-for="q in queue" :key="q.key" class="group/chip relative shrink-0">
          <img v-if="q.url" :src="q.url" :alt="q.file.name" :title="q.file.name" class="size-16 rounded-md bg-inset object-cover">
          <div v-else class="well flex h-16 w-40 items-center gap-2 rounded-md px-2.5" :title="q.file.name">
            <FileText class="size-6 shrink-0 text-primary" stroke-width="1.5" />
            <div class="min-w-0 text-xs">
              <div class="truncate font-medium">{{ q.file.name }}</div>
              <div class="text-muted-foreground">{{ formatSize(q.file.size) }}</div>
            </div>
          </div>
          <button
            type="button" class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-popover text-muted-foreground shadow-[var(--shadow-sm),inset_0_0_0_1px_var(--line)] outline-none hover:text-destructive focus-visible:shadow-[var(--glow)]"
            :aria-label="`Remove ${q.file.name}`" title="Remove" @click="unqueue(q)"
          >
            <X class="size-3" />
          </button>
        </li>
      </ul>

      <div v-if="toolsOpen" class="flex flex-wrap items-center gap-0.5 border-b border-line px-2.5 py-1.5">
        <button
          v-for="t in tools" :key="t.title" type="button" class="btn btn-ghost btn-icon btn-sm" :title="t.title" :aria-label="t.title"
          :disabled="disabled" :class="editor?.isActive(t.mark) && 'btn-active'" @click="t.run"
        >
          <component :is="t.icon" />
        </button>
        <button
          type="button" class="btn btn-ghost btn-icon btn-sm" title="Link" aria-label="Link" :disabled="disabled"
          :class="editor?.isActive('link') && 'btn-active'" @click="openLink"
        >
          <LinkIcon />
        </button>
      </div>

      <form v-if="linkOpen" class="flex items-center gap-1.5 border-b border-line px-2.5 py-2" @submit.prevent="applyLink">
        <input v-model="linkUrl" class="field !h-9 !rounded-md !text-sm" placeholder="https://… (empty removes link)" autofocus>
        <button class="btn btn-primary btn-icon btn-sm" type="submit" title="Apply" aria-label="Apply"><Check /></button>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" title="Cancel" aria-label="Cancel" @click="linkOpen = false"><X /></button>
      </form>

      <div class="flex items-end gap-0.5 px-1">
        <button type="button" class="btn btn-ghost btn-icon shrink-0 !size-10" title="Attach files" aria-label="Attach files" :disabled="disabled" @click="fileInput?.click()">
          <Paperclip />
        </button>
        <input ref="fileInput" type="file" multiple class="hidden" @change="onPick">

        <EditorContent :editor="editor" class="max-h-40 min-w-0 flex-1 overflow-y-auto py-2.5 text-[15px] [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line [&_pre]:bg-inset [&_pre]:font-mono [&_pre]:text-[13px]" />

        <EmojiPicker @pick="insertEmoji">
          <button type="button" class="btn btn-ghost btn-icon shrink-0 !size-10" title="Emoji" aria-label="Emoji" :disabled="disabled"><Smile /></button>
        </EmojiPicker>
        <button
          type="button" class="btn btn-ghost btn-icon shrink-0 !size-10 text-sm font-semibold"
          title="Formatting" aria-label="Toggle formatting toolbar" :disabled="disabled"
          :class="toolsOpen && 'btn-active'" @click="toolsOpen = !toolsOpen"
        >
          Aa
        </button>
        <button
          type="button" class="btn btn-ghost btn-icon shrink-0 !size-10 transition-colors"
          :class="canSend && !disabled && '!text-primary hover:!bg-primary/15'"
          title="Send (Enter)" aria-label="Send" :aria-disabled="!canSend" :disabled="disabled || sending" @click="send"
        >
          <SendHorizontal />
        </button>
      </div>
    </div>

    <!-- Fixed height so the typing line never shifts the layout -->
    <div class="flex h-5 items-center gap-1.5 px-1 pt-1 text-xs text-muted-foreground" aria-live="polite">
      <template v-if="typingText">
        <span class="flex gap-0.5" aria-hidden="true">
          <i v-for="n in 3" :key="n" class="size-1 animate-bounce rounded-full bg-muted-foreground" :style="{ animationDelay: `${(n - 1) * 150}ms` }" />
        </span>
        <span class="truncate"><strong class="font-semibold">{{ typingText }}</strong>…</span>
      </template>
    </div>
  </div>
</template>
