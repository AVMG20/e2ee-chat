import type { JSONContent } from '@tiptap/core'
import { clear, createStore, delMany, get, getMany, keys as idbKeys, set, setMany } from 'idb-keyval'
import { reactive, toRaw } from 'vue'
import {
  type Envelope,
  type Identity,
  type PublicKeys,
  b64,
  deriveFromPassword,
  fingerprint,
  generateIdentity,
  lockIdentity,
  openAny,
  openVault,
  randomId,
  recipientsOf,
  sameKeys,
  seal,
  rotateIdentity,
  sealVault,
  signNotice,
  signedBy,
  unb64,
  verifyNotice,
  unlockIdentity,
} from './crypto'
import { docToText, docWithinLimits } from './render'
import {
  type Account,
  type ChatMessage,
  type ConnectionStatus,
  type Contact,
  type Conversation,
  type ConvId,
  type Device,
  type FriendRequest,
  type Group,
  type ImportResult,
  type ReplyRef,
  type SearchHit,
  MAX_FILE_BYTES,
  MIN_PASSWORD,
} from './types'

// ---------------------------------------------------------------------------
// Encrypted payload format (inside the envelope ciphertext)
// ---------------------------------------------------------------------------

type PayloadConv = { t: 'dm' } | { t: 'g'; id: string }
type PayloadBody =
  | { t: 'text'; doc: JSONContent; reply?: ReplyRef; fwd?: boolean }
  | { t: 'file'; name: string; mime: string; size: number; reply?: ReplyRef; fwd?: boolean }
  | { t: 'group'; id: string; name: string; members: string[]; admins?: string[] }
  | { t: 'leave'; id: string }
  /** Group admin actions (only from admins; in groups without an admin list, from anyone). */
  | { t: 'gname'; id: string; name: string }
  | { t: 'gkick'; id: string; member: string }
  | { t: 'gadmin'; id: string; member: string; on: boolean }
  /** Group picture (the attachment; empty to remove it). Any member can change it. */
  | { t: 'gpic'; id: string; mime: string }
  /** I've read the conversation up to this message time. Also syncs unread counts between my devices. */
  | { t: 'read'; ts: number; with?: string }
  /** My profile picture (the attachment; empty to remove it). Sent to all my contacts. */
  | { t: 'profile'; mime: string; name?: string }
  /** Only the author's own messages can be edited or deleted (checked on receipt). */
  | { t: 'edit'; target: string; doc: JSONContent }
  | { t: 'delete'; target: string }
  | { t: 'react'; target: string; emoji: string; on: boolean }
  /** Sent as a signal (relayed live, never stored). */
  | { t: 'typing' }
interface PayloadHeader {
  conv: PayloadConv
  body: PayloadBody
}

/** [4-byte header length][header JSON][attachment bytes] */
function encodePayload(header: PayloadHeader, attachment?: Uint8Array): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header))
  const a = attachment ?? new Uint8Array(0)
  const out = new Uint8Array(4 + h.length + a.length)
  new DataView(out.buffer).setUint32(0, h.length)
  out.set(h, 4)
  out.set(a, 4 + h.length)
  return out
}

const MAX_HEADER_BYTES = 512 * 1024

function decodePayload(bytes: Uint8Array): { header: PayloadHeader; attachment: Uint8Array } {
  if (bytes.length < 4) throw new Error('bad payload')
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (len > bytes.length - 4 || len > MAX_HEADER_BYTES) throw new Error('bad payload')
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len))) as PayloadHeader
  return { header, attachment: bytes.slice(4 + len) }
}

const isStr = (v: unknown): v is string => typeof v === 'string'

/** Public user IDs: 8 chars of Crockford base32 (no I, L, O, U). */
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/
const validId = (v: unknown): v is string => isStr(v) && ID_RE.test(v)
const validGroupId = (v: unknown): v is string => isStr(v) && /^[0-9a-f]{32}$/.test(v)
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 256 && v.every(validId)
/** Must match the server's rules. */
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.]{2,23}$/
/** Usernames are case-insensitive: the key bundle is bound to the lowercase form. */
const bundleName = (username: string) => username.toLowerCase()

/** Strip control and bidi-override characters from names other people chose. */
function cleanLabel(v: string, max: number): string {
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g, '').trim().slice(0, max)
}

function validHeader(h: PayloadHeader): boolean {
  if (!h || typeof h !== 'object' || !h.conv || !h.body) return false
  if (h.conv.t !== 'dm' && !(h.conv.t === 'g' && validGroupId(h.conv.id))) return false
  const b = h.body
  const validDoc = (d: unknown): d is JSONContent =>
    !!d && typeof d === 'object' && (d as JSONContent).type === 'doc' && docWithinLimits(d as JSONContent)
  const validTarget = (t: unknown) => isStr(t) && t.length <= 64
  const validReply = (r: unknown) =>
    r === undefined || (!!r && typeof r === 'object' && validTarget((r as ReplyRef).id) && validId((r as ReplyRef).from) && isStr((r as ReplyRef).preview))
  const validFwd = (f: unknown) => f === undefined || typeof f === 'boolean'
  switch (b.t) {
    case 'text':
      return validDoc(b.doc) && validReply(b.reply) && validFwd(b.fwd)
    case 'file':
      return isStr(b.name) && isStr(b.mime) && typeof b.size === 'number' && validReply(b.reply) && validFwd(b.fwd)
    case 'edit':
      return validTarget(b.target) && validDoc(b.doc)
    case 'delete':
      return validTarget(b.target)
    case 'react':
      return validTarget(b.target) && isStr(b.emoji) && b.emoji.length > 0 && b.emoji.length <= 16 && typeof b.on === 'boolean'
    case 'typing':
      return true
    case 'group':
      return validGroupId(b.id) && isStr(b.name) && isIdList(b.members) && (b.admins === undefined || isIdList(b.admins))
    case 'leave':
      return validGroupId(b.id)
    case 'gname':
      return validGroupId(b.id) && isStr(b.name)
    case 'gkick':
      return validGroupId(b.id) && validId(b.member)
    case 'gadmin':
      return validGroupId(b.id) && validId(b.member) && typeof b.on === 'boolean'
    case 'gpic':
      return validGroupId(b.id) && isStr(b.mime)
    case 'read':
      return typeof b.ts === 'number' && Number.isFinite(b.ts) && (b.with === undefined || validId(b.with))
    case 'profile':
      return isStr(b.mime) && (b.name === undefined || (isStr(b.name) && b.name.length <= 64))
    default:
      return false
  }
}

/** Objects keyed by ids that come from other people: no prototype to pollute. */
type Dict<T> = Record<string, T>
function dict<T>(src?: unknown): Dict<T> {
  const out = Object.create(null) as Dict<T>
  if (src && typeof src === 'object') for (const [key, v] of Object.entries(src)) out[key] = v as T
  return out
}

/** Message ids are namespaced by sender so one user can't collide with another's ids. */
const msgId = (from: string, id: string) => `${from}/${id}`

/** Only these types are ever handed to the browser as-is; everything else downloads as bytes. */
const SAFE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const safeMime = (m: string) => (SAFE_MIME.has(m) ? m : 'application/octet-stream')

const noop = () => {}

// ---------------------------------------------------------------------------
// Local storage (IndexedDB): one signed-in account per device.
// ---------------------------------------------------------------------------

/** Pinned keys of a contact (trust on first use). Synced between my devices via the vault. */
interface Pin {
  name: string
  signPk: string
  encPk: string
  verified: boolean
  /**
   * Last deliberate change (verify / accept new key), in ms, so the newest wins when
   * devices merge. 0 for trust-on-first-use pins: those never replace a pin another
   * device already has, so a server can't push swapped keys to all my devices.
   */
  at: number
  /** Their earlier signing keys (after they changed keys): accepted only for messages dated before `until`. */
  prev?: { signPk: string; until: number }[]
}
interface ConvMeta {
  unread: number
  lastTs: number
  preview: string
  /** Newest message from someone else that I've told my devices (and maybe them) I read. */
  readTs?: number
  /** User ID → newest message time they've read. */
  reads?: Dict<number>
}
/** Per-conversation settings, synced between my devices. The newest `at` wins. */
interface ConvPrefs {
  muted: boolean
  /** A timed mute ends at this time (ms). Missing or 0: muted until turned back on. */
  until?: number
  /** Notify only when I'm mentioned or replied to. */
  mentions?: boolean
  pinned: boolean
  archived: boolean
  at: number
}
/** A starred message (or, with on false, one that was unstarred), keyed "<conv> <message id>". */
interface Star {
  on: boolean
  at: number
}
/** A message waiting for the server to confirm it (kept on disk until then, so it survives going offline). */
interface Outgoing {
  env: Envelope
  conv: ConvId
  mid: string
}
interface Settings {
  readReceipts: boolean
  at: number
}
interface Profile {
  /** Profile picture (base64), or null. */
  avatar: string | null
  mime: string
  /** Display name shown instead of my username ('' or missing: the username). */
  name?: string
  /**
   * In the synced vault: I have a picture, but its bytes aren't in the vault (they reach my other
   * devices as an encrypted profile message, like they reach contacts; the vault has a size limit).
   */
  pic?: boolean
  at: number
  /** When it was last sent to all contacts (it's re-sent before old copies expire on the server). */
  sentAt: number
}
interface StoredAvatar {
  at: number
  mime: string
  bytes: Uint8Array
  /** Their display name, if they set one. */
  name?: string
}
interface Saved {
  server: string
  id: string
  username: string
  /** Device session token; null once the server says it expired. */
  token: string | null
  identity: Identity
  /** Random id this device picked for itself; a sign-out of this device must name it. */
  deviceId?: string
}
interface Held {
  seq: number
  env: Envelope
}

const db = createStore('e2ee-chat', 'data')
const K = {
  session: 'session',
  cursor: 'cursor',
  pins: 'pins',
  groups: 'groups',
  left: 'left',
  prefs: 'prefs',
  stars: 'stars',
  settings: 'settings',
  profile: 'profile',
  meta: 'meta',
  held: 'held',
  conv: (c: ConvId) => `conv:${c}`,
  out: (envId: string) => `out:${envId}`,
  gpic: (groupId: string) => `gpic:${groupId}`,
  /** New keys being sent to the server (kept until it's clear whether the change went through). */
  pendingKeys: 'pendingKeys',
  file: (mid: string) => `file:${mid}`,
  seen: (mid: string) => `seen:${mid}`,
  avatar: (id: string) => `avatar:${id}`,
}
const LS_USER = 'e2ee-chat.lastUsername'
const LS_SERVER = 'e2ee-chat.lastServer'

export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, '')
  if (!s) throw new Error('Enter the server address')
  if (!/^https?:\/\//i.test(s)) {
    s = (/^(localhost|127\.|\[::1\])/.test(s) ? 'http://' : 'https://') + s
  }
  try {
    return new URL(s).origin
  } catch {
    throw new Error('Invalid server address')
  }
}

const wsUrl = (server: string) => server.replace(/^http/i, 'ws') + '/ws'
const pinKeys = (p: Pin): PublicKeys => ({ signPk: unb64(p.signPk), encPk: unb64(p.encPk) })

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ChatState {
  status: ConnectionStatus
  account: Account | null
  error: string | null
  contacts: Dict<Contact>
  requests: { incoming: FriendRequest[]; outgoing: FriendRequest[] }
  groups: Dict<Group>
  conversations: Conversation[]
  active: ConvId | null
  messages: ChatMessage[]
  syncing: boolean
  /** User IDs typing right now, per conversation. */
  typing: Dict<string[]>
  /** Id of the first message that was unread when the active conversation was opened. */
  firstUnread: string | null
  /** state.messages is the newest part of the active conversation; true if there's more before it. */
  hasOlder: boolean
  /** Message to scroll to and highlight (set by openConv with a focus id, e.g. from search). */
  highlight: string | null
  /** Active conversation: user ID → time of the newest message they've read (read receipts). */
  reads: Dict<number>
  /** Users I blocked. */
  blocked: FriendRequest[]
  settings: { readReceipts: boolean }
  /** Starred messages: "<conv> <message id>" → true. Use chat.isStarred(msg). */
  starred: Dict<true>
}

export const state = reactive<ChatState>({
  status: 'offline',
  account: null,
  error: null,
  contacts: dict(),
  requests: { incoming: [], outgoing: [] },
  groups: dict(),
  conversations: [],
  active: null,
  messages: [],
  syncing: false,
  typing: dict(),
  firstUnread: null,
  hasOlder: false,
  highlight: null,
  reads: dict(),
  blocked: [],
  settings: { readReceipts: true },
  starred: dict(),
})

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

interface ServerUser {
  id: string
  name: string
  signPk: string
  encPk: string
  online: boolean
  /** Their chosen status while online (friends only). */
  status?: string
}

const STATUSES = ['online', 'away', 'dnd', 'invisible'] as const
/** online (green), away (yellow), dnd: do not disturb (red, no notifications), invisible (looks offline). */
export type UserStatus = (typeof STATUSES)[number]
const validStatus = (v: unknown): v is UserStatus => STATUSES.includes(v as UserStatus)
/** What a friend's dot shows. */
const shownStatus = (online: boolean, status: unknown): Contact['status'] =>
  !online ? 'offline' : validStatus(status) && status !== 'invisible' ? status : 'online'
interface Welcome {
  type: 'welcome'
  me: { id: string; username: string; status?: string }
  vault: string | null
  token?: string
  bundle?: string
}

type ServerMsg =
  | { type: 'prelogin'; req?: number; salt: string }
  | Welcome
  | { type: 'friends'; friends: ServerUser[]; incoming: FriendRequest[]; outgoing: FriendRequest[]; blocked?: FriendRequest[] }
  | { type: 'presence'; id: string; online: boolean; status?: string }
  | { type: 'status'; status: string }
  | { type: 'deliver'; seq: number; envelope: Envelope }
  | { type: 'signal'; envelope: Envelope }
  | { type: 'synced'; seq: number }
  | { type: 'sent'; id: string; seq: number }
  | { type: 'failed'; id: string; message: string }
  | { type: 'ok'; req: number }
  | { type: 'error'; req?: number; message: string; code?: string; proof?: string }
  | { type: 'users'; req: number; users: ServerUser[] }
  | { type: 'vault'; vault: string }
  | { type: 'sessions'; req: number; sessions: Device[] }
  | { type: 'head'; req: number; seq: number }
  | { type: 'pong' }

/** An error message from the server (as opposed to a network problem). */
class ServerError extends Error {
  /** Set when the client must act on it: "revoked" (this device was signed out), "deleted" (account deleted). */
  readonly code?: string
  /** For revoked / deleted: my signed statement, checked before anything is deleted. */
  readonly proof?: string
  constructor(message: string, code?: string, proof?: string) {
    super(message)
    this.code = code
    this.proof = proof
  }
}

/** One WebSocket connection. Before sign-in, messages are read with next(); afterwards by a handler. */
class Conn {
  readonly ws: WebSocket
  closed = false
  onClose: (() => void) | null = null
  private queue: ServerMsg[] = []
  private waiter: { resolve: (m: ServerMsg) => void; reject: (e: Error) => void } | null = null
  private handler: ((m: ServerMsg) => void) | null = null

