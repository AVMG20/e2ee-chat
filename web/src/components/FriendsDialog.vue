<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Copy, Loader2, UserPlus, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { copyText } from '@/lib/ui'

const open = defineModel<boolean>('open', { required: true })

const myId = computed(() => chat.formatId(chat.state.account?.id ?? ''))
const incoming = computed(() => chat.state.requests.incoming)
const outgoing = computed(() => chat.state.requests.outgoing)

const input = ref('')
const adding = ref(false)
const error = ref('')
const working = ref<string | null>(null)

watch(open, (o) => {
  if (o) {
    input.value = ''
    error.value = ''
  }
})

async function add() {
  if (!input.value.trim()) return
  adding.value = true
  error.value = ''
  try {
    await chat.sendFriendRequest(input.value)
    input.value = ''
    toast.success('Friend request sent')
  } catch (e) {
    error.value = errMsg(e)
  } finally {
    adding.value = false
  }
}

async function act(key: string, fn: () => Promise<void>) {
  working.value = key
  try {
    await fn()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    working.value = null
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <div class="mb-2 flex size-11 items-center justify-center rounded-lg text-white [background:var(--grad)]"><UserPlus class="size-5" /></div>
        <DialogTitle>Friends</DialogTitle>
        <DialogDescription>Share your ID so friends can find you, or add a friend by their ID.</DialogDescription>
      </DialogHeader>

      <div class="well flex items-center gap-3 rounded-lg p-3.5">
        <div class="min-w-0 flex-1">
          <div class="eyebrow mb-1">Your ID</div>
          <div class="font-mono text-2xl font-semibold tracking-[0.12em] select-all">{{ myId }}</div>
        </div>
        <button class="btn btn-soft btn-sm" @click="copyText(myId, 'ID copied')"><Copy />Copy</button>
      </div>

      <form @submit.prevent="add">
        <label class="label" for="friend-id">Add a friend</label>
        <div class="flex gap-2">
          <input id="friend-id" v-model="input" class="field font-mono !tracking-widest uppercase placeholder:normal-case placeholder:tracking-normal" placeholder="Friend's ID, e.g. 7K3Q-X9PA" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <button type="submit" class="btn btn-primary shrink-0" :disabled="adding || !input.trim()">
            <Loader2 v-if="adding" class="animate-spin" /><template v-else>Add</template>
          </button>
        </div>
        <p v-if="error" class="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{{ error }}</p>
      </form>

      <section v-if="incoming.length">
        <div class="eyebrow mb-2">Requests <span class="text-primary">· {{ incoming.length }}</span></div>
        <ul class="well max-h-48 space-y-0.5 overflow-y-auto rounded-lg p-1.5">
          <li v-for="r in incoming" :key="r.id" class="flex items-center gap-3 rounded-md px-2 py-1.5" style="--dot-ring: var(--card)">
            <UserAvatar :name="r.name" :id="r.id" :size="36" />
            <div class="min-w-0 flex-1 leading-tight">
              <div class="truncate text-sm font-semibold">{{ r.name }}</div>
              <div class="font-mono text-[11px] text-muted-foreground">{{ chat.formatId(r.id) }}</div>
            </div>
            <button class="btn btn-ghost btn-icon btn-sm hover:!text-destructive" title="Decline" aria-label="Decline" :disabled="working === 'd' + r.id" @click="act('d' + r.id, () => chat.declineFriend(r.id))"><X /></button>
            <button class="btn btn-primary btn-sm" :disabled="working === 'a' + r.id" @click="act('a' + r.id, () => chat.acceptFriend(r.id))">
              <Loader2 v-if="working === 'a' + r.id" class="animate-spin" /><Check v-else />Accept
            </button>
          </li>
        </ul>
      </section>

      <section v-if="outgoing.length">
        <div class="eyebrow mb-2">Sent requests</div>
        <ul class="well max-h-40 space-y-0.5 overflow-y-auto rounded-lg p-1.5">
          <li v-for="r in outgoing" :key="r.id" class="flex items-center gap-3 rounded-md px-2 py-1.5" style="--dot-ring: var(--card)">
            <UserAvatar :name="r.name" :id="r.id" :size="32" />
            <div class="min-w-0 flex-1 leading-tight">
              <div class="truncate text-sm font-medium">{{ r.name }}</div>
              <div class="text-[11px] text-muted-foreground">Pending · <span class="font-mono">{{ chat.formatId(r.id) }}</span></div>
            </div>
            <button class="btn btn-soft btn-sm" :disabled="working === 'c' + r.id" @click="act('c' + r.id, () => chat.declineFriend(r.id))">Cancel</button>
          </li>
        </ul>
      </section>
    </DialogContent>
  </Dialog>
</template>
