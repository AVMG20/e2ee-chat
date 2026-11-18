<script setup lang="ts">
import { ref } from 'vue'
import { ShieldCheck } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import FingerprintBlock from '@/components/FingerprintBlock.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import type { Contact } from '@/lib/types'

const props = defineProps<{ contact: Contact }>()
const open = defineModel<boolean>('open', { required: true })
const busy = ref(false)

function mine(): string {
  try {
    return chat.myFingerprint()
  } catch (e) {
    return errMsg(e)
  }
}

async function setVerified(v: boolean | 'indeterminate') {
  busy.value = true
  try {
    await chat.setVerified(props.contact.id, v === true)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <div class="mb-2 flex size-11 items-center justify-center rounded-lg text-white [background:var(--grad)]">
          <ShieldCheck class="size-5" />
        </div>
        <DialogTitle>Verify {{ contact.name }}</DialogTitle>
        <DialogDescription>
          Compare these fingerprints with {{ contact.name }} in person or over a call you trust.
          If both sides see the same values, nobody is intercepting your messages.
        </DialogDescription>
      </DialogHeader>
      <div class="space-y-4">
        <FingerprintBlock label="Your fingerprint" :value="mine()" />
        <FingerprintBlock :label="`${contact.name}'s fingerprint`" :value="contact.fingerprint" />
        <label class="well flex cursor-pointer items-center gap-3 rounded-lg p-3.5 text-sm">
          <Checkbox :model-value="contact.verified" :disabled="busy" @update:model-value="setVerified" />
          <span>I compared the fingerprints and they match</span>
        </label>
      </div>
    </DialogContent>
  </Dialog>
</template>
