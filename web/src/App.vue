<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Toaster } from '@/components/ui/sonner'
import LoginScreen from '@/components/LoginScreen.vue'
import ChatLayout from '@/components/ChatLayout.vue'
import { chat } from '@/lib/chat'
import { initTheme } from '@/lib/theme'

onMounted(initTheme)

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
    <ChatLayout v-if="chat.state.account" />
    <LoginScreen v-else />
  </div>
  <Toaster position="top-center" />
</template>
