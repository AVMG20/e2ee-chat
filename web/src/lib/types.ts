import type { JSONContent } from '@tiptap/core'

/** The signed-in account. */
export interface Account {
  server: string // e.g. "https://chat.example.com"
  /** Public user ID (8 chars, Crockford base32). Share it so friends can add you. */
  id: string
  /** Login name, also shown to friends and group members. */
  username: string
}

export type ConvId = `dm:${string}` | `g:${string}` // dm:<user id> | g:<group id>

/** Anyone we know: friends, and members of our groups who aren't friends. Keyed by user ID. */
export interface Contact {
  id: string
  name: string
  /** Mutual friend: can DM. Non-friends only appear through shared groups. */
  friend: boolean
  /** Only known for friends. */
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

export interface FriendRequest {
  id: string
  name: string
  ts: number
}

export interface Group {
  id: string
  name: string
  /** User IDs. */
  members: string[]
}

export interface FileInfo {
  name: string
  mime: string
  size: number
}

export interface ChatMessage {
  /** Unique per conversation history: "<sender id>/<envelope id>" (system notes: "/<random>"). */
  id: string
  conv: ConvId
  /** Sender's user ID ('' for system notes). Use chat.displayName(from). */
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
  /** When the sender last edited it (ms). Only text messages can be edited. */
  edited?: number
  /** Emoji → user IDs who reacted with it (in order). Missing or empty when nobody reacted. */
  reactions?: Record<string, string[]>
  /** The message this one replies to, as it looked when the reply arrived. */
  reply?: ReplyRef
}

export interface ReplyRef {
  id: string
  /** Sender's user ID. */
  from: string
  /** Short plain-text preview ("📎 photo.jpg" for files). */
  preview: string
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
/** Minimum password length. The password protects your keys, so it must be strong. */
export const MIN_PASSWORD = 10
