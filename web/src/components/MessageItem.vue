<script setup lang="ts">
import { computed } from 'vue'
import { Clock } from 'lucide-vue-next'
import FileMessage from '@/components/FileMessage.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { formatTime, hueOf } from '@/lib/format'
import { renderMessageHtml } from '@/lib/render'
import type { ChatMessage } from '@/lib/types'

const props = defineProps<{
  msg: ChatMessage
  /** First of a run of consecutive messages from the same sender. */
  head: boolean
  /** Last of a run. */
  tail: boolean
  /** Show avatar + name for others (group chats). */
  showSender: boolean
  animate: boolean
}>()

const mine = computed(() => props.msg.from === chat.state.account?.name)
const html = computed(() => (props.msg.kind === 'text' ? renderMessageHtml(props.msg.doc) : ''))
const isImage = computed(() => props.msg.kind === 'file' && !!props.msg.file?.mime.startsWith('image/'))
const time = computed(() => formatTime(props.msg.ts))

const bubbleClass = computed(() => {
  const m = mine.value
  return [
    m ? 'bubble-me' : 'bubble-them',
    !props.head && (m ? 'rounded-tr-[0.45rem]' : 'rounded-tl-[0.45rem]'),
    props.tail ? (m ? 'rounded-br-[0.25rem]' : 'rounded-bl-[0.25rem]') : (m ? 'rounded-br-[0.45rem]' : 'rounded-bl-[0.45rem]'),
  ]
})
</script>

<template>
  <div v-if="msg.kind === 'system'" class="my-3 flex justify-center">
    <span class="rounded-full bg-inset px-3.5 py-1 text-xs text-muted-foreground shadow-[inset_0_0_0_1px_var(--line)]">{{ msg.text }}</span>
  </div>

  <div
    v-else
    class="group flex items-end gap-2"
    :class="[mine ? 'justify-end' : 'justify-start', head ? 'mt-3.5' : 'mt-[3px]', animate && ['msg-in', mine ? 'msg-in-me' : 'msg-in-them']]"
  >
    <div v-if="showSender && !mine" class="w-8 shrink-0">
      <UserAvatar v-if="tail" :name="msg.from" :size="32" />
    </div>

    <div class="flex min-w-0 max-w-[84%] flex-col sm:max-w-[70%]" :class="mine ? 'items-end' : 'items-start'">
      <div
        v-if="head && showSender && !mine"
        class="hue-text mb-1 px-3 text-xs font-semibold tracking-tight"
        :style="{ '--h': hueOf(msg.from) }"
      >{{ msg.from }}</div>

      <FileMessage v-if="isImage" :msg="msg" :mine="mine" :time="time" :sending="msg.status === 'sending'" />
      <div v-else class="bubble" :class="bubbleClass">
        <div v-if="msg.kind === 'text'" class="prose-like" v-html="html" />
        <FileMessage v-else-if="msg.kind === 'file' && msg.file" :msg="msg" :mine="mine" :time="time" :sending="false" />
        <div class="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] tabular-nums opacity-60 transition-opacity group-hover:opacity-100">
          <Clock v-if="msg.status === 'sending'" class="size-3" aria-label="Sending" />
          {{ time }}
        </div>
      </div>

      <div v-if="msg.status === 'failed'" class="mt-1 px-1 text-xs font-medium text-destructive">Failed to send</div>
    </div>
  </div>
</template>
