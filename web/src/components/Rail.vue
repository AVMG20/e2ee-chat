<script setup lang="ts">
import { computed } from 'vue'
import { Download, MessageSquare, Moon, Settings, Star, Sun, Users } from 'lucide-vue-next'
import RailButton from '@/components/shell/RailButton.vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { chat } from '@/lib/chat'
import { showChats, openFriends, view } from '@/lib/nav'
import { isDark, toggleTheme } from '@/lib/theme'
import { accountOpen, sidePanel, starredScope } from '@/lib/ui'

function openStarred() {
  view.value = 'chats'
  starredScope.value = 'all'
  sidePanel.value = 'starred'
}
const incoming = computed(() => chat.state.requests.incoming.length)
const unread = computed(() => chat.state.conversations.reduce((n, c) => (c.muted ? n : n + c.unread), 0))
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <nav class="hidden w-14 shrink-0 flex-col items-center gap-2 bg-rail py-3 md:flex" aria-label="App">
      <img src="/favicon.svg" alt="E2EE Chat" class="mb-1 size-10 rounded-[0.9rem]">
      <div class="mb-1 h-px w-7 bg-line" />

      <RailButton label="Chats" :active="view === 'chats'" @click="showChats">
        <MessageSquare class="size-5" :fill="view === 'chats' ? 'currentColor' : 'none'" />
        <template #badge>
          <span v-if="unread" class="absolute -right-1 -bottom-1 size-3 rounded-full bg-destructive ring-[3px] ring-[var(--rail)]" />
        </template>
      </RailButton>
      <RailButton label="Friends" :active="view === 'friends'" @click="openFriends()">
        <Users class="size-5" />
        <template #badge>
          <span v-if="incoming" class="unread absolute -right-1 -bottom-1 shadow-[0_0_0_3px_var(--rail)] !bg-destructive">{{ incoming }}</span>
        </template>
      </RailButton>

      <RailButton label="Starred messages" @click="openStarred"><Star class="size-5" /></RailButton>

      <div class="flex-1" />

      <RailButton v-if="!chat.isDesktop" label="Download desktop app" :href="chat.desktopDownloadUrl"><Download class="size-5" /></RailButton>
      <RailButton :label="isDark ? 'Light mode' : 'Dark mode'" @click="toggleTheme">
        <Sun v-if="isDark" class="size-5" /><Moon v-else class="size-5" />
      </RailButton>
      <RailButton label="Account settings" @click="accountOpen = true"><Settings class="size-5" /></RailButton>
    </nav>
  </TooltipProvider>
</template>
