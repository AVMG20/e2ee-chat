import { describe, expect, test } from 'bun:test'
import { isEmojiOnly } from '../src/components/messages/emoji'
import { docToPlainText } from '../src/lib/plaintext'

describe('isEmojiOnly', () => {
  test('1 to 6 emoji count, ZWJ/flags/skin tones are one each', () => {
    expect(isEmojiOnly('😀')).toBe(true)
    expect(isEmojiOnly('😀 🎉 🔥')).toBe(true)
    expect(isEmojiOnly('👨‍👩‍👧‍👦')).toBe(true)
    expect(isEmojiOnly('👍🏽')).toBe(true)
    expect(isEmojiOnly('🇳🇱🇩🇪')).toBe(true)
    expect(isEmojiOnly('😀😀😀😀😀😀')).toBe(true)
  })
  test('text, digits, too many emoji or empty are not', () => {
    expect(isEmojiOnly('😀😀😀😀😀😀😀')).toBe(false)
    expect(isEmojiOnly('hi 😀')).toBe(false)
    expect(isEmojiOnly('123')).toBe(false)
    expect(isEmojiOnly('©')).toBe(false)
    expect(isEmojiOnly('  ')).toBe(false)
  })
})

describe('spoilers in text versions', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the ' }, { type: 'text', text: 'butler', marks: [{ type: 'spoiler' }] }] }] }
  test('copied text keeps the markers', () => {
    expect(docToPlainText(doc)).toBe('the ||butler||')
  })
})
