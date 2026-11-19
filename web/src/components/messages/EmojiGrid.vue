<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  Clock, Flag, Hand, Lightbulb, PawPrint, Plane, Search, Smile, Shapes, Trophy, Utensils,
} from 'lucide-vue-next'
import { addRecent, CATEGORIES, cycleTone, emojiData, loadEmoji, recents, searchEmoji, tone, withTone, type EmojiItem } from '@/lib/emoji'
import { coarsePointer } from './state'

/**
 * The full emoji picker: search, category tabs, "recently used" and a skin tone choice.
 * The dataset loads on first use (its own chunk); sections render as they scroll into view.
 */
const emit = defineEmits<{ pick: [emoji: string] }>()

const COLS = 8
const ROW_PX = 32
const TAB_ICONS = [Smile, Hand, PawPrint, Utensils, Plane, Trophy, Lightbulb, Shapes, Flag]

const query = ref('')
const failed = ref(false)
const scroller = ref<HTMLElement | null>(null)
const search = ref<HTMLInputElement | null>(null)
const active = ref(0)
/** Sections that have been near the viewport (rendered for good once they were). */
const shown = reactive<Record<string, boolean>>({ recent: true, 0: true, 1: true })

onMounted(() => {
  loadEmoji().catch(() => (failed.value = true))
  if (!coarsePointer()) void nextTick(() => search.value?.focus())
})

const byGroup = computed(() => {
  const m = new Map<number, EmojiItem[]>()
  for (const it of emojiData.value?.items ?? []) {
    let l = m.get(it.group)
    if (!l) m.set(it.group, (l = []))
    l.push(it)
  }
  return m
})

const results = computed(() => (emojiData.value && query.value.trim() ? searchEmoji(emojiData.value, query.value, 96) : null))

const tabs = computed(() => [
  ...(recents.value.length ? [{ id: 'recent', label: 'Recently used', icon: Clock }] : []),
  ...CATEGORIES.map((c, i) => ({ id: String(c.group), label: c.label, icon: TAB_ICONS[i]! })),
])

let observer: IntersectionObserver | undefined
/** Template ref callback: watches each section so it renders once it nears the viewport. */
function watchSection(el: unknown, id: string) {
  if (!(el instanceof HTMLElement) || el.dataset.watched) return
  el.dataset.watched = '1'
  el.dataset.id = id
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) shown[(e.target as HTMLElement).dataset.id!] = true
  }, { root: scroller.value, rootMargin: '240px 0px' })
  observer.observe(el)
}

onBeforeUnmount(() => observer?.disconnect())

function goTo(id: string) {
  const el = scroller.value?.querySelector<HTMLElement>(`[data-id="${id}"]`)
  if (!el || !scroller.value) return
  shown[id] = true
  scroller.value.scrollTop = el.offsetTop
}

function onScroll() {
  const sc = scroller.value
  if (!sc) return
  const top = sc.scrollTop + 8
  let cur = 0
  tabs.value.forEach((t, i) => {
    const el = sc.querySelector<HTMLElement>(`[data-id="${t.id}"]`)
    if (el && el.offsetTop <= top) cur = i
  })
  active.value = cur
}

const display = (it: EmojiItem) => withTone(it, tone.value)

function pick(e: string) {
  addRecent(e)
  emit('pick', e)
}

const placeholderHeight = (n: number) => `${Math.ceil(n / COLS) * ROW_PX}px`

function onSearchEnter() {
  const first = results.value?.[0]
  if (first) pick(display(first))
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-center gap-1.5">
      <div class="field-icon min-w-0 flex-1">
        <Search />
        <input
          ref="search" v-model="query" class="field !h-8 !text-sm" placeholder="Search emoji" aria-label="Search emoji"
          autocomplete="off" spellcheck="false" @keydown.enter.prevent="onSearchEnter"
        >
      </div>
      <button
        type="button" class="btn btn-ghost btn-icon btn-sm shrink-0 text-lg" title="Skin tone" aria-label="Change skin tone"
        @click="cycleTone"
      >
        {{ ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'][tone] }}
      </button>
    </div>

    <div v-if="!results" class="flex items-center justify-between">
      <button
        v-for="(t, i) in tabs" :key="t.id" type="button" :title="t.label" :aria-label="t.label"
        class="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-hover focus-visible:shadow-[var(--glow)]"
        :class="active === i && '!text-primary bg-primary/10'" @click="goTo(t.id)"
      >
        <component :is="t.icon" class="size-4" />
      </button>
    </div>

    <div ref="scroller" class="relative h-56 overflow-y-auto" @scroll.passive="onScroll">
      <p v-if="failed" class="p-3 text-center text-xs text-muted-foreground">Couldn't load the emoji list.</p>
      <p v-else-if="!emojiData" class="p-3 text-center text-xs text-muted-foreground">Loading…</p>

      <template v-else-if="results">
        <p v-if="!results.length" class="p-3 text-center text-xs text-muted-foreground">No emoji found.</p>
        <div v-else class="grid grid-cols-8 gap-0">
          <button
            v-for="it in results" :key="it.e" type="button" :aria-label="it.name" :title="`:${it.codes[0]}:`"
            class="flex size-8 items-center justify-center rounded-md text-xl outline-none hover:bg-hover focus-visible:shadow-[var(--glow)]"
            @click="pick(display(it))"
          >
            {{ display(it) }}
          </button>
        </div>
      </template>

      <template v-else>
        <section v-if="recents.length" :ref="(el) => watchSection(el, 'recent')">
          <h3 class="sticky top-0 z-[1] bg-popover py-1 text-[11px] font-semibold text-muted-foreground">Recently used</h3>
          <div class="grid grid-cols-8">
            <button
              v-for="e in recents" :key="e" type="button" :aria-label="e"
              class="flex size-8 items-center justify-center rounded-md text-xl outline-none hover:bg-hover focus-visible:shadow-[var(--glow)]"
              @click="pick(e)"
            >
              {{ e }}
            </button>
          </div>
        </section>
        <section v-for="c in CATEGORIES" :key="c.group" :ref="(el) => watchSection(el, String(c.group))">
          <h3 class="sticky top-0 z-[1] bg-popover py-1 text-[11px] font-semibold text-muted-foreground">{{ c.label }}</h3>
          <div v-if="shown[c.group]" class="grid grid-cols-8">
            <button
              v-for="it in byGroup.get(c.group)" :key="it.e" type="button" :aria-label="it.name" :title="`:${it.codes[0]}:`"
              class="flex size-8 items-center justify-center rounded-md text-xl outline-none hover:bg-hover focus-visible:shadow-[var(--glow)]"
              @click="pick(display(it))"
            >
              {{ display(it) }}
            </button>
          </div>
          <div v-else :style="{ height: placeholderHeight(byGroup.get(c.group)?.length ?? 0) }" />
        </section>
      </template>
    </div>
  </div>
</template>
