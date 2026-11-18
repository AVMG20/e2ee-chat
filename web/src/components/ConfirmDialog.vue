<script setup lang="ts">
import { Loader2, TriangleAlert } from 'lucide-vue-next'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

defineProps<{ title: string; description: string; confirmLabel: string; loading?: boolean }>()
const open = defineModel<boolean>('open', { required: true })
defineEmits<{ confirm: [] }>()
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <div class="mb-2 flex size-11 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <TriangleAlert class="size-5" />
        </div>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <button class="btn btn-soft" @click="open = false">Cancel</button>
        <button class="btn btn-danger" :disabled="loading" @click="$emit('confirm')">
          <Loader2 v-if="loading" class="animate-spin" />{{ confirmLabel }}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
