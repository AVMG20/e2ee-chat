import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import './code.css'

const languages = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, lua,
  markdown, php, powershell, python, ruby, rust, shell, sql, swift, typescript, xml, yaml,
}
for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang)
hljs.registerAliases(['vue', 'svelte'], { languageName: 'xml' })

/** Longer code isn't highlighted (keeps rendering fast). */
const MAX_HIGHLIGHT = 20_000

/** Canonical name for a language label ("js" → "javascript"), or null if unknown. */
export function languageName(lang: string): string | null {
  return hljs.getLanguage(lang) ? lang.toLowerCase() : null
}

/**
 * Highlighted HTML for code: only escaped text and <span class="hljs-..."> (highlight.js
 * escapes the input). Returns null when the language is unknown.
 */
export function highlightCode(code: string, lang: string): string | null {
  if (!lang || code.length > MAX_HIGHLIGHT || !hljs.getLanguage(lang)) return null
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return null
  }
}
