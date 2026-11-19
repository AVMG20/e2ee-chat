<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { chat } from '@/lib/chat'
import { hueOf, initials } from '@/lib/format'

const props = withDefaults(defineProps<{
  name: string
  /** Stable user/group ID; the colour hash comes from this (falls back to the name). */
  id?: string
  size?: number
  /** undefined hides the dot. */
  online?: boolean
  /** Profile picture URL; initials are shown when missing or broken. */
  src?: string | null
}>(), { id: undefined, size: 40, online: undefined, src: null })

const broken = ref(false)

/** Online dots show the status: green online, yellow away, red do not disturb, grey offline/invisible. */
const dotClass = computed(() => {
  if (!props.online) return 'bg-zinc-500'
  const st = props.id && props.id === chat.state.account?.id ? chat.state.account.status : props.id ? chat.state.contacts[props.id]?.status : 'online'
  return st === 'away' ? 'bg-amber-400' : st === 'dnd' ? 'bg-destructive' : st === 'invisible' || st === 'offline' ? 'bg-zinc-500' : 'bg-success'
})
watch(() => props.src, () => (broken.value = false))

const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px`, '--h': hueOf(props.id ?? props.name) }))
const dot = computed(() => {
  const d = Math.max(9, Math.round(props.size * 0.28))
  return { width: `${d}px`, height: `${d}px`, boxShadow: '0 0 0 2.5px var(--dot-ring, var(--sidebar))' }
})
</script>

<template>
  <div class="relative shrink-0" :style="box">
    <img v-if="src && !broken" :src="src" alt="" draggable="false" class="size-full rounded-full object-cover" @error="broken = true">
    <div
      v-else
      class="hue-bg flex size-full select-none items-center justify-center rounded-full font-semibold tracking-tight"
      :style="{ fontSize: `${Math.round(size * 0.38)}px` }"
    >
      {{ initials(name) }}
    </div>
    <span
      v-if="online !== undefined"
      class="absolute right-0 bottom-0 rounded-full transition-colors"
      :class="dotClass"
      :style="dot"
    />
  </div>
</template>
