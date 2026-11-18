<script setup lang="ts">
import { computed } from 'vue'
import { Copy, KeyRound } from 'lucide-vue-next'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import FingerprintBlock from '@/components/FingerprintBlock.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { copyText } from '@/lib/ui'

const open = defineModel<boolean>('open', { required: true })
defineEmits<{ changePassword: [] }>()

const id = computed(() => chat.formatId(chat.state.account?.id ?? ''))

function fingerprint(): string {
  try {
    return chat.myFingerprint()
  } catch (e) {
    return errMsg(e)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Your account</DialogTitle>
        <DialogDescription>{{ chat.state.account?.server }}</DialogDescription>
      </DialogHeader>

      <div class="well flex items-center gap-3 rounded-2xl p-3.5" style="--dot-ring: var(--card)">
        <UserAvatar :name="chat.state.account?.username ?? '?'" :id="chat.state.account?.id" :size="48" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-base font-semibold">{{ chat.state.account?.username }}</div>
          <div class="font-mono text-sm tracking-[0.1em] text-muted-foreground select-all">{{ id }}</div>
        </div>
        <button class="btn btn-soft btn-sm" @click="copyText(id, 'ID copied')"><Copy />Copy ID</button>
      </div>

      <FingerprintBlock label="Key fingerprint" :value="fingerprint()" />
      <p class="-mt-3 text-xs text-muted-foreground">Share this with your contacts over a trusted channel so they can verify it is really you.</p>

      <button class="btn btn-soft w-full" @click="open = false; $emit('changePassword')"><KeyRound />Change password</button>
    </DialogContent>
  </Dialog>
</template>
