<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AccountDialog from '@/components/AccountDialog.vue'
import AddMembersDialog from '@/components/AddMembersDialog.vue'
import ChangePasswordDialog from '@/components/ChangePasswordDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ConversationPane from '@/components/ConversationPane.vue'
import RenameGroupDialog from '@/components/RenameGroupDialog.vue'
import Rail from '@/components/Rail.vue'
import Sidebar from '@/components/Sidebar.vue'
import CommandPalette from '@/components/shell/CommandPalette.vue'
import FriendsView from '@/components/shell/FriendsView.vue'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { addMembersGroup, openFriends, pendingAction, renameGroupId, showChats, showConv, view } from '@/lib/nav'
import { startNotifications } from '@/lib/notify'
import { checkForUpdate } from '@/lib/desktop'
import { accountOpen, friendsOpen, paletteOpen } from '@/lib/ui'

// On narrow screens only one of sidebar / main area is visible (see showConv in lib/nav).
const pwOpen = ref(false)
const signOutOpen = ref(false)
const busy = ref(false)

async function signOut() {
  busy.value = true
  try {
    await chat.logout()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
    signOutOpen.value = false
  }
}

// Other components (e.g. the empty conversation state) just set friendsOpen.
watch(friendsOpen, (o) => {
  if (o) {
    friendsOpen.value = false
    openFriends('add')
  }
})
// The chat only counts as read while it is actually on screen.
const wide = window.matchMedia('(min-width: 768px)')
const isWide = ref(wide.matches)
const onWide = () => (isWide.value = wide.matches)
wide.addEventListener('change', onWide)
onBeforeUnmount(() => {
  wide.removeEventListener('change', onWide)
  chat.setConvVisible(false)
})
watch([view, showConv, isWide], () => chat.setConvVisible(view.value === 'chats' && (showConv.value || isWide.value)), { immediate: true })
// Anything that opens a conversation brings the chat view back.
watch(() => chat.state.active, (a) => {
  if (a) view.value = 'chats'
})

// Remove friend / leave group, confirmed once for the whole shell.
const confirmOpen = computed({
  get: () => pendingAction.value !== null,
  set: (v) => { if (!v) pendingAction.value = null },
})
const confirmCopy = computed(() => {
  const p = pendingAction.value
  if (p?.kind === 'remove') {
    return { title: `Remove ${chat.displayName(p.id)}?`, description: 'You will no longer be able to message each other until you are friends again.', label: 'Remove friend' }
  }
  if (p?.kind === 'leave') {
    return { title: `Leave ${chat.state.groups[p.id]?.name ?? 'group'}?`, description: 'You will stop receiving messages from this group.', label: 'Leave group' }
  }
  if (p?.kind === 'block') {
    return { title: `Block ${chat.displayName(p.id)}?`, description: "They won't be able to message you or send friend requests. They won't be told.", label: 'Block' }
  }
  if (p?.kind === 'kick') {
    return { title: `Remove ${chat.displayName(p.id)}?`, description: `They will be removed from ${chat.state.groups[p.group]?.name ?? 'the group'} and stop receiving its messages.`, label: 'Remove from group' }
  }
  return { title: '', description: '', label: '' }
})

async function confirmAction() {
  const p = pendingAction.value
  if (!p) return
  busy.value = true
  try {
    if (p.kind === 'remove') await chat.removeFriend(p.id)
    else if (p.kind === 'block') await chat.blockUser(p.id)
    else if (p.kind === 'kick') await chat.removeMember(p.group, p.id)
    else await chat.leaveGroup(p.id)
    pendingAction.value = null
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
  }
}

const membersGroup = computed(() => (addMembersGroup.value ? chat.state.groups[addMembersGroup.value] ?? null : null))
const membersOpen = computed({
  get: () => membersGroup.value !== null,
  set: (v) => { if (!v) addMembersGroup.value = null },
})

const renameGroup = computed(() => (renameGroupId.value ? chat.state.groups[renameGroupId.value] ?? null : null))
const renameOpen = computed({
  get: () => renameGroup.value !== null,
  set: (v) => { if (!v) renameGroupId.value = null },
})

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
  }
}

let stopNotifications = () => {}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  stopNotifications = startNotifications()
  void offerUpdate()
})

/** Desktop app: offer a newer version once per start (a few seconds in, so startup isn't slowed). */
async function offerUpdate() {
  await new Promise((r) => setTimeout(r, 5000))
  const update = await checkForUpdate()
  if (!update) return
  toast(`Version ${update.version} is available`, {
    description: 'Install it now? The app restarts afterwards.',
    duration: Infinity,
    action: {
      label: 'Update',
      onClick: () => {
        const id = toast.loading('Downloading the update…')
        update.install().catch((e) => {
          toast.dismiss(id)
          toast.error(`Update failed: ${errMsg(e)}`)
        })
      },
    },
  })
}
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  stopNotifications()
})
</script>

<template>
  <div class="flex h-full w-full">
    <Rail />
    <Sidebar class="w-full md:flex md:w-64 md:shrink-0" :class="showConv ? 'hidden' : 'flex'" />
    <FriendsView v-if="view === 'friends'" class="min-w-0 flex-1 md:flex" :class="showConv ? 'flex' : 'hidden'" />
    <ConversationPane v-else class="min-w-0 flex-1 md:flex" :class="showConv ? 'flex' : 'hidden'" @back="showChats" />

    <AccountDialog v-model:open="accountOpen" @change-password="pwOpen = true" @sign-out="signOutOpen = true" />
    <ChangePasswordDialog v-model:open="pwOpen" />
    <CommandPalette v-model:open="paletteOpen" />
    <AddMembersDialog v-if="membersGroup" v-model:open="membersOpen" :group="membersGroup" />
    <RenameGroupDialog v-if="renameGroup" v-model:open="renameOpen" :group="renameGroup" />
    <ConfirmDialog
      v-model:open="signOutOpen"
      title="Sign out?"
      description="This removes this device's local copy of your data. Your messages are stored encrypted on the server and come back when you sign in again."
      confirm-label="Sign out"
      :loading="busy"
      @confirm="signOut"
    />
    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmCopy.title" :description="confirmCopy.description" :confirm-label="confirmCopy.label"
      :loading="busy"
      @confirm="confirmAction"
    />
  </div>
</template>
