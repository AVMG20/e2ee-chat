<script setup lang="ts">
import { ref } from 'vue'
import Sidebar from '@/components/Sidebar.vue'
import ConversationPane from '@/components/ConversationPane.vue'

// On narrow screens only one of sidebar / conversation is visible.
const showConv = ref(false)
</script>

<template>
  <div class="flex h-full w-full">
    <Sidebar
      class="w-full md:flex md:w-[21rem] md:shrink-0 xl:w-[23rem]"
      :class="showConv ? 'hidden' : 'flex'"
      @selected="showConv = true"
    />
    <ConversationPane
      class="min-w-0 flex-1 md:flex"
      :class="showConv ? 'flex' : 'hidden'"
      @back="showConv = false"
    />
  </div>
</template>
