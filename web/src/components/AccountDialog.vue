<script setup lang="ts">
import { computed, ref } from 'vue'
import { Camera, Download, KeyRound, Loader2, LogOut, Trash2 } from 'lucide-vue-next'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import CopyIdButton from '@/components/shell/CopyIdButton.vue'
import Toggle from '@/components/shell/Toggle.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { notifyDenied, notifyEnabled, notifySupported, setNotify, setSound, soundEnabled } from '@/lib/notify'
import { toast } from 'vue-sonner'
import { errMsg } from '@/lib/format'

const open = defineModel<boolean>('open', { required: true })
defineEmits<{ changePassword: []; signOut: [] }>()

const rawId = computed(() => chat.state.account?.id ?? '')
const id = computed(() => chat.formatId(rawId.value))

const picker = ref<HTMLInputElement | null>(null)
const avatarBusy = ref(false)

async function setAvatar(file: File | null) {
  avatarBusy.value = true
  try {
    await chat.setAvatar(file)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    avatarBusy.value = false
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void setAvatar(file)
}

async function setReceipts(on: boolean) {
  try {
    await chat.setReadReceipts(on)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

async function toggleNotify(on: boolean) {
  const result = await setNotify(on)
  if (on && !result) toast.error(notifySupported ? 'Notifications are blocked. Allow them in your browser settings.' : 'This browser does not support notifications.')
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
        <button
          class="group/av relative shrink-0 rounded-full outline-none focus-visible:shadow-[var(--glow)]"
          title="Change picture" aria-label="Change picture" :disabled="avatarBusy" @click="picker?.click()"
        >
          <UserAvatar :name="chat.state.account?.username ?? '?'" :id="chat.state.account?.id" :src="chat.state.account?.avatar" :size="48" />
          <span
            class="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-white transition-opacity"
            :class="avatarBusy ? 'opacity-100' : 'opacity-0 group-hover/av:opacity-100 group-focus-visible/av:opacity-100'"
          >
            <Loader2 v-if="avatarBusy" class="size-5 animate-spin" /><Camera v-else class="size-5" />
          </span>
        </button>
        <input ref="picker" type="file" accept="image/*" class="hidden" @change="onPick">
        <div class="min-w-0 flex-1">
          <div class="truncate text-base font-semibold">{{ chat.state.account?.username }}</div>
          <div class="font-mono text-sm tracking-[0.1em] text-muted-foreground select-all">{{ id }}</div>
          <div class="mt-1 flex gap-3 text-xs">
            <button class="text-[var(--link)] hover:underline disabled:opacity-50" :disabled="avatarBusy" @click="picker?.click()">Change picture</button>
            <button v-if="chat.state.account?.avatar" class="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive hover:underline disabled:opacity-50" :disabled="avatarBusy" @click="setAvatar(null)"><Trash2 class="size-3" />Remove</button>
          </div>
        </div>
        <CopyIdButton :id="rawId" label="Copy ID" />
      </div>

      <div class="space-y-3.5">
        <div class="eyebrow">Notifications</div>
        <Toggle
          :model-value="notifyEnabled" :disabled="!notifySupported" label="Desktop notifications"
          :description="notifyDenied ? 'Blocked by your browser. Allow notifications for this site to use this.' : 'Show a notification for new messages when you are not looking at the chat.'"
          @update:model-value="toggleNotify"
        />
        <Toggle :model-value="soundEnabled" label="Sound" description="Play a short sound for new messages." @update:model-value="setSound" />
      </div>

      <div class="space-y-3.5">
        <div class="eyebrow">Privacy</div>
        <Toggle
          :model-value="chat.state.settings.readReceipts" label="Read receipts"
          description="Let others see when you've read their messages."
          @update:model-value="setReceipts"
        />
      </div>

      <a v-if="!chat.isDesktop" :href="chat.desktopDownloadUrl" target="_blank" rel="noopener noreferrer" class="btn btn-ghost -my-2 justify-start"><Download />Download desktop app</a>

      <div class="grid gap-2 sm:grid-cols-2">
        <button class="btn btn-soft" @click="open = false; $emit('changePassword')"><KeyRound />Change password</button>
        <button class="btn btn-danger" @click="open = false; $emit('signOut')"><LogOut />Sign out</button>
      </div>
    </DialogContent>
  </Dialog>
</template>
