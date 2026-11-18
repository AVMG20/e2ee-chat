import StarterKit from '@tiptap/starter-kit'

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
  ]
}
