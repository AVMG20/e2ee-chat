import { describe, expect, test } from 'bun:test'
import { fencesToCodeBlocks } from '../src/lib/code/fences'

const t = (text: string) => ({ type: 'text', text })
const p = (...lines: string[]) => ({
  type: 'paragraph',
  content: lines.flatMap((l, i) => (i ? [{ type: 'hardBreak' }, t(l)] : [t(l)])),
})

describe('fencesToCodeBlocks', () => {
  test('leaves docs without fences alone', () => {
    const doc = { type: 'doc', content: [p('hello')] }
    expect(fencesToCodeBlocks(doc)).toBe(doc)
  })

  test('fence across shift+enter lines', () => {
    const out = fencesToCodeBlocks({ type: 'doc', content: [p('look:', '```js', 'const a = 1', '  a++', '```', 'nice')] })
    expect(out.content).toEqual([
      p('look:'),
      { type: 'codeBlock', attrs: { language: 'js' }, content: [t('const a = 1\n  a++')] },
      p('nice'),
    ])
  })

  test('fence across paragraphs, unclosed runs to the end', () => {
    const out = fencesToCodeBlocks({ type: 'doc', content: [p('```py'), p('print(1)'), p('x = 2')] })
    expect(out.content).toEqual([{ type: 'codeBlock', attrs: { language: 'py' }, content: [t('print(1)\nx = 2')] }])
  })

  test('one-line fence', () => {
    const out = fencesToCodeBlocks({ type: 'doc', content: [p('```npm i```')] })
    expect(out.content).toEqual([{ type: 'codeBlock', attrs: { language: null }, content: [t('npm i')] }])
  })
})

describe('docToPlainText', () => {
  test('keeps lines, lists and code', async () => {
    const { docToPlainText } = await import('../src/lib/plaintext')
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x  =  1\n  y' }] },
      ],
    }
    expect(docToPlainText(doc)).toBe('line one\nline two\n- a\nx  =  1\n  y')
  })
})

describe('message times', () => {
  test('relative for an hour, then clock, yesterday, weekday, date', async () => {
    const { ago, now, setTimeFormat } = await import('../src/lib/format')
    setTimeFormat('24')
    const base = new Date(2026, 10, 19, 15, 0).getTime() // Thu 19 Nov 2026 15:00
    now.value = base
    expect(ago(base - 20_000)).toBe('just now')
    expect(ago(base - 5 * 60_000)).toBe('5 min ago')
    expect(ago(new Date(2026, 10, 19, 9, 7).getTime())).toBe('09:07')
    expect(ago(new Date(2026, 10, 18, 14, 49).getTime())).toBe('Yesterday at 14:49')
    expect(ago(new Date(2026, 10, 16, 8, 0).getTime())).toMatch(/^Monday at 08:00$/)
    expect(ago(new Date(2026, 10, 10, 8, 0).getTime())).toMatch(/10 Nov.* 08:00|Nov 10.* 08:00/)
  })
})
