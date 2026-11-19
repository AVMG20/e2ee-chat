<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CornerUpLeft, Copy, Forward, Pencil, Plus, RotateCw, Star, Trash2 } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import EmojiGrid from '@/components/messages/EmojiGrid.vue'
import { QUICK_EMOJI } from '@/components/messages/emoji'
import { canDeleteMsg, canEditMsg, canForward, deleteTarget, editingId, forwardMsg, reactTo, replyTo, retry, sheetMsg, toggleStar } from '@/components/messages/state'
import { chat } from '@/lib/chat'
import { docToText } from '@/lib/render'
import { copyText } from '@/lib/ui'

/** Bottom sheet with message actions, opened by long-press on touch devices. */
const msg = computed(() => sheetMsg.value)
const open = computed({
  get: () => !!sheetMsg.value,
  set: (v) => {
    if (!v) sheetMsg.value = null
  },
})
const more = ref(false)
watch(open, (o) => o && (more.value = false))

const text = computed(() => (msg.value?.kind === 'text' ? docToText(msg.value.doc) : ''))

/** Runs an action on the open message, then closes the sheet. */
function run(fn: (m: NonNullable<typeof msg.value>) => void) {
  const m = msg.value
  sheetMsg.value = null
  if (m) fn(m)
}

const row = 'flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-[15px] outline-none hover:bg-hover focus-visible:shadow-[var(--glow)] [&_svg]:size-5 [&_svg]:text-muted-foreground'
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :show-close-button="false" aria-describedby=""
      class="top-auto bottom-0 left-0 max-w-none translate-x-0 translate-y-0 gap-1 rounded-b-none p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] data-open:slide-in-from-bottom-8 sm:max-w-none"
      @close-auto-focus.prevent
    >
      <DialogTitle class="sr-only">Message actions</DialogTitle>
      <DialogDescription class="sr-only">Actions for the selected message</DialogDescription>
      <div class="mx-auto mb-1 h-1 w-9 rounded-full bg-muted-foreground/40" />

      <div v-if="msg && more" class="mx-auto w-full max-w-sm"><EmojiGrid @pick="(e) => run((m) => reactTo(m, e))" /></div>
      <template v-else-if="msg">
        <div v-if="msg.status !== 'failed'" class="flex items-center justify-between gap-0.5 px-1 pb-1">
          <button
            v-for="e in QUICK_EMOJI" :key="e" type="button" :aria-label="`React ${e}`"
            class="flex size-10 items-center justify-center rounded-full text-2xl outline-none hover:bg-hover active:scale-90"
            @click="run((m) => reactTo(m, e))"
          >
            {{ e }}
          </button>
          <button type="button" class="btn btn-soft btn-icon !size-10 !rounded-full" aria-label="More emoji" title="More emoji" @click="more = true"><Plus /></button>
        </div>
        <button v-if="msg.status === 'failed'" type="button" :class="row" @click="run(retry)"><RotateCw />Retry</button>
        <template v-else>
          <button type="button" :class="row" @click="run((m) => (replyTo = m))"><CornerUpLeft />Reply</button>
          <button v-if="canForward(msg)" type="button" :class="row" @click="run((m) => (forwardMsg = m))"><Forward />Forward</button>
          <button type="button" :class="row" @click="run(toggleStar)"><Star :class="chat.isStarred(msg) && 'fill-current'" />{{ chat.isStarred(msg) ? 'Unstar' : 'Star' }}</button>
        </template>
        <button v-if="text" type="button" :class="row" @click="run(() => copyText(text, 'Copied'))"><Copy />Copy text</button>
        <button v-if="canEditMsg(msg)" type="button" :class="row" @click="run((m) => (editingId = m.id))"><Pencil />Edit message</button>
        <button
          v-if="canDeleteMsg(msg)" type="button" :class="[row, 'text-destructive [&_svg]:!text-destructive']"
          @click="run((m) => (deleteTarget = m))"
        >
          <Trash2 />Delete message
        </button>
      </template>
    </DialogContent>
  </Dialog>
</template>