  /** When the server last sent anything (a silent socket is dead). */
  lastSeen = Date.now()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = (ev) => {
      this.lastSeen = Date.now()
      if (typeof ev.data !== 'string') return
      let m: ServerMsg
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      if (!m || typeof m !== 'object') return
      if (this.handler) this.handler(m)
      else if (this.waiter) {
        const w = this.waiter
        this.waiter = null
        w.resolve(m)
      } else this.queue.push(m)
    }
    ws.onclose = () => {
      this.closed = true
      const w = this.waiter
      this.waiter = null
      w?.reject(new Error('Lost the connection to the server'))
      this.onClose?.()
    }
  }

  static open(server: string): Promise<Conn> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(wsUrl(server))
      } catch {
        reject(new Error('Invalid server address'))
        return
      }
      const timer = setTimeout(() => ws.close(), 15_000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve(new Conn(ws))
      }
      ws.onclose = () => {
        clearTimeout(timer)
        reject(new Error(`Could not reach ${server}`))
      }
    })
  }

  /** Next message during sign-in. Server errors are thrown as ServerError. */
  async next(): Promise<ServerMsg> {
    const m =
      this.queue.shift() ??
      (await new Promise<ServerMsg>((resolve, reject) => {
        if (this.closed) return reject(new Error('Lost the connection to the server'))
        const timer = setTimeout(() => {
          this.waiter = null
          reject(new Error('The server did not answer'))
          this.close()
        }, 30_000)
        this.waiter = {
          resolve: (m) => (clearTimeout(timer), resolve(m)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        }
      }))
    if (m.type === 'error') throw new ServerError(m.message, isStr(m.code) ? m.code : undefined, isStr(m.proof) ? m.proof : undefined)
    return m
  }

  attach(handler: (m: ServerMsg) => void) {
    this.handler = handler
    for (const m of this.queue.splice(0)) handler(m)
  }

  send(obj: unknown): boolean {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(obj))
    return true
  }

  close() {
    this.ws.close()
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface VaultData {
  pins: Dict<Pin>
  groups: Dict<Group>
  /** Groups I left (id → ms), so other devices don't bring them back. */
  left: Dict<number>
  prefs: Dict<ConvPrefs>
  settings: Settings
  profile: Profile
  stars: Dict<Star>
}

const defaultSettings = (): Settings => ({ readReceipts: true, at: 0 })
const defaultProfile = (): Profile => ({ avatar: null, mime: '', at: 0, sentAt: 0 })

class Session {
  conn: Conn | null = null
  closed = false
  retry = 0
  pingTimer: ReturnType<typeof setInterval> | undefined
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  flushTimer: ReturnType<typeof setTimeout> | undefined
  vaultTimer: ReturnType<typeof setTimeout> | undefined

  /** Highest server seq processed on this device. */
  cursor = 0
  /** True while downloading history onto a device that had none (no unread counts). */
  fresh = false
  pins: Dict<Pin> = dict()
  left: Dict<number> = dict()
  prefs: Dict<ConvPrefs> = dict()
  settings: Settings = defaultSettings()
  profile: Profile = defaultProfile()
  /** Object URLs of group pictures (group ID → URL). */
  groupPicUrls = new Map<string, string>()
  /** Display names contacts chose (user ID → name). */
  names = new Map<string, string>()
  /** Object URLs of profile pictures (user ID → URL); mine under my own ID. */
  avatarUrls = new Map<string, string>()
  /** Contacts to send my profile picture to (new contacts), batched. */
  profileQueue = new Set<string>()
  profileTimer: ReturnType<typeof setTimeout> | undefined
  readTimer: ReturnType<typeof setTimeout> | undefined
  meta: Dict<ConvMeta> = dict()
  /** Every envelope already processed (replay protection), plus ones not yet written to disk. */
  seen = new Set<string>()
  newSeen: string[] = []
  /** Conversation histories loaded from disk, and which ones need writing back. */
  convs = new Map<ConvId, Promise<ChatMessage[]>>()
  dirtyConvs = new Set<ConvId>()
  /** Envelopes waiting on a contact's key change being accepted (or on a failed lookup). */
  held: Held[] = []
  /** What the server currently says about users we've looked up, by ID. */
  serverUsers: Dict<ServerUser> = dict()
  /** When a contact was last looked up again after a message failed to verify (at most once a minute). */
  relooked = new Map<string, number>()
  /** My profile changed since it was last written to disk (it can be large: an animated GIF). */
  profileDirty = false
  /** The vault as last seen on the server. */
  remoteVault: VaultData | null = null
  /** Users the server says don't exist (deleted accounts): left out when sending to a group. */
  gone = new Set<string>()
  /** Session id → that device's own id, from the last device list (needed to sign it out). */
  deviceIds = new Map<string, string>()

  /** Incoming messages are processed one at a time, in order. */
  queue: Promise<unknown> = Promise.resolve()
  /** Message id → object URL of a file I've shown, and its conversation (released when switching away). */
  fileUrls = new Map<string, { url: string; conv: ConvId }>()
  /** When I last sent a typing signal, and to which conversation. */
  typingSent = { at: 0, conv: '' }
  /** "<conv> <user>" → timer that clears that typing indicator. */
  typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Envelope id → my message waiting for the server's "sent" (also on disk, under K.out). */
  outbox = new Map<string, Outgoing>()
  /** Envelope ids handed to the current connection (cleared when it drops; re-sent after the next sync). */
  inflight = new Set<string>()
  /** Envelope ids sent at least once: they may have arrived even without a "sent". */
  tried = new Set<string>()
  stars: Dict<Star> = dict()
  /** Ends timed mutes on screen. */
  muteTimer: ReturnType<typeof setTimeout> | undefined
  requests = new Map<number, { resolve: (m: ServerMsg) => void; reject: (e: Error) => void }>()
  nextReq = 1

  readonly saved: Saved
  constructor(saved: Saved) {
    this.saved = saved
  }
  get me(): string {
    return this.saved.id
  }
  get identity(): Identity {
    return this.saved.identity
  }
}

let session: Session | null = null

function serial<T>(s: Session, fn: () => Promise<T> | T): Promise<T> {
  const p = s.queue.then(fn)
  s.queue = p.then(noop, noop)
  return p
}

function requireSession(): Session {
  if (!session) throw new Error('Not signed in')
  return session
}

function live(s: Session): boolean {
  return session === s && !s.closed
}

/** Sends a request and waits for the matching ok/users/prelogin reply (errors reject). */
function request(s: Session, msg: Record<string, unknown>): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const req = s.nextReq++
    const timer = setTimeout(() => {
      s.requests.delete(req)
      reject(new Error('The server did not answer. Try again.'))
    }, 20_000)
    s.requests.set(req, {
      resolve: (m) => (clearTimeout(timer), resolve(m)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    })
    if (!s.conn?.send({ ...msg, req })) {
      s.requests.get(req)!.reject(new Error('Not connected to the server'))
      s.requests.delete(req)
    }
  })
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function rawGroups(): Dict<Group> {
  return JSON.parse(JSON.stringify({ ...state.groups }))
}

function scheduleFlush(s: Session) {
  if (s.flushTimer) return
  s.flushTimer = setTimeout(() => {
    s.flushTimer = undefined
    void serial(s, () => flush(s)).catch((e) => console.warn('saving failed', e))
  }, 300)
}

/** Writes everything changed in one transaction. Only call from inside serial(). */
async function flush(s: Session) {
  if (!live(s)) return
  const entries: [IDBValidKey, unknown][] = [
    [K.pins, { ...s.pins }],
    [K.groups, rawGroups()],
    [K.left, { ...s.left }],
    [K.prefs, { ...s.prefs }],
    [K.stars, { ...s.stars }],
    [K.settings, s.settings],
    [K.meta, { ...s.meta }],
    [K.held, s.held],
  ]
  for (const c of s.dirtyConvs) {
    const list = await s.convs.get(c)
    if (list) entries.push([K.conv(c), list])
  }
  for (const mid of s.newSeen) entries.push([K.seen(mid), 1])
  const profileDirty = s.profileDirty
  if (profileDirty) entries.push([K.profile, s.profile])
  s.profileDirty = false
  // Last: if anything before it can't be stored, the cursor stays put and the server sends those messages again.
  entries.push([K.cursor, s.cursor])
  const dirty = [...s.dirtyConvs]
  const seen = s.newSeen
  s.dirtyConvs.clear()
  s.newSeen = []
  try {
    await setMany(entries, db)
  } catch (e) {
    for (const c of dirty) s.dirtyConvs.add(c)
    s.newSeen.push(...seen)
    if (profileDirty) s.profileDirty = true
    throw e
  }
}

function markSeen(s: Session, mid: string) {
  s.seen.add(mid)
  s.newSeen.push(mid)
  scheduleFlush(s)
}

// ---------------------------------------------------------------------------
// Vault: contact pins and groups, encrypted, synced between my devices
// ---------------------------------------------------------------------------

function validPin(p: unknown): p is Pin {
  if (!p || typeof p !== 'object') return false
  const q = p as Pin
  return (
    isStr(q.name) &&
    isStr(q.signPk) &&
    isStr(q.encPk) &&
    typeof q.verified === 'boolean' &&
    typeof q.at === 'number' &&
    unb64(q.signPk).length === 32 &&
    unb64(q.encPk).length === 32 &&
    (q.prev === undefined ||
      (Array.isArray(q.prev) && q.prev.length <= MAX_PREV_KEYS &&
        q.prev.every((k) => k && isStr(k.signPk) && unb64(k.signPk).length === 32 && typeof k.until === 'number')))
  )
}

const MAX_PREV_KEYS = 5

function validGroup(g: unknown): g is Group {
  if (!g || typeof g !== 'object') return false
  const q = g as Group
  return validGroupId(q.id) && isStr(q.name) && isIdList(q.members) && (q.admins === undefined || isIdList(q.admins))
}

function validPrefs(p: unknown): p is ConvPrefs {
  if (!p || typeof p !== 'object') return false
  const q = p as ConvPrefs
  return (
    typeof q.muted === 'boolean' && typeof q.pinned === 'boolean' && typeof q.archived === 'boolean' && typeof q.at === 'number' &&
    (q.until === undefined || (typeof q.until === 'number' && Number.isFinite(q.until))) &&
    (q.mentions === undefined || typeof q.mentions === 'boolean')
  )
}

const starKey = (conv: ConvId, mid: string) => `${conv} ${mid}`
/** Most stars (and unstar markers) kept in the vault; the oldest markers go first. */
const MAX_STARS = 3000

function validStarKey(k: string): boolean {
  const sp = k.indexOf(' ')
  return sp > 0 && validConvId(k.slice(0, sp)) && k.length - sp - 1 <= 100
}

const validConvId = (c: string): c is ConvId =>
  (c.startsWith('dm:') && validId(c.slice(3))) || (c.startsWith('g:') && validGroupId(c.slice(2)))

/** Profile pictures: still images are shrunk to fit easily; animated GIFs are kept as they are, up to this size. */
const MAX_AVATAR_BYTES = 10 * 1024 * 1024

function parseVault(raw: unknown): VaultData {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<VaultData>
  const out: VaultData = {
    pins: dict(), groups: dict(), left: dict(), prefs: dict(), settings: defaultSettings(), profile: defaultProfile(), stars: dict(),
  }
  for (const [id, p] of Object.entries(dict(v.pins))) {
    try {
      if (validId(id) && validPin(p)) {
        const pin: Pin = { name: cleanLabel(p.name, 32), signPk: p.signPk, encPk: p.encPk, verified: p.verified, at: p.at }
        if (p.prev?.length) pin.prev = p.prev.map((k) => ({ signPk: k.signPk, until: k.until }))
        out.pins[id] = pin
      }
    } catch {
      /* bad base64 */
    }
  }
  for (const [id, g] of Object.entries(dict(v.groups))) {
    if (validGroup(g) && g.id === id) {
      out.groups[id] = { id, name: cleanLabel(g.name, 64), members: [...new Set(g.members)] }
      if (g.admins) out.groups[id]!.admins = [...new Set(g.admins)]
    }
  }
  for (const [c, p] of Object.entries(dict(v.prefs))) {
    if (validConvId(c) && validPrefs(p)) {
      const q: ConvPrefs = { muted: p.muted, pinned: p.pinned, archived: p.archived, at: p.at }
      if (p.until) q.until = p.until
      if (p.mentions) q.mentions = true
      out.prefs[c] = q
    }
  }
  for (const [k, st] of Object.entries(dict<Star>(v.stars))) {
    if (validStarKey(k) && st && typeof st.on === 'boolean' && typeof st.at === 'number') out.stars[k] = { on: st.on, at: st.at }
  }
  const st = v.settings as Settings | undefined
  if (st && typeof st.readReceipts === 'boolean' && typeof st.at === 'number') out.settings = { readReceipts: st.readReceipts, at: st.at }
  const pr = v.profile as Profile | undefined
  if (
    pr && typeof pr.at === 'number' && typeof pr.sentAt === 'number' && isStr(pr.mime) &&
    (pr.avatar === null || (isStr(pr.avatar) && pr.avatar.length <= (MAX_AVATAR_BYTES * 4) / 3 + 4))
  ) {
    out.profile = { avatar: pr.avatar, mime: safeMime(pr.mime), at: pr.at, sentAt: pr.sentAt }
    const name = isStr(pr.name) ? cleanLabel(pr.name, MAX_DISPLAY_NAME) : ''
    if (name) out.profile.name = name
    if (pr.pic === true) out.profile.pic = true
  }
  for (const [id, t] of Object.entries(dict(v.left))) if (validGroupId(id) && typeof t === 'number') out.left[id] = t
  return out
}

/** Does this device know something the server's copy doesn't? */
function vaultBehind(s: Session): boolean {
  const r = s.remoteVault
  if (!r) {
    return (
      Object.keys(s.pins).length > 0 || Object.keys(state.groups).length > 0 || Object.keys(s.left).length > 0 ||
      Object.keys(s.prefs).length > 0 || s.settings.at > 0 || s.profile.at > 0 || Object.keys(s.stars).length > 0
    )
  }
  for (const [id, p] of Object.entries(s.pins)) if (!r.pins[id] || p.at > r.pins[id]!.at) return true
  for (const [id, t] of Object.entries(s.left)) if (!r.left[id] || t > r.left[id]!) return true
  for (const id of Object.keys(state.groups)) if (!r.groups[id]) return true
  // Removed here (e.g. I was kicked): the server's copy mustn't bring it back.
  for (const [id, g] of Object.entries(r.groups)) if (!state.groups[id] && g.members.includes(s.me)) return true
  for (const [c, p] of Object.entries(s.prefs)) if (!r.prefs[c] || p.at > r.prefs[c]!.at) return true
  for (const [k, st] of Object.entries(s.stars)) if (!r.stars[k] || st.at > r.stars[k]!.at) return true
  if (s.settings.at > r.settings.at || s.profile.at > r.profile.at || s.profile.sentAt > r.profile.sentAt) return true
  return false
}

function scheduleVaultPush(s: Session) {
  clearTimeout(s.vaultTimer)
  s.vaultTimer = setTimeout(() => void pushVault(s), 1500)
}

async function pushVault(s: Session) {
  if (!live(s) || !s.conn || !vaultBehind(s)) return
  const data = vaultData(s)
  try {
    await request(s, { type: 'vault_put', vault: sealVault(s.identity, data) })
    s.remoteVault = parseVault(data)
  } catch (e) {
    console.warn('could not sync settings', e)
  }
}

/** Merges the server's vault into local state. Only call from inside serial(). */
async function applyVault(s: Session, sealed: string | null | undefined) {
  if (!live(s)) return
  if (isStr(sealed)) {
    let remote: VaultData
    try {
      remote = parseVault(openVault(s.identity, sealed))
    } catch (e) {
      console.warn('could not open synced settings', e)
      return
    }
    s.remoteVault = remote
    let pinsChanged = false
    for (const [id, p] of Object.entries(remote.pins)) {
      if (id === s.me) continue
      const local = s.pins[id]
      if (local && local.at >= p.at) continue
      s.pins[id] = { ...p }
      updateContactFromPin(s, id)
      pinsChanged = true
    }
    for (const [id, t] of Object.entries(remote.left)) {
      s.left[id] = Math.max(s.left[id] ?? 0, t)
      if (state.groups[id]) await removeGroupLocally(s, id)
    }
    for (const [id, g] of Object.entries(remote.groups)) {
      if (!state.groups[id] && !s.left[id] && g.members.includes(s.me)) state.groups[id] = g
    }
    for (const [c, p] of Object.entries(remote.prefs)) {
      if (!s.prefs[c] || p.at > s.prefs[c]!.at) s.prefs[c] = p
    }
    let starsChanged = false
    for (const [k, st] of Object.entries(remote.stars)) {
      if (!s.stars[k] || st.at > s.stars[k]!.at) {
        s.stars[k] = st
        starsChanged = true
      }
    }
    if (starsChanged) showStars(s)
    if (remote.settings.at > s.settings.at) {
      s.settings = remote.settings
      state.settings = { readReceipts: s.settings.readReceipts }
    }
    if (remote.profile.at > s.profile.at) {
      // The picture's bytes come separately (own profile message), unless an older app put them in.
      s.profile = { ...remote.profile }
      s.profileDirty = true
      showMyAvatar(s)
    } else if (remote.profile.at === s.profile.at && remote.profile.sentAt > s.profile.sentAt) {
      s.profile.sentAt = remote.profile.sentAt
      s.profileDirty = true
    }
    scheduleFlush(s)
    refreshConversations()
    if (pinsChanged) await retryHeld(s)
  } else {
    s.remoteVault = null
  }
  if (vaultBehind(s)) scheduleVaultPush(s)
}

// ---------------------------------------------------------------------------
// Contacts & key pinning (trust on first use, then explicit re-trust)
// ---------------------------------------------------------------------------

function parseUser(u: unknown): (ServerUser & { keys: PublicKeys }) | null {
  if (!u || typeof u !== 'object') return null
  const v = u as ServerUser
  if (!validId(v.id) || !isStr(v.name) || !isStr(v.signPk) || !isStr(v.encPk)) return null
  try {
    const keys = { signPk: unb64(v.signPk), encPk: unb64(v.encPk) }
    if (keys.signPk.length !== 32 || keys.encPk.length !== 32) return null
    return { id: v.id, name: cleanLabel(v.name, 32), signPk: v.signPk, encPk: v.encPk, online: !!v.online, status: v.status, keys }
  } catch {
    return null
  }
}

/** Rebuilds a contact's state from its pin and what the server last said. */
function updateContactFromPin(s: Session, id: string, patch: Partial<Contact> = {}) {
  const pin = s.pins[id]
  if (!pin) return
  const prev = state.contacts[id]
  const server = s.serverUsers[id]
  const serverKeys = server ? { signPk: unb64(server.signPk), encPk: unb64(server.encPk) } : null
  const changed = !!serverKeys && !sameKeys(pinKeys(pin), serverKeys)
  state.contacts[id] = {
    id,
    name: s.names.get(id) || pin.name,
    username: pin.name,
    friend: prev?.friend ?? false,
    online: prev?.online ?? false,
    status: prev?.status ?? 'offline',
    fingerprint: fingerprint(pinKeys(pin)),
    verified: pin.verified,
    keyChanged: changed,
    pendingFingerprint: changed ? fingerprint(serverKeys!) : null,
    avatar: s.avatarUrls.get(id) ?? null,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Profile pictures
// ---------------------------------------------------------------------------

function setAvatarUrl(s: Session, id: string, bytes: Uint8Array | null, mime: string) {
  const old = s.avatarUrls.get(id)
  if (old) URL.revokeObjectURL(old)
  s.avatarUrls.delete(id)
  if (bytes?.length) {
    s.avatarUrls.set(id, URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: safeMime(mime) })))
  }
}

