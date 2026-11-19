<script setup lang="ts">
import { ref, watch } from 'vue'
import { Loader2, LockKeyhole, RefreshCw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'

const open = defineModel<boolean>('open', { required: true })

const password = ref('')
const newPassword = ref('')
const confirm = ref('')
const busy = ref(false)
const error = ref('')

watch(open, (o) => {
  if (o) password.value = newPassword.value = confirm.value = error.value = ''
})

async function submit() {
  error.value = ''
  if (newPassword.value && newPassword.value !== confirm.value) {
    error.value = "The new passwords don't match"
    return
  }
  busy.value = true
  try {
    await chat.rotateKeys(password.value, newPassword.value || undefined)
    open.value = false
    toast.success('Your security keys were changed')
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
          <div class="mb-2 flex size-11 items-center justify-center rounded-full bg-destructive/15 text-destructive"><RefreshCw class="size-5" /></div>
          <DialogTitle>Change your security keys?</DialogTitle>
          <DialogDescription>
            This makes new keys for your account. Use it if a device was lost or you think someone got your keys.
          </DialogDescription>
          <ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Messages sent to you afterwards can't be read with the old keys.</li>
            <li>Your other devices are signed out and get the new keys when you sign in again.</li>
            <li>Your friends see that your security code changed. Until they accept the new one, they can't message you or send in groups you're in.</li>
            <li>Your existing chats stay readable.</li>
            <li>If someone may know your password, set a new one below too. Otherwise they could sign in and get the new keys.</li>
          </ul>
        </DialogHeader>
        <div>
          <label class="label" for="rot-pw">Your password</label>
          <div class="field-icon"><LockKeyhole /><input id="rot-pw" v-model="password" class="field" type="password" required autocomplete="current-password" :disabled="busy"></div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label" for="rot-new">New password (optional)</label>
            <input id="rot-new" v-model="newPassword" class="field" type="password" autocomplete="new-password" :disabled="busy" placeholder="Keep current password">
          </div>
          <div v-if="newPassword">
            <label class="label" for="rot-confirm">Repeat new password</label>
            <input id="rot-confirm" v-model="confirm" class="field" type="password" autocomplete="new-password" :disabled="busy">
          </div>
        </div>
        <p v-if="error" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{{ error }}</p>
        <DialogFooter>
          <button type="button" class="btn btn-soft" :disabled="busy" @click="open = false">Cancel</button>
          <button type="submit" class="btn btn-danger" :disabled="busy || !password" aria-label="Change keys" title="Change keys">
            <Loader2 v-if="busy" class="animate-spin" />Change keys
          </button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
