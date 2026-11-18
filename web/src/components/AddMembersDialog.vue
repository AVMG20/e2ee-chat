<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Loader2, UserPlus } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'

const friendList = () =>
  Object.values(chat.state.contacts).filter((c) => c.friend).sort((a, b) => a.name.localeCompare(b.name))
import type { Group } from '@/lib/types'

const props = defineProps<{ group: Group }>()
const open = defineModel<boolean>('open', { required: true })

const selected = ref<string[]>([])
const busy = ref(false)
const candidates = computed(() => friendList().filter((f) => !props.group.members.includes(f.id)))

watch(open, (o) => {
  if (o) selected.value = []
})

function toggle(n: string, on: boolean | 'indeterminate') {
  selected.value = on === true ? [...selected.value, n] : selected.value.filter((x) => x !== n)
}

async function submit() {
  busy.value = true
  try {
    await chat.addMembers(props.group.id, selected.value)
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
    <DialogContent>
      <form class="grid gap-5" @submit.prevent="submit">
        <DialogHeader>
          <div class="mb-2 flex size-11 items-center justify-center rounded-lg text-white [background:var(--grad)]"><UserPlus class="size-5" /></div>
          <DialogTitle>Add members</DialogTitle>
          <DialogDescription>New members will be able to read messages sent after they join.</DialogDescription>
        </DialogHeader>
        <div class="well max-h-60 space-y-0.5 overflow-y-auto rounded-lg p-1.5">
          <p v-if="!candidates.length" class="p-2 text-xs text-muted-foreground">All your friends are already in this group.</p>
          <label v-for="f in candidates" :key="f.id" class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-hover">
            <UserAvatar :name="f.name" :id="f.id" :size="28" />
            <span class="flex-1 font-medium">{{ f.name }}</span>
            <Checkbox :model-value="selected.includes(f.id)" @update:model-value="toggle(f.id, $event)" />
          </label>
        </div>
        <DialogFooter>
          <button type="submit" class="btn btn-primary" :disabled="busy || !selected.length">
            <Loader2 v-if="busy" class="animate-spin" />Add members
          </button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