function showMyAvatar(s: Session) {
  let bytes: Uint8Array | null = null
  try {
    bytes = s.profile.avatar ? unb64(s.profile.avatar) : null
  } catch {
    /* corrupt: show initials */
  }
  setAvatarUrl(s, s.me, bytes, s.profile.mime)
  if (state.account) {
    state.account.avatar = s.avatarUrls.get(s.me) ?? null
    state.account.displayName = s.profile.name || s.saved.username
  }
}

const MAX_DISPLAY_NAME = 32

/** Stores a contact's profile picture and display name if newer than what I have. Only call from inside serial(). */
async function receiveProfile(s: Session, sender: string, ts: number, mime: string, bytes: Uint8Array, rawName?: string) {
  if (bytes.length > MAX_AVATAR_BYTES || (bytes.length && !SAFE_MIME.has(mime))) return
  const prev = await get<StoredAvatar>(K.avatar(sender), db)
  if (prev && prev.at >= ts) return
  const name = rawName ? cleanLabel(rawName, MAX_DISPLAY_NAME) : ''
  const stored: StoredAvatar = { at: ts, mime, bytes }
  if (name) stored.name = name
  await set(K.avatar(sender), stored, db)
  if (!live(s)) return
  setAvatarUrl(s, sender, bytes, mime)
  setDisplayNameOf(s, sender, name)
}

/** A contact's chosen name (or '' for their username); shown everywhere instead of the username. */
function setDisplayNameOf(s: Session, id: string, name: string) {
  if (name) s.names.set(id, name)
  else s.names.delete(id)
  if (state.contacts[id]) updateContactFromPin(s, id)
  refreshConversations()
}

/** Everyone I can send to: pinned contacts whose key hasn't changed. */
function profileAudience(s: Session): string[] {
  const ids = new Set(Object.values(state.contacts).filter((c) => c.friend).map((c) => c.id))
  for (const g of Object.values(state.groups)) for (const id of g.members) ids.add(id)
  const blocked = new Set(state.blocked.map((b) => b.id))
  return [...ids].filter((id) => id !== s.me && s.pins[id] && !blocked.has(id) && !state.contacts[id]?.keyChanged)
}

/** Sends my profile picture (or its removal) to these contacts, in batches. */
function sendProfile(s: Session, ids: string[]) {
  const bytes = s.profile.avatar ? unb64(s.profile.avatar) : new Uint8Array(0)
  const at = s.profile.at || Date.now()
  const body: PayloadBody = { t: 'profile', mime: s.profile.mime }
  if (s.profile.name) body.name = s.profile.name
  // Every envelope is also for me, so my other devices get it too (even with no contacts yet).
  for (let i = 0; i === 0 || i < ids.length; i += 200) {
    sendEnvelope(s, ids.slice(i, i + 200), { conv: { t: 'dm' }, body }, bytes, randomId(), at)
  }
}

/** My profile from another of my devices. Only call from inside serial(). */
function receiveOwnProfile(s: Session, ts: number, mime: string, bytes: Uint8Array, rawName?: string) {
  if (bytes.length > MAX_AVATAR_BYTES || (bytes.length && !SAFE_MIME.has(mime))) return
  const p = s.profile
  // Newer, or the bytes for the picture the vault told me about.
  const fills = ts === p.at && !p.avatar && !!p.pic && bytes.length > 0
  if (ts <= p.at && !fills) return
  const name = rawName ? cleanLabel(rawName, MAX_DISPLAY_NAME) : ''
  s.profile = { avatar: bytes.length ? b64(bytes) : null, mime: bytes.length ? safeMime(mime) : '', at: ts, sentAt: Math.max(p.sentAt, ts) }
  if (name) s.profile.name = name
  else if (fills && p.name) s.profile.name = p.name
  s.profileDirty = true
  showMyAvatar(s)
  refreshConversations()
  scheduleFlush(s)
}

/** New contacts get my picture shortly after I first see them. */
function queueProfile(s: Session, id: string) {
  if ((!s.profile.avatar && !s.profile.name) || s.fresh) return
  s.profileQueue.add(id)
  if (s.profileTimer) return
  s.profileTimer = setTimeout(() => {
    s.profileTimer = undefined
    const audience = new Set(profileAudience(s))
    const ids = [...s.profileQueue].filter((x) => audience.has(x))
    s.profileQueue.clear()
    if (!live(s) || !ids.length) return
    try {
      sendProfile(s, ids)
    } catch (e) {
      console.warn('could not send profile picture', e)
    }
  }, 3000)
}

/** Messages on the server expire, so my picture is re-sent to everyone every 60 days. */
function refreshProfile(s: Session) {
  if ((!s.profile.avatar && !s.profile.name) || Date.now() - s.profile.sentAt < 60 * 86_400_000) return
  try {
    sendProfile(s, profileAudience(s))
    s.profile.sentAt = Date.now()
    s.profileDirty = true
    scheduleFlush(s)
    scheduleVaultPush(s)
  } catch (e) {
    console.warn('could not send profile picture', e)
  }
}

/** Records what the server says about a user; pins their keys if `pin` and not pinned yet. Returns true if a pin was added. */
function applyServerUser(s: Session, raw: unknown, opts: { pin: boolean; friend?: boolean }): boolean {
  const u = parseUser(raw)
  if (!u || u.id === s.me) return false
  s.serverUsers[u.id] = u
  let added = false
  if (!s.pins[u.id] && opts.pin) {
    s.pins[u.id] = { name: u.name, signPk: u.signPk, encPk: u.encPk, verified: false, at: 0 }
    added = true
    queueProfile(s, u.id)
  }
  // A pinned contact's name never changes (usernames are fixed), so the server can't relabel keys.
  const patch: Partial<Contact> = {}
  if (opts.friend !== undefined) {
    patch.friend = opts.friend
    patch.online = u.online
    patch.status = shownStatus(u.online, u.status)
  }
  updateContactFromPin(s, u.id, patch)
  return added
}

function pinsChanged(s: Session) {
  scheduleFlush(s)
  scheduleVaultPush(s)
  refreshConversations()
}

/** Asks the server about users we haven't heard about this session. */
async function lookup(s: Session, ids: string[]) {
  const missing = [...new Set(ids)].filter((id) => validId(id) && id !== s.me && !s.serverUsers[id])
  if (!missing.length) return
  const res = await request(s, { type: 'lookup', ids: missing })
  if (res.type !== 'users' || !Array.isArray(res.users)) return
  for (const u of res.users) applyServerUser(s, u, { pin: false })
  for (const id of missing) if (!s.serverUsers[id]) s.gone.add(id)
}

/** Makes sure we have pinned keys for these users (trust on first use). */
async function ensurePinned(s: Session, ids: string[]) {
  const need = ids.filter((id) => id !== s.me && !s.pins[id])
  if (!need.length) return
  await lookup(s, need)
  let added = false
  for (const id of need) {
    const u = s.serverUsers[id]
    if (u) added = applyServerUser(s, u, { pin: true }) || added
  }
  if (added) pinsChanged(s)
}

function applyFriends(s: Session, m: Extract<ServerMsg, { type: 'friends' }>) {
  const ids = new Set<string>()
  let added = false
  for (const u of Array.isArray(m.friends) ? m.friends : []) {
    added = applyServerUser(s, u, { pin: true, friend: true }) || added
    if (validId(u?.id)) ids.add(u.id)
  }
  for (const c of Object.values(state.contacts)) {
    if (!ids.has(c.id)) {
      c.friend = false
      c.online = false
      c.status = 'offline'
    }
  }
  const reqs = (list: unknown): FriendRequest[] =>
    (Array.isArray(list) ? list : [])
      .filter((r): r is FriendRequest => !!r && validId(r.id) && isStr(r.name) && typeof r.ts === 'number')
      .map((r) => ({ id: r.id, name: cleanLabel(r.name, 32), ts: r.ts }))
  state.requests = { incoming: reqs(m.incoming), outgoing: reqs(m.outgoing) }
  state.blocked = reqs(m.blocked)
  if (added) pinsChanged(s)
  refreshConversations()
}

