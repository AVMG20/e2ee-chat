<script setup lang="ts">
import { ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import EmojiGrid from './EmojiGrid.vue'
import { QUICK_EMOJI } from './emoji'

/** `quick`: shows a row of common emoji with a "+" for the full grid; otherwise the grid directly. */
const props = defineProps<{ quick?: boolean; side?: 'top' | 'bottom'; align?: 'start' | 'center' | 'end' }>()
const emit = defineEmits<{ pick: [emoji: string] }>()
const open = defineModel<boolean>('open', { default: false })
const more = ref(!props.quick)

watch(open, (o) => {
  if (o) more.value = !props.quick
})

function pick(e: string) {
  open.value = false
  emit('pick', e)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child><slot /></PopoverTrigger>
    <PopoverContent :side="side ?? 'top'" :align="align ?? 'end'" class="w-auto p-1.5" @close-auto-focus.prevent>
      <div v-if="!more" class="flex items-center gap-0.5">
        <button
          v-for="e in QUICK_EMOJI" :key="e" type="button" :aria-label="e"
          class="flex size-9 items-center justify-center rounded-md text-xl outline-none transition-transform hover:scale-110 hover:bg-hover focus-visible:shadow-[var(--glow)]"
          @click="pick(e)"
        >
          {{ e }}
        </button>
        <button type="button" class="btn btn-ghost btn-icon" title="More emoji" aria-label="More emoji" @click="more = true"><Plus /></button>
      </div>
      <div v-else class="w-[17.5rem]"><EmojiGrid @pick="pick" /></div>
    </PopoverContent>
  </Popover>
</template>
