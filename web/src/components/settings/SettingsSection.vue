<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <section class="space-y-3">
    <div>
      <div class="eyebrow">{{ title }}</div>
      <p v-if="description" class="mt-1 text-xs text-muted-foreground">{{ description }}</p>
    </div>
    <slot />
  </section>
</template>
