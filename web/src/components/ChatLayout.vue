<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import AddMembersDialog from '@/components/AddMembersDialog.vue'
import ChangePasswordDialog from '@/components/ChangePasswordDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ConversationPane from '@/components/ConversationPane.vue'
import RenameGroupDialog from '@/components/RenameGroupDialog.vue'
import Rail from '@/components/Rail.vue'
import Sidebar from '@/components/Sidebar.vue'
import CommandPalette from '@/components/shell/CommandPalette.vue'
import FriendsView from '@/components/shell/FriendsView.vue'
import ShortcutsDialog from '@/components/shell/ShortcutsDialog.vue'
import StatusTextDialog from '@/components/shell/StatusTextDialog.vue'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { addMembersGroup, openConversation, openFriends, pendingAction, renameGroupId, showChats, showConv, sidebarOrder, view } from '@/lib/nav'
import { openMessageLink, parseMessageLink } from '@/lib/links'
import { startNotifications } from '@/lib/notify'
import { checkForUpdate } from '@/lib/desktop'
import { accountOpen, friendsOpen, paletteOpen, shortcutsOpen, sidePanel, statusTextOpen } from '@/lib/ui'

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
watch([view, showConv, isWide, accountOpen], () => chat.setConvVisible(!accountOpen.value && view.value === 'chats' && (showConv.value || isWide.value)), { immediate: true })
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
    return { title: `Leave ${chat.groupTitle(p.id)}?`, description: 'You will stop receiving messages from this group.', label: 'Leave group' }
  }
  if (p?.kind === 'block') {
    return { title: `Block ${chat.displayName(p.id)}?`, description: "They won't be able to message you or send friend requests. They won't be told.", label: 'Block' }
  }
  if (p?.kind === 'kick') {
    return { title: `Remove ${chat.displayName(p.id)}?`, description: `They will be removed from ${chat.groupTitle(p.group)} and stop receiving its messages.`, label: 'Remove from group' }
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

/** A dialog or menu is open: navigation shortcuts should leave the keys alone. */
const modalOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"]')

/**
 * Alt+↑/↓ steps through the sidebar's conversations; with Shift it only visits ones with unread
 * messages (and wraps around).
 */
function stepConversation(dir: 1 | -1, unreadOnly: boolean) {
  const list = sidebarOrder()
  if (!list.length) return
  const at = list.findIndex((c) => c.id === chat.state.active)
  if (!unreadOnly) {
    const next = list[at < 0 ? (dir === 1 ? 0 : list.length - 1) : at + dir]
    if (next) void openConversation(next.id).catch((e) => toast.error(errMsg(e)))
    return
  }
  for (let i = 1; i <= list.length; i++) {
    const c = list[(((at < 0 ? (dir === 1 ? -1 : list.length) : at) + dir * i) % list.length + list.length) % list.length]!
    if (c.unread > 0 && c.id !== chat.state.active) {
      void openConversation(c.id).catch((e) => toast.error(errMsg(e)))
      return
    }
  }
}

function onKey(e: KeyboardEvent) {
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey
  if (mod && !e.shiftKey && e.key === '/') {
    e.preventDefault()
    shortcutsOpen.value = !shortcutsOpen.value
  } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    if (modalOpen() || accountOpen.value || e.isComposing) return
    // In the message box it switches chats (like Slack/Discord); in other text fields (search, editing a
    // message) Alt+↑/↓ keeps its normal meaning (on a Mac: to the start/end of the text).
    const t = e.target as HTMLElement | null
    if (t?.closest('input, textarea, select, [contenteditable="true"]') && !t.closest('.composer-editor[aria-label="Message"]')) return
    e.preventDefault()
    stepConversation(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
  } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
    // Search in the open chat; without one, leave the browser's own find alone.
    if (!chat.state.active || accountOpen.value || view.value !== 'chats' || modalOpen()) return
    e.preventDefault()
    if (sidePanel.value === 'search') document.querySelector<HTMLInputElement>('input[aria-label="Search this chat"]')?.select()
    else sidePanel.value = 'search'
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ',') {
    // Cmd+, (Ctrl+, elsewhere): settings, as in other apps.
    e.preventDefault()
    accountOpen.value = true
  }
}

/** Resolves once `cond` holds, or after `ms`. */
function waitFor(cond: () => boolean, ms: number): Promise<void> {
  if (cond()) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(cond, (ok) => ok && done())
    const timer = setTimeout(done, ms)
    function done() {
      stop()
      clearTimeout(timer)
      resolve()
    }
  })
}

/** A link to a message (<server>/#/m/<chat>/<id>) in the address bar: open it and tidy the address. Resolves true if it was one. */
async function openLinkFromHash(): Promise<boolean> {
  const target = parseMessageLink(location.href)
  if (!target) return false
  history.replaceState(null, '', location.pathname + location.search)
  // Right after start the chats may still be loading.
  // (A DM link made by the other person names my own id: then wait for the list to be there.)
  const mine = target.conv === `dm:${chat.state.account?.id}`
  await waitFor(() => chat.state.conversations.some((c) => c.id === target.conv) || (mine && !chat.state.syncing && chat.state.conversations.length > 0), 8000)
  await openMessageLink(target)
  return true
}
const onHash = () => void openLinkFromHash().catch(() => {})

/** Wide screens come back to the chat that was open last on this device. */
async function reopenLast() {
  if (!isWide.value || chat.state.active) return
  // The engine only knows a chat once the list has loaded, and the list fills in bit by bit: ask for a few seconds.
  for (let i = 0; i < 20; i++) {
    const id = await chat.lastConversation()
    if (chat.state.active) return
    if (id) {
      await openConversation(id).catch(() => {})
      return
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

let stopNotifications = () => {}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('hashchange', onHash)
  void openLinkFromHash().then((was) => (was ? undefined : reopenLast())).catch(() => {})
  stopNotifications = startNotifications()
  if (chat.isDesktop) {
    setTimeout(() => void offerUpdate(), 5000)
    updateTimer = setInterval(() => void offerUpdate(), 6 * 3600_000)
  }
})

/**
 * Desktop app: offer a newer version a few seconds after start (so startup isn't slowed), then
 * check again every 6 hours while it runs (it often stays open in the tray for days).
 * Each version is offered once per run; Settings › App can always check and install.
 */
let offered = ''
let updateTimer: ReturnType<typeof setInterval> | undefined
async function offerUpdate() {
  const update = await checkForUpdate()
  if (!update || update.version === offered) return
  offered = update.version
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
  clearInterval(updateTimer)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('hashchange', onHash)
  stopNotifications()
})
</script>

<template>
  <div class="flex h-full w-full">
    <Rail />
    <SettingsPage v-if="accountOpen" class="min-w-0 flex-1" @change-password="pwOpen = true" @sign-out="signOutOpen = true" />
    <Sidebar class="w-full md:w-64 md:shrink-0" :class="accountOpen ? 'hidden' : showConv ? 'hidden md:flex' : 'flex'" />
    <FriendsView v-if="view === 'friends'" class="min-w-0 flex-1" :class="accountOpen ? 'hidden' : showConv ? 'flex' : 'hidden md:flex'" />
    <ConversationPane v-else class="min-w-0 flex-1" :class="accountOpen ? 'hidden' : showConv ? 'flex' : 'hidden md:flex'" @back="showChats" />

    <ChangePasswordDialog v-model:open="pwOpen" />
    <CommandPalette v-model:open="paletteOpen" />
    <ShortcutsDialog v-model:open="shortcutsOpen" />
    <StatusTextDialog v-model:open="statusTextOpen" />
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
