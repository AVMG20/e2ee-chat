<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowLeft, AtSign, Ban, Bell, BellOff, Check, Ellipsis, Loader2, ShieldAlert, ShieldCheck, UserMinus, UserPlus, Clock } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import CopyIdButton from '@/components/shell/CopyIdButton.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { addMembersGroup, pendingAction } from '@/lib/nav'
import { MUTE_OPTIONS, friendState, muteFor, openUser, panelUser, sendFriendRequestToast, setPrefs, trustNewKey } from '@/lib/ui'

const conv = computed(() => chat.state.conversations.find((c) => c.id === chat.state.active) ?? null)
const dmId = computed(() => (conv.value?.kind === 'dm' ? conv.value.id.slice(3) : null))
const userId = computed(() => dmId.value ?? panelUser.value)
const contact = computed(() => (userId.value ? chat.state.contacts[userId.value] ?? null : null))
const userName = computed(() => (userId.value ? contact.value?.name ?? chat.displayName(userId.value) : ''))
const showUser = computed(() => !!userId.value && (dmId.value ? !!contact.value : true))
const group = computed(() => (conv.value?.kind === 'group' ? chat.state.groups[conv.value.id.slice(2)] ?? null : null))
const isAdmin = computed(() => (group.value ? chat.isGroupAdmin(group.value.id) : false))
const adminOf = (m: string) => !!group.value?.admins?.includes(m)
const me = computed(() => chat.state.account?.id)
const busy = ref(false)

