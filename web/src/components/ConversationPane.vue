<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ArrowLeft, Copy, Ellipsis, Hash, Loader2, LogOut, MessageCircle, ShieldAlert, ShieldCheck, Upload, UserPlus, Users,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import AddMembersDialog from '@/components/AddMembersDialog.vue'
import Composer from '@/components/Composer.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import FingerprintBlock from '@/components/FingerprintBlock.vue'
import MessageList from '@/components/MessageList.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { copyText, friendsOpen } from '@/lib/ui'

defineEmits<{ back: [] }>()

const conv = computed(() => chat.state.conversations.find((c) => c.id === chat.state.active) ?? null)
const dmId = computed(() => (conv.value?.kind === 'dm' ? conv.value.id.slice(3) : null))
const contact = computed(() => (dmId.value ? chat.state.contacts[dmId.value] ?? null : null))
const convKey = computed(() => (conv.value ? conv.value.id.slice(conv.value.kind === 'dm' ? 3 : 2) : ''))
const hasFriends = computed(() => Object.values(chat.state.contacts).some((c) => c.friend))
const myId = computed(() => chat.formatId(chat.state.account?.id ?? ''))
const nameOf = (id: string) => chat.displayName(id)
const group = computed(() =>
  conv.value?.kind === 'group' ? chat.state.groups[conv.value.id.slice(2)] ?? null : null,
)

const membersOpen = ref(false)
const addOpen = ref(false)
const leaveOpen = ref(false)
const busy = ref(false)

const composer = ref<InstanceType<typeof Composer> | null>(null)

// Drag-and-drop overlay
const dragDepth = ref(0)
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
function onDragEnter(e: DragEvent) {
  if (conv.value && hasFiles(e)) dragDepth.value++
}
function onDragLeave(e: DragEvent) {
  if (conv.value && hasFiles(e)) dragDepth.value = Math.max(0, dragDepth.value - 1)
}
function onDrop(e: DragEvent) {
  dragDepth.value = 0
  if (!conv.value) return
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length) composer.value?.addFiles(files)
}

async function trust() {
  const c = contact.value
  if (!c) return
  if (!c.pendingFingerprint) {
    toast.error('The new key is not available yet. Try again in a moment.')
    return
  }
  busy.value = true
  try {
    await chat.trustNewKey(c.id, c.pendingFingerprint)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
  }
}

async function addFriend(id: string) {
  try {
    await chat.sendFriendRequest(id)
    toast.success('Friend request sent')
  } catch (e) {
    toast.error(errMsg(e))
  }
}

