import type { JSONContent } from '@tiptap/core'
import { clear, createStore, delMany, get, getMany, keys as idbKeys, set, setMany } from 'idb-keyval'
import { reactive } from 'vue'
import {
  type Envelope,
  type Identity,
  type PublicKeys,
  b64,
  deriveFromPassword,
  fingerprint,
  generateIdentity,
  lockIdentity,
  open as openEnvelope,
  openVault,
  randomId,
  recipientsOf,
  sameKeys,
  seal,
  sealVault,
  unb64,
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
  type FriendRequest,
  type Group,
  MAX_FILE_BYTES,
  MIN_PASSWORD,
} from './types'

// ---------------------------------------------------------------------------
// Encrypted payload format (inside the envelope ciphertext)
// ---------------------------------------------------------------------------

type PayloadConv = { t: 'dm' } | { t: 'g'; id: string }
type PayloadBody =
  | { t: 'text'; doc: JSONContent }
  | { t: 'file'; name: string; mime: string; size: number }
  | { t: 'group'; id: string; name: string; members: string[] }
  | { t: 'leave'; id: string }
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
  switch (b.t) {
    case 'text':
      return !!b.doc && typeof b.doc === 'object' && b.doc.type === 'doc' && docWithinLimits(b.doc)
    case 'file':
      return isStr(b.name) && isStr(b.mime) && typeof b.size === 'number'
    case 'group':
      return validGroupId(b.id) && isStr(b.name) && isIdList(b.members)
    case 'leave':
      return validGroupId(b.id)
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
}
interface ConvMeta {
  unread: number
  lastTs: number
  preview: string
}
interface Saved {
  server: string
  id: string
  username: string
  /** Device session token; null once the server says it expired. */
  token: string | null
  identity: Identity
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
  meta: 'meta',
  held: 'held',
  conv: (c: ConvId) => `conv:${c}`,
  file: (mid: string) => `file:${mid}`,
  seen: (mid: string) => `seen:${mid}`,
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
}
interface Welcome {
  type: 'welcome'
  me: { id: string; username: string }
  vault: string | null
  token?: string
  bundle?: string
}

type ServerMsg =
  | { type: 'prelogin'; req?: number; salt: string }
  | Welcome
  | { type: 'friends'; friends: ServerUser[]; incoming: FriendRequest[]; outgoing: FriendRequest[] }
  | { type: 'presence'; id: string; online: boolean }
  | { type: 'deliver'; seq: number; envelope: Envelope }
  | { type: 'synced'; seq: number }
  | { type: 'sent'; id: string; seq: number }
  | { type: 'failed'; id: string; message: string }
  | { type: 'ok'; req: number }
  | { type: 'error'; req?: number; message: string }
  | { type: 'users'; req: number; users: ServerUser[] }
  | { type: 'vault'; vault: string }
  | { type: 'pong' }

/** An error message from the server (as opposed to a network problem). */
class ServerError extends Error {}

/** One WebSocket connection. Before sign-in, messages are read with next(); afterwards by a handler. */
class Conn {
  readonly ws: WebSocket
  closed = false
  onClose: (() => void) | null = null
  private queue: ServerMsg[] = []
  private waiter: { resolve: (m: ServerMsg) => void; reject: (e: Error) => void } | null = null
  private handler: ((m: ServerMsg) => void) | null = null

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = (ev) => {
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
    if (m.type === 'error') throw new ServerError(m.message)
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
}

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
  /** Keys replaced by trustNewKey this session: held messages may still be signed with them. */
  retiredPins: Dict<Pin> = dict()
  /** The vault as last seen on the server. */
  remoteVault: VaultData | null = null

  /** Incoming messages are processed one at a time, in order. */
  queue: Promise<unknown> = Promise.resolve()
  fileUrls = new Map<string, string>()
  /** Envelope id → local message, for messages awaiting the server's "sent". */
  pendingSends = new Map<string, { conv: ConvId; mid: string }>()
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
    [K.cursor, s.cursor],
    [K.pins, { ...s.pins }],
    [K.groups, rawGroups()],
    [K.left, { ...s.left }],
    [K.meta, { ...s.meta }],
    [K.held, s.held],
  ]
  for (const c of s.dirtyConvs) {
    const list = await s.convs.get(c)
    if (list) entries.push([K.conv(c), list])
  }
  for (const mid of s.newSeen) entries.push([K.seen(mid), 1])
  s.dirtyConvs.clear()
  s.newSeen = []
  await setMany(entries, db)
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
    unb64(q.encPk).length === 32
  )
}

