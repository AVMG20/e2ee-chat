<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Camera, KeyRound, Loader2, LogOut, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import CopyIdButton from '@/components/shell/CopyIdButton.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import AvatarCropDialog from '@/components/AvatarCropDialog.vue'
import DeleteAccountDialog from '@/components/DeleteAccountDialog.vue'
import SettingsSection from './SettingsSection.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { accountOpen } from '@/lib/ui'

defineEmits<{ changePassword: []; signOut: [] }>()

const rawId = computed(() => chat.state.account?.id ?? '')
const id = computed(() => chat.formatId(rawId.value))
const picker = ref<HTMLInputElement | null>(null)

const currentName = () => (chat.state.account?.displayName === chat.state.account?.username ? '' : chat.state.account?.displayName ?? '')
// Display name: saved when the field loses focus or Enter is pressed.
const nameInput = ref(currentName())
let nameTimer: ReturnType<typeof setTimeout> | undefined
function saveName() {
  clearTimeout(nameTimer)
  if (nameInput.value.trim() === currentName()) return
  try {
    chat.setDisplayName(nameInput.value)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
// Also saved while typing (debounced) and when the page closes, so Esc doesn't lose it.
watch(nameInput, () => {
  clearTimeout(nameTimer)
  nameTimer = setTimeout(saveName, 600)
})
onBeforeUnmount(saveName)

const avatarBusy = ref(false)
const cropOpen = ref(false)
const cropFile = ref<File | null>(null)
const deleteOpen = ref(false)

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
  cropFile.value = file
  cropOpen.value = true
}
</script>

<template>
  <div class="space-y-8">
    <SettingsSection title="Profile" :description="chat.state.account?.server">
      <div class="well flex items-center gap-3 rounded-lg p-3.5" style="--dot-ring: var(--card)">
        <button
          class="group/av relative shrink-0 rounded-full outline-none focus-visible:shadow-[var(--glow)]"
          title="Change picture" aria-label="Change picture" :disabled="avatarBusy" @click="picker?.click()"
        >
          <UserAvatar :name="chat.state.account?.displayName ?? '?'" :id="chat.state.account?.id" :src="chat.state.account?.avatar" :size="64" />
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
          <div class="truncate text-xs text-muted-foreground">@{{ chat.state.account?.username }}</div>
          <div class="font-mono text-sm tracking-[0.1em] text-muted-foreground select-all">{{ id }}</div>
          <div class="mt-1 flex gap-3 text-xs">
            <button class="text-[var(--link)] hover:underline disabled:opacity-50" aria-label="Change picture" :disabled="avatarBusy" @click="picker?.click()">Change picture</button>
            <button v-if="chat.state.account?.avatar" class="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive hover:underline disabled:opacity-50" aria-label="Remove picture" title="Remove picture" :disabled="avatarBusy" @click="removeAvatar"><Trash2 class="size-3" />Remove</button>
          </div>
        </div>
        <CopyIdButton :id="rawId" label="Copy ID" />
      </div>
    </SettingsSection>

    <div class="space-y-2">
      <label class="eyebrow block" for="display-name">Display name</label>
      <input
        id="display-name" v-model="nameInput" class="field" maxlength="32" autocomplete="nickname"
        :placeholder="chat.state.account?.username" @blur="saveName" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      >
      <p class="text-xs text-muted-foreground">Shown to your friends instead of your username. You still sign in with @{{ chat.state.account?.username }}.</p>
    </div>

    <SettingsSection title="Account">
      <div class="grid gap-2 sm:grid-cols-2">
        <button class="btn btn-soft" aria-label="Change password" title="Change password" @click="$emit('changePassword')"><KeyRound />Change password</button>
        <button class="btn btn-danger" aria-label="Sign out" title="Sign out" @click="$emit('signOut')"><LogOut />Sign out</button>
      </div>
    </SettingsSection>

    <div class="space-y-2 border-t border-destructive/20 pt-4">
      <div class="eyebrow text-destructive">Danger zone</div>
      <button class="btn btn-danger btn-sm" aria-label="Delete account" title="Delete account" @click="deleteOpen = true"><Trash2 />Delete account</button>
    </div>

    <AvatarCropDialog v-model:open="cropOpen" :file="cropFile" />
    <DeleteAccountDialog v-model:open="deleteOpen" @deleted="accountOpen = false" />
  </div>
</template>
