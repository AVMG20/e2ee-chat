<script setup lang="ts">
import { computed, ref } from 'vue'
import { AtSign, Globe, Loader2, Lock, LockKeyhole, Moon, Sun, TriangleAlert } from 'lucide-vue-next'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { isDark, toggleTheme } from '@/lib/theme'
import { MIN_PASSWORD } from '@/lib/types'

const tab = ref<'signin' | 'create'>('signin')
const server = ref('')
const username = ref('')
const password = ref('')
const confirm = ref('')
const busy = ref(false)
const error = ref('')

try {
  server.value = chat.defaultServer()
  username.value = chat.lastUsername()
} catch {
  /* prefill is best-effort */
}

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.]{2,23}$/
const serverUrl = computed(() => (chat.isDesktop ? server.value.trim() : chat.defaultServer()))
const mismatch = computed(() => tab.value === 'create' && confirm.value !== '' && confirm.value !== password.value)
const tooShort = computed(() => tab.value === 'create' && password.value !== '' && password.value.length < MIN_PASSWORD)

function switchTab(t: 'signin' | 'create') {
  tab.value = t
  error.value = ''
}

async function submit() {
  error.value = ''
  const name = username.value.trim()
  if (!USERNAME_RE.test(name)) {
    error.value = 'Username must be 3-24 characters: letters, digits, _ or .'
    return
  }
  if (tab.value === 'create') {
    if (password.value.length < MIN_PASSWORD) {
      error.value = `Password must be at least ${MIN_PASSWORD} characters.`
      return
    }
    if (password.value !== confirm.value) {
      error.value = 'Passwords do not match.'
      return
    }
  }
  busy.value = true
  try {
    if (tab.value === 'create') await chat.register(serverUrl.value, name, password.value)
    else await chat.login(serverUrl.value, name, password.value)
    password.value = ''
    confirm.value = ''
  } catch (e) {
    error.value = errMsg(e)
  } finally {
    busy.value = false
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
                        <img src="/favicon.svg" alt="" class="relative size-16 rounded-2xl">
          </div>
          <h1 class="text-2xl leading-none font-bold">E2EE Chat</h1>
          <p class="mt-2.5 max-w-xs text-[15px] leading-snug text-muted-foreground">Private chat for your own server. End-to-end encrypted.</p>
        </div>

        <div class="dialog rounded-lg p-5 sm:p-6">
          <div class="relative mb-5 grid grid-cols-2 rounded-md bg-inset p-1 shadow-[inset_0_0_0_1px_var(--line)]" role="tablist">
            <span
              class="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded bg-card shadow-[var(--shadow-sm)] transition-transform duration-300 ease-out"
              :class="tab === 'create' && 'translate-x-full'"
            />
            <button
              v-for="t in ([['signin', 'Sign in'], ['create', 'Create account']] as const)" :key="t[0]"
              role="tab" :aria-selected="tab === t[0]" :disabled="busy"
              class="relative z-10 rounded px-3 py-1.5 text-sm font-semibold outline-none transition-colors focus-visible:shadow-[var(--glow)]"
              :class="tab === t[0] ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
              @click="switchTab(t[0])"
            >{{ t[1] }}</button>
          </div>

          <form class="space-y-4" @submit.prevent="submit">
            <div v-if="chat.isDesktop">
              <label class="label" for="server">Server URL</label>
              <div class="field-icon">
                <Globe />
                <input id="server" v-model="server" class="field" type="url" placeholder="https://chat.example.com" required autocomplete="off" :disabled="busy">
              </div>
            </div>
            <div>
              <label class="label" for="username">Username</label>
              <div class="field-icon">
                <AtSign />
                <input
                  id="username" v-model="username" class="field" required minlength="3" maxlength="24" placeholder="yourname"
                  pattern="[A-Za-z0-9_.]{3,24}" autocomplete="username" autocapitalize="off" spellcheck="false" :disabled="busy"
                >
              </div>
              <p v-if="tab === 'create'" class="mt-1.5 text-xs text-muted-foreground">3-24 characters: letters, digits, _ and .</p>
            </div>
            <div>
              <label class="label" for="password">Password</label>
              <div class="field-icon">
                <LockKeyhole />
                <input
                  id="password" v-model="password" class="field" type="password" required :disabled="busy"
                  :autocomplete="tab === 'create' ? 'new-password' : 'current-password'"
                  :minlength="tab === 'create' ? MIN_PASSWORD : undefined" :placeholder="tab === 'create' ? `At least ${MIN_PASSWORD} characters` : 'Your password'"
                >
              </div>
              <p v-if="tooShort" class="mt-1.5 text-xs text-destructive">{{ password.length }} / {{ MIN_PASSWORD }} characters</p>
            </div>
            <div v-if="tab === 'create'">
              <label class="label" for="confirm">Confirm password</label>
              <div class="field-icon">
                <LockKeyhole />
                <input id="confirm" v-model="confirm" class="field" type="password" required autocomplete="new-password" placeholder="Repeat password" :disabled="busy">
              </div>
              <p v-if="mismatch" class="mt-1.5 text-xs text-destructive">Passwords do not match.</p>
            </div>

            <div v-if="tab === 'create'" class="flex items-start gap-2.5 rounded-md bg-[color-mix(in_oklab,oklch(0.8_0.15_85)_16%,transparent)] p-3 text-xs leading-relaxed shadow-[inset_0_0_0_1px_color-mix(in_oklab,oklch(0.8_0.15_85)_35%,transparent)]">
              <TriangleAlert class="mt-0.5 size-4 shrink-0 text-[oklch(0.7_0.15_75)]" />
              <span>Your password locks your encryption keys. It can't be reset. If you forget it, the account is lost.</span>
            </div>

            <p v-if="error" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{{ error }}</p>

            <button type="submit" class="btn btn-primary !h-11 w-full !text-[15px]" :disabled="busy">
              <Loader2 v-if="busy" class="animate-spin" />
              <template v-if="busy">{{ tab === 'create' ? 'Creating your keys…' : 'Unlocking your keys…' }}</template>
              <template v-else>{{ tab === 'create' ? 'Create account' : 'Sign in' }}</template>
            </button>
          </form>
        </div>

        <p class="mt-5 flex items-start justify-center gap-2 px-6 text-center text-xs leading-relaxed text-muted-foreground">
          <Lock class="mt-0.5 size-3.5 shrink-0" />
          <span>Your keys are generated on this device. The server can never read your messages.</span>
        </p>
      </div>
    </div>
  </div>
</template>
