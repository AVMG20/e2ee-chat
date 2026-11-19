import type { JSONContent } from '@tiptap/core'
import { generateHTML } from '@tiptap/html'
import DOMPurify from 'dompurify'
import { find } from 'linkifyjs'
import { highlightCode, languageName } from './code/highlight'
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

// Code blocks keep their language as class="language-xyz" (nothing else may use class).
const LANG_CLASS = /^language-([\w+#-]{1,20})$/
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class') data.keepAttr = node.tagName === 'CODE' && LANG_CLASS.test(data.attrValue)
})

/** Links bare http(s) URLs in plain text (Tiptap only autolinks after a following space, and Enter sends). */
function linkifyBareUrls(frag: DocumentFragment) {
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('a, code, pre')) texts.push(n as Text)
  }
  for (const t of texts) {
    const text = t.data
    if (!/https?:\/\//i.test(text)) continue
    const links = find(text, 'url').filter((l) => /^https?:\/\//i.test(l.href) && /^https?:\/\//i.test(l.value))
    if (!links.length) continue
    const out = document.createDocumentFragment()
    let at = 0
    for (const l of links) {
      if (l.start > at) out.append(text.slice(at, l.start))
      const a = document.createElement('a')
      a.setAttribute('href', l.href)
      a.textContent = l.value
      if (!isDesktop) a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer nofollow')
      out.append(a)
      at = l.end
    }
    if (at < text.length) out.append(text.slice(at))
    t.replaceWith(out)
  }
}

/** Someone who can be @mentioned in a chat: their user ID and the names they go by. */
export interface Mentionable {
  id: string
  names: string[]
}

const MENTION_ID = /^[0-9A-HJKMNP-TV-Z]{8}$/

/** Wraps "@name" of people in the chat in a clickable mention (longest name first; whole names only). */
function markMentions(frag: DocumentFragment, people: Mentionable[]) {
  const names = people
    .filter((p) => MENTION_ID.test(p.id))
    .flatMap((p) => p.names.filter(Boolean).map((n) => ({ id: p.id, name: n.toLowerCase() })))
    .sort((a, b) => b.name.length - a.name.length)
  if (!names.length) return
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('a, code, pre') && (n as Text).data.includes('@')) texts.push(n as Text)
  }
  for (const t of texts) {
    const text = t.data
    const lower = text.toLowerCase()
    const out = document.createDocumentFragment()
    let at = 0
    for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
      if (i < at || (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1]!))) continue
      const hit = names.find(({ name }) => {
        const after = lower[i + 1 + name.length]
        return lower.startsWith(name, i + 1) && (after === undefined || !/[\p{L}\p{N}_.]/u.test(after))
      })
      if (!hit) continue
      if (i > at) out.append(text.slice(at, i))
      const span = document.createElement('span')
      span.className = 'mention'
      span.dataset.uid = hit.id
      span.textContent = text.slice(i, i + 1 + hit.name.length)
      out.append(span)
      at = i + 1 + hit.name.length
    }
    if (!at) continue
    if (at < text.length) out.append(text.slice(at))
    t.replaceWith(out)
  }
}

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
/** `people`: who can be @mentioned in this chat (their mentions become clickable). */
export function renderMessageHtml(doc: JSONContent | undefined, people: Mentionable[] = []): string {
  if (!doc || doc.type !== 'doc' || !docWithinLimits(doc)) return ''
  let html = ''
  try {
    html = generateHTML(doc, editorExtensions())
  } catch {
    return ''
  }
  const frag = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'class'], // target/rel are set by the hook above; class only for code language
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
    RETURN_DOM_FRAGMENT: true,
  })
  linkifyBareUrls(frag)
  markMentions(frag, people)
  // Syntax highlighting: highlight.js escapes the code text and only adds <span class="hljs-…">.
  for (const pre of frag.querySelectorAll('pre')) {
    pre.classList.add('msg-code')
    const code = pre.querySelector('code')
    const lang = code?.className.match(LANG_CLASS)?.[1] ?? ''
    const name = lang && languageName(lang)
    if (name) pre.dataset.lang = name
    const highlighted = code && highlightCode(code.textContent ?? '', lang)
    if (code && highlighted !== null && highlighted !== undefined) code.innerHTML = highlighted
  }
  const box = document.createElement('div')
  box.append(frag)
  return box.innerHTML
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

