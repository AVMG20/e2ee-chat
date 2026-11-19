import type { JSONContent } from '@tiptap/core'

/** The signed-in account. */
export interface Account {
  server: string // e.g. "https://chat.example.com"
  /** Public user ID (8 chars, Crockford base32). Share it so friends can add you. */
  id: string
  /** Login name (fixed). */
  username: string
  /** Name shown to friends and group members: my display name, or the username. */
  displayName: string
  /** Object URL of my profile picture, or null. */
  avatar: string | null
  /** My status: online, away, dnd (do not disturb) or invisible (I look offline to friends). */
  status: 'online' | 'away' | 'dnd' | 'invisible'
  /** My status text ("in a meeting until 3"), or ''. Set with chat.setStatusText. */
  note: string
  /** My security code (8 groups of 5 digits): friends compare it with what they see for me. */
  fingerprint: string
}

export type ConvId = `dm:${string}` | `g:${string}` // dm:<user id> | g:<group id>

/** Anyone we know: friends, and members of our groups who aren't friends. Keyed by user ID. */
export interface Contact {
  id: string
  /** Name to show: their display name if they set one, else their username. */
  name: string
  /** Their login name (fixed; show as @username next to a display name). */
  username: string
  /** Mutual friend: can DM. Non-friends only appear through shared groups. */
  friend: boolean
  /** Only known for friends. */
  online: boolean
  /** What their dot shows: online (green), away (yellow), dnd (red), offline (also when invisible). Friends only. */
  status: 'online' | 'away' | 'dnd' | 'offline'
  /** Their status text, or ''. */
  note: string
  /** Fingerprint of the key pinned for this contact (shown for out-of-band verification). */
  fingerprint: string
  /** User marked this contact's fingerprint as verified in person. */
  verified: boolean
  /** Server now reports a different key than the pinned one. Messages are blocked until trusted. */
  keyChanged: boolean
  /** Fingerprint of the new key when keyChanged; pass it to chat.trustNewKey after checking it. */
  pendingFingerprint: string | null
  /** Object URL of their profile picture, or null. */
  avatar: string | null
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
  /** Can rename, remove members and pick admins. Missing in groups from older versions: everyone is an admin there. */
  admins?: string[]
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
  /** Forwarded from another chat (shown as "Forwarded"). */
  forwarded?: boolean
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
  /** How many of the unread messages mention or reply to me (show as a red @ badge). */
  mentions: number
  lastTs: number
  /** Preview of the last message (plain text). */
  preview: string
  /** No notifications or sound for this conversation right now (a timed mute that ran out is false). */
  muted: boolean
  /** When a timed mute ends (ms), or null when not muted or muted until turned back on. */
  mutedUntil: number | null
  /** Notify only for messages that mention me (@my name) or reply to me. */
  mentionsOnly: boolean
  /** Shown at the top of the list. */
  pinned: boolean
  /** Hidden from the main list (comes back on a new message unless muted). */
  archived: boolean
  /** Group picture, or the other person's profile picture in a DM (object URL), or null. */
  avatar: string | null
}

export interface SearchHit {
  conv: ConvId
  /** Conversation title. */
  title: string
  msg: ChatMessage
}

/** One of my signed-in devices (sessions). */
export interface Device {
  /** Pass to chat.signOutDevice. */
  id: string
  /** E.g. "Firefox on Linux", "Desktop app on Windows". May be '' for devices from older versions. */
  name: string
  /** Signed in at (ms). */
  created: number
  /** Last connected (ms). */
  lastUsed: number
  /** This device. */
  current: boolean
  /** Connected right now. */
  online: boolean
}

/** What chat.importBackup added. */
export interface ImportResult {
  conversations: number
  messages: number
  files: number
}

export type ConnectionStatus = 'offline' | 'connecting' | 'online'

/** Max file size the app will send (bytes). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
/** Minimum password length. The password protects your keys, so it must be strong. */
export const MIN_PASSWORD = 10
