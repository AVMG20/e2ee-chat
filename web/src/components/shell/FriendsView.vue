<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, Check, Loader2, MessageSquare, MoreHorizontal, Search, TriangleAlert, UserPlus, Users, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import UserAvatar from '@/components/UserAvatar.vue'
import CopyIdButton from '@/components/shell/CopyIdButton.vue'
import EntryMenu from '@/components/shell/EntryMenu.vue'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { friendsTab as tab, openDm, showChats, type FriendsTab } from '@/lib/nav'
import type { Contact } from '@/lib/types'

const incoming = computed(() => chat.state.requests.incoming)
const outgoing = computed(() => chat.state.requests.outgoing)
const pendingCount = computed(() => incoming.value.length)
const friends = computed(() =>
  Object.values(chat.state.contacts).filter((c) => c.friend).sort((a, b) => a.name.localeCompare(b.name)),
)
const onlineFriends = computed(() => friends.value.filter((c) => c.online))

const filter = ref('')
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const base = tab.value === 'online' ? onlineFriends.value : friends.value
  return q ? base.filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q.replace(/-/g, ''))) : base
})

const tabs = computed<{ key: FriendsTab; label: string; count?: number }[]>(() => [
  { key: 'online', label: 'Online' },
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending', count: pendingCount.value },
])

const myId = computed(() => chat.state.account?.id ?? '')
const input = ref('')
const adding = ref(false)
const addError = ref('')
const working = ref<string | null>(null)

watch(tab, () => {
  filter.value = ''
  addError.value = ''
})

async function add() {
  if (!input.value.trim()) return
  adding.value = true
  addError.value = ''
  try {
    await chat.sendFriendRequest(input.value)
    input.value = ''
    toast.success('Friend request sent')
  } catch (e) {
    addError.value = errMsg(e)
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

async function message(c: Contact) {
  try {
    await openDm(c.id)
  } catch (e) {
    toast.error(errMsg(e))
  }
}

/** The "…" button opens the same menu as a right-click on the row. */
function openMenu(e: MouseEvent) {
  const btn = e.currentTarget as HTMLElement
  const r = btn.getBoundingClientRect()
  btn.closest('[data-friend-row]')?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }),
  )
}
</script>

