<script setup lang="ts">
import { toast } from 'vue-sonner'
import Toggle from '@/components/shell/Toggle.vue'
import SettingsSection from './SettingsSection.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { notifyContent, notifyDenied, notifyEnabled, notifySupported, setNotify, setNotifyContent, setSound, soundEnabled, type NotifyContent } from '@/lib/notify'

const contents: { id: NotifyContent; label: string; hint: string }[] = [
  { id: 'full', label: 'Name and message', hint: 'Shows who wrote and what they said.' },
  { id: 'name', label: 'Name only', hint: 'Shows who wrote, with "New message" instead of the text.' },
  { id: 'none', label: 'Nothing', hint: 'Shows "New message" with no name.' },
]
const seg = 'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:shadow-[var(--glow)]'

async function toggleGroupMentions(on: boolean) {
  try {
    await chat.setGroupMentionsDefault(on)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

async function toggleNotify(on: boolean) {
  const result = await setNotify(on)
  if (on && !result) toast.error(notifySupported ? (chat.isDesktop ? 'Notifications are blocked. Allow notifications for E2EE Chat in System Settings › Notifications.' : 'Notifications are blocked. Allow them in your browser settings.') : 'This browser does not support notifications.')
}
</script>

<template>
  <div class="space-y-8">
  <SettingsSection title="Notifications">
    <div class="space-y-3.5">
      <Toggle
        :model-value="notifyEnabled" :disabled="!notifySupported" label="Desktop notifications"
        :description="notifyDenied ? (chat.isDesktop ? 'Blocked. Allow notifications for E2EE Chat in System Settings › Notifications.' : 'Blocked by your browser. Allow notifications for this site to use this.') : 'Show a notification for new messages when you are not looking at the chat.'"
        @update:model-value="toggleNotify"
      />
      <Toggle :model-value="soundEnabled" label="Sound" description="Play a short sound for new messages." @update:model-value="setSound" />
      <Toggle
        :model-value="chat.state.settings.groupMentions" label="New groups: notify only for mentions"
        description="Groups you join or create start out quiet: you are only notified when someone mentions you or replies to you. Change it per group at any time."
        @update:model-value="toggleGroupMentions"
      />
    </div>
  </SettingsSection>

  <SettingsSection title="Notification content" description="What a notification shows. Saved on this device.">
    <div class="well inline-flex flex-wrap gap-1 rounded-lg p-1" role="radiogroup" aria-label="Notification content">
      <button
        v-for="c in contents" :key="c.id" role="radio" :aria-checked="notifyContent === c.id" :title="c.hint"
        :class="[seg, notifyContent === c.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground']"
        @click="setNotifyContent(c.id)"
      >{{ c.label }}</button>
    </div>
    <p class="text-xs text-muted-foreground">{{ contents.find((c) => c.id === notifyContent)?.hint }}</p>
  </SettingsSection>
  </div>
</template>
