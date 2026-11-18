<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, Loader2, LogOut, Moon, Plus, Search, SearchX, Settings2, Sun, TriangleAlert, UserPlus } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import AccountDialog from '@/components/AccountDialog.vue'
import ChangePasswordDialog from '@/components/ChangePasswordDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import FriendsDialog from '@/components/FriendsDialog.vue'
import NewGroupDialog from '@/components/NewGroupDialog.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg, relTime } from '@/lib/format'
import { isDark, toggleTheme } from '@/lib/theme'
import { friendsOpen } from '@/lib/ui'
import type { Conversation } from '@/lib/types'

const emit = defineEmits<{ selected: [] }>()

const accountOpen = ref(false)
const pwOpen = ref(false)
const signOutOpen = ref(false)
const signingOut = ref(false)
const incomingCount = computed(() => chat.state.requests.incoming.length)
const groupOpen = ref(false)
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return chat.state.conversations.filter((c) => !q || c.title.toLowerCase().includes(q))
})
const sections = computed(() => [
  { title: 'Groups', items: filtered.value.filter((c) => c.kind === 'group') },
  { title: 'Direct messages', items: filtered.value.filter((c) => c.kind === 'dm') },
].filter((s) => s.items.length))

const statusText = computed(() => ({ online: 'Online', connecting: 'Connecting…', offline: 'Offline' })[chat.state.status])

function contactOf(c: Conversation) {
  return c.kind === 'dm' ? chat.state.contacts[c.id.slice(3)] : undefined
}

