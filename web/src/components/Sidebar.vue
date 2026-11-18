<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, Copy, Hash, Loader2, Moon, Plus, Search, Settings, Sun, TriangleAlert, UserPlus, Users } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import NewGroupDialog from '@/components/NewGroupDialog.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { isDark, toggleTheme } from '@/lib/theme'
import { accountOpen, copyText, friendsOpen } from '@/lib/ui'
import type { Conversation } from '@/lib/types'

const emit = defineEmits<{ selected: [] }>()

const groupOpen = ref(false)
const query = ref('')
const incomingCount = computed(() => chat.state.requests.incoming.length)
const myId = computed(() => chat.formatId(chat.state.account?.id ?? ''))

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return chat.state.conversations.filter((c) => !q || c.title.toLowerCase().includes(q))
})
const dms = computed(() => filtered.value.filter((c) => c.kind === 'dm'))
const groups = computed(() => filtered.value.filter((c) => c.kind === 'group'))

const contactOf = (c: Conversation) => (c.kind === 'dm' ? chat.state.contacts[c.id.slice(3)] : undefined)
const idOf = (c: Conversation) => c.id.slice(c.kind === 'dm' ? 3 : 2)

async function select(c: Conversation) {
  emit('selected')
  try {
    await chat.open(c.id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
</script>

<template>
  <aside class="flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
    <div class="flex h-12 shrink-0 items-center gap-1.5 border-b border-sidebar-border px-2.5">
      <div class="field-icon min-w-0 flex-1">
        <Search />
        <input v-model="query" type="search" placeholder="Search" aria-label="Search conversations" class="field !h-8 !rounded-md !text-sm">
      </div>
      <!-- the icon rail is hidden on small screens, so its actions live here -->
      <div class="flex items-center md:hidden">
        <button class="btn btn-ghost btn-icon btn-sm relative" title="Friends" aria-label="Friends" @click="friendsOpen = true">
          <Users />
          <span v-if="incomingCount" class="unread absolute -top-1 -right-1 !bg-destructive">{{ incomingCount }}</span>
        </button>
        <button class="btn btn-ghost btn-icon btn-sm" aria-label="Toggle theme" @click="toggleTheme"><Sun v-if="isDark" /><Moon v-else /></button>
      </div>
    </div>

    <button
      v-if="incomingCount"
      class="mx-2 mt-2 flex items-center gap-2.5 rounded-md bg-primary/15 px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-primary/25"
      @click="friendsOpen = true"
    >
      <UserPlus class="size-4 shrink-0 text-primary" />
      <span class="flex-1 font-semibold">{{ incomingCount }} friend {{ incomingCount === 1 ? 'request' : 'requests' }}</span>
      <ChevronRight class="size-4 text-muted-foreground" />
    </button>

    <div v-if="chat.state.syncing" class="mx-3 mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Loader2 class="size-3.5 animate-spin" />Syncing messages…
    </div>

    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2">
      <section class="mb-3">
        <div class="flex items-center justify-between px-1.5 pt-2 pb-1">
          <h2 class="eyebrow">Direct messages</h2>
          <button class="btn btn-ghost btn-icon btn-sm !size-5" title="Add friend" aria-label="Add friend" @click="friendsOpen = true"><Plus class="!size-4" /></button>
        </div>
        <p v-if="!dms.length" class="px-2 py-1.5 text-[13px] text-muted-foreground">
          {{ query ? 'No matches.' : 'No friends yet. Share your ID or add one.' }}
        </p>
        <ul class="space-y-px">
          <li v-for="c in dms" :key="c.id">
            <button
              class="row flex h-[2.6rem] w-full items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:shadow-[var(--glow)]"
              :data-active="chat.state.active === c.id" :data-unread="c.unread > 0" :title="c.preview"
              :style="{ '--dot-ring': chat.state.active === c.id ? 'var(--active)' : 'var(--sidebar)' }"
              @click="select(c)"
            >
              <UserAvatar :name="c.title" :id="idOf(c)" :size="32" :online="contactOf(c)?.online" />
              <span class="min-w-0 flex-1 truncate text-[15px]" :class="c.unread > 0 ? 'font-semibold' : 'font-medium'">{{ c.title }}</span>
              <TriangleAlert v-if="contactOf(c)?.keyChanged" class="size-4 shrink-0 text-destructive" />
              <span v-if="c.unread > 0" class="unread shrink-0">{{ c.unread > 99 ? '99+' : c.unread }}</span>
            </button>
          </li>
        </ul>
      </section>

      <section>
        <div class="flex items-center justify-between px-1.5 pt-2 pb-1">
          <h2 class="eyebrow">Groups</h2>
          <button class="btn btn-ghost btn-icon btn-sm !size-5" title="New group" aria-label="New group" @click="groupOpen = true"><Plus class="!size-4" /></button>
        </div>
        <p v-if="!groups.length" class="px-2 py-1.5 text-[13px] text-muted-foreground">{{ query ? 'No matches.' : 'No groups yet.' }}</p>
        <ul class="space-y-px">
          <li v-for="c in groups" :key="c.id">
            <button
              class="row flex h-9 w-full items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:shadow-[var(--glow)]"
              :data-active="chat.state.active === c.id" :data-unread="c.unread > 0" :title="c.preview"
              @click="select(c)"
            >
              <Hash class="size-5 shrink-0 opacity-60" />
              <span class="min-w-0 flex-1 truncate text-[15px]" :class="c.unread > 0 ? 'font-semibold' : 'font-medium'">{{ c.title }}</span>
              <span v-if="c.unread > 0" class="unread shrink-0">{{ c.unread > 99 ? '99+' : c.unread }}</span>
            </button>
          </li>
        </ul>
      </section>
    </nav>

    <!-- user panel -->
    <div class="flex h-[3.25rem] shrink-0 items-center gap-2 bg-rail/60 px-2" style="--dot-ring: color-mix(in srgb, var(--rail) 60%, var(--sidebar))">
      <button class="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-hover" title="Copy your ID" @click="copyText(myId, 'ID copied')">
        <UserAvatar :name="chat.state.account?.username ?? '?'" :id="chat.state.account?.id" :size="32" :online="chat.state.status === 'online'" />
        <span class="min-w-0 flex-1 leading-tight">
          <span class="block truncate text-[13px] font-semibold">{{ chat.state.account?.username }}</span>
          <span class="block truncate font-mono text-[11px] text-muted-foreground">{{ myId }}</span>
        </span>
        <Copy class="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <button class="btn btn-ghost btn-icon btn-sm md:hidden" title="Account settings" aria-label="Account settings" @click="accountOpen = true"><Settings /></button>
    </div>

    <NewGroupDialog v-model:open="groupOpen" @created="emit('selected')" />
  </aside>
</template>
