<script setup lang="ts">
import { computed, ref } from 'vue'
import { SmilePlus } from 'lucide-vue-next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { chat } from '@/lib/chat'
import type { ChatMessage } from '@/lib/types'
import EmojiPicker from './EmojiPicker.vue'
import { myId, reactTo, refocusComposer } from './state'

const props = defineProps<{ msg: ChatMessage }>()

const pickerOpen = ref(false)

const items = computed(() =>
  Object.entries(props.msg.reactions ?? {})
    .filter(([, ids]) => ids.length)
    .map(([emoji, ids]) => ({
      emoji,
      count: ids.length,
      mine: ids.includes(myId()),
      names: ids.map((id) => (id === myId() ? 'You' : chat.displayName(id))).join(', '),
    })),
)
</script>

<template>
  <div v-if="items.length" class="mt-1 flex flex-wrap gap-1">
    <Tooltip v-for="r in items" :key="r.emoji">
      <TooltipTrigger as-child>
        <button
          type="button" :aria-pressed="r.mine" :aria-label="`${r.emoji} ${r.count}`"
          class="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs font-semibold outline-none transition-colors focus-visible:shadow-[var(--glow)]"
          :class="r.mine ? 'bg-primary/20 text-[var(--link)] shadow-[inset_0_0_0_1px_var(--primary)]' : 'bg-soft text-muted-foreground hover:bg-active'"
          @click="reactTo(msg, r.emoji)"
        >
          <span class="text-sm leading-none">{{ r.emoji }}</span>{{ r.count }}
        </button>
      </TooltipTrigger>
      <TooltipContent>{{ r.names }} reacted with {{ r.emoji }}</TooltipContent>
    </Tooltip>
    <EmojiPicker v-model:open="pickerOpen" quick side="top" align="start" @pick="(e) => (reactTo(msg, e), refocusComposer())">
      <button
        type="button" title="Add reaction" aria-label="Add reaction"
        class="flex h-6 items-center rounded-md bg-soft px-1.5 text-muted-foreground outline-none transition-colors hover:bg-active hover:text-foreground focus-visible:shadow-[var(--glow)]"
      >
        <SmilePlus class="size-3.5" />
      </button>
    </EmojiPicker>
  </div>
</template>
