<script setup lang="ts">
import { ref } from 'vue'
import { Download, Loader2, RefreshCw, Upload } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import Toggle from '@/components/shell/Toggle.vue'
import RotateKeysDialog from '@/components/RotateKeysDialog.vue'
import DevicesList from './DevicesList.vue'
import SettingsSection from './SettingsSection.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'

const rotateOpen = ref(false)
const backupBusy = ref<'' | 'export' | 'import'>('')
const backupPicker = ref<HTMLInputElement | null>(null)

async function exportBackup() {
  backupBusy.value = 'export'
  try {
    const { blob, name } = await chat.exportBackup()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    backupBusy.value = ''
  }
}

async function importBackup(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  backupBusy.value = 'import'
  try {
    const r = await chat.importBackup(file)
    if (r.messages || r.files || r.conversations) toast.success(`Restored ${r.messages} messages in ${r.conversations} chats (${r.files} files)`)
    else toast('Nothing new in this backup')
  } catch (err) {
    toast.error(errMsg(err))
  } finally {
    backupBusy.value = ''
  }
}

async function setReceipts(on: boolean) {
  try {
    await chat.setReadReceipts(on)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
</script>

<template>
  <div class="space-y-8">
    <SettingsSection title="Your security code" description="Friends can compare this with the code they see for you.">
      <div class="well rounded-md p-3">
        <p class="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[13px] tracking-wide sm:grid-cols-4"><span v-for="(g, i) in (chat.state.account?.fingerprint ?? '').split(' ')" :key="i">{{ g }}</span></p>
      </div>
      <button class="btn btn-soft btn-sm" aria-label="Change security keys" title="Change security keys" @click="rotateOpen = true"><RefreshCw />Change security keys</button>
    </SettingsSection>

    <SettingsSection title="Privacy">
      <Toggle
        :model-value="chat.state.settings.readReceipts" label="Read receipts"
        description="Let others see when you've read their messages."
        @update:model-value="setReceipts"
      />
    </SettingsSection>

    <SettingsSection title="Devices" description="See where you are signed in and sign out devices you no longer use. A device you sign out deletes its local copy of your chats.">
      <DevicesList />
    </SettingsSection>

    <SettingsSection title="Backup" description="The backup holds all chats and files on this device. It is encrypted and only your account can open it.">
      <div class="grid gap-2 sm:grid-cols-2">
        <button class="btn btn-soft" aria-label="Export backup" :disabled="!!backupBusy" @click="exportBackup">
          <Loader2 v-if="backupBusy === 'export'" class="animate-spin" /><Download v-else />{{ backupBusy === 'export' ? 'Exporting…' : 'Export backup' }}
        </button>
        <button class="btn btn-soft" aria-label="Import backup" :disabled="!!backupBusy" @click="backupPicker?.click()">
          <Loader2 v-if="backupBusy === 'import'" class="animate-spin" /><Upload v-else />{{ backupBusy === 'import' ? 'Importing…' : 'Import backup' }}
        </button>
      </div>
      <input ref="backupPicker" type="file" class="hidden" @change="importBackup">
    </SettingsSection>

    <RotateKeysDialog v-model:open="rotateOpen" />
  </div>
</template>
