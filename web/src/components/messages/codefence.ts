import type { Editor } from '@tiptap/core'

/** "```js" typed on its own line + Enter turns that paragraph into a code block (language = "js"). */
export function codeFenceShortcut(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection
  if (!empty || $from.parent.type.name !== 'paragraph') return false
  const m = /^```([\w+#-]*)$/.exec($from.parent.textContent)
  if (!m) return false
  const chain = editor.chain().focus().deleteRange({ from: $from.start(), to: $from.end() })
  return (m[1] ? chain.setCodeBlock({ language: m[1] }) : chain.setCodeBlock()).run()
}