<template>
  <main class="relative min-w-0 flex-col overflow-hidden bg-background">
    <header class="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 shadow-sm">
      <button class="btn btn-ghost btn-icon btn-sm md:hidden" aria-label="Back to chats" @click="showChats"><ArrowLeft /></button>
      <div class="flex items-center gap-2 font-semibold"><Users class="size-5 text-muted-foreground" />Friends</div>
      <div class="mx-1 hidden h-5 w-px bg-line sm:block" />
      <div class="flex items-center gap-1" role="tablist">
        <button
          v-for="t in tabs" :key="t.key" role="tab" :aria-selected="tab === t.key"
          class="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium outline-none transition-colors focus-visible:shadow-[var(--glow)]"
          :class="tab === t.key ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'"
          @click="tab = t.key"
        >
          {{ t.label }}<span v-if="t.count" class="unread !bg-destructive">{{ t.count }}</span>
        </button>
        <button
          role="tab" :aria-selected="tab === 'add'"
          class="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium outline-none transition-colors focus-visible:shadow-[var(--glow)]"
          :class="tab === 'add' ? 'bg-primary/20 text-[var(--link)]' : 'bg-primary text-white hover:brightness-110'"
          @click="tab = 'add'"
        >Add friend</button>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl p-3 sm:p-5">
        <!-- Online / All -->
        <template v-if="tab === 'online' || tab === 'all'">
          <div v-if="friends.length" class="field-icon mb-4">
            <Search />
            <input v-model="filter" class="field" placeholder="Search friends" aria-label="Search friends" autocomplete="off">
          </div>
          <div v-if="shown.length" class="eyebrow mb-2 px-2">{{ tab === 'online' ? 'Online' : 'All friends' }} · {{ shown.length }}</div>
          <ul class="space-y-px">
            <li v-for="c in shown" :key="c.id">
              <EntryMenu kind="dm" :id="c.id" open-label="Message">
                <div
                  data-friend-row class="row group/row flex items-center gap-3 rounded-md px-2 py-2 text-foreground"
                  style="--dot-ring: var(--background)"
                >
                  <UserAvatar :name="c.name" :id="c.id" :size="36" :online="c.online" />
                  <div class="min-w-0 flex-1 leading-tight">
                    <div class="flex items-center gap-1.5">
                      <span class="truncate text-[15px] font-semibold">{{ c.name }}</span>
                      <TriangleAlert v-if="c.keyChanged" class="size-4 shrink-0 text-destructive" aria-label="Security key changed" />
                    </div>
                    <div class="truncate text-xs text-muted-foreground">
                      {{ c.online ? 'Online' : 'Offline' }} · <span class="font-mono">{{ chat.formatId(c.id) }}</span>
                    </div>
                  </div>
                  <button class="btn btn-soft btn-sm" @click="message(c)"><MessageSquare /><span class="hidden sm:inline">Message</span></button>
                  <button class="btn btn-ghost btn-icon btn-sm" aria-label="More actions" title="More" @click="openMenu"><MoreHorizontal /></button>
                </div>
              </EntryMenu>
            </li>
          </ul>
          <div v-if="!shown.length" class="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <div class="flex size-16 items-center justify-center rounded-full bg-card text-muted-foreground"><Users class="size-7" /></div>
            <p class="max-w-xs text-sm text-muted-foreground">
              <template v-if="filter">No friends match "{{ filter }}".</template>
              <template v-else-if="!friends.length">No friends yet. Share your ID or add a friend by theirs.</template>
              <template v-else>Nobody is online right now.</template>
            </p>
            <button v-if="!friends.length" class="btn btn-primary" @click="tab = 'add'"><UserPlus />Add a friend</button>
          </div>
        </template>

        <!-- Pending -->
        <template v-else-if="tab === 'pending'">
          <section v-if="incoming.length" class="mb-6">
            <div class="eyebrow mb-2 px-2">Incoming · {{ incoming.length }}</div>
            <ul class="space-y-px">
              <li v-for="r in incoming" :key="r.id" class="row flex items-center gap-3 rounded-md px-2 py-2 text-foreground">
                <UserAvatar :name="r.name" :id="r.id" :size="36" />
                <div class="min-w-0 flex-1 leading-tight">
                  <div class="truncate text-[15px] font-semibold">{{ r.name }}</div>
                  <div class="truncate font-mono text-xs text-muted-foreground">{{ chat.formatId(r.id) }}</div>
                </div>
                <button class="btn btn-ghost btn-icon btn-sm hover:!text-destructive" title="Decline" aria-label="Decline" :disabled="working === 'd' + r.id" @click="act('d' + r.id, () => chat.declineFriend(r.id))"><X /></button>
                <button class="btn btn-primary btn-sm" :disabled="working === 'a' + r.id" @click="act('a' + r.id, () => chat.acceptFriend(r.id))">
                  <Loader2 v-if="working === 'a' + r.id" class="animate-spin" /><Check v-else />Accept
                </button>
              </li>
            </ul>
          </section>
          <section v-if="outgoing.length">
            <div class="eyebrow mb-2 px-2">Sent · {{ outgoing.length }}</div>
            <ul class="space-y-px">
              <li v-for="r in outgoing" :key="r.id" class="row flex items-center gap-3 rounded-md px-2 py-2 text-foreground">
                <UserAvatar :name="r.name" :id="r.id" :size="36" />
                <div class="min-w-0 flex-1 leading-tight">
                  <div class="truncate text-[15px] font-semibold">{{ r.name }}</div>
                  <div class="truncate text-xs text-muted-foreground">Waiting for them · <span class="font-mono">{{ chat.formatId(r.id) }}</span></div>
                </div>
                <button class="btn btn-soft btn-sm" :disabled="working === 'c' + r.id" @click="act('c' + r.id, () => chat.declineFriend(r.id))">Cancel</button>
              </li>
            </ul>
          </section>
          <div v-if="!incoming.length && !outgoing.length" class="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <div class="flex size-16 items-center justify-center rounded-full bg-card text-muted-foreground"><UserPlus class="size-7" /></div>
            <p class="text-sm text-muted-foreground">No pending friend requests.</p>
          </div>
        </template>

        <!-- Add friend -->
        <template v-else>
          <h2 class="text-lg font-bold">Add a friend</h2>
          <p class="mt-1 mb-4 text-sm text-muted-foreground">Enter your friend's ID, for example 7K3Q-X9PA. Dashes and case don't matter.</p>
          <form @submit.prevent="add">
            <div class="flex gap-2">
              <input
                v-model="input" class="field font-mono !tracking-widest uppercase placeholder:normal-case placeholder:tracking-normal" aria-label="Friend's ID"
                placeholder="Friend's ID" autocomplete="off" autocapitalize="characters" spellcheck="false"
              >
              <button type="submit" class="btn btn-primary !h-10 shrink-0" :disabled="adding || !input.trim()">
                <Loader2 v-if="adding" class="animate-spin" /><template v-else>Send request</template>
              </button>
            </div>
            <p v-if="addError" class="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{{ addError }}</p>
          </form>
          <div class="well mt-6 flex flex-wrap items-center gap-3 rounded-lg p-4">
            <div class="min-w-0 flex-1">
              <div class="eyebrow mb-1">Your ID</div>
              <div class="font-mono text-2xl font-semibold tracking-[0.12em] select-all">{{ chat.formatId(myId) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">Share it so friends can add you.</div>
            </div>
            <CopyIdButton :id="myId" label="Copy ID" />
          </div>
        </template>
      </div>
    </div>
  </main>
</template>
