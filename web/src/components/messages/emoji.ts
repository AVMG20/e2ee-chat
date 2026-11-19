export const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀']

const EMOJI_MAX = 6
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const PICTO = /\p{Extended_Pictographic}/u
const FLAG = /^\p{Regional_Indicator}{2}$/u

/**
 * True when the text is only 1 to 6 emoji (and whitespace): such messages are shown large.
 * ZWJ sequences, skin tones and flags count as one emoji each.
 */
export function isEmojiOnly(text: string): boolean {
  const t = text.replace(/\s+/g, '')
  if (!t || t.length > 80) return false
  const parts = segmenter ? Array.from(segmenter.segment(t), (s) => s.segment) : Array.from(t)
  if (parts.length > EMOJI_MAX) return false
  return parts.every((g) => (PICTO.test(g) && g.codePointAt(0)! > 0xff) || FLAG.test(g))
}