function validGroup(g: unknown): g is Group {
  if (!g || typeof g !== 'object') return false
  const q = g as Group
  return validGroupId(q.id) && isStr(q.name) && isIdList(q.members)
}

function parseVault(raw: unknown): VaultData {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<VaultData>
  const out: VaultData = { pins: dict(), groups: dict(), left: dict() }
  for (const [id, p] of Object.entries(dict(v.pins))) {
    try {
      if (validId(id) && validPin(p)) out.pins[id] = { ...p, name: cleanLabel(p.name, 32) }
    } catch {
      /* bad base64 */
    }
  }
  for (const [id, g] of Object.entries(dict(v.groups))) {
    if (validGroup(g) && g.id === id) out.groups[id] = { id, name: cleanLabel(g.name, 64), members: [...new Set(g.members)] }
  }
  for (const [id, t] of Object.entries(dict(v.left))) if (validGroupId(id) && typeof t === 'number') out.left[id] = t
  return out
}

/** Does this device know something the server's copy doesn't? */
function vaultBehind(s: Session): boolean {
  const r = s.remoteVault
  if (!r) return Object.keys(s.pins).length > 0 || Object.keys(state.groups).length > 0 || Object.keys(s.left).length > 0
  for (const [id, p] of Object.entries(s.pins)) if (!r.pins[id] || p.at > r.pins[id]!.at) return true
  for (const [id, t] of Object.entries(s.left)) if (!r.left[id] || t > r.left[id]!) return true
  for (const id of Object.keys(state.groups)) if (!r.groups[id]) return true
  return false
}

function scheduleVaultPush(s: Session) {
  clearTimeout(s.vaultTimer)
  s.vaultTimer = setTimeout(() => void pushVault(s), 1500)
}

async function pushVault(s: Session) {
  if (!live(s) || !s.conn || !vaultBehind(s)) return
  const data: VaultData = { pins: { ...s.pins }, groups: rawGroups(), left: { ...s.left } }
  try {
    await request(s, { type: 'vault_put', vault: sealVault(s.identity, data) })
    s.remoteVault = parseVault(JSON.parse(JSON.stringify(data)))
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
    return { id: v.id, name: cleanLabel(v.name, 32), signPk: v.signPk, encPk: v.encPk, online: !!v.online, keys }
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
    name: pin.name,
    friend: prev?.friend ?? false,
    online: prev?.online ?? false,
    fingerprint: fingerprint(pinKeys(pin)),
    verified: pin.verified,
    keyChanged: changed,
    pendingFingerprint: changed ? fingerprint(serverKeys!) : null,
    ...patch,
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
  }
  // A pinned contact's name never changes (usernames are fixed), so the server can't relabel keys.
  const patch: Partial<Contact> = {}
  if (opts.friend !== undefined) {
    patch.friend = opts.friend
    patch.online = u.online
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
    }
  }
  const reqs = (list: unknown): FriendRequest[] =>
    (Array.isArray(list) ? list : [])
      .filter((r): r is FriendRequest => !!r && validId(r.id) && isStr(r.name) && typeof r.ts === 'number')
      .map((r) => ({ id: r.id, name: cleanLabel(r.name, 32), ts: r.ts }))
  state.requests = { incoming: reqs(m.incoming), outgoing: reqs(m.outgoing) }
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