function recipientKeys(s: Session, ids: string[]) {
  const out = [{ name: s.me, encPk: s.identity.encPk }]
  for (const id of new Set(ids)) {
    if (id === s.me) continue
    const pin = s.pins[id]
    if (!pin) throw new Error(`Unknown user ${formatId(id)}`)
    if (state.contacts[id]?.keyChanged) {
      throw new Error(`${displayName(id)}'s security key changed. Verify it before sending.`)
    }
    out.push({ name: id, encPk: unb64(pin.encPk) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------------

/** Muted right now: a timed mute that ran out no longer counts. */
function isMuted(p: ConvPrefs | undefined, now = Date.now()): boolean {
  return !!p?.muted && (!p.until || now < p.until)
}

function refreshConversations() {
  const s = session
  if (!s) return
  const now = Date.now()
  let nextEnd = Infinity
  const list: Conversation[] = []
  const add = (id: ConvId, kind: 'dm' | 'group', title: string) => {
    const m = s.meta[id] ?? { unread: 0, lastTs: 0, preview: '' }
    const p = s.prefs[id]
    const muted = isMuted(p, now)
    if (muted && p!.until) nextEnd = Math.min(nextEnd, p!.until)
    list.push({
      id, kind, title, unread: m.unread, lastTs: m.lastTs, preview: m.preview,
      muted, mutedUntil: muted && p!.until ? p!.until : null, mentionsOnly: !!p?.mentions,
      pinned: !!p?.pinned, archived: !!p?.archived,
      avatar: kind === 'group' ? (s.groupPicUrls.get(id.slice(2)) ?? null) : (s.avatarUrls.get(id.slice(3)) ?? null),
    })
  }
  clearTimeout(s.muteTimer)
  s.muteTimer = undefined
  if (nextEnd < Infinity) {
    s.muteTimer = setTimeout(() => live(s) && refreshConversations(), Math.min(Math.max(nextEnd - now + 50, 1000), 2 ** 31 - 1))
  }
  for (const g of Object.values(state.groups)) add(`g:${g.id}`, 'group', g.name)
  for (const c of Object.values(state.contacts)) {
    if (c.friend || s.meta[`dm:${c.id}`]) add(`dm:${c.id}`, 'dm', c.name)
  }
  list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTs - a.lastTs || a.title.localeCompare(b.title))
  state.conversations = list
}

function previewOf(m: ChatMessage): string {
  if (m.kind === 'file') return `📎 ${m.file?.name ?? 'file'}`
  if (m.kind === 'system') return m.text ?? ''
  const text = docToText(m.doc)
  return text.length > 80 ? text.slice(0, 80) + '…' : text
}

function loadConv(s: Session, conv: ConvId): Promise<ChatMessage[]> {
  let p = s.convs.get(conv)
  if (!p) {
    p = get<ChatMessage[]>(K.conv(conv), db).then((l) => {
      const list = Array.isArray(l) ? l : []
      // "Sending" without a queued copy: the app closed between the server's "sent" and saving it,
      // or it's from an older version. Shown as failed, so it can be sent again (same id: no duplicates).
      for (const m of list) {
        if (m.status === 'sending' && m.from === s.me && !s.outbox.has(m.id.slice(s.me.length + 1))) {
          m.status = 'failed'
          s.dirtyConvs.add(conv)
        }
      }
      return list
    })
    s.convs.set(conv, p)
  }
  return p
}

async function appendMessage(s: Session, m: ChatMessage, countUnread: boolean) {
  const list = await loadConv(s, m.conv)
  if (!live(s) || list.some((x) => x.id === m.id)) return
  // Keep sorted by time; history and live messages may interleave.
  let i = list.length
  while (i > 0 && list[i - 1]!.ts > m.ts) i--
  list.splice(i, 0, m)
  s.dirtyConvs.add(m.conv)

  const meta = s.meta[m.conv] ?? { unread: 0, lastTs: 0, preview: '' }
  if (m.ts >= meta.lastTs) {
    meta.lastTs = m.ts
    meta.preview = previewLine(s, m)
  }
  // Also counted in the open chat while the app isn't being looked at (cleared on return).
  if (countUnread && !s.fresh && (state.active !== m.conv || !watching())) meta.unread++
  s.meta[m.conv] = meta
  if (countUnread && !s.fresh) {
    const p = s.prefs[m.conv]
    if (p?.archived && !isMuted(p) && m.ts > p.at) setPrefs(s, m.conv, { archived: false })
    if (state.active === m.conv) scheduleRead(s)
  }
  scheduleFlush(s)
  if (m.from) stopTyping(m.conv, m.from)
  if (countUnread && !s.fresh) {
    for (const cb of incomingListeners) {
      try {
        cb(m)
      } catch (e) {
        console.warn('incoming listener failed', e)
      }
    }
  }

  // With older messages not on screen, ones from before the first shown are picked up by loadOlder.
  if (state.active === m.conv && !(state.hasOlder && state.messages.length && m.ts < state.messages[0]!.ts)) {
    let j = state.messages.length
    while (j > 0 && state.messages[j - 1]!.ts > m.ts) j--
    state.messages.splice(j, 0, m)
  }
  refreshConversations()
}

/** Sidebar preview: "alice: hi" in groups, "hi" in DMs. */
function previewLine(s: Session, m: ChatMessage): string {
  const prefix = m.conv.startsWith('g:') && m.kind !== 'system' ? `${m.from === s.me ? 'You' : displayName(m.from)}: ` : ''
  return prefix + previewOf(m)
}

/**
 * Applies an edit, delete or reaction to a message in `conv`. Edits and deletes only
 * work on the author's own messages. Only call from inside serial(), or for my own changes.
 */
async function applyChange(s: Session, conv: ConvId, sender: string, body: PayloadBody, ts: number) {
  if (body.t !== 'edit' && body.t !== 'delete' && body.t !== 'react') return
  const list = await loadConv(s, conv)
  if (!live(s)) return
  const i = list.findIndex((x) => x.id === body.target)
  const m = list[i]
  if (!m || m.kind === 'system') return
  // The same object as in `list`, through the reactive proxy when it's on screen.
  const target = state.messages.find((x) => x.id === m.id && x.conv === conv) ?? m
  if (body.t === 'react') {
    const r = dict<string[]>(m.reactions)
    const users = (r[body.emoji] ?? []).filter((u) => u !== sender)
    if (body.on) {
      if (!r[body.emoji] && Object.keys(r).length >= 20) return
      users.push(sender)
    }
    if (users.length) r[body.emoji] = users
    else delete r[body.emoji]
    target.reactions = Object.keys(r).length ? r : undefined
  } else if (m.from !== sender) {
    return
  } else if (body.t === 'edit') {
    if (m.kind !== 'text') return
    target.doc = body.doc
    target.edited = ts
  } else {
    list.splice(i, 1)
    const j = state.messages.findIndex((x) => x.id === m.id && x.conv === conv)
    if (j >= 0) state.messages.splice(j, 1)
    if (state.firstUnread === m.id) state.firstUnread = null
    const meta = s.meta[conv]
    if (meta?.unread && m.from !== s.me && m.ts > (meta.readTs ?? 0)) {
      meta.unread = Math.max(0, meta.unread - 1)
      refreshConversations()
    }
    const key = starKey(conv, m.id)
    if (s.stars[key]?.on) {
      s.stars[key] = { on: false, at: Math.max(Date.now(), s.stars[key]!.at + 1) }
      showStars(s)
      scheduleVaultPush(s)
    }
    if (m.kind === 'file') {
      await delMany([K.file(m.id)], db)
      const f = s.fileUrls.get(m.id)
      if (f) URL.revokeObjectURL(f.url)
      s.fileUrls.delete(m.id)
    }
  }
  s.dirtyConvs.add(conv)
  const meta = s.meta[conv]
  if (meta && body.t !== 'react') {
    const last = list[list.length - 1]
    meta.preview = last ? previewLine(s, last) : ''
    refreshConversations()
  }
  scheduleFlush(s)
}

/** What a reply shows of the message it answers: my own copy if I have it. */
async function resolveReply(s: Session, conv: ConvId, r: ReplyRef): Promise<ReplyRef> {
  const local = (await loadConv(s, conv)).find((x) => x.id === r.id)
  if (local) return { id: r.id, from: local.from, preview: previewOf(local).slice(0, 120) }
  return { id: r.id.slice(0, 64), from: r.from, preview: cleanLabel(r.preview, 120) }
}

function stopTyping(conv: string, user: string) {
  const key = `${conv} ${user}`
  const t = session?.typingTimers.get(key)
  if (t) clearTimeout(t)
  session?.typingTimers.delete(key)
  const list = state.typing[conv]
  if (!list?.includes(user)) return
  const rest = list.filter((u) => u !== user)
  if (rest.length) state.typing[conv] = rest
  else delete state.typing[conv]
}

/** A live typing signal: shown for a few seconds, never stored. */
function handleSignal(s: Session, env: Envelope) {
  if (!env || typeof env !== 'object' || !isStr(env.id) || !validId(env.from) || !Array.isArray(env.keys)) return
  if (typeof env.ts !== 'number' || Math.abs(Date.now() - env.ts) > 30_000) return
  const sender = env.from
  const pin = s.pins[sender]
  if (sender === s.me || !pin || state.contacts[sender]?.keyChanged) return
  let header: PayloadHeader
  try {
    header = decodePayload(openAny([s.identity, ...(s.identity.old ?? [])], s.me, unb64(pin.signPk), env)).header
  } catch {
    return
  }
  if (!validHeader(header) || header.body.t !== 'typing' || state.blocked.some((b) => b.id === sender)) return
  let conv: ConvId
  if (header.conv.t === 'dm') {
    if (!state.contacts[sender]?.friend) return
    conv = `dm:${sender}`
  } else {
    const g = state.groups[header.conv.id]
    if (!g || !g.members.includes(sender)) return
    conv = `g:${g.id}`
  }
  const list = state.typing[conv] ?? []
  if (!list.includes(sender)) state.typing[conv] = [...list, sender]
  const key = `${conv} ${sender}`
  clearTimeout(s.typingTimers.get(key))
  s.typingTimers.set(key, setTimeout(() => live(s) && stopTyping(conv, sender), 6000))
}

function setPrefs(s: Session, conv: ConvId, patch: Partial<Omit<ConvPrefs, 'at'>>) {
  const cur = s.prefs[conv] ?? { muted: false, pinned: false, archived: false, at: 0 }
  const next: ConvPrefs = { ...cur, ...patch, at: Math.max(Date.now(), cur.at + 1) }
  if (!next.muted || !next.until) delete next.until
  if (!next.mentions) delete next.mentions
  s.prefs[conv] = next
  scheduleFlush(s)
  scheduleVaultPush(s)
  refreshConversations()
}

/** Puts the starred messages in state.starred. */
function showStars(s: Session) {
  const out = dict<true>()
  for (const [k, st] of Object.entries(s.stars)) if (st.on) out[k] = true
  state.starred = out
}

/** Does this message from someone else mention me (@my name) or reply to one of my messages? */
function mentionsMe(s: Session, m: ChatMessage): boolean {
  if (!m.from || m.from === s.me) return false
  if (m.reply?.from === s.me) return true
  if (m.kind !== 'text') return false
  const text = docToText(m.doc).toLowerCase()
  const names = new Set([s.saved.username, s.profile.name].filter((n): n is string => !!n).map((n) => n.toLowerCase()))
  for (const name of names) {
    for (let i = text.indexOf('@' + name); i >= 0; i = text.indexOf('@' + name, i + 1)) {
      const after = text[i + 1 + name.length]
      if (after === undefined || !/[a-z0-9_.]/.test(after)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Read receipts
// ---------------------------------------------------------------------------

/**
 * Is the user looking at the app? The desktop app reports its window focus (setWindowActive),
 * since a window hidden in the tray doesn't always look hidden to the page.
 */
let windowActive: boolean | null = null
/** Is the open chat actually on screen (not the friends view, not the chat list on a phone)? */
let convVisible = true
const watching = () =>
  convVisible && typeof document !== 'undefined' && document.visibilityState === 'visible' && (windowActive ?? document.hasFocus())

/** The UI says whether the open chat is on screen; messages in it only count as read while it is. */
export function setConvVisible(visible: boolean) {
  if (convVisible === visible) return
  convVisible = visible
  if (visible) poke()
}

/** Desktop app: the window gained or lost focus (or was hidden). */
export function setWindowActive(active: boolean) {
  windowActive = active
  if (active) poke()
}

export function isWatching(): boolean {
  return watching()
}

/** Back in the app with a chat open: what arrived meanwhile is read now (marked with the New line). */
function catchUpActive(s: Session) {
  const conv = state.active
  const meta = conv ? s.meta[conv] : undefined
  if (!conv || !meta?.unread) return
  const n = meta.unread
  meta.unread = 0
  scheduleFlush(s)
  refreshConversations()
  {
    const shown = state.messages
    let left = n
    for (let i = shown.length - 1; i >= 0 && left > 0; i--) {
      const m = shown[i]!
      if (m.from && m.from !== s.me) {
        state.firstUnread = m.id
        left--
      }
    }
  }
}

function poke() {
  if (!session || !state.active || !watching()) return
  catchUpActive(session)
  scheduleRead(session)
}

function scheduleRead(s: Session) {
  clearTimeout(s.readTimer)
  s.readTimer = setTimeout(() => void sendRead(s), 800)
}

/**
 * Tells my other devices (and, if read receipts are on, the others in the chat) that I've
 * read the active conversation up to its newest message from someone else.
 */
async function sendRead(s: Session) {
  const conv = state.active
  if (!live(s) || !conv || !watching() || !s.conn) return
  const list = await loadConv(s, conv)
  let ts = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!
    if (m.from && m.from !== s.me) {
      ts = m.ts
      break
    }
  }
  const meta = s.meta[conv]
  if (!ts || !meta || (meta.readTs ?? 0) >= ts || state.active !== conv) return
  try {
    const { pc, to } = await targetsOf(s, conv)
    const body: PayloadBody = { t: 'read', ts }
    if (conv.startsWith('dm:')) body.with = conv.slice(3)
    sendEnvelope(s, s.settings.readReceipts ? to : [], { conv: pc, body })
    meta.readTs = ts
    scheduleFlush(s)
  } catch {
    /* tried again on the next message or focus */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', poke)
  document.addEventListener('visibilitychange', poke)
  // Back online or back to the app: reconnect now instead of waiting out the backoff.
  const retryNow = () => {
    const s = session
    if (!s || s.closed || s.conn || document.visibilityState !== 'visible') return
    s.retry = 0
    clearTimeout(s.reconnectTimer)
    void reconnect(s)
  }
  window.addEventListener('online', retryNow)
  document.addEventListener('visibilitychange', retryNow)
}

/** A read receipt: mine (from another device) clears unread here; others' show as "Seen". */
async function applyRead(s: Session, conv: ConvId, sender: string, ts: number) {
  const meta = s.meta[conv] ?? { unread: 0, lastTs: 0, preview: '' }
  if (sender === s.me) {
    if ((meta.readTs ?? 0) >= ts) return
    meta.readTs = ts
    if (meta.unread) {
      const list = await loadConv(s, conv)
      meta.unread = list.filter((m) => m.from && m.from !== s.me && m.ts > ts).length
    }
  } else {
    const reads = dict<number>(meta.reads)
    if ((reads[sender] ?? 0) >= ts) return
    reads[sender] = ts
    meta.reads = reads
    if (state.active === conv) state.reads = { ...reads }
  }
  s.meta[conv] = meta
  scheduleFlush(s)
  refreshConversations()
}

// ---------------------------------------------------------------------------
// Group admin
// ---------------------------------------------------------------------------

/** Groups from before admins existed have no list: everyone in them is an admin. */
const isAdmin = (g: Group, id: string) => !g.admins || g.admins.includes(id)

type GroupOp = Extract<PayloadBody, { t: 'gname' | 'gkick' | 'gadmin' }>

/** Applies a rename, removal or admin change by `sender`. Only call from inside serial(), or for my own changes. */
async function applyGroupOp(s: Session, sender: string, body: GroupOp, ts: number) {
  const g = state.groups[body.id]
  if (!g || !g.members.includes(sender) || !isAdmin(g, sender)) return
  const conv: ConvId = `g:${g.id}`
  const who = sender === s.me ? 'You' : displayName(sender)
  if (body.t === 'gname') {
    const name = cleanLabel(body.name, 64)
    if (!name || name === g.name) return
    g.name = name
    groupsChanged(s)
    await systemMessage(s, conv, `${who} renamed the group to “${name}”`, ts)
    return
  }
  const member = body.member
  if (!g.members.includes(member)) return
  const whom = member === s.me ? 'you' : displayName(member)
  if (body.t === 'gkick') {
    if (member === sender) return
    if (member === s.me) {
      await removeGroupLocally(s, g.id, false)
      // Sync now: until the server's copy drops it, a reload would bring the group back.
      clearTimeout(s.vaultTimer)
      void pushVault(s)
      if (!s.fresh) state.error = `${displayName(sender)} removed you from “${g.name}”`
      return
    }
    g.members = g.members.filter((id) => id !== member)
    if (g.admins) g.admins = g.admins.filter((id) => id !== member)
    groupsChanged(s)
    await systemMessage(s, conv, `${who} removed ${whom}`, ts)
    return
  }
  const admins = new Set(g.admins ?? g.members)
  if (body.on === admins.has(member) && g.admins) return
  if (body.on) admins.add(member)
  else admins.delete(member)
  if (!admins.size) return // a group always keeps an admin
  g.admins = g.members.filter((id) => admins.has(id))
  groupsChanged(s)
  await systemMessage(s, conv, body.on ? `${who} made ${whom} an admin` : `${who} removed ${whom} as admin`, ts)
}

async function systemMessage(s: Session, conv: ConvId, text: string, ts = Date.now()) {
  await appendMessage(
    s,
    { id: msgId('', randomId()), conv, from: '', ts, kind: 'system', text, status: 'received' },
    false,
  )
}

async function updateMessageStatus(s: Session, conv: ConvId, mid: string, status: ChatMessage['status']) {
  const shown = state.messages.find((m) => m.id === mid && m.conv === conv)
  if (shown) shown.status = status
  const m = (await loadConv(s, conv)).find((x) => x.id === mid)
  if (m && m.status !== status) {
    m.status = status
    s.dirtyConvs.add(conv)
    scheduleFlush(s)
  }
}

function groupsChanged(s: Session) {
  scheduleFlush(s)
  scheduleVaultPush(s)
  refreshConversations()
}

const names = (ids: string[]) => ids.map(displayName).join(', ')

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

async function receive(s: Session, seq: number, env: Envelope) {
  if (typeof seq !== 'number' || seq <= s.cursor) return
  try {
    await receiveEnvelope(s, seq, env)
  } catch (e) {
    console.warn('dropping message', e)
  } finally {
    s.cursor = Math.max(s.cursor, seq)
    scheduleFlush(s)
  }
}

async function receiveEnvelope(s: Session, seq: number, env: Envelope) {
  if (!live(s)) return
  if (!env || typeof env !== 'object' || !isStr(env.id) || env.id.length > 64 || !validId(env.from) || !Array.isArray(env.keys)) return
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return
  const sender = env.from
  const mine = sender === s.me
  const mid = msgId(sender, env.id)
  if (s.seen.has(mid)) {
    if (mine) await confirmSent(s, env.id)
    return
  }

  let signPk: Uint8Array
  if (mine) {
    signPk = s.identity.signPk
  } else {
    const pin = s.pins[sender]
    if (pin && !s.serverUsers[sender]) {
      try {
        await lookup(s, [sender]) // notices key changes
      } catch {
        /* offline: the pin is enough */
      }
    }
    if (state.contacts[sender]?.keyChanged) {
      s.held.push({ seq, env })
      scheduleFlush(s)
      return
    }
    if (pin) {
      signPk = unb64(pin.signPk)
    } else {
      try {
        await lookup(s, [sender])
      } catch {
        s.held.push({ seq, env }) // retried after the next sync
        scheduleFlush(s)
        return
      }
      const u = s.serverUsers[sender]
      if (!u) return // account no longer exists
      signPk = unb64(u.signPk)
    }
  }

  // My earlier keys (after changing keys) still decrypt what was sent to them. As a signature on
  // my own messages, an earlier key only counts for messages stored before it was replaced.
  const myKeys = [s.identity, ...(s.identity.old ?? [])]
  let signers: Uint8Array[]
  if (mine) {
    signers = [s.identity.signPk, ...(s.identity.old ?? []).filter((o) => seq <= (o.until ?? 0)).map((o) => o.signPk)]
  } else {
    // A contact's earlier key (they changed keys) only for messages dated before I accepted the new one.
    const prev = (s.pins[sender]?.prev ?? []).filter((k) => env.ts < k.until).map((k) => unb64(k.signPk))
    signers = [signPk, ...prev]
  }
  const signer = signers.find((pk) => signedBy(pk, env))
  let plain: Uint8Array | null = null
  if (signer) {
    try {
      plain = openAny(myKeys, s.me, signer, env)
    } catch {
      /* not for me / damaged */
    }
  }
  if (!signer && !mine && s.pins[sender]) {
    // Not signed with the key I know: maybe they changed their keys. Ask the server again (at most
    // once a minute per person); if it reports new keys, hold the message until they're accepted.
    const last = s.relooked.get(sender) ?? 0
    if (Date.now() - last > 60_000) {
      s.relooked.set(sender, Date.now())
      delete s.serverUsers[sender]
      try {
        await lookup(s, [sender])
      } catch {
        s.held.push({ seq, env }) // can't tell now: try again after the next sync
        scheduleFlush(s)
        return
      }
      if (state.contacts[sender]?.keyChanged) {
        s.held.push({ seq, env })
        scheduleFlush(s)
        return
      }
    }
  }
  if (!plain) {
    console.warn(`dropping undecryptable message from ${sender}`)
    return
  }
  // The envelope is authentic: whatever happens next, never process it twice.
  try {
    const { header, attachment } = decodePayload(plain!)
    if (!validHeader(header)) throw new Error('invalid header')
    const ts = Math.min(env.ts, Date.now() + 60_000)
    await handlePayload(s, sender, recipientsOf(env), mid, ts, header, attachment)
  } catch (e) {
    console.warn(`dropping malformed message from ${sender}:`, e)
  }
  markSeen(s, mid)
  if (mine) await confirmSent(s, env.id)
}

async function handlePayload(
  s: Session,
  sender: string,
  recipients: string[],
  mid: string,
  ts: number,
  { conv: pc, body }: PayloadHeader,
  attachment: Uint8Array,
) {
  const me = s.me
  const mine = sender === me
  /** Only friends can DM me or put me in a new group; others reach me only in groups I'm already in. */
  const trusted = mine || !!state.contacts[sender]?.friend
  if (!recipients.includes(me)) return

  if (body.t === 'group') {
    if (pc.t !== 'g' || pc.id !== body.id) return
    const proposed = [...new Set(body.members)]
    if (!proposed.includes(sender)) return
    const conv: ConvId = `g:${body.id}`
    const existing = state.groups[body.id]
    if (!existing) {
      if (!proposed.includes(me) || !trusted || s.left[body.id]) return
      const name = cleanLabel(body.name, 64) || 'Group'
      await ensurePinned(s, proposed).catch(noop)
      const group: Group = { id: body.id, name, members: proposed }
      if (body.admins) {
        const admins = proposed.filter((id) => body.admins!.includes(id))
        group.admins = admins.length ? admins : [sender]
      }
      state.groups[body.id] = group
      groupsChanged(s)
      const others = proposed.filter((id) => id !== me && id !== sender)
      await systemMessage(
        s,
        conv,
        mine
          ? `You created “${name}”${others.length ? ` with ${names(others)}` : ''}`
          : `${displayName(sender)} added you to “${name}”`,
        ts,
      )
      return
    }
    if (!existing.members.includes(sender) || !isAdmin(existing, sender)) return
    // Updates can only add members; leaving is a separate, self-authored message.
    const added = proposed.filter((id) => !existing.members.includes(id))
    if (!added.length) return
    await ensurePinned(s, added).catch(noop)
    existing.members = [...existing.members, ...added]
    groupsChanged(s)
    await systemMessage(s, conv, `${mine ? 'You' : displayName(sender)} added ${names(added)}`, ts)
    return
  }

  if (body.t === 'leave') {
    const g = state.groups[body.id]
    if (!g || pc.t !== 'g' || pc.id !== body.id || !g.members.includes(sender)) return
    if (mine) {
      await removeGroupLocally(s, g.id) // left on another of my devices
      return
    }
    g.members = g.members.filter((id) => id !== sender)
    let promoted: string | undefined
    if (g.admins) {
      g.admins = g.admins.filter((id) => id !== sender)
      if (!g.admins.length && g.members.length) g.admins = [(promoted = g.members[0]!)]
    }
    groupsChanged(s)
    await systemMessage(s, `g:${g.id}`, `${displayName(sender)} left the group`, ts)
    if (promoted) await systemMessage(s, `g:${g.id}`, `${promoted === me ? 'You are' : `${displayName(promoted)} is`} now an admin`, ts)
    return
  }

  if (body.t === 'gname' || body.t === 'gkick' || body.t === 'gadmin') {
    if (pc.t !== 'g' || pc.id !== body.id) return
    await applyGroupOp(s, sender, body, ts)
    return
  }

  if (body.t === 'gpic') {
    if (pc.t !== 'g' || pc.id !== body.id) return
    const g = state.groups[body.id]
    if (!g || !g.members.includes(sender) || (!mine && state.blocked.some((b) => b.id === sender))) return
    if (await receiveGroupPic(s, g.id, ts, body.mime, attachment)) {
      await systemMessage(s, `g:${g.id}`, `${mine ? 'You' : displayName(sender)} ${attachment.length ? 'changed' : 'removed'} the group picture`, ts)
    }
    return
  }

  if (body.t === 'profile') {
    if (mine) {
      if (pc.t === 'dm') receiveOwnProfile(s, ts, body.mime, attachment, body.name)
      return
    }
    if (pc.t !== 'dm' || !s.pins[sender] || state.blocked.some((b) => b.id === sender)) return
    await receiveProfile(s, sender, ts, body.mime, attachment, body.name)
    return
  }

  // Chat content.
  let conv: ConvId
  if (pc.t === 'dm') {
    if (mine && body.t === 'read') {
      // Sent only to my own devices when read receipts are off.
      if (!body.with || !s.pins[body.with]) return
      conv = `dm:${body.with}`
    } else if (mine) {
      // A copy of something I sent from another device.
      const peers = recipients.filter((id) => id !== me)
      if (peers.length !== 1) return
      conv = `dm:${peers[0]!}`
      await ensurePinned(s, peers).catch(noop)
    } else {
      if (!trusted || recipients.some((id) => id !== me && id !== sender)) return
      conv = `dm:${sender}`
    }
  } else {
    const g = state.groups[pc.id]
    if (!g || !g.members.includes(sender)) return
    conv = `g:${g.id}`
  }
  if (!mine) await ensurePinned(s, [sender]).catch(noop)

  if (body.t === 'typing') return
  // Blocked users stay in shared groups (so everyone's group state agrees), but I don't see what they say.
  if (!mine && state.blocked.some((b) => b.id === sender)) return
  if (body.t === 'read') {
    await applyRead(s, conv, sender, Math.min(body.ts, ts))
    return
  }
  if (body.t === 'edit' || body.t === 'delete' || body.t === 'react') {
    await applyChange(s, conv, sender, body, ts)
    return
  }

  const msg: ChatMessage = { id: mid, conv, from: sender, ts, kind: 'text', status: mine ? 'sent' : 'received' }
  if (body.reply) msg.reply = await resolveReply(s, conv, body.reply)
  if (body.fwd) msg.forwarded = true
  if (body.t === 'text') {
    msg.doc = body.doc
  } else {
    if (attachment.length > MAX_FILE_BYTES) return
    msg.kind = 'file'
    msg.file = {
      name: cleanLabel(body.name, 200) || 'file',
      mime: body.mime.slice(0, 100),
      size: attachment.length,
    }
    await set(K.file(mid), attachment, db)
  }
  await appendMessage(s, msg, !mine)
}

/** Re-processes held envelopes (after a key was accepted, or after a sync). Only call from inside serial(). */
async function retryHeld(s: Session) {
  const held = s.held
  if (!held.length) return
  s.held = []
  for (const h of held) {
    try {
      await receiveEnvelope(s, h.seq, h.env)
    } catch (e) {
      console.warn('dropping held message', e)
    }
  }
  scheduleFlush(s)
}

/** The server has my message: done with it. */
async function confirmSent(s: Session, envId: string) {
  const p = s.outbox.get(envId)
  if (!p) return
  dropOutgoing(s, envId)
  await updateMessageStatus(s, p.conv, p.mid, 'sent')
}

function dropOutgoing(s: Session, envId: string) {
  s.outbox.delete(envId)
  s.inflight.delete(envId)
  s.tried.delete(envId)
  void delMany([K.out(envId)], db).catch(noop)
}

/** Hands queued messages to the server, oldest first. Called once a (re)connected device has caught up. */
function flushOutbox(s: Session) {
  if (!live(s) || !s.conn) return
  const queued = [...s.outbox.entries()].filter(([id]) => !s.inflight.has(id)).sort((a, b) => a[1].env.ts - b[1].env.ts)
  for (const [id, o] of queued) {
    if (!signedBy(s.identity.signPk, o.env)) {
      // Sealed before I changed keys: shown as failed, so Retry seals it again with the new keys.
      dropOutgoing(s, id)
      void updateMessageStatus(s, o.conv, o.mid, 'failed')
      continue
    }
    if (!s.conn.send({ type: 'send', envelope: o.env })) return
    s.inflight.add(id)
    s.tried.add(id)
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function dispatch(s: Session, m: ServerMsg) {
  if (!live(s)) return
  // Replies to requests are handled right away, never behind the message queue.
  const req = 'req' in m && typeof m.req === 'number' && m.req > 0 ? m.req : 0
  if (req && (m.type === 'ok' || m.type === 'users' || m.type === 'prelogin' || m.type === 'sessions' || m.type === 'head' || m.type === 'error')) {
    const r = s.requests.get(req)
    s.requests.delete(req)
    if (m.type === 'error') r?.reject(new ServerError(m.message, isStr(m.code) ? m.code : undefined))
    else r?.resolve(m)
    return
  }
  switch (m.type) {
    case 'error':
      if (!req && (m.code === 'revoked' || m.code === 'deleted')) {
        void signedOut(s, m.code, m.message, m.proof)
        return
      }
      state.error = m.message
      return
    case 'presence': {
      const c = validId(m.id) ? state.contacts[m.id] : undefined
      if (c?.friend) {
        c.online = !!m.online
        c.status = shownStatus(!!m.online, (m as { status?: unknown }).status)
      }
      return
    }
    case 'status':
      // Changed on another of my devices.
      if (state.account && validStatus(m.status)) state.account.status = m.status
      return
    case 'pong':
      return
    case 'signal':
      handleSignal(s, m.envelope)
      return
    case 'sent':
    case 'failed': {
      const p = isStr(m.id) ? s.outbox.get(m.id) : undefined
      if (p) {
        dropOutgoing(s, m.id)
        void updateMessageStatus(s, p.conv, p.mid, m.type === 'sent' ? 'sent' : 'failed')
      }
      if (m.type === 'failed') state.error = m.message
      return
    }
  }
  void serial(s, () => handleQueued(s, m)).catch((e) => console.warn(`handling ${m.type} failed`, e))
}

async function handleQueued(s: Session, m: ServerMsg) {
  if (!live(s)) return
  switch (m.type) {
    case 'friends':
      applyFriends(s, m)
      break
    case 'deliver':
      await receive(s, m.seq, m.envelope)
      break
    case 'synced':
      await retryHeld(s)
      state.syncing = false
      s.fresh = false
      try {
        await flush(s)
      } catch (e) {
        console.warn('saving failed', e)
      }
      flushOutbox(s)
      refreshProfile(s)
      scheduleRead(s)
      break
    case 'vault':
      await applyVault(s, m.vault)
      break
  }
}

/** Takes over an authenticated connection. */
function attach(s: Session, conn: Conn, w: Welcome) {
  if (state.account && validStatus(w.me?.status)) state.account.status = w.me.status
  s.conn = conn
  s.retry = 0
  state.status = 'online'
  state.syncing = true
  conn.onClose = () => onClosed(s, conn)
  void serial(s, async () => {
    // Before any message is handled: they may already be sealed to keys this device just changed to.
    await settleKeyChange(s).catch(noop)
    await applyVault(s, w.vault)
  })
  conn.attach((m) => dispatch(s, m))
  clearInterval(s.pingTimer)
  s.pingTimer = setInterval(() => {
    const c = s.conn
    if (!c) return
    // Pings are answered within seconds; nothing for a minute means the connection died
    // (sleep, network change) without the socket noticing.
    if (Date.now() - c.lastSeen > 60_000) c.close()
    else c.send({ type: 'ping' })
  }, 25_000)
  // The socket may have dropped while we were setting up.
  if (conn.closed) onClosed(s, conn)
}

function onClosed(s: Session, conn: Conn) {
  if (s.conn !== conn) return
  s.conn = null
  clearInterval(s.pingTimer)
  for (const r of s.requests.values()) r.reject(new Error('Lost the connection to the server'))
  s.requests.clear()
  // Unconfirmed sends stay queued: after reconnecting, the catch-up confirms the ones that
  // arrived (my own copy comes back) and the rest are sent again.
  s.inflight.clear()
  if (!live(s)) return
  state.status = 'connecting'
  state.syncing = false
  scheduleReconnect(s)
}

function scheduleReconnect(s: Session) {
  clearTimeout(s.reconnectTimer)
  s.reconnectTimer = setTimeout(() => void reconnect(s), Math.min(30_000, 1000 * 2 ** s.retry++))
}

async function reconnect(s: Session) {
  if (!live(s) || s.conn) return
  state.status = 'connecting'
  let conn: Conn | null = null
  let w: ServerMsg
  try {
    conn = await Conn.open(s.saved.server)
    conn.send({ type: 'resume', token: s.saved.token, cursor: s.cursor, device: deviceName(), deviceId: s.saved.deviceId })
    w = await conn.next()
    if (w.type !== 'welcome') throw new Error('Unexpected reply from the server')
  } catch (e) {
    conn?.close()
    if (!live(s)) return
    if (e instanceof ServerError && e.code === 'revoked') {
      await signedOut(s, e.code, e.message, e.proof)
      return
    }
    if (e instanceof ServerError && /expired|sign in/i.test(e.message)) {
      await expire(s, e.message)
      return
    }
    state.status = 'offline'
    scheduleReconnect(s)
    return
  }
  if (!live(s)) {
    conn.close()
    return
  }
  attach(s, conn, w)
}

const revokeNotice = (me: string, deviceId: string) => `revoke ${me} ${deviceId}`
const deleteNotice = (me: string) => `delete ${me}`

/**
 * This device was signed out from another device, or the account was deleted. Local data is only
 * deleted when my own key signed that (the server can't fake it); otherwise it's kept, like an expired session.
 */
async function signedOut(s: Session, code: 'revoked' | 'deleted', message: string, proof: string | undefined) {
  if (session !== s) return
  const text = code === 'deleted' ? deleteNotice(s.me) : revokeNotice(s.me, s.saved.deviceId ?? '')
  const genuine = (code === 'deleted' || !!s.saved.deviceId) && verifyNotice(s.identity.signPk, text, proof)
  if (genuine) await wipe(s, message)
  else await expire(s, code === 'deleted' ? 'This account is no longer available. Sign in again.' : 'You were signed out. Sign in again.')
}

/** Deletes everything on this device and goes back to the sign-in screen. */
async function wipe(s: Session, message: string) {
  if (session !== s) return
  session = null
  stop(s)
  await s.queue
  await clear(db)
  forgetUsername()
  resetState()
  state.error = message
}

function forgetUsername() {
  try {
    localStorage.removeItem(LS_USER)
  } catch {
    /* storage disabled */
  }
}

/** The server no longer accepts this device's session: back to the sign-in screen, keeping local data. */
async function expire(s: Session, message: string) {
  stop(s)
  session = null
  await set(K.session, { ...s.saved, token: null } satisfies Saved, db)
  resetState()
  state.error = message
}

function stop(s: Session) {
  s.closed = true
  clearInterval(s.pingTimer)
  clearTimeout(s.reconnectTimer)
  clearTimeout(s.flushTimer)
  clearTimeout(s.vaultTimer)
  clearTimeout(s.profileTimer)
  clearTimeout(s.readTimer)
  clearTimeout(s.muteTimer)
  s.conn?.close()
  for (const r of s.requests.values()) r.reject(new Error('Signed out'))
  s.requests.clear()
  for (const f of s.fileUrls.values()) URL.revokeObjectURL(f.url)
  for (const url of s.avatarUrls.values()) URL.revokeObjectURL(url)
  for (const url of s.groupPicUrls.values()) URL.revokeObjectURL(url)
}

function resetState() {
  Object.assign(state, {
    status: 'offline',
    account: null,
    contacts: dict(),
    requests: { incoming: [], outgoing: [] },
    groups: dict(),
    conversations: [],
    active: null,
    messages: [],
    syncing: false,
    typing: dict(),
    firstUnread: null,
    hasOlder: false,
    highlight: null,
    reads: dict(),
    blocked: [],
    settings: { readReceipts: true },
    starred: dict(),
  } satisfies Partial<ChatState>)
}

/** Loads this device's local data into a new session and makes it current. */
async function loadSession(saved: Saved): Promise<Session> {
  const s = new Session(saved)
  const [cursor, pins, groups, left, prefs, settings, profile, meta, held, stars] = await getMany(
    [K.cursor, K.pins, K.groups, K.left, K.prefs, K.settings, K.profile, K.meta, K.held, K.stars],
    db,
  )
  s.cursor = typeof cursor === 'number' ? cursor : 0
  const vault = parseVault({ pins, groups, left, prefs, settings, profile, stars })
  s.stars = vault.stars
  s.pins = vault.pins
  s.left = vault.left
  s.prefs = vault.prefs
  s.settings = vault.settings
  s.profile = vault.profile
  s.meta = dict(meta)
  s.held = Array.isArray(held) ? held : []
  const avatarKeys: string[] = []
  const outKeys: string[] = []
  const picKeys: string[] = []
  for (const key of await idbKeys(db)) {
    if (!isStr(key)) continue
    if (key.startsWith('seen:')) s.seen.add(key.slice(5))
    else if (key.startsWith('avatar:')) avatarKeys.push(key)
    else if (key.startsWith('out:')) outKeys.push(key)
    else if (key.startsWith('gpic:')) picKeys.push(key)
  }
  const pics = await getMany<StoredAvatar | undefined>(picKeys, db)
  picKeys.forEach((key, i) => {
    const p = pics[i]
    if (p?.bytes instanceof Uint8Array && p.bytes.length) setGroupPicUrl(s, key.slice(5), p.bytes, p.mime)
  })
  const outgoing = await getMany<Outgoing | undefined>(outKeys, db)
  outKeys.forEach((key, i) => {
    const o = outgoing[i]
    if (o?.env && validConvId(o.conv) && isStr(o.mid)) {
      s.outbox.set(key.slice(4), o)
      s.tried.add(key.slice(4)) // may have reached the server before the app closed
    }
  })
  const avatars = await getMany<StoredAvatar | undefined>(avatarKeys, db)
  avatarKeys.forEach((key, i) => {
    const a = avatars[i]
    if (a?.bytes instanceof Uint8Array) setAvatarUrl(s, key.slice(7), a.bytes, a.mime)
    if (a?.name && isStr(a.name)) s.names.set(key.slice(7), a.name)
  })

  if (session) stop(session)
  session = s
  resetState()
  state.account = {
    server: saved.server, id: saved.id, username: saved.username, avatar: null, displayName: saved.username, status: 'online',
    fingerprint: fingerprint({ signPk: saved.identity.signPk, encPk: saved.identity.encPk }),
  }
  state.settings = { readReceipts: s.settings.readReceipts }
  showMyAvatar(s)
  state.groups = vault.groups
  for (const id of Object.keys(s.pins)) updateContactFromPin(s, id)
  showStars(s)
  refreshConversations()
  void navigator.storage?.persist?.().catch(noop)
  return s
}

/** Signs in on a fresh connection: keeps local data if it belongs to this account, else wipes it. */
async function begin(conn: Conn, w: Welcome, server: string, identity: Identity, token: string, cursor: number, deviceId: string) {
  if (!validId(w.me?.id)) throw new Error('Unexpected reply from the server')
  const prev = await get<Saved>(K.session, db)
  let replay = false
  if (!prev || prev.id !== w.me.id || prev.server !== server) {
    await clear(db)
    replay = cursor > 0 // the server is syncing from a cursor that belonged to other data
    cursor = 0
  }
  const saved: Saved = { server, id: w.me.id, username: w.me.username, token, identity, deviceId }
  await setMany([[K.session, saved], [K.cursor, cursor]], db)
  try {
    localStorage.setItem(LS_USER, saved.username)
    localStorage.setItem(LS_SERVER, server)
  } catch {
    /* storage disabled */
  }
  const s = await loadSession(saved)
  s.fresh = cursor === 0
  if (replay) {
    conn.close()
    void reconnect(s)
    return
  }
  attach(s, conn, w)
}

function checkUsername(input: string): string {
  const u = input.trim()
  if (!USERNAME_RE.test(u)) {
    throw new Error('Username must be 3-24 characters (letters, digits, _ and .) and start with a letter or digit')
  }
  return u
}

function checkPassword(pw: string) {
  if (pw.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for your password`)
}

const randomSalt = () => crypto.getRandomValues(new Uint8Array(16))

// ---------------------------------------------------------------------------
// Public API: account
// ---------------------------------------------------------------------------

export const isDesktop = '__TAURI_INTERNALS__' in globalThis

export function defaultServer(): string {
  if (!isDesktop) return location.origin
  try {
    return localStorage.getItem(LS_SERVER) ?? ((import.meta.env.VITE_DEFAULT_SERVER as string | undefined) || '')
  } catch {
    return ''
  }
}

export function lastUsername(): string {
  try {
    return localStorage.getItem(LS_USER) ?? ''
  } catch {
    return ''
  }
}

/** Resumes the saved session, if any. Works offline (reconnects in the background). */
export async function restore(): Promise<boolean> {
  // Data from the old, pre-account version of the app.
  try {
    indexedDB.deleteDatabase('keyval-store')
  } catch {
    /* ignore */
  }
  const saved = await get<Saved>(K.session, db)
  if (!saved?.token || !saved.identity || !validId(saved.id)) return false
  if (!saved.deviceId) {
    // Signed in with an older version: pick an id now (the server learns it on resume).
    saved.deviceId = randomId()
    await set(K.session, saved, db)
  }
  const s = await loadSession(saved)
  state.status = 'connecting'
  void reconnect(s)
  return true
}

export async function register(serverInput: string, usernameInput: string, password: string) {
  const server = normalizeServer(serverInput)
  const username = checkUsername(usernameInput)
  checkPassword(password)
  const salt = randomSalt()
  const keys = await deriveFromPassword(password, salt)
  const identity = generateIdentity()
  const deviceId = randomId()
  const conn = await Conn.open(server)
  try {
    conn.send({
      type: 'register',
      username,
      salt: b64(salt),
      authKey: b64(keys.authKey),
      signPk: b64(identity.signPk),
      encPk: b64(identity.encPk),
      bundle: lockIdentity(identity, keys.lockKey, bundleName(username)),
      device: deviceName(),
      deviceId,
    })
    const w = await conn.next()
    if (w.type !== 'welcome' || !isStr(w.token)) throw new Error('Unexpected reply from the server')
    await begin(conn, w, server, identity, w.token, 0, deviceId)
  } catch (e) {
    conn.close()
    throw e
  }
}

export async function login(serverInput: string, usernameInput: string, password: string) {
  const server = normalizeServer(serverInput)
  const username = checkUsername(usernameInput)
  if (!password) throw new Error('Enter your password')
  const conn = await Conn.open(server)
  try {
    conn.send({ type: 'prelogin', username })
    const pre = await conn.next()
    if (pre.type !== 'prelogin' || !isStr(pre.salt)) throw new Error('Unexpected reply from the server')
    const keys = await deriveFromPassword(password, unb64(pre.salt))
    const prev = await get<Saved>(K.session, db)
    const sameAccount = prev?.server === server && bundleName(prev.username) === bundleName(username)
    const cursor = sameAccount ? ((await get<number>(K.cursor, db)) ?? 0) : 0
    const deviceId = randomId()
    conn.send({ type: 'login', username, authKey: b64(keys.authKey), cursor, device: deviceName(), deviceId })
    const w = await conn.next()
    if (w.type !== 'welcome' || !isStr(w.token) || !isStr(w.bundle)) throw new Error('Unexpected reply from the server')
    let identity: Identity
    try {
      identity = unlockIdentity(w.bundle, keys.lockKey, bundleName(w.me.username))
    } catch {
      throw new Error('Could not unlock your keys with this password')
    }
    await begin(conn, w, server, identity, w.token, cursor, deviceId)
  } catch (e) {
    conn.close()
    throw e
  }
}

/** Signs this device out and deletes everything stored on it. */
export async function logout() {
  const s = session
  session = null
  if (s) {
    s.conn?.send({ type: 'logout' })
    stop(s)
    await s.queue
  }
  await clear(db)
  resetState()
}

export async function changePassword(oldPassword: string, newPassword: string) {
  const s = requireSession()
  checkPassword(newPassword)
  if (oldPassword === newPassword) throw new Error('The new password is the same as the old one')
  const pre = await request(s, { type: 'prelogin' })
  if (pre.type !== 'prelogin' || !isStr(pre.salt)) throw new Error('Unexpected reply from the server')
  const old = await deriveFromPassword(oldPassword, unb64(pre.salt))
  const newSalt = randomSalt()
  const next = await deriveFromPassword(newPassword, newSalt)
  await request(s, {
    type: 'password',
    authKey: b64(old.authKey),
    newSalt: b64(newSalt),
    newAuthKey: b64(next.authKey),
    bundle: lockIdentity(s.identity, next.lockKey, bundleName(s.saved.username)),
  })
}

// ---------------------------------------------------------------------------
// Public API: people
// ---------------------------------------------------------------------------

export function formatId(id: string): string {
  return id.length === 8 ? `${id.slice(0, 4)}-${id.slice(4)}` : id
}

export function displayName(id: string): string {
  if (!id) return ''
  if (session && id === session.me) return session.profile.name || session.saved.username
  return state.contacts[id]?.name ?? session?.serverUsers[id]?.name ?? formatId(id)
}

/** "7k3q-x9pa", "7K3Q X9PA", "7K3QX9PA" → "7K3QX9PA" (Crockford: I/L read as 1, O as 0). */
function parseId(input: string): string {
  const id = input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (!validId(id)) throw new Error("That doesn't look like a user ID (8 letters and digits, like 7K3Q-X9PA)")
  return id
}

async function friendOp(type: string, id: string) {
  const s = requireSession()
  await request(s, { type, id })
}

export function sendFriendRequest(input: string) {
  return friendOp('friend_request', parseId(input))
}
export function acceptFriend(id: string) {
  return friendOp('friend_accept', id)
}
export function declineFriend(id: string) {
  return friendOp('friend_decline', id)
}
export function removeFriend(id: string) {
  return friendOp('friend_remove', id)
}

/** Only friends (or people I already have a chat with) get a DM; a note must not create one for a group member. */
function hasDm(s: Session, id: string): boolean {
  return !!state.contacts[id]?.friend || !!s.meta[`dm:${id}`]
}

export async function setVerified(id: string, verified: boolean) {
  const s = requireSession()
  const pin = s.pins[id]
  if (!pin) return
  pin.verified = verified
  pin.at = Date.now()
  updateContactFromPin(s, id)
  pinsChanged(s)
  if (hasDm(s, id)) await systemMessage(s, `dm:${id}`, `You marked ${displayName(id)} as ${verified ? 'verified' : 'not verified'}`)
}

/**
 * Accept a contact's changed key. `seenFingerprint` is the pendingFingerprint the user
 * compared; if the server swapped the key again in the meantime, this throws.
 */
export async function trustNewKey(id: string, seenFingerprint: string) {
  const s = requireSession()
  const u = s.serverUsers[id]
  if (!u) throw new Error(`${displayName(id)} is not on this server`)
  const keys = { signPk: unb64(u.signPk), encPk: unb64(u.encPk) }
  if (fingerprint(keys) !== seenFingerprint) {
    throw new Error(`${displayName(id)}'s key changed again. Compare the new security code before accepting.`)
  }
  const old = s.pins[id]
  const now = Date.now()
  const pin: Pin = { name: old?.name ?? u.name, signPk: u.signPk, encPk: u.encPk, verified: false, at: now }
  // Their messages from before the change stay readable (also on my other devices, through the vault).
  if (old) pin.prev = [{ signPk: old.signPk, until: now }, ...(old.prev ?? [])].slice(0, MAX_PREV_KEYS)
  s.pins[id] = pin
  updateContactFromPin(s, id)
  pinsChanged(s)
  if (hasDm(s, id)) await systemMessage(s, `dm:${id}`, `You accepted a new security key for ${displayName(id)}`)
  await serial(s, () => retryHeld(s))
}

// ---------------------------------------------------------------------------
// Public API: conversations
// ---------------------------------------------------------------------------

/** How many messages are put on screen at a time. */
const PAGE = 60

/** Forgets object URLs of files outside the conversation on screen, so their memory can be freed. */
function releaseFiles(s: Session, keep: ConvId) {
  for (const [mid, f] of s.fileUrls) {
    if (f.conv === keep) continue
    URL.revokeObjectURL(f.url)
    s.fileUrls.delete(mid)
  }
}

/** Opens a conversation. With `focus`, resolves false if that message isn't there (anymore). */
export async function openConv(conv: ConvId, focus?: string): Promise<boolean> {
  const s = requireSession()
  state.active = conv
  const meta = s.meta[conv]
  const unread = meta?.unread ?? 0
  if (meta?.unread) {
    meta.unread = 0
    scheduleFlush(s)
    refreshConversations()
  }
  const list = await loadConv(s, conv)
  if (session !== s || state.active !== conv) return false
  let firstUnread: string | null = null
  for (let i = list.length - 1, n = unread; i >= 0 && n > 0; i--) {
    const m = list[i]!
    if (m.from && m.from !== s.me) {
      firstUnread = m.id
      n--
    }
  }
  releaseFiles(s, conv)
  let start = Math.max(0, list.length - PAGE)
  const unreadAt = firstUnread ? list.findIndex((m) => m.id === firstUnread) : -1
  if (unreadAt >= 0) start = Math.min(start, Math.max(0, unreadAt - 10))
  const focusAt = focus ? list.findIndex((m) => m.id === focus) : -1
  if (focusAt >= 0) start = Math.min(start, Math.max(0, focusAt - 20))
  state.firstUnread = firstUnread
  state.highlight = focusAt >= 0 ? focus! : null
  state.messages = list.slice(start)
  state.hasOlder = start > 0
  state.reads = { ...dict<number>(s.meta[conv]?.reads) }
  scheduleRead(s)
  return !focus || focusAt >= 0
}

/** Is this message (still) in the conversation on this device? */
export async function hasMessage(conv: ConvId, id: string): Promise<boolean> {
  const s = requireSession()
  return (await loadConv(s, conv)).some((m) => m.id === id)
}

/** Puts the next page of older messages of the active conversation on screen. Resolves false if there are none. */
export async function loadOlder(): Promise<boolean> {
  const s = requireSession()
  const conv = state.active
  if (!conv || !state.hasOlder) return false
  const list = await loadConv(s, conv)
  if (state.active !== conv) return false
  const first = state.messages[0]
  const idx = first ? list.findIndex((m) => m.id === first.id) : list.length
  if (idx <= 0) {
    state.hasOlder = false
    return false
  }
  const start = Math.max(0, idx - PAGE)
  state.messages.unshift(...list.slice(start, idx))
  state.hasOlder = start > 0
  return true
}

/** Searches the message history on this device. All words must match; newest first. `conv` limits it to one chat. */
export async function search(query: string, opts: { conv?: ConvId; limit?: number } = {}): Promise<SearchHit[]> {
  const s = requireSession()
  const limit = opts.limit ?? 50
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const hits: SearchHit[] = []
  for (const c of state.conversations) {
    if (opts.conv && c.id !== opts.conv) continue
    const cached = s.convs.get(c.id)
    const list = cached ? await cached : ((await get<ChatMessage[]>(K.conv(c.id), db)) ?? [])
    if (session !== s) return []
    for (const m of list) {
      if (m.kind === 'system') continue
      const text = (m.kind === 'file' ? (m.file?.name ?? '') : docToText(m.doc)).toLowerCase()
      if (terms.every((t) => text.includes(t))) hits.push({ conv: c.id, title: c.title, msg: m })
    }
  }
  hits.sort((a, b) => b.msg.ts - a.msg.ts)
  return hits.slice(0, limit)
}

function sendEnvelope(s: Session, to: string[], header: PayloadHeader, attachment?: Uint8Array, id = randomId(), ts = Date.now()) {
  const env = seal(s.identity, s.me, recipientKeys(s, to), encodePayload(header, attachment), id, ts)
  markSeen(s, msgId(s.me, env.id))
  if (!s.conn?.send({ type: 'send', envelope: env })) throw new Error('Not connected to the server')
  return env
}

async function targetsOf(s: Session, conv: ConvId): Promise<{ pc: PayloadConv; to: string[] }> {
  if (conv.startsWith('dm:')) {
    const peer = conv.slice(3)
    if (!s.pins[peer]) throw new Error('Unknown contact')
    // They'd drop it: only friends can message each other directly.
    if (!state.contacts[peer]?.friend) throw new Error(`You're not friends with ${displayName(peer)}, so messages can't be delivered`)
    if (state.blocked.some((b) => b.id === peer)) throw new Error(`You blocked ${displayName(peer)}`)
    return { pc: { t: 'dm' }, to: [peer] }
  }
  const g = state.groups[conv.slice(2)]
  if (!g) throw new Error('Group not found')
  return { pc: { t: 'g', id: g.id }, to: await groupRecipients(s, g.members) }
}

/** Everyone in a member list except me, skipping accounts that no longer exist. */
async function groupRecipients(s: Session, members: string[]): Promise<string[]> {
  await ensurePinned(s, members).catch(noop)
  await lookup(s, members).catch(noop) // notices deleted accounts
  const to = members.filter((id) => id !== s.me && s.pins[id] && !s.gone.has(id))
  if (to.length === 0) throw new Error('Nobody else is in this group')
  return to
}

/**
 * Sends a chat message to `conv`. It's shown right away and queued on disk; while offline it
 * stays "sending" and goes out after reconnecting.
 */
async function sendContent(
  conv: ConvId,
  header: (pc: PayloadConv) => PayloadHeader,
  local: Partial<ChatMessage>,
  attachment?: Uint8Array,
) {
  const s = requireSession()
  const { pc, to } = await targetsOf(s, conv)
  const id = randomId()
  const mid = msgId(s.me, id)
  const ts = Date.now()
  // Sealed now, with the keys pinned now: throws before anything is shown if a key changed.
  const env = seal(s.identity, s.me, recipientKeys(s, to), encodePayload(header(pc), attachment), id, ts)
  const msg: ChatMessage = { id: mid, conv, from: s.me, ts, kind: 'text', status: 'sending', ...local }
  if (attachment) {
    if (!live(s)) return
    await set(K.file(mid), attachment, db)
  }
  if (!live(s)) return
  try {
    await queueOutgoing(s, { env, conv, mid })
  } catch (e) {
    if (attachment) await delMany([K.file(mid)], db).catch(noop)
    throw new Error(`Couldn't save the message on this device: ${e instanceof Error ? e.message : e}`)
  }
  if (!live(s)) return
  await appendMessage(s, msg, false)
  if (s.prefs[conv]?.archived) setPrefs(s, conv, { archived: false })
  if (state.active === conv) state.firstUnread = null // replying means I've read it
  sendQueued(s, id)
}

/** Stores a sealed message until the server confirms it. */
async function queueOutgoing(s: Session, o: Outgoing) {
  const id = o.env.id
  await set(K.out(id), o, db) // if this fails, nothing is queued
  s.outbox.set(id, o)
  markSeen(s, msgId(s.me, id))
}

/** Sends a queued message now if connected and caught up (otherwise it goes after the next sync). */
function sendQueued(s: Session, id: string) {
  const o = s.outbox.get(id)
  if (!o || !s.conn || state.syncing || s.inflight.has(id)) return
  if (s.conn.send({ type: 'send', envelope: o.env })) {
    s.inflight.add(id)
    s.tried.add(id)
  }
}

function replyRef(m?: ChatMessage | null, conv = state.active): ReplyRef | undefined {
  if (!m || m.kind === 'system' || m.conv !== conv) return undefined
  return { id: m.id, from: m.from, preview: previewOf(m).slice(0, 120) }
}

function activeConv(): ConvId {
  const conv = state.active // the conversation on screen when the user hit send
  if (!conv) throw new Error('Open a conversation first')
  return conv
}

/** `conv`: the chat to send to (default: the open one). Pass it when sending takes a while, so switching chats can't redirect it. */
export async function sendText(doc: JSONContent, replyTo?: ChatMessage | null, conv: ConvId = activeConv()) {
  const reply = replyRef(replyTo, conv)
  await sendContent(conv, (pc) => ({ conv: pc, body: { t: 'text', doc, reply } }), { kind: 'text', doc, reply })
}

export async function sendFile(file: File, replyTo?: ChatMessage | null, target: ConvId = activeConv()) {
  const reply = replyRef(replyTo, target)
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const name = cleanLabel(file.name, 200) || 'file'
  const mime = (file.type || 'application/octet-stream').slice(0, 100)
  await sendContent(
    target,
    (conv) => ({ conv, body: { t: 'file', name, mime, size: bytes.length, reply } }),
    { kind: 'file', file: { name, mime, size: bytes.length }, reply },
    bytes,
  )
}

export async function fileUrl(msg: ChatMessage): Promise<string | null> {
  const s = session
  if (!s || msg.kind !== 'file' || !msg.file) return null
  const cached = s.fileUrls.get(msg.id)
  if (cached) return cached.url
  const bytes = await get<Uint8Array>(K.file(msg.id), db)
  if (!bytes || session !== s) return null
  const again = s.fileUrls.get(msg.id)
  if (again) return again.url
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: safeMime(msg.file.mime) }))
  s.fileUrls.set(msg.id, { url, conv: msg.conv })
  return url
}

export async function createGroup(nameInput: string, members: string[]): Promise<ConvId> {
  const s = requireSession()
  const name = cleanLabel(nameInput, 64)
  if (!name) throw new Error('Give the group a name')
  const others = [...new Set(members)].filter((id) => validId(id) && id !== s.me && state.contacts[id]?.friend)
  if (others.length === 0) throw new Error('Pick at least one friend')
  const group: Group = { id: randomId(), name, members: [s.me, ...others], admins: [s.me] }
  sendEnvelope(s, others, { conv: { t: 'g', id: group.id }, body: { t: 'group', ...group } })
  state.groups[group.id] = group
  groupsChanged(s)
  const conv: ConvId = `g:${group.id}`
  await systemMessage(s, conv, `You created “${name}” with ${names(others)}`)
  await openConv(conv)
  return conv
}

export async function addMembers(groupId: string, members: string[]) {
  const s = requireSession()
  const g = state.groups[groupId]
  if (!g) throw new Error('Group not found')
  if (!isAdmin(g, s.me)) throw new Error('Only admins can add people')
  const added = [...new Set(members)].filter((id) => validId(id) && !g.members.includes(id) && state.contacts[id]?.friend)
  if (added.length === 0) return
  const all = [...g.members, ...added]
  sendEnvelope(s, await groupRecipients(s, all), {
    conv: { t: 'g', id: g.id },
    body: { t: 'group', id: g.id, name: g.name, members: all, admins: g.admins },
  })
  g.members = all
  groupsChanged(s)
  await systemMessage(s, `g:${g.id}`, `You added ${names(added)}`)
  // New members get the current group picture (dated as before, so others ignore the copy).
  const pic = await get<StoredAvatar>(K.gpic(g.id), db)
  const to = added.filter((id) => s.pins[id] && !s.gone.has(id))
  if (pic?.bytes?.length && to.length) {
    try {
      sendEnvelope(s, to, { conv: { t: 'g', id: g.id }, body: { t: 'gpic', id: g.id, mime: pic.mime } }, pic.bytes, randomId(), pic.at)
    } catch {
      /* they'll get it with the next change */
    }
  }
}

/** `remember`: keep it out for good (I left), so other devices and old invites don't bring it back. */
async function removeGroupLocally(s: Session, groupId: string, remember = true) {
  const conv: ConvId = `g:${groupId}`
  const list = await loadConv(s, conv)
  await delMany([K.conv(conv), K.gpic(groupId), ...list.filter((m) => m.kind === 'file').map((m) => K.file(m.id))], db)
  setGroupPicUrl(s, groupId, null, '')
  s.convs.delete(conv)
  s.dirtyConvs.delete(conv)
  for (const [mid, f] of s.fileUrls) {
    if (f.conv !== conv) continue
    URL.revokeObjectURL(f.url)
    s.fileUrls.delete(mid)
  }
  delete state.groups[groupId]
  delete s.meta[conv]
  if (remember) s.left[groupId] = Date.now()
  if (state.active === conv) {
    state.active = null
    state.messages = []
  }
  groupsChanged(s)
}

export async function leaveGroup(groupId: string) {
  const s = requireSession()
  const g = state.groups[groupId]
  if (!g) return
  // Also sent to my other devices, which then leave too.
  const others = g.members.filter((id) => id !== s.me && s.pins[id])
  sendEnvelope(s, others, { conv: { t: 'g', id: g.id }, body: { t: 'leave', id: g.id } })
  await removeGroupLocally(s, groupId)
}

// ---------------------------------------------------------------------------
// Public API: edit, delete, react (stubs, implemented below)
// ---------------------------------------------------------------------------

export const desktopDownloadUrl: string =
  (import.meta.env.VITE_DOWNLOAD_URL as string | undefined) || 'https://github.com/AVMG20/e2ee-chat/releases/latest'

async function sendChange(msg: ChatMessage, body: PayloadBody) {
  const s = requireSession()
  if (msg.kind === 'system') return
  if (body.t !== 'react' && msg.from !== s.me) throw new Error('You can only change your own messages')
  if (msg.status === 'failed' || msg.status === 'sending') {
    const envId = msg.id.slice(s.me.length + 1)
    // Never reached anyone (or not yet): a delete only needs to happen here.
    if (body.t === 'delete' && (msg.status === 'failed' || (s.outbox.has(envId) && !s.tried.has(envId)))) {
      if (s.outbox.has(envId)) dropOutgoing(s, envId)
      return applyChange(s, msg.conv, s.me, body, Date.now())
    }
    if (body.t === 'delete') throw new Error("This message may already be on its way. Delete it once it's sent.")
    throw new Error("This message hasn't been sent yet")
  }
  const { pc, to } = await targetsOf(s, msg.conv)
  sendEnvelope(s, to, { conv: pc, body })
  await applyChange(s, msg.conv, s.me, body, Date.now())
}

export async function editMessage(msg: ChatMessage, doc: JSONContent): Promise<void> {
  if (msg.kind !== 'text') throw new Error('Only text messages can be edited')
  if (!docWithinLimits(doc)) throw new Error('Message is too long')
  await sendChange(msg, { t: 'edit', target: msg.id, doc })
}

export async function deleteMessage(msg: ChatMessage): Promise<void> {
  await sendChange(msg, { t: 'delete', target: msg.id })
}

export async function react(msg: ChatMessage, emoji: string): Promise<void> {
  const s = requireSession()
  const on = !msg.reactions?.[emoji]?.includes(s.me)
  await sendChange(msg, { t: 'react', target: msg.id, emoji, on })
}

/** Tell the active conversation I'm typing. Call on input; throttled here. */
export function typing() {
  const s = session
  const conv = state.active
  if (!s || !conv || state.status !== 'online') return
  const now = Date.now()
  if (s.typingSent.conv === conv && now - s.typingSent.at < 3000) return
  s.typingSent = { at: now, conv }
  void targetsOf(s, conv)
    .then(({ pc, to }) => {
      const env = seal(s.identity, s.me, recipientKeys(s, to), encodePayload({ conv: pc, body: { t: 'typing' } }), randomId(), now)
      s.conn?.send({ type: 'signal', envelope: env })
    })
    .catch(noop)
}

const incomingListeners = new Set<(m: ChatMessage) => void>()
export function onIncoming(cb: (m: ChatMessage) => void): () => void {
  incomingListeners.add(cb)
  return () => incomingListeners.delete(cb)
}
export function previewText(m: ChatMessage): string {
  return previewOf(m)
}

// ---------------------------------------------------------------------------
// Public API: blocking, chat settings, profile picture, group admin
// ---------------------------------------------------------------------------

/** Blocks a user: ends the friendship, and nothing they send (requests, DMs, group messages) reaches me. */
export function blockUser(id: string) {
  return friendOp('block', id)
}
export function unblockUser(id: string) {
  return friendOp('unblock', id)
}

/**
 * Mute, pin or archive a conversation (synced to my other devices). `mutedUntil` (ms) makes a mute
 * end by itself; muting without it (or with null) lasts until turned off. `mentionsOnly`: notify only
 * when I'm mentioned or replied to.
 */
export function setConvPrefs(
  conv: ConvId,
  patch: Partial<{ muted: boolean; mutedUntil: number | null; mentionsOnly: boolean; pinned: boolean; archived: boolean }>,
) {
  const s = requireSession()
  const p: Partial<Omit<ConvPrefs, 'at'>> = {}
  if (patch.muted !== undefined) {
    p.muted = patch.muted
    p.until = patch.muted && patch.mutedUntil ? patch.mutedUntil : 0
  } else if (patch.mutedUntil !== undefined) {
    p.until = patch.mutedUntil ?? 0
  }
  if (patch.mentionsOnly !== undefined) p.mentions = patch.mentionsOnly
  if (patch.pinned !== undefined) p.pinned = patch.pinned
  if (patch.archived !== undefined) p.archived = patch.archived
  setPrefs(s, conv, p)
}

/** Should this incoming message notify (sound / notification)? False in muted chats, and in mentions-only chats unless it mentions me. */
export function shouldNotify(m: ChatMessage): boolean {
  const s = session
  if (!s) return false
  if (state.account?.status === 'dnd') return false
  const p = s.prefs[m.conv]
  if (isMuted(p)) return false
  return !p?.mentions || mentionsMe(s, m)
}

/** Whether others see when I've read their messages. My own devices always sync read state. */
export function setReadReceipts(on: boolean) {
  const s = requireSession()
  s.settings = { readReceipts: on, at: Date.now() }
  state.settings = { readReceipts: on }
  scheduleFlush(s)
  scheduleVaultPush(s)
}

/** A square part of an image, in the image's own pixels. */
export interface CropArea {
  x: number
  y: number
  size: number
}

/** Crops to a square (the given area, or the middle) and shrinks to fit MAX_AVATAR_BYTES. */
async function encodeAvatar(file: Blob, crop?: CropArea): Promise<{ bytes: Uint8Array; mime: string }> {
  if (file.type === 'image/gif') {
    // Kept as is, so it stays animated (round avatars show the middle of it).
    if (file.size > MAX_AVATAR_BYTES) throw new Error(`This GIF is ${(file.size / 1024 / 1024).toFixed(1)} MB; GIFs can be up to ${MAX_AVATAR_BYTES / 1024 / 1024} MB`)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const head = new TextDecoder().decode(bytes.subarray(0, 6))
    if (head !== 'GIF87a' && head !== 'GIF89a') throw new Error("That image couldn't be opened")
    return { bytes, mime: 'image/gif' }
  }
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    throw new Error("That image couldn't be opened")
  }
  let side = Math.min(bmp.width, bmp.height)
  let x = (bmp.width - side) / 2
  let y = (bmp.height - side) / 2
  if (crop && [crop.x, crop.y, crop.size].every(Number.isFinite) && crop.size >= 1) {
    side = Math.min(crop.size, bmp.width, bmp.height)
    x = Math.min(Math.max(0, crop.x), bmp.width - side)
    y = Math.min(Math.max(0, crop.y), bmp.height - side)
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  canvas.getContext('2d')!.drawImage(bmp, x, y, side, side, 0, 0, 256, 256)
  bmp.close()
  for (const q of [0.85, 0.7, 0.5]) {
    let blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', q))
    // Safari can't encode WebP and hands back PNG.
    if (blob?.type !== 'image/webp') blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q))
    if (blob && blob.size <= 96 * 1024) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type }
  }
  throw new Error("That image couldn't be made small enough")
}

/**
 * Sets (or with null removes) my profile picture and sends it to all my contacts, encrypted.
 * `crop`: the square to use, in the image's pixels (default: the middle).
 */
export async function setAvatar(file: Blob | null, crop?: CropArea) {
  const s = requireSession()
  const img = file ? await encodeAvatar(file, crop) : null
  if (!live(s)) return
  s.profile = { avatar: img ? b64(img.bytes) : null, mime: img?.mime ?? '', at: Date.now(), sentAt: 0 }
  s.profileDirty = true
  showMyAvatar(s)
  scheduleFlush(s)
  scheduleVaultPush(s)
  try {
    sendProfile(s, profileAudience(s))
    s.profile.sentAt = Date.now()
    s.profileDirty = true
  } catch {
    /* sent after reconnecting (sentAt stays 0) */
  }
}

export function isGroupAdmin(groupId: string, userId?: string): boolean {
  const g = state.groups[groupId]
  const id = userId ?? session?.me
  return !!g && !!id && g.members.includes(id) && isAdmin(g, id)
}

async function groupOp(body: GroupOp) {
  const s = requireSession()
  const g = state.groups[body.id]
  if (!g) throw new Error('Group not found')
  if (!isAdmin(g, s.me)) throw new Error('Only admins can do that')
  const to = await groupRecipients(s, g.members)
  sendEnvelope(s, to, { conv: { t: 'g', id: g.id }, body })
  await applyGroupOp(s, s.me, body, Date.now())
}

export async function renameGroup(groupId: string, nameInput: string) {
  const name = cleanLabel(nameInput, 64)
  if (!name) throw new Error('Give the group a name')
  await groupOp({ t: 'gname', id: groupId, name })
}

/** Removes someone from a group (admins only). They get a notice and lose the chat. */
export async function removeMember(groupId: string, member: string) {
  if (member === session?.me) throw new Error('Use Leave group instead')
  await groupOp({ t: 'gkick', id: groupId, member })
}

export async function setAdmin(groupId: string, member: string, on: boolean) {
  await groupOp({ t: 'gadmin', id: groupId, member, on })
}

// ---------------------------------------------------------------------------
// Public API: retry, forward, star, media
// ---------------------------------------------------------------------------

/** The payload of one of my own messages, rebuilt from what's stored here. */
async function contentOf(shown: ChatMessage, fwd: boolean): Promise<{ body: PayloadBody; attachment?: Uint8Array; local: Partial<ChatMessage> }> {
  // A plain copy: what the UI passes in is reactive, and reactive objects can't be stored.
  const msg = JSON.parse(JSON.stringify(toRaw(shown))) as ChatMessage
  const reply = fwd ? undefined : msg.reply
  if (msg.kind === 'text' && msg.doc) {
    return { body: { t: 'text', doc: msg.doc, reply, fwd: fwd || undefined }, local: { kind: 'text', doc: msg.doc, reply, forwarded: fwd || undefined } }
  }
  if (msg.kind === 'file' && msg.file) {
    const bytes = await get<Uint8Array>(K.file(msg.id), db)
    if (!(bytes instanceof Uint8Array)) throw new Error("That file isn't on this device")
    const f = msg.file
    return {
      body: { t: 'file', name: f.name, mime: f.mime, size: bytes.length, reply, fwd: fwd || undefined },
      attachment: bytes,
      local: { kind: 'file', file: { ...f, size: bytes.length }, reply, forwarded: fwd || undefined },
    }
  }
  throw new Error("This message can't be sent")
}

/** Sends one of my failed messages again (same message, so nobody gets it twice). */
export async function retryMessage(msg: ChatMessage) {
  const s = requireSession()
  if (msg.from !== s.me || msg.status !== 'failed') return
  const envId = msg.id.slice(s.me.length + 1)
  const { pc, to } = await targetsOf(s, msg.conv)
  const { body, attachment } = await contentOf(msg, !!msg.forwarded)
  if (msg.forwarded && (body.t === 'text' || body.t === 'file')) body.fwd = true
  if (msg.reply && (body.t === 'text' || body.t === 'file')) body.reply = msg.reply
  const env = seal(s.identity, s.me, recipientKeys(s, to), encodePayload({ conv: pc, body }, attachment), envId, msg.ts)
  if (!live(s)) return
  await queueOutgoing(s, { env, conv: msg.conv, mid: msg.id })
  await updateMessageStatus(s, msg.conv, msg.id, 'sending')
  sendQueued(s, envId)
}

/** Forwards a message (text or file) to other conversations. It's marked "Forwarded" there. */
export async function forwardMessage(msg: ChatMessage, targets: ConvId[]) {
  requireSession()
  if (msg.kind === 'system') throw new Error("This message can't be forwarded")
  const convs = [...new Set(targets)].filter((c) => validConvId(c))
  if (!convs.length) throw new Error('Pick a chat to forward to')
  const { body, attachment, local } = await contentOf(msg, true)
  const failed: string[] = []
  for (const conv of convs) {
    try {
      await sendContent(conv, (pc) => ({ conv: pc, body }), local, attachment)
    } catch (e) {
      failed.push(`${state.conversations.find((c) => c.id === conv)?.title ?? 'a chat'}: ${e instanceof Error ? e.message : e}`)
    }
  }
  if (failed.length) throw new Error(`Couldn't forward to ${failed.join('; ')}`)
}

export function isStarred(msg: ChatMessage): boolean {
  return !!state.starred[starKey(msg.conv, msg.id)]
}

/** Stars or unstars a message (synced to my other devices; nobody else sees it). */
export function toggleStar(msg: ChatMessage) {
  const s = requireSession()
  if (msg.kind === 'system') return
  const key = starKey(msg.conv, msg.id)
  const on = !s.stars[key]?.on
  s.stars[key] = { on, at: Math.max(Date.now(), (s.stars[key]?.at ?? 0) + 1) }
  const keys = Object.keys(s.stars)
  if (keys.length > MAX_STARS) {
    // Forget the oldest unstar markers first, then the oldest stars.
    const order = keys.sort((a, b) => Number(s.stars[a]!.on) - Number(s.stars[b]!.on) || s.stars[a]!.at - s.stars[b]!.at)
    for (const k of order.slice(0, keys.length - MAX_STARS)) delete s.stars[k]
  }
  showStars(s)
  scheduleFlush(s)
  scheduleVaultPush(s)
}

/** My starred messages that are on this device, newest first. Open one with open(hit.conv, hit.msg.id). */
export async function starredMessages(): Promise<SearchHit[]> {
  const s = requireSession()
  const byConv = new Map<ConvId, Set<string>>()
  for (const k of Object.keys(state.starred)) {
    const sp = k.indexOf(' ')
    const conv = k.slice(0, sp) as ConvId
    if (!byConv.has(conv)) byConv.set(conv, new Set())
    byConv.get(conv)!.add(k.slice(sp + 1))
  }
  const hits: SearchHit[] = []
  for (const c of state.conversations) {
    const ids = byConv.get(c.id)
    if (!ids) continue
    const list = await loadConv(s, c.id)
    if (session !== s) return []
    for (const m of list) if (ids.has(m.id)) hits.push({ conv: c.id, title: c.title, msg: m })
  }
  return hits.sort((a, b) => b.msg.ts - a.msg.ts)
}

/** File and image messages of a conversation, newest first (for the media gallery). */
export async function mediaOf(conv: ConvId): Promise<ChatMessage[]> {
  const s = requireSession()
  const list = await loadConv(s, conv)
  return list.filter((m) => m.kind === 'file' && m.file).reverse()
}

/** Images are shown inline; everything else is a download. */
export function isImage(msg: ChatMessage): boolean {
  return msg.kind === 'file' && !!msg.file && SAFE_MIME.has(msg.file.mime)
}

// ---------------------------------------------------------------------------
// Public API: devices, account deletion
// ---------------------------------------------------------------------------

/** A readable name for this device, like "Firefox on Linux" or "Desktop app on Windows". */
export function deviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  const app = isDesktop
    ? 'Desktop app'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser'
  return os ? `${app} on ${os}` : app
}

/** My signed-in devices, most recently used first. */
export async function listDevices(): Promise<Device[]> {
  const s = requireSession()
  const res = await request(s, { type: 'sessions' })
  if (res.type !== 'sessions' || !Array.isArray(res.sessions)) throw new Error('Unexpected reply from the server')
  const list = res.sessions.filter((d) => d && isStr(d.id) && typeof d.created === 'number' && typeof d.lastUsed === 'number')
  for (const d of list as (Device & { deviceId?: unknown })[]) {
    if (isStr(d.deviceId) && /^[0-9a-f]{32}$/.test(d.deviceId)) s.deviceIds.set(d.id, d.deviceId)
  }
  return list
    .map((d) => ({
      id: d.id,
      name: cleanLabel(isStr(d.name) ? d.name : '', 64),
      created: d.created,
      lastUsed: d.lastUsed,
      current: d.current === true,
      online: d.online === true,
    }))
}

/** Signs out another of my devices. It deletes its local data the next time it connects (right away if online). */
export async function signOutDevice(id: string) {
  const s = requireSession()
  const deviceId = s.deviceIds.get(id)
  if (deviceId && deviceId === s.saved.deviceId) throw new Error('Use Sign out to sign out this device')
  // Devices from older versions have no id of their own: they're signed out but keep their data.
  const proof = deviceId ? signNotice(s.identity, revokeNotice(s.me, deviceId)) : undefined
  await request(s, { type: 'revoke_session', id, proof })
}

/**
 * Deletes my account on the server (keys, friends, stored messages, settings) and everything on
 * this device. My other devices are signed out. Can't be undone.
 */
export async function deleteAccount(password: string) {
  const s = requireSession()
  if (!password) throw new Error('Enter your password')
  const pre = await request(s, { type: 'prelogin' })
  if (pre.type !== 'prelogin' || !isStr(pre.salt)) throw new Error('Unexpected reply from the server')
  const keys = await deriveFromPassword(password, unb64(pre.salt))
  // Leave my groups first, so the others see it (and get a new admin if I was the only one).
  for (const g of Object.values(state.groups)) {
    try {
      const others = g.members.filter((id) => id !== s.me && s.pins[id])
      if (others.length) sendEnvelope(s, others, { conv: { t: 'g', id: g.id }, body: { t: 'leave', id: g.id } })
    } catch {
      /* best effort */
    }
  }
  await request(s, { type: 'delete_account', authKey: b64(keys.authKey), proof: signNotice(s.identity, deleteNotice(s.me)) })
  // The server closes the connection next: stop first so this session doesn't try to reconnect.
  session = null
  stop(s)
  await s.queue
  await clear(db)
  forgetUsername()
  resetState()
}

// ---------------------------------------------------------------------------
// Public API: backup
// ---------------------------------------------------------------------------
//
// File: "E2EECHAT-BACKUP2", a random 16-byte backup id, then records, each
// [4-byte length][24-byte nonce][ciphertext]. Each record is encrypted with a key derived from my
// private key and bound (AAD) to my user ID, the backup id and its position, so only my account
// can open it and records can't be swapped (also not between backups), dropped or cut off
// unnoticed (the last record says how many came before it).
// Record plaintext: [4-byte header length][header JSON][bytes] (bytes only for files).
// Big chats are split over several records.

const BACKUP_MAGIC = 'E2EECHAT-BACKUP2'
/** A chat's messages are split into records of about this many bytes of JSON. */
const BACKUP_CHUNK = 1024 * 1024
/** Largest record header accepted on import (one message is far smaller). */
const MAX_BACKUP_HEADER = 32 * 1024 * 1024
const BACKUP_CONTEXT = 'e2ee-chat/backup/v1'

type BackupRecord =
  | { t: 'head'; user: string; created: number }
  | { t: 'conv'; conv: ConvId; messages: ChatMessage[] }
  | { t: 'file'; mid: string }
  | { t: 'end'; n: number }

function backupAad(user: string, backupId: Uint8Array, i: number): Uint8Array {
  return new TextEncoder().encode(`${BACKUP_CONTEXT}\n${user}\n${b64(backupId)}\n${i}`)
}

/**
 * Everything on this device (all chats with their files) as one encrypted file. Only this
 * account can open it again with importBackup. Returns the file and a suggested name.
 */
export async function exportBackup(): Promise<{ blob: Blob; name: string }> {
  const s = requireSession()
  const { backupKey, sealRecord } = await import('./crypto')
  const key = backupKey(s.identity, BACKUP_CONTEXT)
  const backupId = crypto.getRandomValues(new Uint8Array(16))
  const parts: BlobPart[] = [new TextEncoder().encode(BACKUP_MAGIC) as Uint8Array<ArrayBuffer>, backupId]
  let i = 0
  const put = (rec: BackupRecord, bytes?: Uint8Array) => {
    const sealed = sealRecord(key, encodePayload(rec as unknown as PayloadHeader, bytes), backupAad(s.me, backupId, i++))
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, sealed.length)
    parts.push(len, sealed as Uint8Array<ArrayBuffer>)
  }
  put({ t: 'head', user: s.me, created: Date.now() })
  await serial(s, () => flush(s))
  const convKeys = (await idbKeys(db)).filter((k): k is string => isStr(k) && k.startsWith('conv:'))
  for (const ck of convKeys) {
    const conv = ck.slice(5) as ConvId
    if (!validConvId(conv)) continue
    const list = await loadConv(s, conv)
    if (session !== s) throw new Error('Signed out')
    if (!list.length) continue
    let chunk: ChatMessage[] = []
    let size = 0
    for (const m of list) {
      const n = JSON.stringify(m).length
      if (chunk.length && size + n > BACKUP_CHUNK) {
        put({ t: 'conv', conv, messages: chunk })
        chunk = []
        size = 0
      }
      chunk.push(m)
      size += n
    }
    if (chunk.length) put({ t: 'conv', conv, messages: chunk })
    for (const m of list) {
      if (m.kind !== 'file') continue
      const bytes = await get<Uint8Array>(K.file(m.id), db)
      if (bytes instanceof Uint8Array) put({ t: 'file', mid: m.id }, bytes)
    }
  }
  put({ t: 'end', n: i })
  const day = new Date().toISOString().slice(0, 10)
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), name: `e2ee-chat-${s.saved.username}-${day}.backup` }
}

