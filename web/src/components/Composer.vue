<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import {
  ArrowUp, Bold, Check, Code, Code2, Italic, Link as LinkIcon, List, ListOrdered, Paperclip, Quote,
  Strikethrough, X,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { editorExtensions } from '@/lib/editor'
import { errMsg } from '@/lib/format'
import { isEmptyDoc } from '@/lib/render'
import { MAX_FILE_BYTES } from '@/lib/types'

const props = defineProps<{ disabled?: boolean }>()

const fileInput = ref<HTMLInputElement | null>(null)
const sending = ref(false)
const toolsOpen = ref(false)
const empty = ref(true)
const linkOpen = ref(false)
const linkUrl = ref('')

async function send() {
  const ed = editor.value
  if (!ed || props.disabled || sending.value) return
  const doc = ed.getJSON()
  if (isEmptyDoc(doc)) return
  sending.value = true
  try {
    await chat.sendText(doc)
    ed.commands.clearContent(true)
    empty.value = true
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    sending.value = false
  }
}

async function sendFiles(files: File[]) {
  if (props.disabled) return
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      toast.error(`"${f.name}" is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`)
      continue
    }
    try {
      await chat.sendFile(f)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
}

const SendOnEnter = Extension.create({
  name: 'sendOnEnter',
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        void send()
        return true
      },
    }
  },
})

const editor = useEditor({
  extensions: [...editorExtensions(), Placeholder.configure({ placeholder: 'Message' }), SendOnEnter],
  editable: !props.disabled,
  onUpdate: ({ editor: ed }) => {
    empty.value = isEmptyDoc(ed.getJSON())
  },
  editorProps: {
    attributes: { class: 'composer-editor prose-like', 'aria-label': 'Message' },
    handlePaste: (_view, event) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (!files.length) return false
      event.preventDefault()
      void sendFiles(files)
      return true
    },
    // Files dropped on the editor are handled by the conversation pane.
    handleDrop: (_view, event) => Boolean(event.dataTransfer?.files.length),
  },
})

watch(() => props.disabled, (d) => editor.value?.setEditable(!d))
onBeforeUnmount(() => editor.value?.destroy())

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  void sendFiles(files)
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
defineExpose({ sendFiles })

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
  <div>
    <div class="composer-shell overflow-hidden rounded-lg" :class="disabled && 'opacity-60'">
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
        <button type="button" class="btn btn-ghost btn-icon shrink-0 !size-10" title="Attach file" aria-label="Attach file" :disabled="disabled" @click="fileInput?.click()">
          <Paperclip />
        </button>
        <input ref="fileInput" type="file" multiple class="hidden" @change="onPick">

        <EditorContent :editor="editor" class="max-h-40 min-w-0 flex-1 overflow-y-auto py-2.5 text-[15px]" />

        <button
          type="button" class="btn btn-ghost btn-icon shrink-0 !size-10 text-sm font-semibold"
          title="Formatting" aria-label="Toggle formatting toolbar" :disabled="disabled"
          :class="toolsOpen && 'btn-active'" @click="toolsOpen = !toolsOpen"
        >
          Aa
        </button>
        <button
          type="button" class="btn btn-primary btn-icon shrink-0 !size-10 transition-all" title="Send (Enter)" aria-label="Send"
          :class="empty && 'scale-90 !opacity-35'" :disabled="disabled || sending || empty" @click="send"
        >
          <ArrowUp stroke-width="2.5" />
        </button>
      </div>
    </div>
  </div>
</template>
