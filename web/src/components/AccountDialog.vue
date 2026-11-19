<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Camera, Download, KeyRound, RefreshCw, Laptop, Loader2, LogOut, Trash2, Upload } from 'lucide-vue-next'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import CopyIdButton from '@/components/shell/CopyIdButton.vue'
import Toggle from '@/components/shell/Toggle.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import AvatarCropDialog from '@/components/AvatarCropDialog.vue'
import DevicesDialog from '@/components/DevicesDialog.vue'
import RotateKeysDialog from '@/components/RotateKeysDialog.vue'
import DeleteAccountDialog from '@/components/DeleteAccountDialog.vue'
import { chat } from '@/lib/chat'
import { notifyDenied, notifyEnabled, notifySupported, setNotify, setSound, soundEnabled } from '@/lib/notify'
import { toast } from 'vue-sonner'
import { errMsg } from '@/lib/format'

const open = defineModel<boolean>('open', { required: true })
defineEmits<{ changePassword: []; signOut: [] }>()

const rawId = computed(() => chat.state.account?.id ?? '')
const id = computed(() => chat.formatId(rawId.value))

const picker = ref<HTMLInputElement | null>(null)

// Display name: saved when the field loses focus or Enter is pressed.
const nameInput = ref('')
watch(open, (o) => {
  if (o) nameInput.value = chat.state.account?.displayName === chat.state.account?.username ? '' : chat.state.account?.displayName ?? ''
}, { immediate: true })
function saveName() {
  try {
    chat.setDisplayName(nameInput.value)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
const avatarBusy = ref(false)

const cropOpen = ref(false)
const cropFile = ref<File | null>(null)
const devicesOpen = ref(false)
const deleteOpen = ref(false)
const rotateOpen = ref(false)
const backupBusy = ref<'' | 'export' | 'import'>('')
const backupPicker = ref<HTMLInputElement | null>(null)

async function removeAvatar() {
  avatarBusy.value = true
  try {
    await chat.setAvatar(null)
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
  if (!file) return
  if (file.type === 'image/gif') {
    avatarBusy.value = true
    chat.setAvatar(file).catch((e) => toast.error(errMsg(e))).finally(() => (avatarBusy.value = false))
    return
  }
  {
    cropFile.value = file
    cropOpen.value = true
  }
}

async function exportBackup() {
  backupBusy.value = 'export'
  try {
    const { blob, name } = await chat.exportBackup()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    backupBusy.value = ''
  }
}

async function importBackup(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  backupBusy.value = 'import'
  try {
    const r = await chat.importBackup(file)
    if (r.messages || r.files || r.conversations) toast.success(`Restored ${r.messages} messages in ${r.conversations} chats (${r.files} files)`)
    else toast('Nothing new in this backup')
  } catch (err) {
    toast.error(errMsg(err))
  } finally {
    backupBusy.value = ''
  }
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
          <UserAvatar :name="chat.state.account?.displayName ?? '?'" :id="chat.state.account?.id" :src="chat.state.account?.avatar" :size="48" />
          <span
            class="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-white transition-opacity"
            :class="avatarBusy ? 'opacity-100' : 'opacity-0 group-hover/av:opacity-100 group-focus-visible/av:opacity-100'"
          >
            <Loader2 v-if="avatarBusy" class="size-5 animate-spin" /><Camera v-else class="size-5" />
          </span>
        </button>
        <input ref="picker" type="file" accept="image/*,image/gif" class="hidden" @change="onPick">
        <div class="min-w-0 flex-1">
          <div class="truncate text-base font-semibold">{{ chat.state.account?.displayName }}</div>
          <div v-if="chat.state.account?.displayName !== chat.state.account?.username" class="truncate text-xs text-muted-foreground">@{{ chat.state.account?.username }}</div>
          <div class="font-mono text-sm tracking-[0.1em] text-muted-foreground select-all">{{ id }}</div>
          <div class="mt-1 flex gap-3 text-xs">
            <button class="text-[var(--link)] hover:underline disabled:opacity-50" :disabled="avatarBusy" @click="picker?.click()">Change picture</button>
            <button v-if="chat.state.account?.avatar" class="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive hover:underline disabled:opacity-50" :disabled="avatarBusy" @click="removeAvatar"><Trash2 class="size-3" />Remove</button>
          </div>
        </div>
        <CopyIdButton :id="rawId" label="Copy ID" />
      </div>

      <div class="space-y-2">
        <label class="eyebrow block" for="display-name">Display name</label>
        <input
          id="display-name" v-model="nameInput" class="field" maxlength="32" autocomplete="nickname"
          :placeholder="chat.state.account?.username" @blur="saveName" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        >
        <p class="text-xs text-muted-foreground">Shown to your friends instead of your username. You still sign in with @{{ chat.state.account?.username }}.</p>
      </div>

      <div class="space-y-2">
        <div class="eyebrow">Your security code</div>
        <div class="well rounded-md p-3">
          <p class="grid grid-cols-4 gap-x-2 gap-y-1 font-mono text-[13px] tracking-wide"><span v-for="(g, i) in (chat.state.account?.fingerprint ?? '').split(' ')" :key="i">{{ g }}</span></p>
        </div>
        <p class="text-xs text-muted-foreground">Friends can compare this with the code they see for you.</p>
        <button class="btn btn-soft btn-sm" aria-label="Change security keys" title="Change security keys" @click="rotateOpen = true"><RefreshCw />Change security keys</button>
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

      <div class="space-y-3.5">
        <div class="eyebrow">Devices</div>
        <p class="text-xs text-muted-foreground">See where you are signed in and sign out devices you no longer use.</p>
        <button class="btn btn-soft w-full" @click="devicesOpen = true"><Laptop />Manage devices</button>
      </div>

      <div class="space-y-3.5">
        <div class="eyebrow">Backup</div>
        <p class="text-xs text-muted-foreground">The backup holds all chats and files on this device. It is encrypted and only your account can open it.</p>
        <div class="grid gap-2 sm:grid-cols-2">
          <button class="btn btn-soft" :disabled="!!backupBusy" @click="exportBackup">
            <Loader2 v-if="backupBusy === 'export'" class="animate-spin" /><Download v-else />{{ backupBusy === 'export' ? 'Exporting…' : 'Export backup' }}
          </button>
          <button class="btn btn-soft" :disabled="!!backupBusy" @click="backupPicker?.click()">
            <Loader2 v-if="backupBusy === 'import'" class="animate-spin" /><Upload v-else />{{ backupBusy === 'import' ? 'Importing…' : 'Import backup' }}
          </button>
        </div>
        <input ref="backupPicker" type="file" class="hidden" @change="importBackup">
      </div>

      <a v-if="!chat.isDesktop" :href="chat.desktopDownloadUrl" target="_blank" rel="noopener noreferrer" class="btn btn-ghost -my-2 justify-start"><Download />Download desktop app</a>

      <div class="grid gap-2 sm:grid-cols-2">
        <button class="btn btn-soft" @click="open = false; $emit('changePassword')"><KeyRound />Change password</button>
        <button class="btn btn-danger" @click="open = false; $emit('signOut')"><LogOut />Sign out</button>
      </div>

      <div class="space-y-2 border-t border-destructive/20 pt-4">
        <div class="eyebrow text-destructive">Danger zone</div>
        <button class="btn btn-danger btn-sm" aria-label="Delete account" title="Delete account" @click="deleteOpen = true"><Trash2 />Delete account</button>
      </div>
    </DialogContent>
  </Dialog>

  <AvatarCropDialog v-model:open="cropOpen" :file="cropFile" />
  <DevicesDialog v-model:open="devicesOpen" />
  <RotateKeysDialog v-model:open="rotateOpen" />
  <DeleteAccountDialog v-model:open="deleteOpen" @deleted="open = false" />
</template>
