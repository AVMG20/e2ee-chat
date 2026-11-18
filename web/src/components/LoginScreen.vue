<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AtSign, Globe, KeyRound, Loader2, Lock, Moon, Sun, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { chat } from '@/lib/chat'
import { errMsg, hostOf } from '@/lib/format'
import { isDark, toggleTheme } from '@/lib/theme'
import type { Account } from '@/lib/types'

const accounts = ref<Account[]>([])
const tab = ref<'signin' | 'create'>('create')
const server = ref('')
const name = ref('')
const invite = ref('')
const creating = ref(false)
const createError = ref('')
const signingIn = ref<string | null>(null)
const loginError = ref('')
const forgetTarget = ref<Account | null>(null)
const forgetOpen = ref(false)
const forgetting = ref(false)

const keyOf = (a: Account) => `${a.name}@${a.server}`

async function refresh() {
  try {
    accounts.value = await chat.listAccounts()
    if (!accounts.value.length) tab.value = 'create'
  } catch (e) {
    toast.error(errMsg(e))
  }
}

onMounted(async () => {
  try {
    server.value = chat.defaultServer()
  } catch (e) {
    toast.error(errMsg(e))
  }
  await refresh()
  if (accounts.value.length) tab.value = 'signin'
})

async function signIn(acc: Account) {
  signingIn.value = keyOf(acc)
  loginError.value = ''
  try {
    await chat.login(acc)
  } catch (e) {
    loginError.value = errMsg(e)
  } finally {
    signingIn.value = null
  }
}

function askForget(acc: Account) {
  forgetTarget.value = acc
  forgetOpen.value = true
}

async function doForget() {
  if (!forgetTarget.value) return
  forgetting.value = true
  try {
    await chat.forgetAccount(forgetTarget.value)
    forgetOpen.value = false
    await refresh()
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    forgetting.value = false
  }
}

async function create() {
  creating.value = true
  createError.value = ''
  try {
    await chat.createAccount(server.value.trim(), name.value.trim(), invite.value.trim())
  } catch (e) {
    createError.value = errMsg(e)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="relative h-full w-full overflow-y-auto">
    <div class="aurora" aria-hidden="true"><i /><i /><i /></div>

    <button class="btn btn-soft btn-icon absolute top-4 right-4 z-10" :title="isDark ? 'Light mode' : 'Dark mode'" aria-label="Toggle theme" @click="toggleTheme">
      <Sun v-if="isDark" /><Moon v-else />
    </button>

    <div class="relative flex min-h-full items-center justify-center p-4">
      <div class="fade-up w-full max-w-[27rem] py-8">
        <div class="mb-7 flex flex-col items-center text-center">
          <div class="relative mb-5">
            <div class="absolute inset-0 scale-110 rounded-[1.6rem] opacity-70 blur-xl [background:var(--grad)]" />
            <img src="/favicon.svg" alt="" class="relative size-[4.5rem] rounded-[1.4rem] shadow-[var(--shadow-lg)] ring-1 ring-white/15">
          </div>
          <h1 class="text-[1.75rem] leading-none font-semibold tracking-tight">E2EE Chat</h1>
          <p class="mt-2.5 max-w-xs text-[15px] leading-snug text-muted-foreground">Private chat for your own server. End-to-end encrypted.</p>
        </div>

        <div class="dialog rounded-[2rem] p-5 sm:p-6">
          <!-- segmented control -->
          <div class="relative mb-5 grid grid-cols-2 rounded-2xl bg-inset p-1 shadow-[inset_0_0_0_1px_var(--line)]" role="tablist">
            <span
              class="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-xl bg-card shadow-[var(--shadow-sm),inset_0_0_0_1px_var(--line)] transition-transform duration-300 ease-out"
              :class="tab === 'create' && 'translate-x-full'"
            />
            <button
              v-for="t in ([['signin', 'Sign in'], ['create', 'Create account']] as const)" :key="t[0]"
              role="tab" :aria-selected="tab === t[0]"
              class="relative z-10 rounded-xl px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:shadow-[var(--glow)]"
              :class="tab === t[0] ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
              @click="tab = t[0]"
            >{{ t[1] }}</button>
          </div>

          <div v-if="tab === 'signin'" class="space-y-2.5">
            <p v-if="!accounts.length" class="py-8 text-center text-sm text-muted-foreground">
              No accounts saved on this device yet.<br>
              <button class="mt-1 font-semibold text-primary hover:underline" @click="tab = 'create'">Create one</button>
            </p>
            <div
              v-for="acc in accounts"
              :key="keyOf(acc)"
              class="well flex items-center gap-3 rounded-2xl p-2.5 transition-colors hover:bg-hover"
            >
              <UserAvatar :name="acc.name" :size="42" />
              <div class="min-w-0 flex-1 leading-tight">
                <div class="truncate text-[15px] font-semibold">{{ acc.name }}</div>
                <div class="mt-0.5 truncate text-xs text-muted-foreground">{{ hostOf(acc.server) }}</div>
              </div>
              <button class="btn btn-ghost btn-icon btn-sm hover:!text-destructive" title="Forget this account" aria-label="Forget this account" @click="askForget(acc)">
                <Trash2 />
              </button>
              <button class="btn btn-primary btn-sm" :disabled="signingIn !== null" @click="signIn(acc)">
                <Loader2 v-if="signingIn === keyOf(acc)" class="animate-spin" />
                Sign in
              </button>
            </div>
            <p v-if="loginError" class="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{{ loginError }}</p>
          </div>

          <form v-else class="space-y-4" @submit.prevent="create">
            <div>
              <label class="label" for="server">Server URL</label>
              <div class="field-icon">
                <Globe />
                <input id="server" v-model="server" class="field" type="url" placeholder="https://chat.example.com" required autocomplete="off">
              </div>
            </div>
            <div>
              <label class="label" for="username">Username</label>
              <div class="field-icon">
                <AtSign />
                <input
                  id="username" v-model="name" class="field" required minlength="2" maxlength="32" placeholder="yourname"
                  pattern="[a-z0-9_.\-]{2,32}" autocomplete="off" autocapitalize="off"
                >
              </div>
              <p class="mt-1.5 text-xs text-muted-foreground">Lowercase a-z 0-9 _ . - , 2-32 characters.</p>
            </div>
            <div>
              <label class="label" for="invite">Invite code</label>
              <div class="field-icon">
                <KeyRound />
                <input id="invite" v-model="invite" class="field" required autocomplete="off" placeholder="Ask the server admin">
              </div>
            </div>
            <p v-if="createError" class="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{{ createError }}</p>
            <button type="submit" class="btn btn-primary !h-12 w-full !rounded-2xl !text-[15px]" :disabled="creating">
              <Loader2 v-if="creating" class="animate-spin" />
              Create account
            </button>
          </form>
        </div>

        <p class="mt-5 flex items-start justify-center gap-2 px-6 text-center text-xs leading-relaxed text-muted-foreground">
          <Lock class="mt-0.5 size-3.5 shrink-0" />
          <span>Your keys are generated on this device. The server can never read your messages.</span>
        </p>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="forgetOpen"
      title="Forget this account?"
      :description="`This deletes ${forgetTarget?.name ?? 'the account'}'s encryption keys and all message history from this device. Without a backup of the keys you will not be able to sign in again.`"
      confirm-label="Forget account"
      :loading="forgetting"
      @confirm="doForget"
    />
  </div>
</template>
