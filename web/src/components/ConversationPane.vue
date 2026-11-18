<script setup lang="ts">
import { computed, ref } from 'vue'
import { useElementSize } from '@vueuse/core'
import {
  ArrowLeft, Loader2, Lock, LogOut, MessageCircle, ShieldAlert, ShieldCheck, Sparkles, Upload, UserPlus, Users,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import AddMembersDialog from '@/components/AddMembersDialog.vue'
import Composer from '@/components/Composer.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import FingerprintBlock from '@/components/FingerprintBlock.vue'
import MessageList from '@/components/MessageList.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import VerifyDialog from '@/components/VerifyDialog.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'

defineEmits<{ back: [] }>()

const conv = computed(() => chat.state.conversations.find((c) => c.id === chat.state.active) ?? null)
const dmName = computed(() => (conv.value?.kind === 'dm' ? conv.value.id.slice(3) : null))
const contact = computed(() => (dmName.value ? chat.state.contacts[dmName.value] ?? null : null))
const group = computed(() =>
  conv.value?.kind === 'group' ? chat.state.groups[conv.value.id.slice(2)] ?? null : null,
)

const verifyOpen = ref(false)
const membersOpen = ref(false)
const addOpen = ref(false)
const leaveOpen = ref(false)
const busy = ref(false)

const topEl = ref<HTMLElement | null>(null)
const bottomEl = ref<HTMLElement | null>(null)
const { height: topH } = useElementSize(topEl, undefined, { box: 'border-box' })
const { height: bottomH } = useElementSize(bottomEl, undefined, { box: 'border-box' })
const composer = ref<InstanceType<typeof Composer> | null>(null)

const onlineCount = computed(() =>
  group.value ? group.value.members.filter((m) => chat.state.contacts[m]?.online).length : 0,
)

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
  if (files.length) void composer.value?.sendFiles(files)
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
    await chat.trustNewKey(c.name, c.pendingFingerprint)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
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
    class="app-bg relative flex-col overflow-hidden"
    @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop"
  >
    <!-- Empty state -->
    <div v-if="!conv" class="relative flex flex-1 flex-col items-center justify-center gap-8 p-8 text-center">
      <button class="btn btn-soft btn-sm absolute top-4 left-4 md:hidden" @click="$emit('back')"><ArrowLeft />Chats</button>
      <div class="relative h-40 w-56">
        <div class="glass float-y absolute top-2 left-0 flex size-14 items-center justify-center rounded-2xl text-muted-foreground" style="animation-delay: -2s"><Lock class="size-6" /></div>
        <div class="glass float-y absolute right-0 bottom-0 flex size-14 items-center justify-center rounded-2xl text-success" style="animation-delay: -4s"><ShieldCheck class="size-6" /></div>
        <div class="float-y absolute top-1/2 left-1/2 flex size-28 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[2rem] text-white shadow-[var(--shadow-lg)] [background:var(--grad)]">
          <MessageCircle class="size-12" stroke-width="1.75" />
          <Sparkles class="absolute -top-2 -right-2 size-6 text-[oklch(0.85_0.12_85)]" />
        </div>
      </div>
      <div class="max-w-sm space-y-2">
        <h2 class="text-2xl font-semibold tracking-tight">Your messages, only yours</h2>
        <p class="text-[15px] leading-relaxed text-muted-foreground">
          Pick a conversation to start chatting. Everything is encrypted on this device before it leaves.
        </p>
      </div>
    </div>

    <template v-else>
      <MessageList :top-pad="topH" :bottom-pad="bottomH" />

      <div ref="topEl" class="pointer-events-none absolute inset-x-0 top-0 z-10 space-y-2 p-2 sm:p-3">
        <header class="glass pointer-events-auto flex items-center gap-3 rounded-2xl px-3 py-2.5">
          <button class="btn btn-ghost btn-icon md:hidden" title="Back" aria-label="Back" @click="$emit('back')"><ArrowLeft /></button>
          <UserAvatar :name="conv.title" :size="40" :online="contact?.online" style="--dot-ring: var(--card)" />
          <div class="min-w-0 flex-1 leading-tight">
            <div class="flex items-center gap-1.5">
              <h1 class="truncate text-[15.5px] font-semibold">{{ conv.title }}</h1>
              <ShieldCheck v-if="contact?.verified" class="size-4 shrink-0 text-success" title="Verified" />
            </div>
            <div v-if="contact" class="mt-0.5 truncate text-xs" :class="contact.online ? 'text-success' : 'text-muted-foreground'">
              {{ contact.online ? 'Online' : 'Offline' }}<template v-if="contact.verified"> · Verified</template>
            </div>
            <div v-else-if="group" class="mt-0.5 truncate text-xs text-muted-foreground">
              {{ group.members.length }} members<template v-if="onlineCount"> · {{ onlineCount }} online</template>
            </div>
          </div>

          <template v-if="contact">
            <button class="btn btn-soft btn-sm" title="Verify security key" @click="verifyOpen = true">
              <ShieldCheck :class="contact.verified && 'text-success'" /><span class="hidden sm:inline">{{ contact.verified ? 'Verified' : 'Verify' }}</span>
            </button>
          </template>
          <template v-else-if="group">
            <button class="btn btn-ghost btn-icon" title="Members" aria-label="Members" @click="membersOpen = true"><Users /></button>
            <button class="btn btn-ghost btn-icon" title="Add members" aria-label="Add members" @click="addOpen = true"><UserPlus /></button>
            <button class="btn btn-ghost btn-icon hover:!text-destructive" title="Leave group" aria-label="Leave group" @click="leaveOpen = true"><LogOut /></button>
          </template>
        </header>

        <div
          v-if="contact?.keyChanged"
          class="pointer-events-auto max-h-[60dvh] space-y-3 overflow-y-auto rounded-2xl bg-[color-mix(in_oklab,var(--destructive)_14%,var(--glass-solid))] p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--destructive)_40%,transparent),var(--shadow-md)] backdrop-blur-xl"
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
      </div>

      <div ref="bottomEl" class="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/70 to-transparent px-2 pt-10 pb-2 sm:px-4 sm:pb-4">
        <div class="pointer-events-auto"><Composer ref="composer" :disabled="!!contact?.keyChanged" /></div>
      </div>

      <Transition
        enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0"
      >
        <div v-if="dragDepth > 0" class="pointer-events-none absolute inset-3 z-30 flex flex-col items-center justify-center gap-3 rounded-[2rem] border-2 border-dashed border-primary bg-background/80 text-primary backdrop-blur-md">
          <div class="flex size-16 items-center justify-center rounded-2xl text-white [background:var(--grad)]"><Upload class="size-7" /></div>
          <p class="text-lg font-semibold tracking-tight">Drop files to send</p>
        </div>
      </Transition>

      <VerifyDialog v-if="contact" v-model:open="verifyOpen" :contact="contact" />

      <template v-if="group">
        <Dialog v-model:open="membersOpen">
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{{ group.name }}</DialogTitle>
              <DialogDescription>{{ group.members.length }} members</DialogDescription>
            </DialogHeader>
            <ul class="well max-h-72 space-y-0.5 overflow-y-auto rounded-2xl p-1.5 text-sm">
              <li v-for="m in group.members" :key="m" class="flex items-center gap-3 rounded-xl px-2 py-1.5" style="--dot-ring: var(--card)">
                <UserAvatar :name="m" :size="32" :online="m === chat.state.account?.name ? true : !!chat.state.contacts[m]?.online" />
                <span class="flex-1 font-medium">{{ m }}</span>
                <span v-if="m === chat.state.account?.name" class="text-xs text-muted-foreground">you</span>
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