/** Checks a message from a backup (made by this account, but checked like anything else read from a file). */
function backupMessage(conv: ConvId, raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as ChatMessage
  if (!isStr(m.id) || m.id.length > 120 || m.conv !== conv || !isStr(m.from) || (m.from && !validId(m.from))) return null
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) return null
  const out: ChatMessage = { id: m.id, conv, from: m.from, ts: m.ts, kind: m.kind, status: m.status === 'received' ? 'received' : 'sent' }
  if (m.status === 'sending' || m.status === 'failed') out.status = 'failed'
  if (m.kind === 'text') {
    if (!m.doc || typeof m.doc !== 'object' || m.doc.type !== 'doc' || !docWithinLimits(m.doc)) return null
    out.doc = m.doc
    if (typeof m.edited === 'number') out.edited = m.edited
  } else if (m.kind === 'file') {
    const f = m.file
    if (!f || !isStr(f.name) || !isStr(f.mime) || typeof f.size !== 'number') return null
    out.file = { name: cleanLabel(f.name, 200) || 'file', mime: f.mime.slice(0, 100), size: f.size }
  } else if (m.kind === 'system') {
    if (!isStr(m.text)) return null
    out.text = m.text.slice(0, 500)
  } else {
    return null
  }
  if (m.reply && isStr(m.reply.id) && isStr(m.reply.from) && isStr(m.reply.preview)) {
    out.reply = { id: m.reply.id.slice(0, 120), from: m.reply.from, preview: cleanLabel(m.reply.preview, 120) }
  }
  if (m.reactions && typeof m.reactions === 'object') {
    const r = dict<string[]>()
    for (const [e, users] of Object.entries(m.reactions).slice(0, 20)) {
      if (isStr(e) && e.length <= 16 && isIdList(users)) r[e] = users
    }
    if (Object.keys(r).length) out.reactions = r
  }
  if (m.forwarded === true) out.forwarded = true
  return out
}

