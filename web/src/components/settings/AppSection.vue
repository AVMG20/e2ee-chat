<script setup lang="ts">
import { ref } from 'vue'
import { Download, Loader2, RefreshCw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import SettingsSection from './SettingsSection.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { type AvailableUpdate, appVersion, checkForUpdate } from '@/lib/desktop'

const version = ref('')
const update = ref<AvailableUpdate | null>(null)
const updateBusy = ref<'' | 'check' | 'install'>('')
if (chat.isDesktop) void appVersion().then((v) => (version.value = v))
async function checkUpdates() {
  updateBusy.value = 'check'
  try {
    update.value = await checkForUpdate()
    if (!update.value) toast.success("You're on the latest version")
  } finally {
    updateBusy.value = ''
  }
}
async function installUpdate() {
  if (!update.value) return
  updateBusy.value = 'install'
  try {
    await update.value.install()
  } catch (e) {
    toast.error(`Update failed: ${errMsg(e)}`)
    updateBusy.value = ''
  }
}
</script>

<template>
  <SettingsSection title="App">
    <div class="well flex flex-wrap items-center gap-3 rounded-md p-3 text-sm">
      <span class="min-w-0 flex-1">
        E2EE Chat {{ version }}
        <span v-if="update" class="block text-xs text-muted-foreground">Version {{ update.version }} is available.</span>
        <span v-else class="block text-xs text-muted-foreground">Updates are checked each time the app starts.</span>
      </span>
      <button v-if="update" class="btn btn-primary btn-sm" aria-label="Update and restart" title="Update and restart" :disabled="!!updateBusy" @click="installUpdate">
        <Loader2 v-if="updateBusy === 'install'" class="animate-spin" /><Download v-else />Update and restart
      </button>
      <button v-else class="btn btn-soft btn-sm" aria-label="Check for updates" title="Check for updates" :disabled="!!updateBusy" @click="checkUpdates">
        <Loader2 v-if="updateBusy === 'check'" class="animate-spin" /><RefreshCw v-else />Check for updates
      </button>
    </div>
  </SettingsSection>
</template>
