<script setup lang="ts">
import { computed, ref } from 'vue'
import { Archive, BellOff, Check, ChevronRight, ChevronDown, Copy, Hash, Loader2, Moon, Pin, Plus, Search, Settings, Sun, TriangleAlert, UserPlus, Users } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import NewGroupDialog from '@/components/NewGroupDialog.vue'
import EntryMenu from '@/components/shell/EntryMenu.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { drafts } from '@/components/messages/state'
import { chat } from '@/lib/chat'
import { errMsg, relTime } from '@/lib/format'
import { openConversation, openFriends, showConv } from '@/lib/nav'
import { docToText } from '@/lib/render'
import { isDark, toggleTheme } from '@/lib/theme'
import { accountOpen, paletteOpen, useCopy } from '@/lib/ui'
import type { Conversation } from '@/lib/types'

const groupOpen = ref(false)
const { copied, copy } = useCopy()
const incomingCount = computed(() => chat.state.requests.incoming.length)
const myId = computed(() => chat.formatId(chat.state.account?.id ?? ''))
const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform)

// chat.state.conversations is already newest-first; keep that order within each section.
const active = computed(() => chat.state.conversations.filter((c) => !c.archived))
const dms = computed(() => active.value.filter((c) => c.kind === 'dm'))
const groups = computed(() => active.value.filter((c) => c.kind === 'group'))
const archived = computed(() => chat.state.conversations.filter((c) => c.archived))
const archiveOpen = ref(false)

function draftOf(c: Conversation) {
  const d = c.id === chat.state.active ? undefined : drafts.get(c.id)
  return d?.doc ? docToText(d.doc as Parameters<typeof docToText>[0]).trim() : ''
}
const contactOf = (c: Conversation) => (c.kind === 'dm' ? chat.state.contacts[c.id.slice(3)] : undefined)
const idOf = (c: Conversation) => c.id.slice(c.kind === 'dm' ? 3 : 2)

