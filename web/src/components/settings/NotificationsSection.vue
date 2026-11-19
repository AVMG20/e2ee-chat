<script setup lang="ts">
import { toast } from 'vue-sonner'
import Toggle from '@/components/shell/Toggle.vue'
import SettingsSection from './SettingsSection.vue'
import { chat } from '@/lib/chat'
import { notifyDenied, notifyEnabled, notifySupported, setNotify, setSound, soundEnabled } from '@/lib/notify'

async function toggleNotify(on: boolean) {
  const result = await setNotify(on)
  if (on && !result) toast.error(notifySupported ? (chat.isDesktop ? 'Notifications are blocked. Allow notifications for E2EE Chat in System Settings › Notifications.' : 'Notifications are blocked. Allow them in your browser settings.') : 'This browser does not support notifications.')
}
</script>

<template>
  <SettingsSection title="Notifications">
    <div class="space-y-3.5">
      <Toggle
        :model-value="notifyEnabled" :disabled="!notifySupported" label="Desktop notifications"
        :description="notifyDenied ? (chat.isDesktop ? 'Blocked. Allow notifications for E2EE Chat in System Settings › Notifications.' : 'Blocked by your browser. Allow notifications for this site to use this.') : 'Show a notification for new messages when you are not looking at the chat.'"
        @update:model-value="toggleNotify"
      />
      <Toggle :model-value="soundEnabled" label="Sound" description="Play a short sound for new messages." @update:model-value="setSound" />
    </div>
  </SettingsSection>
</template>
