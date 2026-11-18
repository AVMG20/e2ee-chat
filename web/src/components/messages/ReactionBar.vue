<script setup lang="ts">
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { chat } from '@/lib/chat'
import type { ChatMessage } from '@/lib/types'
import { myId, reactTo } from './state'

const props = defineProps<{ msg: ChatMessage }>()

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
  </div>
</template>
