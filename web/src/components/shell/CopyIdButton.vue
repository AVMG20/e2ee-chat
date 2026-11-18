<script setup lang="ts">
import { Check, Copy } from 'lucide-vue-next'
import { chat } from '@/lib/chat'
import { useCopy } from '@/lib/ui'

/** Copies a user ID (formatted) and shows a check mark for a moment. Add `btn-icon` via class for an icon-only button. */
const props = defineProps<{ id: string; label?: string }>()
const { copied, copy } = useCopy()
</script>

<template>
  <button class="btn btn-soft btn-sm" :aria-label="label ? undefined : 'Copy ID'" :title="label ? undefined : 'Copy ID'" @click="copy(chat.formatId(props.id))">
    <Check v-if="copied" class="text-success" /><Copy v-else />
    <template v-if="label">{{ copied ? 'Copied' : label }}</template>
  </button>
</template>
