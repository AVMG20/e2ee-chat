import type { JSONContent } from '@tiptap/core'

type Inline = JSONContent[]

const FENCE = /^```([\w+#-]{0,20})\s*$/
const ONE_LINE = /^```([^`]+)```$/

/** Splits a paragraph's inline content into lines at hard breaks. */
function linesOf(p: JSONContent): Inline[] {
  const lines: Inline[] = [[]]
  for (const n of p.content ?? []) {
    if (n.type === 'hardBreak') lines.push([])
    else lines[lines.length - 1]!.push(n)
  }
  return lines
}

const textOf = (line: Inline) => line.map((n) => (n.type === 'text' ? (n.text ?? '') : '')).join('')

function codeBlock(lang: string, lines: string[]): JSONContent {
  const text = lines.join('\n')
  return {
    type: 'codeBlock',
    attrs: { language: lang || null },
    ...(text ? { content: [{ type: 'text', text }] } : {}),
  }
}

function paragraph(lines: Inline[]): JSONContent {
  const content: JSONContent[] = []
  lines.forEach((l, i) => {
    if (i) content.push({ type: 'hardBreak' })
    content.push(...l)
  })
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

/**
 * Discord-style fences: text typed or pasted as
 *   ```js
 *   code
 *   ```
 * (as paragraphs or shift+enter lines) becomes a real code block with a language.
 * "```inline```" on its own line becomes a code block too. An unclosed fence runs to the end.
 */
export function fencesToCodeBlocks(doc: JSONContent): JSONContent {
  if (!JSON.stringify(doc).includes('```')) return doc
  const out: JSONContent[] = []
  let code: { lang: string; lines: string[] } | null = null
  for (const node of doc.content ?? []) {
    if (node.type !== 'paragraph') {
      if (code) code.lines.push(textOf(node.content ?? []))
      else out.push(node)
      continue
    }
    let pending: Inline[] = []
    const flush = () => {
      if (pending.length) out.push(paragraph(pending))
      pending = []
    }
    for (const line of linesOf(node)) {
      const text = textOf(line).trim()
      if (code) {
        if (text === '```') {
          out.push(codeBlock(code.lang, code.lines))
          code = null
        } else {
          code.lines.push(textOf(line))
        }
        continue
      }
      const one = ONE_LINE.exec(text)
      const fence = FENCE.exec(text)
      if (one) {
        flush()
        out.push(codeBlock('', [one[1]!.trim()]))
      } else if (fence) {
        flush()
        code = { lang: fence[1]!.toLowerCase(), lines: [] }
      } else {
        pending.push(line)
      }
    }
    flush()
  }
  if (code) out.push(codeBlock(code.lang, code.lines))
  return { ...doc, content: out }
}