function refreshConversations() {
  const s = session
  if (!s) return
  const list: Conversation[] = []
  const add = (id: ConvId, kind: 'dm' | 'group', title: string) => {
    const m = s.meta[id] ?? { unread: 0, lastTs: 0, preview: '' }
    list.push({ id, kind, title, unread: m.unread, lastTs: m.lastTs, preview: m.preview })
  }
  for (const g of Object.values(state.groups)) add(`g:${g.id}`, 'group', g.name)
  for (const c of Object.values(state.contacts)) {
    if (c.friend || s.meta[`dm:${c.id}`]) add(`dm:${c.id}`, 'dm', c.name)
  }
  list.sort((a, b) => b.lastTs - a.lastTs || a.title.localeCompare(b.title))
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
    p = get<ChatMessage[]>(K.conv(conv), db).then((l) => (Array.isArray(l) ? l : []))
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
    const prefix = m.conv.startsWith('g:') && m.kind !== 'system' ? `${m.from === s.me ? 'You' : displayName(m.from)}: ` : ''
    meta.preview = prefix + previewOf(m)
  }
  if (countUnread && !s.fresh && state.active !== m.conv) meta.unread++
  s.meta[m.conv] = meta
  scheduleFlush(s)

  if (state.active === m.conv) {
    let j = state.messages.length
    while (j > 0 && state.messages[j - 1]!.ts > m.ts) j--
    state.messages.splice(j, 0, m)
  }
  refreshConversations()
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
  if (!env || typeof env !== 'object' || !isStr(env.id) || !validId(env.from) || !Array.isArray(env.keys)) return
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

  let plain: Uint8Array
  try {
    plain = openEnvelope(s.identity, s.me, signPk, env)
  } catch (e) {
    const retired = s.retiredPins[sender]
    try {
      if (!retired) throw e
      plain = openEnvelope(s.identity, s.me, unb64(retired.signPk), env)
    } catch {
      console.warn(`dropping undecryptable message from ${sender}:`, e)
      return
    }
  }
  // The envelope is authentic: whatever happens next, never process it twice.
  try {
    const { header, attachment } = decodePayload(plain)
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
      state.groups[body.id] = { id: body.id, name, members: proposed }
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
    if (!existing.members.includes(sender)) return
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
    groupsChanged(s)
    await systemMessage(s, `g:${g.id}`, `${displayName(sender)} left the group`, ts)
    return
  }

  // Chat content.
  let conv: ConvId
  if (pc.t === 'dm') {
    if (mine) {
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

  const msg: ChatMessage = { id: mid, conv, from: sender, ts, kind: 'text', status: mine ? 'sent' : 'received' }
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

async function confirmSent(s: Session, envId: string) {
  const p = s.pendingSends.get(envId)
  if (!p) return
  s.pendingSends.delete(envId)
  await updateMessageStatus(s, p.conv, p.mid, 'sent')
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function dispatch(s: Session, m: ServerMsg) {
  if (!live(s)) return
  // Replies to requests are handled right away, never behind the message queue.
  const req = 'req' in m && typeof m.req === 'number' && m.req > 0 ? m.req : 0
  if (req && (m.type === 'ok' || m.type === 'users' || m.type === 'prelogin' || m.type === 'error')) {
    const r = s.requests.get(req)
    s.requests.delete(req)
    if (m.type === 'error') r?.reject(new ServerError(m.message))
    else r?.resolve(m)
    return
  }
  switch (m.type) {
    case 'error':
      state.error = m.message
      return
    case 'presence': {
      const c = validId(m.id) ? state.contacts[m.id] : undefined
      if (c?.friend) c.online = !!m.online
      return
    }
    case 'pong':
      return
    case 'sent':
    case 'failed': {
      const p = isStr(m.id) ? s.pendingSends.get(m.id) : undefined
      if (p) {
        s.pendingSends.delete(m.id)
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
      await flush(s)
      break
    case 'vault':
      await applyVault(s, m.vault)
      break
  }
}

/** Takes over an authenticated connection. */
function attach(s: Session, conn: Conn, w: Welcome) {
  s.conn = conn
  s.retry = 0
  state.status = 'online'
  state.syncing = true
  conn.onClose = () => onClosed(s, conn)
  void serial(s, () => applyVault(s, w.vault))
  conn.attach((m) => dispatch(s, m))
  clearInterval(s.pingTimer)
  s.pingTimer = setInterval(() => s.conn?.send({ type: 'ping' }), 25_000)
  // The socket may have dropped while we were setting up.
  if (conn.closed) onClosed(s, conn)
}

function onClosed(s: Session, conn: Conn) {
  if (s.conn !== conn) return
  s.conn = null
  clearInterval(s.pingTimer)
  for (const r of s.requests.values()) r.reject(new Error('Lost the connection to the server'))
  s.requests.clear()
  // Unconfirmed sends: shown as failed, fixed up if the server's copy shows up after reconnecting.
  for (const p of s.pendingSends.values()) void updateMessageStatus(s, p.conv, p.mid, 'failed')
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
    conn.send({ type: 'resume', token: s.saved.token, cursor: s.cursor })
    w = await conn.next()
    if (w.type !== 'welcome') throw new Error('Unexpected reply from the server')
  } catch (e) {
    conn?.close()
    if (!live(s)) return
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
  s.conn?.close()
  for (const r of s.requests.values()) r.reject(new Error('Signed out'))
  s.requests.clear()
  for (const url of s.fileUrls.values()) URL.revokeObjectURL(url)
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
  } satisfies Partial<ChatState>)
}

/** Loads this device's local data into a new session and makes it current. */
async function loadSession(saved: Saved): Promise<Session> {
  const s = new Session(saved)
  const [cursor, pins, groups, left, meta, held] = await getMany(
    [K.cursor, K.pins, K.groups, K.left, K.meta, K.held],
    db,
  )
  s.cursor = typeof cursor === 'number' ? cursor : 0
  const vault = parseVault({ pins, groups, left })
  s.pins = vault.pins
  s.left = vault.left
  s.meta = dict(meta)
  s.held = Array.isArray(held) ? held : []
  for (const key of await idbKeys(db)) {
    if (isStr(key) && key.startsWith('seen:')) s.seen.add(key.slice(5))
  }

  if (session) stop(session)
  session = s
  resetState()
  state.account = { server: saved.server, id: saved.id, username: saved.username }
  state.groups = vault.groups
  for (const id of Object.keys(s.pins)) updateContactFromPin(s, id)
  refreshConversations()
  void navigator.storage?.persist?.().catch(noop)
  return s
}

/** Signs in on a fresh connection: keeps local data if it belongs to this account, else wipes it. */
async function begin(conn: Conn, w: Welcome, server: string, identity: Identity, token: string, cursor: number) {
  if (!validId(w.me?.id)) throw new Error('Unexpected reply from the server')
  const prev = await get<Saved>(K.session, db)
  let replay = false
  if (!prev || prev.id !== w.me.id || prev.server !== server) {
    await clear(db)
    replay = cursor > 0 // the server is syncing from a cursor that belonged to other data
    cursor = 0
  }
  const saved: Saved = { server, id: w.me.id, username: w.me.username, token, identity }
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
    return localStorage.getItem(LS_SERVER) ?? ''
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
    })
    const w = await conn.next()
    if (w.type !== 'welcome' || !isStr(w.token)) throw new Error('Unexpected reply from the server')
    await begin(conn, w, server, identity, w.token, 0)
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
    conn.send({ type: 'login', username, authKey: b64(keys.authKey), cursor })
    const w = await conn.next()
    if (w.type !== 'welcome' || !isStr(w.token) || !isStr(w.bundle)) throw new Error('Unexpected reply from the server')
    let identity: Identity
    try {
      identity = unlockIdentity(w.bundle, keys.lockKey, bundleName(w.me.username))
    } catch {
      throw new Error('Could not unlock your keys with this password')
    }
    await begin(conn, w, server, identity, w.token, cursor)
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
  if (session && id === session.me) return session.saved.username
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

export function myFingerprint(): string {
  return fingerprint(requireSession().identity)
}

export async function setVerified(id: string, verified: boolean) {
  const s = requireSession()
  const pin = s.pins[id]
  if (!pin) return
  pin.verified = verified
  pin.at = Date.now()
  updateContactFromPin(s, id)
  pinsChanged(s)
  await systemMessage(s, `dm:${id}`, `You marked ${displayName(id)} as ${verified ? 'verified' : 'not verified'}`)
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
  if (old) s.retiredPins[id] = old
  s.pins[id] = { name: old?.name ?? u.name, signPk: u.signPk, encPk: u.encPk, verified: false, at: Date.now() }
  updateContactFromPin(s, id)
  pinsChanged(s)
  await systemMessage(s, `dm:${id}`, `You accepted a new security key for ${displayName(id)}`)
  await serial(s, () => retryHeld(s))
}

// ---------------------------------------------------------------------------
// Public API: conversations
// ---------------------------------------------------------------------------

export async function openConv(conv: ConvId) {
  const s = requireSession()
  state.active = conv
  const meta = s.meta[conv]
  if (meta?.unread) {
    meta.unread = 0
    scheduleFlush(s)
    refreshConversations()
  }
  const list = await loadConv(s, conv)
  if (session === s && state.active === conv) state.messages = list.slice()
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
    return { pc: { t: 'dm' }, to: [peer] }
  }
  const g = state.groups[conv.slice(2)]
  if (!g) throw new Error('Group not found')
  return { pc: { t: 'g', id: g.id }, to: await groupRecipients(s, g.members) }
}

/** Everyone in a member list except me, skipping accounts that no longer exist. */
async function groupRecipients(s: Session, members: string[]): Promise<string[]> {
  await ensurePinned(s, members).catch(noop)
  const to = members.filter((id) => id !== s.me && s.pins[id])
  if (to.length === 0) throw new Error('Nobody else is in this group')
  return to
}

async function sendContent(header: (pc: PayloadConv) => PayloadHeader, local: Partial<ChatMessage>, attachment?: Uint8Array) {
  const s = requireSession()
  const conv = state.active // the conversation on screen when the user hit send
  if (!conv) throw new Error('Open a conversation first')
  const { pc, to } = await targetsOf(s, conv)
  const id = randomId()
  const mid = msgId(s.me, id)
  const ts = Date.now()
  recipientKeys(s, to) // throws before anything is shown if a key changed
  const msg: ChatMessage = { id: mid, conv, from: s.me, ts, kind: 'text', status: 'sending', ...local }
  if (attachment) {
    if (!live(s)) return
    await set(K.file(mid), attachment, db)
  }
  if (!live(s)) return
  await appendMessage(s, msg, false)
  s.pendingSends.set(id, { conv, mid })
  try {
    sendEnvelope(s, to, header(pc), attachment, id, ts)
  } catch (e) {
    s.pendingSends.delete(id)
    await updateMessageStatus(s, conv, mid, 'failed')
    throw e
  }
}

export async function sendText(doc: JSONContent, replyTo?: ChatMessage | null) {
  void replyTo
  await sendContent((conv) => ({ conv, body: { t: 'text', doc } }), { kind: 'text', doc })
}

export async function sendFile(file: File, replyTo?: ChatMessage | null) {
  void replyTo
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const name = cleanLabel(file.name, 200) || 'file'
  const mime = (file.type || 'application/octet-stream').slice(0, 100)
  await sendContent(
    (conv) => ({ conv, body: { t: 'file', name, mime, size: bytes.length } }),
    { kind: 'file', file: { name, mime, size: bytes.length } },
    bytes,
  )
}

export async function fileUrl(msg: ChatMessage): Promise<string | null> {
  const s = session
  if (!s || msg.kind !== 'file' || !msg.file) return null
  const cached = s.fileUrls.get(msg.id)
  if (cached) return cached
  const bytes = await get<Uint8Array>(K.file(msg.id), db)
  if (!bytes || session !== s) return null
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: safeMime(msg.file.mime) }))
  s.fileUrls.set(msg.id, url)
  return url
}

