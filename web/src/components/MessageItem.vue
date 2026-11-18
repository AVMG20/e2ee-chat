<script setup lang="ts">
import { computed } from 'vue'
import { Clock } from 'lucide-vue-next'
import FileMessage from '@/components/FileMessage.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { formatClock, hueOf } from '@/lib/format'
import { renderMessageHtml } from '@/lib/render'
import type { ChatMessage } from '@/lib/types'

const props = defineProps<{
  msg: ChatMessage
  /** First message of a run from the same sender (shows avatar + name). */
  head: boolean
  animate: boolean
}>()

const name = computed(() => (props.msg.from === chat.state.account?.id ? chat.state.account.username : chat.displayName(props.msg.from)))
const html = computed(() => (props.msg.kind === 'text' ? renderMessageHtml(props.msg.doc) : ''))
const time = computed(() => formatClock(props.msg.ts))
</script>

<template>
  <div v-if="msg.kind === 'system'" class="my-2 px-4 text-center text-xs text-muted-foreground">{{ msg.text }}</div>

  <div
    v-else
    class="msg-row group relative flex gap-4 px-4 py-0.5 pr-6"
    :class="[head ? 'mt-4' : '', animate && 'msg-in']"
  >
    <div class="w-10 shrink-0 pt-0.5">
      <UserAvatar v-if="head" :name="name" :id="msg.from" :size="40" />
      <span v-else class="hidden pt-1 text-right text-[10px] text-muted-foreground group-hover:block">{{ time }}</span>
    </div>

    <div class="min-w-0 flex-1">
      <div v-if="head" class="flex items-baseline gap-2 leading-snug">
        <span class="hue-text text-[15px] font-semibold" :style="{ '--h': hueOf(msg.from) }">{{ name }}</span>
        <span class="text-[11px] text-muted-foreground">{{ time }}</span>
        <Clock v-if="msg.status === 'sending'" class="size-3 text-muted-foreground" aria-label="Sending" />
      </div>
      <div v-if="msg.kind === 'text'" class="prose-like text-[15px] text-foreground/90" v-html="html" />
      <FileMessage v-else-if="msg.kind === 'file' && msg.file" :msg="msg" />
      <div v-if="msg.status === 'failed'" class="mt-0.5 text-xs font-medium text-destructive">Failed to send</div>
      <Clock v-if="msg.status === 'sending' && !head" class="mt-0.5 size-3 text-muted-foreground" aria-label="Sending" />
    </div>
  </div>
</template>
