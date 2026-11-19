import { Mark, markInputRule, markPasteRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

/**
 * ||text|| hides the text until the reader clicks it. Stored as a mark in the message document,
 * rendered as <span class="spoiler"> (the only class DOMPurify lets through on a span, see render.ts).
 */
export const Spoiler = Mark.create({
  name: 'spoiler',
  inclusive: false,
  parseHTML: () => [{ tag: 'span.spoiler' }],
  renderHTML: () => ['span', { class: 'spoiler' }, 0],
  addInputRules() {
    return [markInputRule({ find: /(?:^|\s)(\|\|(?!\s)([^|]+?)\|\|)$/, type: this.type })]
  },
  addPasteRules() {
    return [markPasteRule({ find: /(?:^|\s)(\|\|(?!\s)([^|]+?)\|\|)/g, type: this.type })]
  },
})

/**
 * The single Tiptap schema used for both composing and rendering messages.
 * Rendering with the same schema means unknown/hostile node types are dropped.
 */
export function editorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
      },
    }),
    Spoiler,
  ]
}