async function leave() {
  if (!group.value) return
  busy.value = true
  try {
    await chat.leaveGroup(group.value.id)
    leaveOpen.value = false
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main
    class="relative min-w-0 flex-col overflow-hidden bg-background"
    @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop"
  >
    <!-- Empty state -->
    <div v-if="!conv" class="relative flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <button class="btn btn-soft btn-sm absolute top-3 left-3 md:hidden" @click="$emit('back')"><ArrowLeft />Chats</button>
      <div class="flex size-20 items-center justify-center rounded-full bg-card text-primary"><MessageCircle class="size-9" stroke-width="1.75" /></div>
      <div v-if="hasFriends" class="max-w-sm space-y-1.5">
        <h2 class="text-xl font-bold">Your messages, only yours</h2>
        <p class="text-sm leading-relaxed text-muted-foreground">Pick a conversation to start chatting. Everything is encrypted on this device before it leaves.</p>
      </div>
      <div v-else class="flex max-w-sm flex-col items-center gap-4">
        <div class="space-y-1.5">
          <h2 class="text-xl font-bold">Find your people</h2>
          <p class="text-sm leading-relaxed text-muted-foreground">Share your ID with a friend, or add theirs, to start an encrypted chat.</p>
        </div>
        <button class="well flex items-center gap-3 rounded-md px-4 py-2.5 transition-colors hover:bg-hover" title="Copy your ID" @click="copyText(myId, 'ID copied')">
          <span class="font-mono text-xl font-semibold tracking-[0.12em]">{{ myId }}</span>
          <Copy class="size-4 text-muted-foreground" />
        </button>
        <button class="btn btn-primary" @click="friendsOpen = true"><UserPlus />Add a friend</button>
      </div>
    </div>

    <template v-else>
      <header class="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3 shadow-sm">
        <button class="btn btn-ghost btn-icon btn-sm md:hidden" title="Back" aria-label="Back" @click="$emit('back')"><ArrowLeft /></button>
        <Hash v-if="group" class="size-5 shrink-0 text-muted-foreground" />
        <UserAvatar v-else :name="conv.title" :id="convKey" :size="28" :online="contact?.online" style="--dot-ring: var(--background)" />
        <div class="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 class="truncate text-[15px] font-bold">{{ conv.title }}</h1>
          <ShieldCheck v-if="contact?.verified" class="size-4 shrink-0 self-center text-success" title="Verified" />
          <span v-if="contact" class="hidden truncate text-xs text-muted-foreground sm:inline">{{ contact.online ? 'Online' : 'Offline' }}</span>
          <button v-else-if="group" class="truncate text-xs text-muted-foreground hover:text-foreground hover:underline" @click="membersOpen = true">{{ group.members.length }} members</button>
        </div>

        <DropdownMenu v-if="group">
          <DropdownMenuTrigger as-child>
            <button class="btn btn-ghost btn-icon btn-sm" title="Group options" aria-label="Group options"><Ellipsis /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-48">
            <DropdownMenuItem @select="membersOpen = true"><Users />Members</DropdownMenuItem>
            <DropdownMenuItem @select="addOpen = true"><UserPlus />Add members</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" @select="leaveOpen = true"><LogOut />Leave group</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div
        v-if="contact?.keyChanged"
        class="max-h-[50dvh] shrink-0 space-y-3 overflow-y-auto border-b border-destructive/40 bg-destructive/10 p-3 sm:px-4"
        role="alert"
      >
        <div class="flex items-start gap-3 text-sm">
          <ShieldAlert class="mt-0.5 size-5 shrink-0 text-destructive" />
          <p class="min-w-0 flex-1 leading-relaxed">
            <strong class="font-semibold text-destructive">{{ contact.name }}'s security key changed.</strong>
            This could mean they reinstalled, or someone is impersonating them.
            Compare this with {{ contact.name }} in person or on a call before trusting it.
          </p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="opacity-70"><FingerprintBlock label="Previous key" :value="contact.fingerprint" compact /></div>
          <FingerprintBlock v-if="contact.pendingFingerprint" label="New key" :value="contact.pendingFingerprint" tone="danger" compact />
          <p v-else class="self-center text-xs text-muted-foreground">Waiting for the new key…</p>
        </div>
        <div class="flex justify-end">
          <button class="btn btn-danger btn-sm" :disabled="busy || !contact.pendingFingerprint" @click="trust">
            <Loader2 v-if="busy" class="animate-spin" />Trust new key
          </button>
        </div>
      </div>

      <MessageList />

      <div class="shrink-0 px-3 pb-1 sm:px-4 sm:pb-2"><Composer ref="composer" :disabled="!!contact?.keyChanged" /></div>

      <Transition
        enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0"
      >
        <div v-if="dragDepth > 0" class="pointer-events-none absolute inset-3 z-30 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-primary bg-background/85 text-primary">
          <Upload class="size-9" />
          <p class="text-lg font-bold">Drop files to add them</p>
        </div>
      </Transition>

      <template v-if="group">
        <Dialog v-model:open="membersOpen">
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{{ group.name }}</DialogTitle>
              <DialogDescription>{{ group.members.length }} members</DialogDescription>
            </DialogHeader>
            <ul class="well max-h-72 space-y-0.5 overflow-y-auto rounded-md p-1.5 text-sm">
              <li v-for="m in group.members" :key="m" class="flex items-center gap-3 rounded-md px-2 py-1.5" style="--dot-ring: var(--card)">
                <UserAvatar :name="nameOf(m)" :id="m" :size="32" :online="m === chat.state.account?.id ? true : chat.state.contacts[m]?.friend ? !!chat.state.contacts[m]?.online : undefined" />
                <span class="flex-1 font-medium">{{ nameOf(m) }}</span>
                <span v-if="m === chat.state.account?.id" class="text-xs text-muted-foreground">you</span>
                <button v-else-if="!chat.state.contacts[m]?.friend" class="btn btn-soft btn-sm" @click="addFriend(m)"><UserPlus />Add friend</button>
              </li>
            </ul>
          </DialogContent>
        </Dialog>
        <AddMembersDialog v-model:open="addOpen" :group="group" />
        <ConfirmDialog
          v-model:open="leaveOpen"
          title="Leave group?"
          :description="`You will stop receiving messages from ${group.name}.`"
          confirm-label="Leave group"
          :loading="busy"
          @confirm="leave"
        />
      </template>
    </template>
  </main>
</template>
