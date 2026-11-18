<script setup lang="ts">
import { ref, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import type { Group } from '@/lib/types'

const props = defineProps<{ group: Group }>()
const open = defineModel<boolean>('open', { required: true })

const name = ref('')
const busy = ref(false)
watch(open, (o) => {
  if (o) name.value = props.group.name
})

async function submit() {
  const n = name.value.trim()
  if (!n || n === props.group.name) {
    open.value = false
    return
  }
  busy.value = true
  try {
    await chat.renameGroup(props.group.id, n)
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
          <DialogTitle>Rename group</DialogTitle>
          <DialogDescription>Everyone in the group will see the new name.</DialogDescription>
        </DialogHeader>
        <input v-model="name" class="field" aria-label="Group name" maxlength="64" autocomplete="off" @focus="($event.target as HTMLInputElement).select()">
        <DialogFooter>
          <button type="button" class="btn btn-soft" @click="open = false">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="busy || !name.trim()"><Loader2 v-if="busy" class="animate-spin" />Save</button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
