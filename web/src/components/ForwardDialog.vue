<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Forward, Hash, Loader2, Search } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { forwardMsg, refocusComposer } from '@/components/messages/state'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import type { ConvId } from '@/lib/types'

const open = computed({
  get: () => !!forwardMsg.value,
  set: (v) => {
    if (!v) forwardMsg.value = null
  },
})
const query = ref('')
const selected = ref<ConvId[]>([])
const busy = ref(false)

watch(open, (o) => {
  if (o) {
    query.value = ''
    selected.value = []
  }
})

const convs = computed(() => {
  const q = query.value.trim().toLowerCase()
  return chat.state.conversations.filter((c) => !q || c.title.toLowerCase().includes(q))
})
const idOf = (id: ConvId) => id.slice(id.startsWith('dm:') ? 3 : 2)

function toggle(id: ConvId, on: boolean | 'indeterminate') {
  selected.value = on === true ? [...selected.value, id] : selected.value.filter((x) => x !== id)
}

async function submit() {
  const m = forwardMsg.value
  if (!m || !selected.value.length) return
  busy.value = true
  try {
    await chat.forwardMessage(m, selected.value)
    toast.success(selected.value.length === 1 ? 'Message forwarded' : `Forwarded to ${selected.value.length} chats`)
    open.value = false
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent @close-auto-focus="(e: Event) => (e.preventDefault(), refocusComposer())">
      <form class="grid gap-4" @submit.prevent="submit">
        <DialogHeader>
          <div class="mb-2 flex size-11 items-center justify-center rounded-lg text-white [background:var(--grad)]"><Forward class="size-5" /></div>
          <DialogTitle>Forward message</DialogTitle>
          <DialogDescription>Pick the chats to send it to.</DialogDescription>
        </DialogHeader>
        <div class="field-icon">
          <Search />
          <input v-model="query" class="field" placeholder="Filter chats" aria-label="Filter chats" autocomplete="off" spellcheck="false">
        </div>
        <div class="well max-h-60 space-y-0.5 overflow-y-auto rounded-lg p-1.5">
          <p v-if="!convs.length" class="p-2 text-xs text-muted-foreground">No chats found.</p>
          <label v-for="c in convs" :key="c.id" class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-hover">
            <span v-if="c.kind === 'group'" class="flex size-7 shrink-0 items-center justify-center rounded-full bg-soft"><Hash class="size-3.5" /></span>
            <UserAvatar v-else :name="c.title" :id="idOf(c.id)" :src="chat.state.contacts[idOf(c.id)]?.avatar" :size="28" />
            <span class="min-w-0 flex-1 truncate font-medium">{{ c.title }}</span>
            <Checkbox :model-value="selected.includes(c.id)" :aria-label="`Forward to ${c.title}`" @update:model-value="toggle(c.id, $event)" />
          </label>
        </div>
        <DialogFooter>
          <button type="submit" class="btn btn-primary" :disabled="busy || !selected.length">
            <Loader2 v-if="busy" class="animate-spin" />Send
          </button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
