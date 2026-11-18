<script setup lang="ts">
import { computed } from 'vue'
import { hueOf, initials } from '@/lib/format'

const props = withDefaults(defineProps<{
  name: string
  size?: number
  /** undefined hides the dot. */
  online?: boolean
}>(), { size: 40, online: undefined })

const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px`, '--h': hueOf(props.name) }))
const dot = computed(() => {
  const d = Math.max(9, Math.round(props.size * 0.28))
  return { width: `${d}px`, height: `${d}px`, boxShadow: '0 0 0 2.5px var(--dot-ring, var(--sidebar))' }
})
</script>

<template>
  <div class="relative shrink-0" :style="box">
    <div
      class="hue-bg flex size-full select-none items-center justify-center rounded-full font-semibold tracking-tight"
      :style="{ fontSize: `${Math.round(size * 0.38)}px` }"
    >
      {{ initials(name) }}
    </div>
    <span
      v-if="online !== undefined"
      class="absolute right-0 bottom-0 rounded-full transition-colors"
      :class="online ? 'bg-success' : 'bg-zinc-500'"
      :style="dot"
    />
  </div>
</template>
