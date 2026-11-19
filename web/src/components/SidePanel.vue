<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { sidePanel } from '@/lib/ui'

/** Right-hand panel shell: header with title and close button, scrolling body in the default slot. */
defineProps<{ title: string }>()
</script>

<template>
  <aside
    :aria-label="title"
    class="absolute inset-y-0 right-0 z-20 flex w-full min-w-0 flex-col border-l border-line bg-sidebar shadow-xl sm:w-80 lg:static lg:z-auto lg:shrink-0 lg:shadow-none"
  >
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 shadow-sm">
      <h2 class="min-w-0 flex-1 truncate text-[15px] font-bold">{{ title }}</h2>
      <button class="btn btn-ghost btn-icon btn-sm" title="Close panel (Esc)" aria-label="Close panel" @click="sidePanel = null"><X /></button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3"><slot /></div>
  </aside>
</template>
