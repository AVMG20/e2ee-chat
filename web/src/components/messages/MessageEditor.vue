<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { Extension } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { fencesToCodeBlocks } from '@/lib/code/fences'
import { editorExtensions } from '@/lib/editor'
import { errMsg } from '@/lib/format'
import { isEmptyDoc } from '@/lib/render'
import type { ChatMessage } from '@/lib/types'
import { codeFenceShortcut } from './codefence'
import { editingId } from './state'

const props = defineProps<{ msg: ChatMessage }>()
let saving = false

function cancel() {
  if (editingId.value === props.msg.id) editingId.value = null
}

async function save() {
  const ed = editor.value
  if (!ed || saving) return
  const doc = fencesToCodeBlocks(ed.getJSON())
  if (isEmptyDoc(doc)) {
    toast.error('A message can\'t be empty. Delete it instead.')
    return
  }
  if (JSON.stringify(doc) === JSON.stringify(props.msg.doc)) return cancel()
  saving = true
  try {
    await chat.editMessage(props.msg, doc)
    cancel()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    saving = false
  }
}

const Keys = Extension.create({
  name: 'editKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (this.editor.isActive('codeBlock')) return false
        if (codeFenceShortcut(this.editor)) return true
        void save()
        return true
      },
      'Mod-Enter': () => (void save(), true),
      Escape: () => (cancel(), true),
    }
  },
})

const editor = useEditor({
  extensions: [...editorExtensions(), Keys],
  content: props.msg.doc,
  autofocus: 'end',
  editorProps: { attributes: { class: 'composer-editor prose-like', 'aria-label': 'Edit message' } },
})
onBeforeUnmount(() => editor.value?.destroy())
</script>

<template>
  <div>
    <EditorContent :editor="editor" class="max-h-60 overflow-y-auto rounded-md bg-composer px-3 py-2 text-[15px] [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line [&_pre]:bg-inset [&_pre]:font-mono [&_pre]:text-[13px] focus-within:shadow-[var(--glow)]" />
    <p class="mt-1 text-xs text-muted-foreground">
      escape to <button class="text-[var(--link)] hover:underline" @click="cancel">cancel</button>
      · enter to <button class="text-[var(--link)] hover:underline" @click="save">save</button>
    </p>
  </div>
</template>
