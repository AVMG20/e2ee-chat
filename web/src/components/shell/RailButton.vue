<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

defineOptions({ inheritAttrs: false })
defineProps<{ label: string; active?: boolean; href?: string }>()
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <component
        v-bind="$attrs"
        :is="href ? 'a' : 'button'" :href="href" :target="href ? '_blank' : undefined" :rel="href ? 'noopener noreferrer' : undefined"
        :aria-label="label" :aria-current="active || undefined"
        class="group relative flex size-10 items-center justify-center rounded-[0.9rem] outline-none transition-all hover:rounded-lg focus-visible:shadow-[var(--glow)]"
        :class="active ? 'rounded-lg bg-primary text-white' : 'text-muted-foreground hover:bg-active hover:text-foreground'"
      >
        <span
          class="absolute top-1/2 -left-2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all"
          :class="active ? 'h-5' : 'h-0 group-hover:h-2.5'"
        />
        <slot />
        <slot name="badge" />
      </component>
    </TooltipTrigger>
    <TooltipContent side="right" :side-offset="10">{{ label }}</TooltipContent>
  </Tooltip>
</template>