/** Adds the chats from a backup made by this account. Messages already here are kept as they are. */
export async function importBackup(file: Blob): Promise<ImportResult> {
  const s = requireSession()
  const { backupKey, openRecord } = await import('./crypto')
  // Backups made before changing keys open with an earlier key.
  const keys = [s.identity, ...(s.identity.old ?? [])].map((k) => backupKey(k, BACKUP_CONTEXT))
  let key = keys[0]!
  const data = new Uint8Array(await file.arrayBuffer())
  const magic = new TextEncoder().encode(BACKUP_MAGIC)
  if (data.length < magic.length + 16 || new TextDecoder().decode(data.subarray(0, magic.length)) !== BACKUP_MAGIC) {
    throw new Error("That isn't an E2EE Chat backup")
  }
  const backupId = data.slice(magic.length, magic.length + 16)
  const records: { rec: BackupRecord; bytes: Uint8Array }[] = []
  let off = magic.length + 16
  let ended = false
  for (let i = 0; off < data.length; i++) {
    if (ended || off + 4 > data.length) throw new Error('The backup is damaged')
    const len = new DataView(data.buffer, data.byteOffset + off, 4).getUint32(0)
    off += 4
    if (off + len > data.length) throw new Error('The backup is incomplete')
    let plain: Uint8Array
    const sealed = data.subarray(off, off + len)
    const aad = backupAad(s.me, backupId, i)
    try {
      plain = openRecord(key, sealed, aad)
    } catch {
      const other = i === 0 ? keys.slice(1).find((k) => { try { openRecord(k, sealed, aad); return true } catch { return false } }) : undefined
      if (!other) throw new Error(i === 0 ? 'This backup belongs to another account' : 'The backup is damaged')
      key = other
      plain = openRecord(key, sealed, aad)
    }
    off += len
    let header: unknown
    let bytes: Uint8Array
    try {
      const hlen = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0)
      if (hlen > plain.length - 4 || hlen > MAX_BACKUP_HEADER) throw new Error('bad record')
      header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + hlen)))
      bytes = plain.slice(4 + hlen) // own buffer: a view would store the whole record
    } catch {
      throw new Error('The backup is damaged')
    }
    const rec = header as BackupRecord
    if (i === 0 && (rec?.t !== 'head' || rec.user !== s.me)) throw new Error('This backup belongs to another account')
    if (rec?.t === 'end') {
      if (rec.n !== i) throw new Error('The backup is damaged')
      ended = true
    }
    records.push({ rec, bytes })
  }
  if (!ended) throw new Error('The backup is incomplete')

  const result: ImportResult = { conversations: 0, messages: 0, files: 0 }
  await serial(s, async () => {
    const known = new Map<string, ConvId>()
    const touched = new Set<ConvId>()
    for (const { rec, bytes } of records) {
      if (!live(s)) return
      if (rec.t === 'conv' && validConvId(rec.conv) && Array.isArray(rec.messages)) {
        const list = await loadConv(s, rec.conv)
        const have = new Set(list.map((m) => m.id))
        let added = 0
        for (const raw of rec.messages) {
          const m = backupMessage(rec.conv, raw)
          if (m && m.kind === 'file') known.set(m.id, rec.conv)
          if (!m || have.has(m.id)) continue
          have.add(m.id)
          list.push(m)
          added++
        }
        if (!added) continue
        list.sort((a, b) => a.ts - b.ts)
        s.dirtyConvs.add(rec.conv)
        const meta = s.meta[rec.conv] ?? { unread: 0, lastTs: 0, preview: '' }
        const last = list[list.length - 1]!
        if (last.ts >= meta.lastTs) {
          meta.lastTs = last.ts
          meta.preview = previewLine(s, last)
        }
        s.meta[rec.conv] = meta
        touched.add(rec.conv)
        result.messages += added
      } else if (rec.t === 'file' && isStr(rec.mid) && known.has(rec.mid) && bytes.length <= MAX_FILE_BYTES) {
        if (await get(K.file(rec.mid), db)) continue
        await set(K.file(rec.mid), bytes, db)
        result.files++
      }
    }
    result.conversations = touched.size
    await flush(s)
  })
  refreshConversations()
  if (state.active) await openConv(state.active)
  return result
}

