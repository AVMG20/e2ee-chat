<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ value: string; label?: string; tone?: 'default' | 'danger'; compact?: boolean }>()
const chunks = computed(() => props.value.trim().split(/\s+/).filter(Boolean))
</script>

<template>
  <div class="min-w-0">
    <div v-if="label" class="eyebrow mb-2">{{ label }}</div>
    <div
      v-if="chunks.length > 1"
      class="grid gap-1.5"
      :class="'grid-cols-4'"
    >
      <span
        v-for="(c, i) in chunks" :key="i" class="fp-chunk select-all"
        :class="[compact && 'text-[0.8rem]', tone === 'danger' && 'text-destructive']"
      >{{ c }}</span>
    </div>
    <code v-else class="fp-chunk block break-all px-3 text-left select-all" :class="tone === 'danger' && 'text-destructive'">{{ value }}</code>
  </div>
</template>