async function select(c: Conversation) {
  try {
    await openConversation(c.id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
</script>

<template>
  <aside class="flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
    <div class="flex h-12 shrink-0 items-center gap-1.5 border-b border-sidebar-border px-2.5">
      <button
        class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-inset px-2.5 text-left text-sm text-muted-foreground outline-none transition-shadow hover:text-foreground focus-visible:shadow-[var(--glow)]"
        aria-label="Search conversations" @click="paletteOpen = true"
      >
        <Search class="size-4 shrink-0" />
        <span class="flex-1 truncate">Search</span>
        <kbd class="hidden shrink-0 rounded bg-soft px-1.5 py-px font-sans text-[10px] font-semibold md:block">{{ isMac ? '⌘ K' : 'Ctrl K' }}</kbd>
      </button>
      <!-- the icon rail is hidden on small screens, so its actions live here -->
      <div class="flex items-center md:hidden">
        <button class="btn btn-ghost btn-icon btn-sm relative" title="Friends" aria-label="Friends" @click="openFriends(incomingCount ? 'pending' : 'online')">
          <Users />
          <span v-if="incomingCount" class="unread absolute -top-1 -right-1 !bg-destructive">{{ incomingCount }}</span>
        </button>
        <button class="btn btn-ghost btn-icon btn-sm" aria-label="Toggle theme" @click="toggleTheme"><Sun v-if="isDark" /><Moon v-else /></button>
      </div>
    </div>

    <button
      v-if="incomingCount"
      class="mx-2 mt-2 flex items-center gap-2.5 rounded-md bg-primary/15 px-2.5 py-2 text-left text-[13px] outline-none transition-colors hover:bg-primary/25 focus-visible:shadow-[var(--glow)]"
      @click="openFriends('pending')"
    >
      <UserPlus class="size-4 shrink-0 text-primary" />
      <span class="flex-1 font-semibold">{{ incomingCount }} friend {{ incomingCount === 1 ? 'request' : 'requests' }}</span>
      <ChevronRight class="size-4 text-muted-foreground" />
    </button>

    <div v-if="chat.state.syncing" class="mx-3 mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Loader2 class="size-3.5 animate-spin" />Syncing messages…
    </div>

    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2" aria-label="Conversations">
      <section class="mb-3">
        <div class="flex items-center justify-between px-1.5 pt-2 pb-1">
          <h2 class="eyebrow">Direct messages</h2>
          <button class="btn btn-ghost btn-icon btn-sm !size-5" title="Add friend" aria-label="Add friend" @click="openFriends('add')"><Plus class="!size-4" /></button>
        </div>
        <p v-if="!dms.length" class="px-2 py-1.5 text-[13px] text-muted-foreground">No friends yet. Share your ID or add one.</p>
        <ul class="space-y-px">
          <li v-for="c in dms" :key="c.id">
            <EntryMenu kind="dm" :id="idOf(c)">
              <button
                class="row flex h-12 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:shadow-[var(--glow)]"
                :data-active="chat.state.active === c.id" :data-unread="c.unread > 0"
                :style="{ '--dot-ring': chat.state.active === c.id ? 'var(--active)' : 'var(--sidebar)' }"
                @click="select(c)"
              >
                <UserAvatar :name="c.title" :id="idOf(c)" :src="contactOf(c)?.avatar" :size="32" :online="contactOf(c)?.online" />
                <span class="min-w-0 flex-1 leading-tight">
                  <span class="flex items-baseline gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-[15px]" :class="c.unread > 0 ? 'font-semibold' : 'font-medium'">{{ c.title }}</span>
                    <TriangleAlert v-if="contactOf(c)?.keyChanged" class="size-3.5 shrink-0 self-center text-destructive" />
                    <span class="shrink-0 text-[11px] font-normal text-muted-foreground">{{ relTime(c.lastTs) }}</span>
                  </span>
                  <span class="mt-0.5 flex items-center gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground"><template v-if="draftOf(c)"><span class="font-semibold text-destructive">Draft:</span> {{ draftOf(c) }}</template><template v-else>{{ c.preview }}</template></span>
                    <Pin v-if="c.pinned" class="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
                    <BellOff v-if="c.muted" class="size-3 shrink-0 text-muted-foreground" aria-label="Muted" />
                    <span v-if="c.unread > 0" class="unread shrink-0" :class="c.muted && '!bg-zinc-500'">{{ c.unread > 99 ? '99+' : c.unread }}</span>
                  </span>
                </span>
              </button>
            </EntryMenu>
          </li>
        </ul>
      </section>

      <section>
        <div class="flex items-center justify-between px-1.5 pt-2 pb-1">
          <h2 class="eyebrow">Groups</h2>
          <button class="btn btn-ghost btn-icon btn-sm !size-5" title="New group" aria-label="New group" @click="groupOpen = true"><Plus class="!size-4" /></button>
        </div>
        <p v-if="!groups.length" class="px-2 py-1.5 text-[13px] text-muted-foreground">No groups yet.</p>
        <ul class="space-y-px">
          <li v-for="c in groups" :key="c.id">
            <EntryMenu kind="group" :id="idOf(c)">
              <button
                class="row flex h-12 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:shadow-[var(--glow)]"
                :data-active="chat.state.active === c.id" :data-unread="c.unread > 0"
                @click="select(c)"
              >
                <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-soft"><Hash class="size-4" /></span>
                <span class="min-w-0 flex-1 leading-tight">
                  <span class="flex items-baseline gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-[15px]" :class="c.unread > 0 ? 'font-semibold' : 'font-medium'">{{ c.title }}</span>
                    <span class="shrink-0 text-[11px] font-normal text-muted-foreground">{{ relTime(c.lastTs) }}</span>
                  </span>
                  <span class="mt-0.5 flex items-center gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground"><template v-if="draftOf(c)"><span class="font-semibold text-destructive">Draft:</span> {{ draftOf(c) }}</template><template v-else>{{ c.preview }}</template></span>
                    <Pin v-if="c.pinned" class="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
                    <BellOff v-if="c.muted" class="size-3 shrink-0 text-muted-foreground" aria-label="Muted" />
                    <span v-if="c.unread > 0" class="unread shrink-0" :class="c.muted && '!bg-zinc-500'">{{ c.unread > 99 ? '99+' : c.unread }}</span>
                  </span>
                </span>
              </button>
            </EntryMenu>
          </li>
        </ul>
      </section>

      <section v-if="archived.length" class="mt-3">
        <button
          class="flex w-full items-center gap-1.5 rounded-md px-1.5 pt-2 pb-1 text-left outline-none focus-visible:shadow-[var(--glow)]"
          :aria-expanded="archiveOpen" @click="archiveOpen = !archiveOpen"
        >
          <ChevronDown class="size-3.5 text-muted-foreground transition-transform" :class="!archiveOpen && '-rotate-90'" />
          <h2 class="eyebrow flex items-center gap-1.5"><Archive class="size-3.5" />Archived ({{ archived.length }})</h2>
        </button>
        <ul v-if="archiveOpen" class="space-y-px">
          <li v-for="c in archived" :key="c.id">
            <EntryMenu :kind="c.kind" :id="idOf(c)">
              <button
                class="row flex h-12 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:shadow-[var(--glow)]"
                :data-active="chat.state.active === c.id" :data-unread="c.unread > 0"
                :style="{ '--dot-ring': chat.state.active === c.id ? 'var(--active)' : 'var(--sidebar)' }"
                @click="select(c)"
              >
                <UserAvatar v-if="c.kind === 'dm'" :name="c.title" :id="idOf(c)" :src="contactOf(c)?.avatar" :size="32" :online="contactOf(c)?.online" />
                <span v-else class="flex size-8 shrink-0 items-center justify-center rounded-full bg-soft"><Hash class="size-4" /></span>
                <span class="min-w-0 flex-1 truncate text-[15px] font-medium">{{ c.title }}</span>
                <span v-if="c.unread > 0" class="unread shrink-0" :class="c.muted && '!bg-zinc-500'">{{ c.unread > 99 ? '99+' : c.unread }}</span>
              </button>
            </EntryMenu>
          </li>
        </ul>
      </section>
    </nav>

    <!-- user panel -->
    <div class="flex h-[3.25rem] shrink-0 items-center gap-2 bg-rail/60 px-2" style="--dot-ring: color-mix(in srgb, var(--rail) 60%, var(--sidebar))">
      <button class="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left outline-none transition-colors hover:bg-hover focus-visible:shadow-[var(--glow)]" title="Copy your ID" @click="copy(myId)">
        <UserAvatar :name="chat.state.account?.username ?? '?'" :id="chat.state.account?.id" :src="chat.state.account?.avatar" :size="32" :online="chat.state.status === 'online'" />
        <span class="min-w-0 flex-1 leading-tight">
          <span class="block truncate text-[13px] font-semibold">{{ chat.state.account?.username }}</span>
          <span class="block truncate font-mono text-[11px] text-muted-foreground">{{ copied ? 'ID copied' : myId }}</span>
        </span>
        <Check v-if="copied" class="size-4 shrink-0 text-success" /><Copy v-else class="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <button class="btn btn-ghost btn-icon btn-sm md:hidden" title="Account settings" aria-label="Account settings" @click="accountOpen = true"><Settings /></button>
    </div>

    <NewGroupDialog v-model:open="groupOpen" @created="showConv = true" />
  </aside>
</template>
