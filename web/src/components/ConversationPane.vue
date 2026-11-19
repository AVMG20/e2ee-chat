<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowLeft, AtSign, Bell, BellOff, Check, Copy, Ellipsis, Hash, Images, Info, Loader2, LogOut, MessageCircle, Pencil, Search, Star, ShieldAlert, ShieldCheck, Upload, User, UserPlus, Users,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import Composer from '@/components/Composer.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import InfoPanel from '@/components/panels/InfoPanel.vue'
import MediaPanel from '@/components/panels/MediaPanel.vue'
import MessageList from '@/components/MessageList.vue'
import SearchPanel from '@/components/panels/SearchPanel.vue'
import SidePanel from '@/components/SidePanel.vue'
import StarredPanel from '@/components/panels/StarredPanel.vue'
import { viewerId } from '@/components/messages/state'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { addMembersGroup, renameGroupId } from '@/lib/nav'
import { MUTE_OPTIONS, copyText, friendsOpen, muteFor, panelUser, setPrefs, sidePanel, starredScope, trustNewKey, type SidePanel as PanelName } from '@/lib/ui'

defineEmits<{ back: [] }>()

const conv = computed(() => chat.state.conversations.find((c) => c.id === chat.state.active) ?? null)
const dmId = computed(() => (conv.value?.kind === 'dm' ? conv.value.id.slice(3) : null))
const contact = computed(() => (dmId.value ? chat.state.contacts[dmId.value] ?? null : null))
const convKey = computed(() => (conv.value ? conv.value.id.slice(conv.value.kind === 'dm' ? 3 : 2) : ''))
const hasFriends = computed(() => Object.values(chat.state.contacts).some((c) => c.friend))
const myId = computed(() => chat.formatId(chat.state.account?.id ?? ''))
const group = computed(() =>
  conv.value?.kind === 'group' ? chat.state.groups[conv.value.id.slice(2)] ?? null : null,
)

const notFriend = computed(() => !!dmId.value && !contact.value?.friend)
const blocked = computed(() => !!dmId.value && chat.state.blocked.some((b) => b.id === dmId.value))
const outgoing = computed(() => !!dmId.value && chat.state.requests.outgoing.some((r) => r.id === dmId.value))
const incoming = computed(() => !!dmId.value && chat.state.requests.incoming.some((r) => r.id === dmId.value))
const peerName = computed(() => conv.value?.title ?? '')
async function bannerAction(fn: () => Promise<unknown>, ok: string) {
  busy.value = true
  try {
    await fn()
    toast.success(ok)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
  }
}
const addFriend = () => bannerAction(() => chat.sendFriendRequest(dmId.value!), 'Friend request sent')
const acceptFriend = () => bannerAction(() => chat.acceptFriend(dmId.value!), 'Friend added')
const unblock = () => bannerAction(() => chat.unblockUser(dmId.value!), 'Unblocked')
function showMembers() {
  panelUser.value = null
  sidePanel.value = 'info'
}
function toggleInfo() {
  if (sidePanel.value === 'info') sidePanel.value = null
  else showMembers()
}

const isAdmin = computed(() => (group.value ? chat.isGroupAdmin(group.value.id) : false))

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
  busy.value = true
  try {
    await trustNewKey(contact.value)
  } finally {
    busy.value = false
  }
}

const panelTitles: Record<PanelName, string> = { info: 'Members', search: 'Search', media: 'Media and files', starred: 'Starred messages' }
const panelTitle = computed(() => (sidePanel.value === 'info' && (contact.value || panelUser.value) ? 'User info' : sidePanel.value ? panelTitles[sidePanel.value] : ''))
/** The panel shows beside an open chat; the starred panel (from the rail) also works without one. */
const panelShown = computed(() => !!sidePanel.value && (!!conv.value || sidePanel.value === 'starred'))
const togglePanel = (p: PanelName) => (sidePanel.value = sidePanel.value === p ? null : p)
const showStarred = () => { starredScope.value = 'chat'; sidePanel.value = 'starred' }

