<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Loader2, Users } from 'lucide-vue-next'
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

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [] }>()

const name = ref('')
const selected = ref<string[]>([])
const busy = ref(false)
const contacts = computed(() => friendList())

watch(open, (o) => {
  if (o) {
    name.value = ''
    selected.value = []
  }
})

/** What the group will be called if no name is typed: its members' names. */
const defaultTitle = computed(() => {
  const names = selected.value.map((id) => chat.displayName(id))
  if (!names.length) return 'Members\' names'
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
})

function toggle(n: string, on: boolean | 'indeterminate') {
  selected.value = on === true ? [...selected.value, n] : selected.value.filter((x) => x !== n)
}

async function submit() {
  if (!selected.value.length) return
  busy.value = true
  try {
    await chat.createGroup(name.value.trim(), selected.value)
    open.value = false
    emit('created')
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
          <div class="mb-2 flex size-11 items-center justify-center rounded-lg text-white [background:var(--grad)]"><Users class="size-5" /></div>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>Pick at least one member. A name is optional: without one, the group is called after its members.</DialogDescription>
        </DialogHeader>
        <div>
          <label class="label" for="group-name">Group name <span class="font-normal text-muted-foreground">(optional)</span></label>
          <input id="group-name" v-model="name" class="field" maxlength="64" autocomplete="off" :placeholder="selected.length ? defaultTitle : 'e.g. Weekend plans'">
        </div>
        <div>
          <div class="label">Members <span v-if="selected.length" class="text-primary">· {{ selected.length }} selected</span></div>
          <div class="well max-h-56 space-y-0.5 overflow-y-auto rounded-lg p-1.5">
            <p v-if="!contacts.length" class="p-2 text-xs text-muted-foreground">Add some friends first, then you can group them.</p>
            <label v-for="f in contacts" :key="f.id" class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-hover">
              <UserAvatar :name="f.name" :id="f.id" :src="f.avatar" :size="28" />
              <span class="flex-1 font-medium">{{ f.name }}</span>
              <Checkbox :model-value="selected.includes(f.id)" @update:model-value="toggle(f.id, $event)" />
            </label>
          </div>
        </div>
        <DialogFooter>
          <button type="submit" class="btn btn-primary" :disabled="busy || !selected.length">
            <Loader2 v-if="busy" class="animate-spin" />Create group
          </button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
