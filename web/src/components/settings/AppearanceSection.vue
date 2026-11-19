<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { Monitor, Moon, Sun } from 'lucide-vue-next'
import SettingsSection from './SettingsSection.vue'
import { formatClock, setTimeFormat, timeFormat, type TimeFormat } from '@/lib/format'
import { setTheme, themeChoice, type ThemeChoice } from '@/lib/theme'

const themes: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
]

const clock = ref(Date.now())
const timer = setInterval(() => (clock.value = Date.now()), 1000)
onBeforeUnmount(() => clearInterval(timer))

const formats: { id: TimeFormat; label: string }[] = [
  { id: '24', label: '24-hour' },
  { id: '12', label: '12-hour' },
]
const seg = 'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:shadow-[var(--glow)]'
</script>

<template>
  <div class="space-y-8">
    <SettingsSection title="Theme" description="System follows your device and switches with it.">
      <div class="well inline-flex gap-1 rounded-lg p-1" role="radiogroup" aria-label="Theme">
        <button
          v-for="t in themes" :key="t.id" role="radio" :aria-checked="themeChoice === t.id" :aria-label="`${t.label} theme`" :title="`${t.label} theme`"
          :class="[seg, themeChoice === t.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground']"
          @click="setTheme(t.id)"
        ><component :is="t.icon" class="size-4" />{{ t.label }}</button>
      </div>
    </SettingsSection>

    <SettingsSection title="Time format" description="How times are shown in chats. Saved on this device.">
      <div class="well inline-flex gap-1 rounded-lg p-1" role="radiogroup" aria-label="Time format">
        <button
          v-for="f in formats" :key="f.id" role="radio" :aria-checked="timeFormat === f.id" :aria-label="`${f.label} time`" :title="`${f.label} time`"
          :class="[seg, timeFormat === f.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground']"
          @click="setTimeFormat(f.id)"
        >{{ f.label }}</button>
      </div>
      <div class="well flex items-center justify-between gap-3 rounded-md p-3 text-sm">
        <span class="text-muted-foreground">Preview</span>
        <span class="font-mono font-semibold">{{ formatClock(clock) }}</span>
      </div>
    </SettingsSection>
  </div>
</template>
