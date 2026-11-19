<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Toaster } from '@/components/ui/sonner'
import LoginScreen from '@/components/LoginScreen.vue'
import ChatLayout from '@/components/ChatLayout.vue'
import { chat } from '@/lib/chat'

const booting = ref(true)

// Toasts sit bottom-right on wide screens; on phones bottom-centre, above the composer.
const wideMedia = window.matchMedia('(min-width: 768px)')
const wide = ref(wideMedia.matches)
const onWide = () => (wide.value = wideMedia.matches)
wideMedia.addEventListener('change', onWide)
onBeforeUnmount(() => wideMedia.removeEventListener('change', onWide))

onMounted(async () => {
  try {
    await chat.restore()
  } catch {
    /* fall through to the login screen */
  } finally {
    booting.value = false
  }
})

watch(
  () => chat.state.error,
  (e) => {
    if (e) {
      toast.error(e)
      chat.state.error = null
    }
  },
)
</script>

<template>
  <div class="h-dvh w-full bg-background text-foreground">
    <div v-if="booting" class="app-bg flex h-full flex-col items-center justify-center gap-4">
      <img src="/favicon.svg" alt="" class="size-16 animate-pulse rounded-[1.2rem] shadow-[var(--shadow-lg)]">
      <p class="text-sm text-muted-foreground">Loading…</p>
    </div>
    <ChatLayout v-else-if="chat.state.account" />
    <LoginScreen v-else />
  </div>
  <Toaster :position="wide ? 'bottom-right' : 'bottom-center'" :offset="wide ? 24 : 80" />
</template>