// Esc closes the panel, unless it was meant for a dialog, menu or the image viewer.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || !sidePanel.value || viewerId.value) return
  if (document.querySelector('[role="dialog"], [role="menu"], [role="alertdialog"]')) return
  sidePanel.value = null
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

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
    class="relative min-w-0 overflow-hidden bg-background"
    @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop"
  >
    <div class="relative flex min-h-0 min-w-0 flex-1">
    <div class="relative flex min-w-0 flex-1 flex-col">
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
        <UserAvatar v-else :name="conv.title" :id="convKey" :src="contact?.avatar" :size="28" :online="contact?.online" style="--dot-ring: var(--background)" />
        <div class="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 class="truncate text-[15px] font-bold">{{ conv.title }}</h1>
          <button v-if="group && isAdmin" class="self-center text-muted-foreground hover:text-foreground" title="Rename group" aria-label="Rename group" @click="renameGroupId = group.id"><Pencil class="size-3.5" /></button>
          <ShieldCheck v-if="contact?.verified" class="size-4 shrink-0 self-center text-success" title="Verified" />
          <span v-if="contact?.friend" class="hidden truncate text-xs text-muted-foreground sm:inline">{{ contact.online ? 'Online' : 'Offline' }}</span>
          <button v-else-if="group" class="truncate text-xs text-muted-foreground hover:text-foreground hover:underline" @click="showMembers">{{ group.members.length }} members</button>
        </div>

        <button class="btn btn-ghost btn-icon btn-sm" :class="sidePanel === 'search' && 'bg-soft text-foreground'" :aria-pressed="sidePanel === 'search'" title="Search messages" aria-label="Search messages" @click="togglePanel('search')"><Search /></button>
        <button
          class="btn btn-ghost btn-icon btn-sm" :class="sidePanel === 'info' && 'bg-soft text-foreground'" :aria-pressed="sidePanel === 'info'"
          :title="group ? 'Members' : 'User info'" :aria-label="group ? 'Members' : 'User info'" @click="toggleInfo"
        ><Users v-if="group" /><User v-else /></button>

        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button class="btn btn-ghost btn-icon btn-sm" :title="group ? 'Group options' : 'Chat options'" :aria-label="group ? 'Group options' : 'Chat options'"><Ellipsis /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <template v-if="group">
              <DropdownMenuItem @select="showMembers"><Users />Members</DropdownMenuItem>
              <DropdownMenuItem v-if="isAdmin" @select="addMembersGroup = group.id"><UserPlus />Add members</DropdownMenuItem>
              <DropdownMenuItem v-if="isAdmin" @select="renameGroupId = group.id"><Pencil />Rename group</DropdownMenuItem>
              <DropdownMenuSeparator />
            </template>
            <DropdownMenuItem v-if="contact" @select="sidePanel = 'info'"><Info />User info</DropdownMenuItem>
            <DropdownMenuItem @select="sidePanel = 'media'"><Images />Media and files</DropdownMenuItem>
            <DropdownMenuItem @select="showStarred"><Star />Starred messages</DropdownMenuItem>
            <DropdownMenuItem v-if="conv.muted" @select="setPrefs(conv.id, { muted: false })"><Bell />Unmute</DropdownMenuItem>
            <DropdownMenuSub v-else>
              <DropdownMenuSubTrigger><BellOff />Mute</DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="w-56">
                <DropdownMenuItem v-for="o in MUTE_OPTIONS" :key="o.ms" @select="muteFor(conv.id, o.ms)">{{ o.label }}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem v-if="group" @select="setPrefs(conv.id, { mentionsOnly: !conv.mentionsOnly })"><AtSign />Only notify for mentions<Check v-if="conv.mentionsOnly" class="ml-auto" /></DropdownMenuItem>
            <template v-if="group">
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="leaveOpen = true"><LogOut />Leave group</DropdownMenuItem>
            </template>
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
            Keys don't change when someone reinstalls or changes their password, so someone may be trying to impersonate them.
            Check with {{ contact.name }} outside this app before trusting it.
          </p>
        </div>
        <div class="flex justify-end">
          <button class="btn btn-danger btn-sm" :disabled="busy || !contact.pendingFingerprint" @click="trust">
            <Loader2 v-if="busy" class="animate-spin" />Trust new key
          </button>
        </div>
      </div>

      <div
        v-if="blocked || notFriend"
        class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-soft px-3 py-2 text-sm sm:px-4"
        role="status"
      >
        <p class="min-w-0 flex-1 leading-snug">
          <template v-if="blocked">You blocked {{ peerName }}.</template>
          <template v-else>You're not friends with {{ peerName }} anymore. Messages can't be delivered.</template>
        </p>
        <button v-if="blocked" class="btn btn-soft btn-sm" :disabled="busy" title="Unblock" aria-label="Unblock" @click="unblock">Unblock</button>
        <button v-else-if="incoming" class="btn btn-primary btn-sm" :disabled="busy" title="Accept friend request" aria-label="Accept friend request" @click="acceptFriend">Accept</button>
        <button v-else-if="outgoing" class="btn btn-soft btn-sm" disabled>Request sent</button>
        <button v-else class="btn btn-primary btn-sm" :disabled="busy" title="Add friend" aria-label="Add friend" @click="addFriend">Add friend</button>
      </div>

      <MessageList />

      <div class="shrink-0 px-3 pb-1 sm:px-4 sm:pb-2"><Composer ref="composer" :disabled="!!contact?.keyChanged || notFriend || blocked" /></div>

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
    </div>

    <SidePanel v-if="panelShown" :title="panelTitle">
      <InfoPanel v-if="sidePanel === 'info'" />
      <SearchPanel v-else-if="sidePanel === 'search'" />
      <MediaPanel v-else-if="sidePanel === 'media'" />
      <StarredPanel v-else-if="sidePanel === 'starred'" />
    </SidePanel>
    </div>
  </main>
</template>
