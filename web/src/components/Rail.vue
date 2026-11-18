<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquare, Moon, Settings, Sun, Users } from 'lucide-vue-next'
import { chat } from '@/lib/chat'
import { isDark, toggleTheme } from '@/lib/theme'
import { accountOpen, friendsOpen } from '@/lib/ui'

defineEmits<{ chats: [] }>()
const incoming = computed(() => chat.state.requests.incoming.length)
const unread = computed(() => chat.state.conversations.reduce((n, c) => n + c.unread, 0))

const item = 'relative flex size-10 items-center justify-center rounded-[0.9rem] text-muted-foreground outline-none transition-all hover:rounded-lg hover:bg-active hover:text-foreground focus-visible:shadow-[var(--glow)]'
</script>

<template>
  <nav class="hidden w-14 shrink-0 flex-col items-center gap-2 bg-rail py-3 md:flex" aria-label="App">
    <img src="/favicon.svg" alt="E2EE Chat" class="mb-1 size-10 rounded-[0.9rem]">
    <div class="mb-1 h-px w-7 bg-line" />

    <button :class="[item, '!bg-primary !text-white !rounded-lg']" title="Chats" aria-label="Chats" @click="$emit('chats')">
      <MessageSquare class="size-5" fill="currentColor" />
      <span v-if="unread" class="absolute -right-1 -bottom-1 size-3 rounded-full bg-destructive ring-[3px] ring-[var(--rail)]" />
    </button>
    <button :class="item" title="Friends" aria-label="Friends" @click="friendsOpen = true">
      <Users class="size-5" />
      <span v-if="incoming" class="unread absolute -right-1 -bottom-1 shadow-[0_0_0_3px_var(--rail)] !bg-destructive">{{ incoming }}</span>
    </button>

    <div class="flex-1" />

    <button :class="item" :title="isDark ? 'Light mode' : 'Dark mode'" aria-label="Toggle theme" @click="toggleTheme">
      <Sun v-if="isDark" class="size-5" /><Moon v-else class="size-5" />
    </button>
    <button :class="item" title="Account settings" aria-label="Account settings" @click="accountOpen = true"><Settings class="size-5" /></button>
  </nav>
</template>
