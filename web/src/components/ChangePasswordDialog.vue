<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { KeyRound, Loader2, LockKeyhole } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { MIN_PASSWORD } from '@/lib/types'

const open = defineModel<boolean>('open', { required: true })

const current = ref('')
const next = ref('')
const confirm = ref('')
const busy = ref(false)
const error = ref('')

const mismatch = computed(() => confirm.value !== '' && confirm.value !== next.value)

watch(open, (o) => {
  if (o) {
    current.value = next.value = confirm.value = error.value = ''
  }
})

async function submit() {
  error.value = ''
  if (next.value.length < MIN_PASSWORD) {
    error.value = `New password must be at least ${MIN_PASSWORD} characters.`
    return
  }
  if (next.value !== confirm.value) {
    error.value = 'Passwords do not match.'
    return
  }
  busy.value = true
  try {
    await chat.changePassword(current.value, next.value)
    open.value = false
    toast.success('Password changed')
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
          <div class="mb-2 flex size-11 items-center justify-center rounded-lg text-white [background:var(--grad)]"><KeyRound class="size-5" /></div>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Your keys are re-locked with the new password. Your other devices will be signed out. Passwords can't be reset.</DialogDescription>
        </DialogHeader>
        <div>
          <label class="label" for="pw-old">Current password</label>
          <div class="field-icon"><LockKeyhole /><input id="pw-old" v-model="current" class="field" type="password" required autocomplete="current-password" :disabled="busy"></div>
        </div>
        <div>
          <label class="label" for="pw-new">New password</label>
          <div class="field-icon"><LockKeyhole /><input id="pw-new" v-model="next" class="field" type="password" required :minlength="MIN_PASSWORD" autocomplete="new-password" :placeholder="`At least ${MIN_PASSWORD} characters`" :disabled="busy"></div>
        </div>
        <div>
          <label class="label" for="pw-confirm">Confirm new password</label>
          <div class="field-icon"><LockKeyhole /><input id="pw-confirm" v-model="confirm" class="field" type="password" required autocomplete="new-password" :disabled="busy"></div>
          <p v-if="mismatch" class="mt-1.5 text-xs text-destructive">Passwords do not match.</p>
        </div>
        <p v-if="error" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{{ error }}</p>
        <DialogFooter>
          <button type="submit" class="btn btn-primary" :disabled="busy">
            <Loader2 v-if="busy" class="animate-spin" />{{ busy ? 'Re-locking keys…' : 'Change password' }}
          </button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
