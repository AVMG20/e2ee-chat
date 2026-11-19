<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Laptop, Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { chat } from '@/lib/chat'
import { errMsg, relTime } from '@/lib/format'
import type { Device } from '@/lib/types'

const devices = ref<Device[]>([])
const loading = ref(false)
const failed = ref(false)
const target = ref<Device | null>(null)
const confirmOpen = ref(false)
const signingOut = ref(false)

async function load() {
  loading.value = true
  failed.value = false
  try {
    devices.value = await chat.listDevices()
  } catch (e) {
    failed.value = true
    toast.error(errMsg(e))
  } finally {
    loading.value = false
  }
}
onMounted(load)

function ask(d: Device) {
  target.value = d
  confirmOpen.value = true
}

async function signOut() {
  if (!target.value) return
  signingOut.value = true
  try {
    await chat.signOutDevice(target.value.id)
    confirmOpen.value = false
    toast.success('Device signed out')
    await load()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    signingOut.value = false
  }
}

function activity(d: Device) {
  if (d.current || d.online) return 'Active now'
  return `Active ${relTime(d.lastUsed)}`
}
</script>

<template>
  <div>
    <div v-if="loading && !devices.length" class="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 class="size-4 animate-spin" />Loading…</div>
    <div v-else-if="failed" class="space-y-3 py-4 text-center text-sm text-muted-foreground">
      <p>Couldn't load your devices.</p>
      <button class="btn btn-soft" aria-label="Try again" @click="load">Try again</button>
    </div>
    <ul v-else class="space-y-2">
      <li v-for="d in devices" :key="d.id" class="well flex items-center gap-3 rounded-lg p-3">
        <Laptop class="size-5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span class="truncate text-sm font-semibold">{{ d.name || 'Unknown device' }}</span>
            <span v-if="d.current" class="rounded-full bg-primary/15 px-2 py-0.5 text-[0.6875rem] font-semibold text-[var(--link)]">This device</span>
          </div>
          <div class="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span class="size-2 rounded-full" :class="d.online ? 'bg-green-500' : 'bg-muted-foreground/40'" :title="d.online ? 'Online' : 'Offline'" />
            {{ activity(d) }}
          </div>
        </div>
        <button v-if="!d.current" class="btn btn-danger btn-sm" :aria-label="`Sign out ${d.name || 'Unknown device'}`" :title="`Sign out ${d.name || 'Unknown device'}`" @click="ask(d)">Sign out</button>
      </li>
    </ul>

    <ConfirmDialog
      v-model:open="confirmOpen" title="Sign out this device?"
      :description="`${target?.name || 'This device'} will be signed out and delete its local copy of your chats. Your chats stay safe on your other devices.`"
      confirm-label="Sign out" :loading="signingOut" @confirm="signOut"
    />
  </div>
</template>