async function select(c: Conversation) {
  emit('selected')
  try {
    await chat.open(c.id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

const idOf = (c: Conversation) => c.id.slice(c.kind === 'dm' ? 3 : 2)

async function signOut() {
  signingOut.value = true
  try {
    await chat.logout()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    signingOut.value = false
    signOutOpen.value = false
  }
}
</script>

<template>
  <aside class="flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
    <header class="flex items-center gap-3 px-4 pt-4 pb-3">
      <img src="/favicon.svg" alt="" class="size-9 rounded-xl shadow-md ring-1 ring-line">
      <div class="min-w-0 flex-1 leading-tight">
        <h1 class="text-[15px] font-semibold">E2EE Chat</h1>
        <p class="text-[11px] text-muted-foreground">End-to-end encrypted</p>
      </div>
      <button class="btn btn-soft btn-icon relative" title="Friends" aria-label="Friends" @click="friendsOpen = true">
        <UserPlus />
        <span v-if="incomingCount" class="unread absolute -top-1.5 -right-1.5 !min-w-[1.1rem] !h-[1.1rem] !px-1 !text-[10px] shadow-[0_0_0_2px_var(--sidebar)]">{{ incomingCount }}</span>
      </button>
      <button class="btn btn-soft btn-icon" title="New group" aria-label="New group" @click="groupOpen = true"><Plus /></button>
    </header>

    <div class="px-3 pb-3">
      <div class="field-icon">
        <Search />
        <input v-model="query" type="search" placeholder="Search chats" aria-label="Search conversations" class="field !h-10 !rounded-xl !text-sm">
      </div>
    </div>

    <button
      v-if="incomingCount"
      class="mx-3 mb-2 flex items-center gap-3 rounded-2xl p-3 text-left text-sm shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent-from)_30%,transparent)] transition-colors [background:linear-gradient(90deg,color-mix(in_oklab,var(--accent-from)_16%,transparent),color-mix(in_oklab,var(--accent-to)_6%,transparent))] hover:brightness-110"
      @click="friendsOpen = true"
    >
      <span class="flex size-8 shrink-0 items-center justify-center rounded-xl text-white [background:var(--grad)]"><UserPlus class="size-4" /></span>
      <span class="flex-1 font-semibold">{{ incomingCount }} friend {{ incomingCount === 1 ? 'request' : 'requests' }}</span>
      <ChevronRight class="size-4 text-muted-foreground" />
    </button>

    <div v-if="chat.state.syncing" class="mx-4 mb-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Loader2 class="size-3.5 animate-spin" />Syncing messages…
    </div>

    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <div v-if="!filtered.length" class="flex flex-col items-center gap-3 px-4 py-14 text-center text-sm text-muted-foreground">
        <SearchX class="size-8 opacity-40" />
        <template v-if="query">No matching chats.</template>
        <template v-else>
          No conversations yet.
          <button class="btn btn-soft btn-sm" @click="friendsOpen = true"><UserPlus />Add a friend</button>
        </template>
      </div>

      <section v-for="section in sections" :key="section.title" class="mb-3">
        <h2 class="eyebrow px-3 pt-2 pb-1.5">{{ section.title }}</h2>
        <ul class="space-y-0.5">
          <li v-for="c in section.items" :key="c.id">
            <button
              class="row flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-none focus-visible:shadow-[var(--glow)]"
              :data-active="chat.state.active === c.id"
              :style="{ '--dot-ring': 'var(--sidebar)' }"
              @click="select(c)"
            >
              <UserAvatar :name="c.title" :id="idOf(c)" :size="42" :online="contactOf(c)?.online" />
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2">
                  <span class="flex-1 truncate text-[14.5px] font-semibold">{{ c.title }}</span>
                  <span class="shrink-0 text-[11px] tabular-nums" :class="c.unread > 0 ? 'font-semibold text-primary' : 'text-muted-foreground'">
                    {{ relTime(c.lastTs) }}
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-2">
                  <span class="flex-1 truncate text-[13px]" :class="c.unread > 0 ? 'text-foreground/80' : 'text-muted-foreground'">
                    {{ c.preview || (c.kind === 'group' ? 'No messages yet' : 'Say hi') }}
                  </span>
                  <TriangleAlert v-if="contactOf(c)?.keyChanged" class="size-4 shrink-0 text-destructive" />
                  <span v-if="c.unread > 0" class="unread shrink-0">{{ c.unread > 99 ? '99+' : c.unread }}</span>
                </div>
              </div>
            </button>
          </li>
        </ul>
      </section>
    </nav>

    <div class="p-3 pt-0">
      <div class="well flex items-center gap-3 rounded-2xl p-2.5">
        <UserAvatar
          :name="chat.state.account?.username ?? '?'" :id="chat.state.account?.id" :size="38"
          :online="chat.state.status === 'online'"
          style="--dot-ring: var(--card)"
        />
        <div class="min-w-0 flex-1 leading-tight">
          <div class="truncate text-sm font-semibold">{{ chat.state.account?.username }}</div>
          <div class="mt-0.5 truncate font-mono text-[11px] tracking-wider text-muted-foreground" :title="statusText">{{ chat.formatId(chat.state.account?.id ?? '') }}</div>
        </div>
        <button class="btn btn-ghost btn-icon btn-sm" title="Account" aria-label="Account" @click="accountOpen = true"><Settings2 /></button>
        <button class="btn btn-ghost btn-icon btn-sm" :title="isDark ? 'Light mode' : 'Dark mode'" aria-label="Toggle theme" @click="toggleTheme">
          <Sun v-if="isDark" /><Moon v-else />
        </button>
        <button class="btn btn-ghost btn-icon btn-sm hover:!text-destructive" title="Sign out" aria-label="Sign out" @click="signOutOpen = true"><LogOut /></button>
      </div>
    </div>

    <AccountDialog v-model:open="accountOpen" @change-password="pwOpen = true" />
    <ChangePasswordDialog v-model:open="pwOpen" />
    <FriendsDialog v-model:open="friendsOpen" />
    <ConfirmDialog
      v-model:open="signOutOpen"
      title="Sign out?"
      description="This removes this device's local copy of your data. Your messages are stored encrypted on the server and come back when you sign in again."
      confirm-label="Sign out"
      :loading="signingOut"
      @confirm="signOut"
    />
    <NewGroupDialog v-model:open="groupOpen" @created="emit('selected')" />
  </aside>
</template>
