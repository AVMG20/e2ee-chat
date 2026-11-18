<script setup lang="ts">
defineProps<{ label: string; description?: string; disabled?: boolean }>()
const on = defineModel<boolean>({ required: true })
</script>

<template>
  <div class="flex items-center gap-3">
    <div class="min-w-0 flex-1 leading-snug">
      <div class="text-sm font-medium">{{ label }}</div>
      <div v-if="description" class="text-xs text-muted-foreground">{{ description }}</div>
    </div>
    <button
      type="button" role="switch" :aria-checked="on" :aria-label="label" :disabled="disabled"
      class="relative h-6 w-10 shrink-0 rounded-full outline-none transition-colors focus-visible:shadow-[var(--glow)] disabled:opacity-45"
      :class="on ? 'bg-primary' : 'bg-active'"
      @click="on = !on"
    >
      <span class="absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform" :class="on && 'translate-x-4'" />
    </button>
  </div>
</template>
