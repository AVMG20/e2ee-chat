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
