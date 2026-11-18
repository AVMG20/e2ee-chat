<script setup lang="ts">
import { EMOJI } from './emoji'

defineEmits<{ pick: [emoji: string] }>()
</script>

<template>
  <div class="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto">
    <button
      v-for="e in EMOJI" :key="e" type="button" :aria-label="e"
      class="flex size-8 items-center justify-center rounded-md text-xl outline-none hover:bg-hover focus-visible:shadow-[var(--glow)]"
      @click="$emit('pick', e)"
    >
      {{ e }}
    </button>
  </div>
</template>