export async function createGroup(nameInput: string, members: string[]): Promise<ConvId> {
  const s = requireSession()
  const name = cleanLabel(nameInput, 64)
  if (!name) throw new Error('Give the group a name')
  const others = [...new Set(members)].filter((id) => validId(id) && id !== s.me && state.contacts[id]?.friend)
  if (others.length === 0) throw new Error('Pick at least one friend')
  const group: Group = { id: randomId(), name, members: [s.me, ...others] }
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
  const added = [...new Set(members)].filter((id) => validId(id) && !g.members.includes(id) && state.contacts[id]?.friend)
  if (added.length === 0) return
  const all = [...g.members, ...added]
  sendEnvelope(s, await groupRecipients(s, all), {
    conv: { t: 'g', id: g.id },
    body: { t: 'group', id: g.id, name: g.name, members: all },
  })
  g.members = all
  groupsChanged(s)
  await systemMessage(s, `g:${g.id}`, `You added ${names(added)}`)
}

async function removeGroupLocally(s: Session, groupId: string) {
  const conv: ConvId = `g:${groupId}`
  const list = await loadConv(s, conv)
  await delMany([K.conv(conv), ...list.filter((m) => m.kind === 'file').map((m) => K.file(m.id))], db)
  s.convs.delete(conv)
  s.dirtyConvs.delete(conv)
  delete state.groups[groupId]
  delete s.meta[conv]
  s.left[groupId] = Date.now()
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

export async function editMessage(msg: ChatMessage, doc: JSONContent): Promise<void> {
  void msg; void doc
  throw new Error('not implemented')
}
export async function deleteMessage(msg: ChatMessage): Promise<void> {
  void msg
  throw new Error('not implemented')
}
export async function react(msg: ChatMessage, emoji: string): Promise<void> {
  void msg; void emoji
  throw new Error('not implemented')
}
const incomingListeners = new Set<(m: ChatMessage) => void>()
export function onIncoming(cb: (m: ChatMessage) => void): () => void {
  incomingListeners.add(cb)
  return () => incomingListeners.delete(cb)
}
export function previewText(m: ChatMessage): string {
  return previewOf(m)
}
