<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import {
  Bold, Check, Code, Code2, FileText, Italic, Link as LinkIcon, List, ListOrdered, Paperclip, Quote,
  SendHorizontal, Smile, Strikethrough, X,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import EmojiPicker from '@/components/messages/EmojiPicker.vue'
import {
  coarsePointer, composerApi, drafts, draftsReady, extra, myId, queues, replyTo, requestScroll, sendTyping, startEditLast, type Queued,
} from '@/components/messages/state'
import { codeFenceShortcut } from '@/components/messages/codefence'
import { chat } from '@/lib/chat'
import { addRecent, codeFor, emojiData, loadEmoji, searchEmoji } from '@/lib/emoji'
import { fencesToCodeBlocks } from '@/lib/code/fences'
import { editorExtensions } from '@/lib/editor'
import { errMsg, formatSize } from '@/lib/format'
import { isEmptyDoc } from '@/lib/render'
import { MAX_FILE_BYTES } from '@/lib/types'
import { sidePanel } from '@/lib/ui'
import type { ConvId } from '@/lib/types'

const props = defineProps<{ disabled?: boolean }>()

const fileInput = ref<HTMLInputElement | null>(null)
const sending = ref(false)
const toolsOpen = ref(false)
const empty = ref(true)
const linkOpen = ref(false)
const linkUrl = ref('')
const queue = ref<Queued[]>([])
let nextKey = 1

const coarse = coarsePointer()
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
  const conv = chat.state.active
  if (!conv) return
  const doc = fencesToCodeBlocks(ed.getJSON())
  const hasText = !isEmptyDoc(doc)
  const files = [...queue.value]
  if (!hasText && !files.length) return
  sending.value = true
  let reply = replyTo.value
  const here = () => chat.state.active === conv
  // The user may have switched chats while a send was in flight; then clear that chat's saved state instead.
  const clearReply = () => {
    if (here()) replyTo.value = null
    else {
      const d = drafts.get(conv)
      if (d?.reply) drafts.set(conv, { ...d, reply: null })
    }
  }
  try {
    if (hasText) {
      await chat.sendText(doc, reply, conv)
      reply = null
      clearReply()
      if (here()) {
        ed.commands.clearContent(true)
        empty.value = true
      } else {
        const d = drafts.get(conv)
        if (d) drafts.set(conv, { ...d, doc: null })
      }
    }
    for (const q of files) {
      await chat.sendFile(q.file, reply, conv)
      reply = null
      clearReply()
      if (here()) unqueue(q)
      else {
        if (q.url) URL.revokeObjectURL(q.url)
        queues.set(conv, (queues.get(conv) ?? []).filter((x) => x !== q))
      }
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

// ---------- :emoji: shortcodes ----------
const emojiPop = ref<{ query: string; from: number; to: number } | null>(null)
const emojiIdx = ref(0)

const emojiCandidates = computed(() => {
  const q = emojiPop.value?.query
  const data = emojiData.value
  if (!q || !data) return []
  return searchEmoji(data, q, 8).map((it) => ({ e: it.e, code: codeFor(it, q) }))
})
watch(emojiCandidates, () => (emojiIdx.value = 0))

/** Looks at the text before the cursor: ":sm" opens the suggestions, a finished ":smile:" becomes the emoji. */
function updateEmoji() {
  const ed = editor.value
  emojiPop.value = null
  if (!ed) return
  const { $from, empty: collapsed } = ed.state.selection
  if (!collapsed || $from.parent.type.name === 'codeBlock' || $from.marks().some((m) => m.type.name === 'code')) return
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const m = /(?:^|[\s(])(:([a-z0-9_+-]{1,32}):?)$/i.exec(before)
  if (!m) return
  const typed = m[1]!
  const name = m[2]!
  const from = $from.pos - typed.length
  if (typed.endsWith(':')) {
    void loadEmoji().then((d) => {
      const e = d.byCode.get(name.toLowerCase())
      // Still the same text under the cursor? Then swap ":name:" for the emoji.
      if (e && editor.value?.state.selection.from === $from.pos && editor.value.state.doc.textBetween(from, $from.pos) === typed) {
        editor.value.chain().insertContentAt({ from, to: $from.pos }, e).run()
        addRecent(e)
      }
    }).catch(() => {})
    return
  }
  if (name.length < 2) return
  emojiPop.value = { query: name, from, to: $from.pos }
  if (!emojiData.value) void loadEmoji().then(() => updateEmoji()).catch(() => {})
}

function pickEmoji(i = emojiIdx.value) {
  const p = emojiPop.value
  const c = emojiCandidates.value[i]
  if (!p || !c) return false
  editor.value?.chain().focus().insertContentAt({ from: p.from, to: p.to }, c.e).run()
  addRecent(c.e)
  emojiPop.value = null
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
    const emojiMenu = () => emojiPop.value && emojiCandidates.value.length > 0
    return {
      Enter: () => {
        if (menu() && pickMention()) return true
        if (emojiMenu() && pickEmoji()) return true
        // In a code block Enter is a newline; Ctrl/Cmd+Enter or the button sends.
        if (this.editor.isActive('codeBlock')) return false
        if (codeFenceShortcut(this.editor)) return true
        // Phones: Enter is a newline (the default Enter behaviour); the Send button sends.
        if (coarsePointer()) return false
        void send()
        return true
      },
      'Mod-Enter': () => (void send(), true),
      Tab: () => (menu() ? pickMention() : emojiMenu() ? pickEmoji() : false),
      ArrowUp: () => {
        if (menu()) {
          mentionIdx.value = (mentionIdx.value + candidates.value.length - 1) % candidates.value.length
          return true
        }
        if (emojiMenu()) {
          emojiIdx.value = (emojiIdx.value + emojiCandidates.value.length - 1) % emojiCandidates.value.length
          return true
        }
        if (empty.value && !queue.value.length && !props.disabled) return startEditLast()
        return false
      },
      ArrowDown: () => {
        if (menu()) mentionIdx.value = (mentionIdx.value + 1) % candidates.value.length
        else if (emojiMenu()) emojiIdx.value = (emojiIdx.value + 1) % emojiCandidates.value.length
        else return false
        return true
      },
      Escape: () => {
        if (mention.value) mention.value = null
        else if (emojiPop.value) emojiPop.value = null
        else if (replyTo.value) replyTo.value = null
        // An open side panel closes first (ProseMirror swallows Esc, so ConversationPane never sees it).
        else if (sidePanel.value) sidePanel.value = null
        else requestScroll('bottom') // jump to the newest message (which also marks it read)
        return true
      },
      PageUp: () => (requestScroll('up'), true),
      PageDown: () => (requestScroll('down'), true),
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
    updateEmoji()
    // Keep the draft up to date (saved on this device too).
    const conv = chat.state.active
    if (conv && chat.state.account) drafts.set(conv, { doc: empty.value ? null : doc, reply: replyTo.value })
  },
  onSelectionUpdate: () => (updateMention(), updateEmoji()),
  onBlur: () => setTimeout(() => (mention.value = emojiPop.value = null), 150),
  editorProps: {
    attributes: { class: 'composer-editor prose-like', 'aria-label': 'Message' },
    handlePaste: (_view, event) => {
      const cd = event.clipboardData
      let files = Array.from(cd?.files ?? [])
      if (!files.length) files = Array.from(cd?.items ?? []).flatMap((i) => (i.kind === 'file' ? [i.getAsFile()] : [])).filter((f): f is File => !!f)
      if (!files.length) return false
      // Screenshots arrive as a generic "image.png"; give each a distinct name.
      files = files.map((f) => (/^image\.\w+$/i.test(f.name) ? new File([f], `pasted-${Date.now()}-${nextKey}.${f.name.split('.').pop()}`, { type: f.type }) : f))
      event.preventDefault()
      addFiles(files)
      return true
    },
    // Files dropped on the editor are handled by the conversation pane.
    handleDrop: (_view, event) => Boolean(event.dataTransfer?.files.length),
  },
})

watch(() => props.disabled, (d) => editor.value?.setEditable(!d))

// Per-conversation drafts: text, reply target and queued files (restored on mount too).
function restore(now: ConvId | null) {
  const ed = editor.value
  if (!ed) return
  const d = now ? drafts.get(now) : undefined
  ed.commands.setContent((d?.doc as object | null) ?? '', { emitUpdate: false })
  replyTo.value = d?.reply ?? null
  queue.value = (now && queues.get(now)) || []
  empty.value = isEmptyDoc(ed.getJSON())
  mention.value = null
  emojiPop.value = null
  if (now) ed.commands.focus('end')
}
watch(
  () => chat.state.active,
  (now, old) => {
    const ed = editor.value
    if (!ed) return
    if (old !== undefined && old && chat.state.account) {
      drafts.set(old, { doc: isEmptyDoc(ed.getJSON()) ? null : ed.getJSON(), reply: replyTo.value })
      queues.set(old, queue.value)
    }
    restore(now)
  },
)
// On mount (e.g. coming back from the Friends view) restore the draft once the editor exists.
watch(editor, (ed) => ed && restore(chat.state.active), { immediate: true })
// Saved drafts arrive a moment after sign-in: fill an untouched message box with the open chat's draft.
watch(draftsReady, (ready) => {
  const ed = editor.value
  const conv = chat.state.active
  if (!ready || !ed || !conv || !empty.value) return
  const doc = drafts.get(conv)?.doc
  if (!doc) return
  ed.commands.setContent(doc as object, { emitUpdate: false })
  empty.value = isEmptyDoc(ed.getJSON())
})

// Signing out drops queued files too (state.ts clears the text drafts).
watch(() => chat.state.account, (a) => {
  if (a) return
  queue.value = []
  editor.value?.commands.clearContent(false)
  empty.value = true
})

watch(replyTo, (r) => {
  if (r) editor.value?.commands.focus()
})

// Type to talk: typing (or pasting) while nothing else takes text puts it in the message box, like Discord.
function onWindowKey(e: KeyboardEvent) {
  const ed = editor.value
  if (!ed || props.disabled || e.defaultPrevented || e.isComposing || ed.isFocused) return
  const paste = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v'
  const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey
  if (!paste && !printable) return
  const t = e.target as HTMLElement | null
  if (t?.closest('input, textarea, select, [contenteditable="true"], [role=dialog], [role=menu], [role=listbox]')) return
  // A space or a key on a focused button means "press it", not "type".
  if (printable && e.key === ' ' && t?.closest('button, a, [role=button]')) return
  if (document.querySelector('[role=dialog], [role=menu]')) return
  // Focus right now so this key's character lands in the box: Tiptap's focus() only focuses on the
  // next animation frame outside Safari, which would drop the first letter(s) in Chromium.
  ed.view.dom.focus({ preventScroll: true })
  ed.commands.focus('end')
}
window.addEventListener('keydown', onWindowKey)

composerApi.focus = () => editor.value?.commands.focus('end')
/** Quote: a blockquote of the given text followed by an empty paragraph to write the answer in. */
composerApi.quote = (text) => {
  const ed = editor.value
  if (!ed || props.disabled) return
  const lines = text.trim().slice(0, 2000).split('\n')
  // Spoilers come back as ||text|| (see plaintext.ts): keep them hidden in the quote too.
  const inline = (l: string) => l.split(/\|\|([^|]+?)\|\|/).flatMap((part, i) =>
    !part ? [] : i % 2 ? [{ type: 'text', text: part, marks: [{ type: 'spoiler' }] }] : [{ type: 'text', text: part }])
  const quote = { type: 'blockquote', content: lines.map((l) => (inline(l).length ? { type: 'paragraph', content: inline(l) } : { type: 'paragraph' })) }
  ed.chain().focus('end').insertContent([quote, { type: 'paragraph' }]).run()
  void nextTick(() => ed.commands.focus('end'))
}

onBeforeUnmount(() => {
  composerApi.focus = composerApi.quote = null
  window.removeEventListener('keydown', onWindowKey)
  const ed = editor.value
  const id = chat.state.active
  if (ed && id && chat.state.account) {
    drafts.set(id, { doc: isEmptyDoc(ed.getJSON()) ? null : ed.getJSON(), reply: replyTo.value })
    queues.set(id, queue.value)
  }
  ed?.destroy()
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

function closeLink() {
  linkOpen.value = false
  editor.value?.commands.focus()
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
      v-if="emojiCandidates.length" role="listbox" aria-label="Emoji suggestions"
      class="dialog absolute right-0 bottom-full left-0 z-20 mb-1.5 overflow-hidden rounded-lg p-1 text-sm"
    >
      <li v-for="(c, i) in emojiCandidates" :key="c.e" role="option" :aria-selected="i === emojiIdx">
        <button
          type="button" class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
          :class="i === emojiIdx ? 'bg-active' : 'hover:bg-hover'" @mousedown.prevent="pickEmoji(i)"
        >
          <span class="w-6 text-center text-xl leading-none">{{ c.e }}</span>
          <span class="min-w-0 flex-1 truncate font-medium">:{{ c.code }}:</span>
        </button>
      </li>
    </ul>

    <ul
      v-else-if="candidates.length" role="listbox" aria-label="Mention a member"
      class="dialog absolute right-0 bottom-full left-0 z-20 mb-1.5 overflow-hidden rounded-lg p-1 text-sm"
    >
      <li v-for="(c, i) in candidates" :key="c.id" role="option" :aria-selected="i === mentionIdx">
        <button
          type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
          :class="i === mentionIdx ? 'bg-active' : 'hover:bg-hover'" @mousedown.prevent="pickMention(i)"
        >
          <UserAvatar :name="c.name" :id="c.id" :src="chat.state.contacts[c.id]?.avatar" :size="24" :online="chat.state.contacts[c.id]?.friend ? chat.state.contacts[c.id]?.online : undefined" still style="--dot-ring: var(--popover)" />
          <span class="min-w-0 flex-1 truncate font-medium">{{ c.name }}</span>
          <span v-if="chat.state.contacts[c.id]?.username && chat.state.contacts[c.id]?.username !== c.name" class="truncate text-xs text-muted-foreground">@{{ chat.state.contacts[c.id]?.username }}</span>
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
        <input v-model="linkUrl" class="field !h-9 !rounded-md !text-sm" aria-label="Link address" @keydown.esc.prevent.stop="closeLink" placeholder="https://… (empty removes link)" autofocus>
        <button class="btn btn-primary btn-icon btn-sm" type="submit" title="Apply" aria-label="Apply"><Check /></button>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" title="Cancel" aria-label="Cancel" @click="closeLink"><X /></button>
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
          :title="coarse ? 'Send' : 'Send (Enter)'" aria-label="Send" :aria-disabled="!canSend" :disabled="disabled || sending" @click="send"
        >
          <SendHorizontal />
        </button>
      </div>
    </div>

    <!-- Fixed height so the typing line never shifts the layout -->
    <div class="flex h-5 items-center gap-1.5 px-1 pt-1 text-xs text-muted-foreground" aria-live="polite">
      <span v-if="chat.state.status === 'connecting'" class="truncate">Connecting…</span>
      <span v-else-if="chat.state.status === 'offline'" class="truncate">Offline. Messages are sent when you're back online.</span>
      <template v-else-if="typingText">
        <span class="flex gap-0.5" aria-hidden="true">
          <i v-for="n in 3" :key="n" class="size-1 animate-bounce rounded-full bg-muted-foreground" :style="{ animationDelay: `${(n - 1) * 150}ms` }" />
        </span>
        <span class="truncate"><strong class="font-semibold">{{ typingText }}</strong>…</span>
      </template>
    </div>
  </div>
</template>
