<script setup lang="ts">
import { ref } from 'vue'
import AccountDialog from '@/components/AccountDialog.vue'
import ChangePasswordDialog from '@/components/ChangePasswordDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ConversationPane from '@/components/ConversationPane.vue'
import FriendsDialog from '@/components/FriendsDialog.vue'
import Rail from '@/components/Rail.vue'
import Sidebar from '@/components/Sidebar.vue'
import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { accountOpen, friendsOpen } from '@/lib/ui'

// On narrow screens only one of sidebar / conversation is visible.
const showConv = ref(false)
const pwOpen = ref(false)
const signOutOpen = ref(false)
const signingOut = ref(false)

async function signOut() {
  signingOut.value = true
  try {
    await chat.logout()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    signingOut.value = false
    signOutOpen.value = false
  }
}
</script>

<template>
  <div class="flex h-full w-full">
    <Rail @chats="showConv = false" />
    <Sidebar
      class="w-full md:flex md:w-60 md:shrink-0"
      :class="showConv ? 'hidden' : 'flex'"
      @selected="showConv = true"
    />
    <ConversationPane
      class="min-w-0 flex-1 md:flex"
      :class="showConv ? 'flex' : 'hidden'"
      @back="showConv = false"
    />

    <AccountDialog v-model:open="accountOpen" @change-password="pwOpen = true" @sign-out="signOutOpen = true" />
    <ChangePasswordDialog v-model:open="pwOpen" />
    <FriendsDialog v-model:open="friendsOpen" />
    <ConfirmDialog
      v-model:open="signOutOpen"
      title="Sign out?"
      description="This removes this device's local copy of your data. Your messages are stored encrypted on the server and come back when you sign in again."
      confirm-label="Sign out"
      :loading="signingOut"
      @confirm="signOut"
    />
  </div>
</template>
