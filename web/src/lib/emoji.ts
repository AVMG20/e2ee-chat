import { ref, shallowRef } from 'vue'

/** One emoji of the bundled dataset. */
export interface EmojiItem {
  /** The character(s) to insert. */
  e: string
  /** English name, e.g. "thumbs up". */
  name: string
  /** Shortcodes without colons, e.g. ["+1", "thumbsup"]. The first is the canonical one. */
  codes: string[]
  /** Lowercased searchable text (name, shortcodes, keywords). */
  hay: string
  group: number
  /** Skin tone variants, light to dark (only for emoji that have them). */
  skins?: string[]
}

export interface EmojiData {
  items: EmojiItem[]
  /** Shortcode → emoji character. */
  byCode: Map<string, string>
}

/** Picker categories: dataset group id → label. (Group 2 is skin-tone/hair components, never shown.) */
export const CATEGORIES = [
  { group: 0, label: 'Smileys & emotion' },
  { group: 1, label: 'People & body' },
  { group: 3, label: 'Animals & nature' },
  { group: 4, label: 'Food & drink' },
  { group: 5, label: 'Travel & places' },
  { group: 6, label: 'Activities' },
  { group: 7, label: 'Objects' },
  { group: 8, label: 'Symbols' },
  { group: 9, label: 'Flags' },
] as const

interface RawEmoji {
  hexcode: string
  label: string
  unicode: string
  group?: number
  tags?: string[]
  skins?: { unicode: string }[]
}

/** The dataset is large (~600 KB), so it lives in its own chunk and is only fetched on first use. */
export const emojiData = shallowRef<EmojiData | null>(null)
let loading: Promise<EmojiData> | null = null

/** Loads the emoji dataset once (separate chunk). Also fills `emojiData` for reactive readers. */
export function loadEmoji(): Promise<EmojiData> {
  loading ??= Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/shortcodes/github.json'),
    import('emojibase-data/versions/emoji.json'),
  ]).then(([c, s, v]) => {
    const data = build(
      c.default as unknown as RawEmoji[],
      s.default as unknown as Record<string, string | string[]>,
      unsupportedHexcodes(v.default as unknown as Record<string, string[]>),
    )
    emojiData.value = data
    return data
  }).catch((e) => {
    loading = null // allow a retry
    throw e
  })
  return loading
}

/** Pixels of a glyph drawn on a canvas, to tell real emoji from the "missing character" box. */
function glyphKey(ctx: CanvasRenderingContext2D, ch: string): string {
  ctx.clearRect(0, 0, 40, 40)
  ctx.fillText(ch, 2, 2)
  return ctx.canvas.toDataURL()
}

/**
 * Emoji newer than the system's emoji font would show as empty boxes. The dataset says in which
 * Unicode version each emoji appeared; one sample per recent version tells whether the system draws them.
 */
function unsupportedHexcodes(versions: Record<string, string[]>): Set<string> {
  const out = new Set<string>()
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  } catch {
    /* no canvas: assume everything is drawn */
  }
  if (!ctx) return out
  ctx.canvas.width = ctx.canvas.height = 40
  ctx.textBaseline = 'top'
  ctx.font = '28px sans-serif'
  const missing = glyphKey(ctx, '\u0378') // an unassigned character: drawn as the "missing" box
  for (const [ver, list] of Object.entries(versions)) {
    if (Number(ver) < 11 || !list.length) continue // everything older is drawn everywhere
    const sample = list.find((h) => !h.includes('-')) ?? list[0]!
    const ch = String.fromCodePoint(...sample.split('-').map((h) => parseInt(h, 16)))
    if (glyphKey(ctx, ch) === missing) for (const h of list) out.add(h)
  }
  return out
}

function build(raw: RawEmoji[], shortcodes: Record<string, string | string[]>, unsupported: Set<string>): EmojiData {
  const items: EmojiItem[] = []
  const byCode = new Map<string, string>()
  for (const r of raw) {
    if (r.group === undefined || r.group === 2 || unsupported.has(r.hexcode)) continue
    const sc = shortcodes[r.hexcode]
    const codes = sc ? (Array.isArray(sc) ? sc : [sc]) : [r.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')]
    const hay = [r.label, ...codes, ...(r.tags ?? [])].join(' ').toLowerCase()
    items.push({ e: r.unicode, name: r.label, codes, hay, group: r.group, skins: r.skins?.map((s) => s.unicode) })
    for (const c of codes) if (!byCode.has(c)) byCode.set(c, r.unicode)
  }
  return { items, byCode }
}

/** Best matches for a typed query: shortcode prefix first, then name words, then anything containing it. */
export function searchEmoji(data: EmojiData, query: string, limit = 80): EmojiItem[] {
  const q = query.trim().toLowerCase().replace(/^:/, '')
  if (!q) return []
  const scored: [number, number, EmojiItem][] = []
  data.items.forEach((it, i) => {
    let s = -1
    if (it.codes.includes(q)) s = 0
    else if (it.codes.some((c) => c.startsWith(q))) s = 1
    else if (it.name.toLowerCase().startsWith(q)) s = 2
    else if (it.hay.includes(' ' + q)) s = 3
    else if (it.hay.includes(q)) s = 4
    if (s >= 0) scored.push([s, i, it])
  })
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return scored.slice(0, limit).map((x) => x[2])
}

/** The shortcode of an item that best matches what was typed (for display in the suggestion list). */
export function codeFor(it: EmojiItem, query: string): string {
  const q = query.toLowerCase()
  return it.codes.find((c) => c.startsWith(q)) ?? it.codes.find((c) => c.includes(q)) ?? it.codes[0]!
}

// ---------- recently used + skin tone (this device only) ----------
const RECENT_KEY = 'e2ee-chat:recent-emoji'
const TONE_KEY = 'e2ee-chat:emoji-tone'
const MAX_RECENT = 24

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode or blocked storage: it just won't be remembered */
  }
}

function readRecents(): string[] {
  try {
    const v = JSON.parse(readStore(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 32).slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

/** Most recently used emoji first. */
export const recents = ref<string[]>(readRecents())

/** Remembers an emoji as just used. */
export function addRecent(e: string) {
  recents.value = [e, ...recents.value.filter((x) => x !== e)].slice(0, MAX_RECENT)
  writeStore(RECENT_KEY, JSON.stringify(recents.value))
}

/** Preferred skin tone: 0 = default yellow, 1..5 = light..dark. */
export const tone = ref(Math.min(5, Math.max(0, Number(readStore(TONE_KEY)) || 0)))
export function cycleTone() {
  tone.value = (tone.value + 1) % 6
  writeStore(TONE_KEY, String(tone.value))
}

/** The emoji with the preferred skin tone applied, if it has variants. */
export const withTone = (it: EmojiItem, t: number): string => (t > 0 && it.skins?.[t - 1]) || it.e
