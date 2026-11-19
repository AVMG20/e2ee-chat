<script setup lang="ts">
import { computed } from 'vue'
import type { Conversation } from '@/lib/types'

/**
 * Unread marker of a conversation: a red "@N" when someone mentioned me, a blue count normally,
 * and only a small dot when it is muted or set to mentions-only (nothing to be loud about).
 */
const props = defineProps<{ conv: Pick<Conversation, 'unread' | 'mentions' | 'muted' | 'mentionsOnly'> }>()

const cap = (n: number) => (n > 99 ? '99+' : String(n))
const kind = computed(() => {
  const c = props.conv
  if (c.unread <= 0) return 'none'
  if (c.mentions > 0) return 'mention'
  return c.muted || c.mentionsOnly ? 'dot' : 'count'
})
</script>

<template>
  <span v-if="kind === 'mention'" class="unread shrink-0 !bg-destructive" :title="`${conv.mentions} ${conv.mentions === 1 ? 'mention' : 'mentions'}`">@{{ cap(conv.mentions) }}</span>
  <span v-else-if="kind === 'count'" class="unread shrink-0">{{ cap(conv.unread) }}</span>
  <span v-else-if="kind === 'dot'" class="size-2 shrink-0 rounded-full bg-muted-foreground" title="New messages" />
</template>
