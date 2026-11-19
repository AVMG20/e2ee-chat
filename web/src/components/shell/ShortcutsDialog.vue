<script setup lang="ts">
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { isMac } from '@/lib/ui'

const open = defineModel<boolean>('open', { required: true })

const mod = isMac ? '⌘' : 'Ctrl'
const alt = isMac ? '⌥' : 'Alt'
const shift = isMac ? '⇧' : 'Shift'

const groups: { title: string; items: { keys: string[]; what: string }[] }[] = [
  {
    title: 'Navigate',
    items: [
      { keys: [mod, 'K'], what: 'Quick switcher' },
      { keys: [alt, '↑'], what: 'Previous conversation' },
      { keys: [alt, '↓'], what: 'Next conversation' },
      { keys: [alt, shift, '↑'], what: 'Previous conversation with unread messages' },
      { keys: [alt, shift, '↓'], what: 'Next conversation with unread messages' },
      { keys: [mod, 'F'], what: 'Search this chat' },
      { keys: [mod, ','], what: 'Settings' },
    ],
  },
  {
    title: 'Messages',
    items: [
      { keys: ['Enter'], what: 'Send' },
      { keys: [shift, 'Enter'], what: 'New line' },
      { keys: ['↑'], what: 'Edit your last message (empty message box)' },
      { keys: ['Esc'], what: 'Jump to the latest message' },
      { keys: ['Page Up'], what: 'Scroll up' },
      { keys: ['Page Down'], what: 'Scroll down' },
    ],
  },
  { title: 'Help', items: [{ keys: [mod, '/'], what: 'This list' }] },
]
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>Faster ways around the app.</DialogDescription>
      </DialogHeader>
      <div class="max-h-[60dvh] space-y-5 overflow-y-auto pr-1">
        <section v-for="g in groups" :key="g.title">
          <h3 class="eyebrow mb-1.5">{{ g.title }}</h3>
          <ul class="space-y-1">
            <li v-for="i in g.items" :key="i.what" class="flex items-center justify-between gap-3 text-sm">
              <span>{{ i.what }}</span>
              <span class="flex shrink-0 gap-1">
                <kbd v-for="k in i.keys" :key="k" class="rounded bg-soft px-1.5 py-0.5 font-sans text-xs font-semibold">{{ k }}</kbd>
              </span>
            </li>
          </ul>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
