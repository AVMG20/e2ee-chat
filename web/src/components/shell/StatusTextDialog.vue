<script setup lang="ts">
import { ref, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'

const MAX = 128
const open = defineModel<boolean>('open', { required: true })
const text = ref('')
const busy = ref(false)

watch(open, (o) => {
  if (o) text.value = chat.state.account?.note ?? ''
})

/** Saves the text; an empty string clears it. */
async function save(value: string) {
  busy.value = true
  try {
    await chat.setStatusText(value.trim())
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
      <form class="grid gap-5" @submit.prevent="save(text)">
        <DialogHeader>
          <DialogTitle>Set a custom status</DialogTitle>
          <DialogDescription>Your friends see this next to your name, for example "in a meeting until 3".</DialogDescription>
        </DialogHeader>
        <div>
          <label class="label" for="status-text">Status</label>
          <input id="status-text" v-model="text" class="field" :maxlength="MAX" autocomplete="off" placeholder="What's up?" autofocus>
          <p class="mt-1 text-right text-xs text-muted-foreground">{{ text.length }}/{{ MAX }}</p>
        </div>
        <DialogFooter>
          <button type="button" class="btn btn-ghost" :disabled="busy || !chat.state.account?.note" @click="save('')">Clear status</button>
          <button type="submit" class="btn btn-primary" :disabled="busy"><Loader2 v-if="busy" class="animate-spin" />Save</button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