async function setAdmin(m: string, on: boolean) {
  if (!group.value) return
  try {
    await chat.setAdmin(group.value.id, m, on)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

const nameOf = (id: string) => chat.state.contacts[id]?.name ?? chat.displayName(id)

/** Runs the friend action that fits where `id` stands (add, accept, cancel, unblock). */
async function friendAction(id: string, what: 'add' | 'accept' | 'cancel' | 'unblock') {
  try {
    if (what === 'add') await sendFriendRequestToast(id, nameOf(id))
    else if (what === 'accept') {
      await chat.acceptFriend(id)
      toast.success(`You're now friends with ${nameOf(id)}`)
    } else if (what === 'cancel') await chat.declineFriend(id)
    else await chat.unblockUser(id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

async function toggleVerified() {
  if (!contact.value) return
  busy.value = true
  try {
    await chat.setVerified(contact.value.id, !contact.value.verified)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    busy.value = false
  }
}

async function trust() {
  busy.value = true
  try {
    await trustNewKey(contact.value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="conv" class="space-y-5">
    <!-- Group -->
    <template v-if="group && !showUser">
      <section>
        <h3 class="eyebrow mb-1.5 px-1">Members, {{ group.members.length }}</h3>
        <button v-if="isAdmin" class="btn btn-soft btn-sm mb-2 w-full" @click="addMembersGroup = group.id"><UserPlus />Add members</button>
        <ul class="space-y-0.5 text-sm">
          <li v-for="m in group.members" :key="m" class="row flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left outline-none focus-visible:shadow-[var(--glow)]" :aria-label="`Show info for ${chat.displayName(m)}`" @click="openUser(m)">
            <UserAvatar :name="chat.displayName(m)" :id="m" :src="m === me ? chat.state.account?.avatar : chat.state.contacts[m]?.avatar" :size="32" :online="m === me ? true : chat.state.contacts[m]?.friend ? !!chat.state.contacts[m]?.online : undefined" />
            <span class="min-w-0 flex-1 truncate font-medium hover:underline">{{ chat.displayName(m) }}</span>
            </button>
            <span v-if="adminOf(m)" class="rounded bg-primary/15 px-1.5 py-px text-[11px] font-semibold text-[var(--link)]">Admin</span>
            <span v-if="m === me" class="text-xs text-muted-foreground">you</span>
            <template v-else-if="friendState(m) !== 'friend'">
              <button v-if="friendState(m) === 'outgoing'" class="btn btn-ghost btn-icon btn-sm" title="Request sent. Click to cancel" aria-label="Cancel friend request" @click="friendAction(m, 'cancel')"><Clock /></button>
              <button v-else-if="friendState(m) === 'incoming'" class="btn btn-ghost btn-icon btn-sm" title="Accept friend request" aria-label="Accept friend request" @click="friendAction(m, 'accept')"><Check /></button>
              <button v-else-if="friendState(m) === 'blocked'" class="btn btn-ghost btn-icon btn-sm" title="Unblock" aria-label="Unblock" @click="friendAction(m, 'unblock')"><Ban /></button>
              <button v-else class="btn btn-ghost btn-icon btn-sm" title="Add friend" aria-label="Add friend" @click="friendAction(m, 'add')"><UserPlus /></button>
            </template>
            <DropdownMenu v-if="isAdmin && m !== me">
              <DropdownMenuTrigger as-child>
                <button class="btn btn-ghost btn-icon btn-sm" title="Member options" aria-label="Member options"><Ellipsis /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-48">
                <template v-if="group.admins">
                  <DropdownMenuItem v-if="adminOf(m)" @select="setAdmin(m, false)"><ShieldCheck />Remove as admin</DropdownMenuItem>
                  <DropdownMenuItem v-else @select="setAdmin(m, true)"><ShieldCheck />Make admin</DropdownMenuItem>
                  <DropdownMenuSeparator />
                </template>
                <DropdownMenuItem variant="destructive" @select="pendingAction = { kind: 'kick', id: m, group: group.id }"><UserMinus />Remove from group</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        </ul>
      </section>
    </template>

    <!-- Person (the DM partner, or someone picked in a group) -->
    <template v-else-if="showUser && userId">
      <button v-if="group" class="btn btn-ghost btn-sm -mb-2" @click="panelUser = null"><ArrowLeft />Back to members</button>
      <section class="flex flex-col items-center gap-2 pt-2 text-center" style="--dot-ring: var(--sidebar)">
        <UserAvatar :name="userName" :id="userId" :src="contact?.avatar" :size="96" :online="contact?.friend ? !!contact.online : undefined" />
        <h3 class="max-w-full truncate text-lg font-bold">{{ userName }}</h3>
        <p v-if="contact && contact.username !== contact.name" class="max-w-full truncate text-sm text-muted-foreground">@{{ contact.username }}</p>
        <p v-if="contact?.friend" class="text-xs text-muted-foreground">{{ contact.online ? 'Online' : 'Offline' }}</p>
        <div class="flex items-center gap-2">
          <span class="font-mono text-sm font-semibold tracking-[0.1em]">{{ chat.formatId(userId) }}</span>
          <CopyIdButton :id="userId" class="btn-icon" />
        </div>
      </section>

      <section v-if="contact" class="space-y-2">
        <h3 class="eyebrow px-1">Security code</h3>
        <div class="well space-y-2 rounded-md p-3">
          <p class="grid grid-cols-4 gap-x-2 gap-y-1 font-mono text-[13px] tracking-wide"><span v-for="(g, i) in contact.fingerprint.split(' ')" :key="i">{{ g }}</span></p>
          <p class="flex items-center gap-1.5 text-xs" :class="contact.verified ? 'text-success' : 'text-muted-foreground'">
            <ShieldCheck class="size-3.5" />{{ contact.verified ? 'Verified' : 'Not verified. Compare this code with theirs in person.' }}
          </p>
          <button class="btn btn-soft btn-sm w-full" :disabled="busy" @click="toggleVerified">
            <Loader2 v-if="busy" class="animate-spin" />{{ contact.verified ? 'Mark as not verified' : 'Mark as verified' }}
          </button>
        </div>
        <div v-if="contact.keyChanged" class="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs" role="alert">
          <p class="flex items-start gap-2 leading-relaxed"><ShieldAlert class="mt-0.5 size-4 shrink-0 text-destructive" /><span><strong class="font-semibold text-destructive">Security key changed.</strong> Check the new code with {{ contact.name }} outside this app.</span></p>
          <p v-if="contact.pendingFingerprint" class="grid grid-cols-4 gap-x-2 gap-y-1 font-mono text-[13px] tracking-wide"><span v-for="(g, i) in contact.pendingFingerprint.split(' ')" :key="i">{{ g }}</span></p>
          <button class="btn btn-danger btn-sm w-full" :disabled="busy || !contact.pendingFingerprint" @click="trust"><Loader2 v-if="busy" class="animate-spin" />Trust new key</button>
        </div>
      </section>
    </template>

    <!-- Notifications -->
    <section v-if="!panelUser" class="space-y-0.5">
      <h3 class="eyebrow mb-1 px-1">Notifications</h3>
      <template v-if="conv.muted">
        <button class="row flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm" @click="setPrefs(conv.id, { muted: false })"><Bell class="size-4" />Unmute</button>
      </template>
      <template v-else>
        <button v-for="o in MUTE_OPTIONS" :key="o.ms" class="row flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm" @click="muteFor(conv.id, o.ms)"><BellOff class="size-4" />{{ o.label }}</button>
      </template>
      <button v-if="group" class="row flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm" @click="setPrefs(conv.id, { mentionsOnly: !conv.mentionsOnly })">
        <AtSign class="size-4" />Only notify for mentions<Check v-if="conv.mentionsOnly" class="ml-auto size-4" />
      </button>
    </section>

    <section v-if="showUser && userId" class="space-y-0.5">
      <button v-if="contact?.friend" class="row flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-destructive" @click="pendingAction = { kind: 'remove', id: userId }"><UserMinus class="size-4" />Remove friend</button>
      <template v-else-if="friendState(userId) === 'outgoing'">
        <button class="btn btn-soft btn-sm mb-1 w-full" disabled aria-label="Request sent" title="Request sent"><Clock />Request sent</button>
        <button class="row flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm" aria-label="Cancel request" title="Cancel request" @click="friendAction(userId, 'cancel')"><Ban class="size-4" />Cancel request</button>
      </template>
      <button v-else-if="friendState(userId) === 'incoming'" class="btn btn-soft btn-sm mb-1 w-full" aria-label="Accept" title="Accept" @click="friendAction(userId, 'accept')"><Check />Accept</button>
      <button v-else-if="friendState(userId) === 'blocked'" class="btn btn-soft btn-sm mb-1 w-full" aria-label="Unblock" title="Unblock" @click="friendAction(userId, 'unblock')"><Ban />Unblock</button>
      <button v-else class="btn btn-soft btn-sm mb-1 w-full" aria-label="Add friend" title="Add friend" @click="friendAction(userId, 'add')"><UserPlus />Add friend</button>
      <button v-if="friendState(userId) !== 'blocked'" class="row flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-destructive" @click="pendingAction = { kind: 'block', id: userId }"><Ban class="size-4" />Block</button>
    </section>
  </div>
</template>
