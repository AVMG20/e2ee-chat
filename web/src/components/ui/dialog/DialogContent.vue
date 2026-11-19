<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from 'reka-ui'

import type { HTMLAttributes } from 'vue'
import { XIcon } from '@lucide/vue'
import { reactiveOmit } from '@vueuse/core'
import { cn } from '@/lib/utils'
import {
  DialogClose,
  DialogContent,
  DialogPortal,
  useForwardPropsEmits,
} from 'reka-ui'
import DialogOverlay from './DialogOverlay.vue'

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<DialogContentProps & { class?: HTMLAttributes['class'], showCloseButton?: boolean }>(), {
  showCloseButton: true,
})
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, 'class')

const forwarded = useForwardPropsEmits(delegatedProps, emits)

/** Clicking a toast (e.g. its "Update" button) mustn't close the dialog. */
function keepOpenForToasts(event: CustomEvent<{ originalEvent: Event }>) {
  const target = event.detail.originalEvent.target
  if (target instanceof Element && target.closest('[data-sonner-toaster]')) event.preventDefault()
}
</script>

<template>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent
      data-slot="dialog-content"
      v-bind="{ ...$attrs, ...forwarded }"
      @interact-outside="keepOpenForToasts"
      :class="cn('dialog data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 grid max-h-[calc(100dvh-2rem)] max-w-[calc(100%-1.5rem)] gap-5 overflow-y-auto rounded-lg p-6 text-sm duration-200 sm:max-w-md fixed top-1/2 left-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2 outline-none', props.class)"
    >
      <slot />

      <DialogClose
        v-if="showCloseButton"
        data-slot="dialog-close"
        as-child
      >
        <button class="btn btn-ghost btn-icon btn-sm absolute top-4 right-4"><XIcon /><span class="sr-only">Close</span></button>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
