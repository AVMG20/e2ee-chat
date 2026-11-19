import type { JSONContent } from '@tiptap/core'

const MAX_DOC_NODES = 20_000

/** Text of a message for copying: keeps line breaks, code blocks verbatim, list items as "- ". */
export function docToPlainText(doc: JSONContent | undefined): string {
  if (!doc) return ''
  let nodes = 0
  const walk = (n: JSONContent, depth: number): string => {
    if (!n || typeof n !== 'object' || nodes++ > MAX_DOC_NODES || depth > 50) return ''
    if (n.type === 'text') {
      if (typeof n.text !== 'string') return ''
      // Spoilers keep their ||markers|| so pasting the text back keeps them hidden.
      return n.marks?.some((m) => m.type === 'spoiler') ? `||${n.text}||` : n.text
    }
    if (n.type === 'hardBreak') return '\n'
    const kids = Array.isArray(n.content) ? n.content : []
    const inner = (sep: string) => kids.map((k) => walk(k, depth + 1)).join(sep)
    switch (n.type) {
      case 'doc':
      case 'blockquote':
        return inner('\n')
      case 'bulletList':
        return kids.map((k) => '- ' + walk(k, depth + 1).replace(/\n/g, '\n  ')).join('\n')
      case 'orderedList':
        return kids.map((k, i) => `${i + 1}. ` + walk(k, depth + 1).replace(/\n/g, '\n   ')).join('\n')
      case 'listItem':
        return inner('\n')
      default:
        return inner('')
    }
  }
  return walk(doc, 0).trim()
}
