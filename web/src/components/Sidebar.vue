<script setup lang="ts">
import { computed, ref } from 'vue'
import { Fingerprint, LogOut, Moon, Plus, Search, SearchX, Sun, TriangleAlert } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import FingerprintBlock from '@/components/FingerprintBlock.vue'
import NewGroupDialog from '@/components/NewGroupDialog.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg, relTime } from '@/lib/format'
import { isDark, toggleTheme } from '@/lib/theme'
import type { Conversation } from '@/lib/types'

const emit = defineEmits<{ selected: [] }>()

const fpOpen = ref(false)
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

function fingerprint(): string {
  try {
    return chat.myFingerprint()
  } catch (e) {
    return errMsg(e)
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
      <button class="btn btn-soft btn-icon" title="New group" aria-label="New group" @click="groupOpen = true"><Plus /></button>
    </header>

    <div class="px-3 pb-3">
      <div class="field-icon">
        <Search />
        <input v-model="query" type="search" placeholder="Search chats" aria-label="Search conversations" class="field !h-10 !rounded-xl !text-sm">
      </div>
    </div>

    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <div v-if="!filtered.length" class="flex flex-col items-center gap-2 px-4 py-14 text-center text-sm text-muted-foreground">
        <SearchX class="size-8 opacity-40" />
        {{ query ? 'No matching chats.' : 'No conversations yet.' }}
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
              <UserAvatar :name="c.title" :size="42" :online="contactOf(c)?.online" />
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
          :name="chat.state.account?.name ?? '?'" :size="38"
          :online="chat.state.status === 'online'"
          style="--dot-ring: var(--card)"
        />
        <div class="min-w-0 flex-1 leading-tight">
          <div class="truncate text-sm font-semibold">{{ chat.state.account?.name }}</div>
          <div class="mt-0.5 text-xs text-muted-foreground" :class="chat.state.status === 'connecting' && 'animate-pulse'">{{ statusText }}</div>
        </div>
        <button class="btn btn-ghost btn-icon btn-sm" title="Your fingerprint" aria-label="Your fingerprint" @click="fpOpen = true"><Fingerprint /></button>
        <button class="btn btn-ghost btn-icon btn-sm" :title="isDark ? 'Light mode' : 'Dark mode'" aria-label="Toggle theme" @click="toggleTheme">
          <Sun v-if="isDark" /><Moon v-else />
        </button>
        <button class="btn btn-ghost btn-icon btn-sm hover:!text-destructive" title="Sign out" aria-label="Sign out" @click="chat.logout()"><LogOut /></button>
      </div>
    </div>

    <Dialog v-model:open="fpOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <div class="mb-2 flex size-11 items-center justify-center rounded-2xl text-white [background:var(--grad)]"><Fingerprint class="size-5" /></div>
          <DialogTitle>Your fingerprint</DialogTitle>
          <DialogDescription>
            Share this with your contacts over a trusted channel so they can verify it is really you.
          </DialogDescription>
        </DialogHeader>
        <FingerprintBlock :value="fingerprint()" />
      </DialogContent>
    </Dialog>

    <NewGroupDialog v-model:open="groupOpen" @created="emit('selected')" />
  </aside>
</template>