// ---------------------------------------------------------------------------
// Public API: changing my keys
// ---------------------------------------------------------------------------

/**
 * Replaces my keys with new ones (after a device was lost or the account may be compromised), so
 * messages sent to me from now on can't be opened with the old keys. Needs the password. My
 * other devices are signed out (they get the new keys when signing in again). Contacts see that
 * my security code changed and have to accept the new one before they can message me again.
 * My earlier keys are kept (locked with my password) only to open older messages and backups.
 */
export async function rotateKeys(password: string, newPassword?: string) {
  const s = requireSession()
  if (!password) throw new Error('Enter your password')
  if (newPassword) checkPassword(newPassword)
  if (newPassword && newPassword === password) throw new Error('The new password is the same as the old one')
  const pre = await request(s, { type: 'prelogin' })
  if (pre.type !== 'prelogin' || !isStr(pre.salt)) throw new Error('Unexpected reply from the server')
  const keys = await deriveFromPassword(password, unb64(pre.salt))
  const newSalt = newPassword ? randomSalt() : null
  const lock = newPassword ? await deriveFromPassword(newPassword, newSalt!) : keys
  // My own messages signed with the old key are accepted up to the server's newest message now.
  const head = await request(s, { type: 'head' })
  if (head.type !== 'head' || typeof head.seq !== 'number') throw new Error('Unexpected reply from the server')
  const next = rotateIdentity(s.identity, head.seq)
  // Kept on disk first: if the reply gets lost, the next connection finds out which keys the server has.
  await set(K.pendingKeys, next, db)
  const vault = sealVault(next, vaultData(s))
  try {
    await request(s, {
      type: 'rotate_keys',
      authKey: b64(keys.authKey),
      oldSignPk: b64(s.identity.signPk),
      signPk: b64(next.signPk),
      encPk: b64(next.encPk),
      bundle: lockIdentity(next, lock.lockKey, bundleName(s.saved.username)),
      vault,
      ...(newPassword ? { newSalt: b64(newSalt!), newAuthKey: b64(lock.authKey) } : {}),
    })
  } catch (e) {
    if (e instanceof ServerError) {
      await delMany([K.pendingKeys], db)
      throw e
    }
    if (live(s)) await settleKeyChange(s).catch(noop)
    throw e
  }
  await adoptKeys(s, next)
  s.remoteVault = parseVault(vaultData(s))
  for (const c of state.conversations) {
    if (c.kind === 'dm') await systemMessage(s, c.id, 'You changed your security keys')
  }
}

