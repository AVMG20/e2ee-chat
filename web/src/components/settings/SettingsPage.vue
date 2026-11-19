<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue'
import { ArrowLeft, Bell, ChevronRight, Monitor, Palette, ShieldCheck, User, X } from 'lucide-vue-next'
import MyAccountSection from './MyAccountSection.vue'
import PrivacySection from './PrivacySection.vue'
import NotificationsSection from './NotificationsSection.vue'
import AppearanceSection from './AppearanceSection.vue'
import AppSection from './AppSection.vue'
import { chat } from '@/lib/chat'
import { accountOpen, settingsSection, type SettingsSection } from '@/lib/ui'

defineEmits<{ changePassword: []; signOut: [] }>()

const sections = computed<{ id: SettingsSection; label: string; icon: Component }[]>(() => [
  { id: 'account', label: 'My account', icon: User },
  { id: 'privacy', label: 'Privacy & security', icon: ShieldCheck },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  ...(chat.isDesktop ? [{ id: 'app' as const, label: 'App', icon: Monitor }] : []),
])
const current = computed(() => sections.value.find((s) => s.id === settingsSection.value) ?? sections.value[0]!)

// Phone width: the list and the content take turns.
const showContent = ref(false)
function pick(id: SettingsSection) {
  settingsSection.value = id
  showContent.value = true
}

function close() {
  accountOpen.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  // A dialog inside the page handles Esc itself.
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
  close()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="flex h-full min-w-0 bg-background" role="region" aria-label="Settings">
    <nav
      class="w-full min-w-0 shrink-0 flex-col overflow-y-auto bg-sidebar p-4 md:flex md:w-60 md:p-3"
      :class="showContent ? 'hidden' : 'flex'" aria-label="Settings sections"
    >
      <div class="mb-3 flex items-center justify-between px-1 md:hidden">
        <h1 class="text-lg font-semibold">Settings</h1>
        <button class="btn btn-ghost btn-icon btn-sm" aria-label="Close settings" title="Close settings" @click="close"><X /></button>
      </div>
      <h1 class="eyebrow mb-2 hidden px-2 pt-2 md:block">Settings</h1>
      <ul class="space-y-0.5">
        <li v-for="s in sections" :key="s.id">
          <button
            class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium outline-none transition-colors focus-visible:shadow-[var(--glow)]"
            :class="s.id === current.id ? 'md:bg-active md:text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'"
            :aria-current="s.id === current.id ? 'page' : undefined" :aria-label="s.label" :title="s.label" @click="pick(s.id)"
          >
            <component :is="s.icon" class="size-4 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ s.label }}</span>
            <ChevronRight class="size-4 shrink-0 opacity-50 md:hidden" />
          </button>
        </li>
      </ul>
    </nav>

    <main class="relative min-w-0 flex-1 overflow-y-auto" :class="showContent ? 'block' : 'hidden md:block'">
      <div class="mx-auto w-full max-w-[42rem] px-4 pt-4 pb-16 md:px-8 md:pt-8">
        <div class="mb-6 flex items-center gap-2">
          <button class="btn btn-ghost btn-icon btn-sm md:hidden" aria-label="Back to settings list" title="Back" @click="showContent = false"><ArrowLeft /></button>
          <h2 class="min-w-0 flex-1 truncate text-xl font-semibold">{{ current.label }}</h2>
          <button class="btn btn-ghost btn-icon hidden md:inline-flex" aria-label="Close settings (Esc)" title="Close (Esc)" @click="close"><X /></button>
        </div>
        <MyAccountSection v-if="current.id === 'account'" @change-password="$emit('changePassword')" @sign-out="$emit('signOut')" />
        <PrivacySection v-else-if="current.id === 'privacy'" />
        <NotificationsSection v-else-if="current.id === 'notifications'" />
        <AppearanceSection v-else-if="current.id === 'appearance'" />
        <AppSection v-else-if="current.id === 'app'" />
      </div>
    </main>
  </div>
</template>
