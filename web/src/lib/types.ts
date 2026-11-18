import type { JSONContent } from '@tiptap/core'

/** A saved local account (identity keys never leave the device). */
export interface Account {
  server: string // e.g. "https://chat.example.com"
  name: string
}

export type ConvId = `dm:${string}` | `g:${string}`

export interface Contact {
  name: string
  online: boolean
  /** Fingerprint of the key pinned for this contact (shown for out-of-band verification). */
  fingerprint: string
  /** User marked this contact's fingerprint as verified in person. */
  verified: boolean
  /** Server now reports a different key than the pinned one. Messages are blocked until trusted. */
  keyChanged: boolean
  /** Fingerprint of the new key when keyChanged; pass it to chat.trustNewKey after checking it. */
  pendingFingerprint: string | null
}

export interface Group {
  id: string
  name: string
  members: string[]
}

export interface FileInfo {
  name: string
  mime: string
  size: number
}

export interface ChatMessage {
  /** Unique per conversation history: "<sender>/<envelope id>" (system notes: "/<random>"). */
  id: string
  conv: ConvId
  from: string
  ts: number // ms since epoch
  kind: 'text' | 'file' | 'system'
  /** Tiptap document, for kind === 'text'. */
  doc?: JSONContent
  /** For kind === 'file'. Use chat.fileUrl(msg) to get a displayable URL. */
  file?: FileInfo
  /** For kind === 'system' (e.g. "alice added bob"). */
  text?: string
  status: 'sending' | 'sent' | 'received' | 'failed'
}

export interface Conversation {
  id: ConvId
  kind: 'dm' | 'group'
  title: string
  unread: number
  lastTs: number
  /** Preview of the last message (plain text). */
  preview: string
}

export type ConnectionStatus = 'offline' | 'connecting' | 'online'

/** Max file size the app will send (bytes). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