/** My synced settings as they're sealed into the vault. */
function vaultData(s: Session): VaultData {
  return JSON.parse(JSON.stringify({
    pins: { ...s.pins },
    groups: rawGroups(),
    left: { ...s.left },
    prefs: { ...s.prefs },
    settings: s.settings,
    // Without the picture's bytes (they can be up to 2 MB): see Profile.pic.
    profile: { ...s.profile, avatar: null, pic: !!s.profile.avatar || !!s.profile.pic },
    stars: { ...s.stars },
  }))
}

async function adoptKeys(s: Session, next: Identity) {
  if (!live(s)) return
  s.saved.identity = next
  await set(K.session, s.saved, db)
  await delMany([K.pendingKeys], db)
  if (state.account) state.account.fingerprint = fingerprint({ signPk: next.signPk, encPk: next.encPk })
}

/** A key change whose reply never came: use the new keys if the server has them, else forget them. */
async function settleKeyChange(s: Session) {
  const pending = await get<Identity>(K.pendingKeys, db)
  if (!pending?.signPk || !live(s)) return
  const res = await request(s, { type: 'lookup', ids: [s.me] })
  const me = res.type === 'users' && Array.isArray(res.users) ? parseUser(res.users[0]) : null
  if (!me) return
  if (sameKeys(me.keys, { signPk: pending.signPk, encPk: pending.encPk })) await adoptKeys(s, pending)
  else if (sameKeys(me.keys, { signPk: s.identity.signPk, encPk: s.identity.encPk })) await delMany([K.pendingKeys], db)
}

/** Sets (or with '' removes) my display name. Sent encrypted to my contacts, like my profile picture. */
export function setDisplayName(input: string) {
  const s = requireSession()
  const name = cleanLabel(input, MAX_DISPLAY_NAME)
  if ((s.profile.name ?? '') === name) return
  s.profile = { ...s.profile, name: name || undefined, at: Date.now(), sentAt: 0 }
  if (!name) delete s.profile.name
  s.profileDirty = true
  showMyAvatar(s)
  refreshConversations()
  scheduleFlush(s)
  scheduleVaultPush(s)
  try {
    sendProfile(s, profileAudience(s))
    s.profile.sentAt = Date.now()
  } catch {
    /* sent after reconnecting (sentAt stays 0) */
  }
}

/** Does this message mention me (@username or @display name) or reply to me? */
export function messageMentionsMe(m: ChatMessage): boolean {
  return !!session && mentionsMe(session, m)
}

/** Sets my status for my friends (and my other devices). Do not disturb also silences notifications here. */
export async function setStatus(status: UserStatus) {
  const s = requireSession()
  if (!validStatus(status)) throw new Error('Unknown status')
  await request(s, { type: 'set_status', status })
  if (state.account) state.account.status = status
}

// ---------------------------------------------------------------------------
// Group pictures
// ---------------------------------------------------------------------------

function setGroupPicUrl(s: Session, groupId: string, bytes: Uint8Array | null, mime: string) {
  const old = s.groupPicUrls.get(groupId)
  if (old) URL.revokeObjectURL(old)
  s.groupPicUrls.delete(groupId)
  if (bytes?.length) s.groupPicUrls.set(groupId, URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: safeMime(mime) })))
}

/** Stores a group picture if it's newer than mine. Resolves true if it changed. Only call from inside serial(). */
async function receiveGroupPic(s: Session, groupId: string, ts: number, mime: string, bytes: Uint8Array): Promise<boolean> {
  if (bytes.length > MAX_AVATAR_BYTES || (bytes.length && !SAFE_MIME.has(mime))) return false
  const prev = await get<StoredAvatar>(K.gpic(groupId), db)
  if (prev && prev.at >= ts) return false
  await set(K.gpic(groupId), { at: ts, mime, bytes } satisfies StoredAvatar, db)
  if (!live(s)) return false
  setGroupPicUrl(s, groupId, bytes, mime)
  refreshConversations()
  return true
}

/**
 * Sets (or with null removes) a group's picture, for everyone in it. Any member can. `crop` as for
 * setAvatar; animated GIFs are kept as they are.
 */
export async function setGroupPicture(groupId: string, file: Blob | null, crop?: CropArea) {
  const s = requireSession()
  const g = state.groups[groupId]
  if (!g) throw new Error('Group not found')
  const img = file ? await encodeAvatar(file, crop) : null
  const bytes = img?.bytes ?? new Uint8Array(0)
  const mime = img?.mime ?? ''
  const ts = Date.now()
  const to = await groupRecipients(s, g.members)
  sendEnvelope(s, to, { conv: { t: 'g', id: g.id }, body: { t: 'gpic', id: g.id, mime } }, bytes, randomId(), ts)
  await serial(s, async () => {
    if (await receiveGroupPic(s, g.id, ts, mime, bytes)) await systemMessage(s, `g:${g.id}`, `You ${bytes.length ? 'changed' : 'removed'} the group picture`, ts)
  })
}
