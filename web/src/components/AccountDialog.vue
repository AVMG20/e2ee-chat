<script setup lang="ts">
import { computed } from 'vue'
import { Download, KeyRound, LogOut } from 'lucide-vue-next'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import FingerprintBlock from '@/components/FingerprintBlock.vue'
import CopyIdButton from '@/components/shell/CopyIdButton.vue'
import Toggle from '@/components/shell/Toggle.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { notifyDenied, notifyEnabled, notifySupported, setNotify, setSound, soundEnabled } from '@/lib/notify'
import { toast } from 'vue-sonner'

const open = defineModel<boolean>('open', { required: true })
defineEmits<{ changePassword: []; signOut: [] }>()

const rawId = computed(() => chat.state.account?.id ?? '')
const id = computed(() => chat.formatId(rawId.value))

async function toggleNotify(on: boolean) {
  const result = await setNotify(on)
  if (on && !result) toast.error(notifySupported ? 'Notifications are blocked. Allow them in your browser settings.' : 'This browser does not support notifications.')
}

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

      <div class="well flex items-center gap-3 rounded-lg p-3.5" style="--dot-ring: var(--card)">
        <UserAvatar :name="chat.state.account?.username ?? '?'" :id="chat.state.account?.id" :size="48" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-base font-semibold">{{ chat.state.account?.username }}</div>
          <div class="font-mono text-sm tracking-[0.1em] text-muted-foreground select-all">{{ id }}</div>
        </div>
        <CopyIdButton :id="rawId" label="Copy ID" />
      </div>

      <FingerprintBlock label="Key fingerprint" :value="fingerprint()" />
      <p class="-mt-3 text-xs text-muted-foreground">Share this with your contacts over a trusted channel so they can verify it is really you.</p>

      <div class="space-y-3.5">
        <div class="eyebrow">Notifications</div>
        <Toggle
          :model-value="notifyEnabled" :disabled="!notifySupported" label="Desktop notifications"
          :description="notifyDenied ? 'Blocked by your browser. Allow notifications for this site to use this.' : 'Show a notification for new messages when you are not looking at the chat.'"
          @update:model-value="toggleNotify"
        />
        <Toggle :model-value="soundEnabled" label="Sound" description="Play a short sound for new messages." @update:model-value="setSound" />
      </div>

      <a v-if="!chat.isDesktop" :href="chat.desktopDownloadUrl" target="_blank" rel="noopener noreferrer" class="btn btn-ghost -my-2 justify-start"><Download />Download desktop app</a>

      <div class="grid gap-2 sm:grid-cols-2">
        <button class="btn btn-soft" @click="open = false; $emit('changePassword')"><KeyRound />Change password</button>
        <button class="btn btn-danger" @click="open = false; $emit('signOut')"><LogOut />Sign out</button>
      </div>
    </DialogContent>
  </Dialog>
</template>
