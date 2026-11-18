import type { JSONContent } from '@tiptap/core'
import { generateHTML } from '@tiptap/html'
import DOMPurify from 'dompurify'
import { editorExtensions } from './editor'

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 's', 'u', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'hr',
]

const isDesktop = '__TAURI_INTERNALS__' in globalThis

// Links from other users always open outside the app. In the browser that's a new
// tab without opener/referrer; in the desktop app the window's navigation guard
// catches the click and hands the URL to the system browser.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return
  if (isDesktop) node.removeAttribute('target')
  else node.setAttribute('target', '_blank')
  node.setAttribute('rel', 'noopener noreferrer nofollow')
})

/** Nesting/size limits for docs received from others (keeps rendering cheap and non-recursive-bomb). */
export const MAX_DOC_DEPTH = 32
export const MAX_DOC_NODES = 20_000

/** True if a received doc is within depth/size limits. */
export function docWithinLimits(doc: unknown): boolean {
  const stack: [unknown, number][] = [[doc, 0]]
  let nodes = 0
  while (stack.length) {
    const [n, depth] = stack.pop()!
    if (!n || typeof n !== 'object' || depth > MAX_DOC_DEPTH || ++nodes > MAX_DOC_NODES) return false
    const content = (n as JSONContent).content
    if (content === undefined) continue
    if (!Array.isArray(content)) return false
    for (const c of content) stack.push([c, depth + 1])
  }
  return true
}

/**
 * Turn a (possibly hostile) Tiptap document from another user into safe HTML.
 * The doc only ever passes through our schema and is then sanitized again.
 */
export function renderMessageHtml(doc: JSONContent | undefined): string {
  if (!doc || doc.type !== 'doc' || !docWithinLimits(doc)) return ''
  let html = ''
  try {
    html = generateHTML(doc, editorExtensions())
  } catch {
    return ''
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href'], // target/rel are set by the hook above
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  })
}

/** Plain-text version of a message doc (for previews/notifications). */
export function docToText(doc: JSONContent | undefined): string {
  if (!doc) return ''
  const parts: string[] = []
  // Iterative walk; strings on the stack are separators emitted after a block's children.
  const stack: (JSONContent | string)[] = [doc]
  let nodes = 0
  while (stack.length && nodes++ < MAX_DOC_NODES) {
    const n = stack.pop()!
    if (typeof n === 'string') {
      parts.push(n)
      continue
    }
    if (!n || typeof n !== 'object') continue
    if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text)
    if (n.type === 'hardBreak') parts.push(' ')
    if (n.type === 'paragraph' || n.type === 'listItem') stack.push(' ')
    if (Array.isArray(n.content)) for (let i = n.content.length - 1; i >= 0; i--) stack.push(n.content[i]!)
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}

/** True if the doc has no visible text. */
export function isEmptyDoc(doc: JSONContent | undefined): boolean {
  return docToText(doc) === ''
}
