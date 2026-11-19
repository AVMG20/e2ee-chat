<script setup lang="ts">
import { ref, watch } from 'vue'
import { Loader2, LockKeyhole, TriangleAlert } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ deleted: [] }>()

const password = ref('')
const busy = ref(false)
const error = ref('')

watch(open, (o) => {
  if (o) password.value = error.value = ''
})

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await chat.deleteAccount(password.value)
    open.value = false
    emit('deleted')
    toast.success('Your account was deleted')
  } catch (e) {
    error.value = errMsg(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <form class="grid gap-4" @submit.prevent="submit">
        <DialogHeader>
          <div class="mb-2 flex size-11 items-center justify-center rounded-full bg-destructive/15 text-destructive"><TriangleAlert class="size-5" /></div>
          <DialogTitle>Delete your account?</DialogTitle>
          <DialogDescription>
            This deletes your account, your friends and the messages stored on the server, and signs out all your devices. It can't be undone.
            Your friends keep their own copies of your conversations.
          </DialogDescription>
        </DialogHeader>
        <div>
          <label class="label" for="del-pw">Enter your password to confirm</label>
          <div class="field-icon"><LockKeyhole /><input id="del-pw" v-model="password" class="field" type="password" required autocomplete="current-password" :disabled="busy"></div>
        </div>
        <p v-if="error" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{{ error }}</p>
        <DialogFooter>
          <button type="button" class="btn btn-soft" :disabled="busy" @click="open = false">Cancel</button>
          <button type="submit" class="btn btn-danger" :disabled="busy || !password" aria-label="Delete account" title="Delete account">
            <Loader2 v-if="busy" class="animate-spin" />Delete account
          </button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
