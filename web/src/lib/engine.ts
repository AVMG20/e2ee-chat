import type { JSONContent } from '@tiptap/core'
import { del, delMany, get, keys as idbKeys, set } from 'idb-keyval'
import { reactive } from 'vue'
import {
  type Envelope,
  type Identity,
  type PublicKeys,
  b64,
  fingerprint,
  generateIdentity,
  open as openEnvelope,
  randomId,
  recipientsOf,
  sameKeys,
  seal,
  signChallenge,
  unb64,
} from './crypto'
import { docToText, docWithinLimits } from './render'
import {
  type Account,
  type ChatMessage,
  type ConnectionStatus,
  type Contact,
  type Conversation,
  type ConvId,
  type Group,
  MAX_FILE_BYTES,
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

/** Must match the server's rules. Leading [a-z0-9] also rules out "__proto__". */
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/
const RESERVED_NAMES = new Set(['constructor', 'prototype', 'hasownproperty', 'isprototypeof', 'tostring', 'valueof'])
export const validName = (v: unknown): v is string => isStr(v) && NAME_RE.test(v) && !RESERVED_NAMES.has(v)
const validGroupId = (v: unknown): v is string => isStr(v) && /^[0-9a-f]{32}$/.test(v)
const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 256 && v.every(validName)

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
      return validGroupId(b.id) && isStr(b.name) && isNameList(b.members)
    case 'leave':
      return validGroupId(b.id)
    default:
      return false
  }
}

/** Objects keyed by names/ids that come from other people: no prototype to pollute. */
type Dict<T> = Record<string, T>
function dict<T>(src?: unknown): Dict<T> {
  const out = Object.create(null) as Dict<T>
  if (src && typeof src === 'object') for (const [key, v] of Object.entries(src)) out[key] = v as T
  return out
}

/** Message ids are namespaced by sender so one user can't collide with another's ids. */
const msgId = (from: string, id: string) => `${from}/${id}`

/** Envelopes older than this are refused, so replays can't outlive the seen-list. */
const MAX_AGE_MS = 45 * 86_400_000

/** Only these types are ever handed to the browser as-is; everything else downloads as bytes. */
const SAFE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const safeMime = (m: string) => (SAFE_MIME.has(m) ? m : 'application/octet-stream')

// ---------------------------------------------------------------------------
// Local storage (IndexedDB). Keys stay on this device.
// ---------------------------------------------------------------------------

interface Pin {
  signPk: string
  encPk: string
  verified: boolean
}
interface ConvMeta {
  unread: number
  lastTs: number
  preview: string
}

const acctKey = (a: Account) => `${a.server}|${a.name}`
const k = {
  accounts: 'accounts',
  identity: (a: string) => `id:${a}`,
  pins: (a: string) => `pins:${a}`,
  groups: (a: string) => `groups:${a}`,
  meta: (a: string) => `meta:${a}`,
  seen: (a: string) => `seen:${a}`,
  conv: (a: string, c: ConvId) => `conv:${a}:${c}`,
  file: (a: string, id: string) => `file:${a}:${id}`,
}

export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, '')
  if (!s) throw new Error('Enter the server address')
  if (!/^https?:\/\//i.test(s)) {
    s = (/^(localhost|127\.|\[::1\])/.test(s) ? 'http://' : 'https://') + s
  }
  const url = new URL(s)
  return url.origin
}

function wsUrl(server: string): string {
  return server.replace(/^http/i, 'ws') + '/ws'
}

const pinKeys = (p: Pin): PublicKeys => ({ signPk: unb64(p.signPk), encPk: unb64(p.encPk) })

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ChatState {
  status: ConnectionStatus
  account: Account | null
  error: string | null
  contacts: Dict<Contact>
  groups: Dict<Group>
  conversations: Conversation[]
  active: ConvId | null
  messages: ChatMessage[]
}

export const state = reactive<ChatState>({
  status: 'offline',
  account: null,
  error: null,
  contacts: dict(),
  groups: dict(),
  conversations: [],
  active: null,
  messages: [],
})

interface ServerUser {
  name: string
  signPk: string
  encPk: string
  online: boolean
}

type ServerMsg =
  | { type: 'challenge'; nonce: string }
  | { type: 'welcome'; name: string }
  | { type: 'directory'; users: ServerUser[] }
  | { type: 'user'; user: ServerUser }
  | { type: 'presence'; name: string; online: boolean }
  | { type: 'deliver'; qid: number; envelope: Envelope }
  | { type: 'sent'; id: string }
  | { type: 'failed'; id: string; message: string }
  | { type: 'pong' }
  | { type: 'error'; message: string }

/** Everything belonging to the logged-in session. */
class Session {
  ws: WebSocket | null = null
  closed = false
  retry = 0
  pingTimer: ReturnType<typeof setInterval> | undefined
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** Keys the server currently reports, by name (may differ from pins). */
  serverKeys: Dict<PublicKeys> = dict()
  pins: Dict<Pin> = dict()
  meta: Dict<ConvMeta> = dict()
  /** Message id → time, for every envelope already processed (replay protection). */
  seen = new Map<string, number>()
  /** Envelopes from contacts whose key changed, retried after trustNewKey. */
  held: { qid: number; env: Envelope }[] = []
  /** Every read-modify-write of local storage runs through this chain, one at a time. */
  queue: Promise<unknown> = Promise.resolve()
  fileUrls = new Map<string, string>()
  /** Envelope id → local message, for messages awaiting the server's "sent". */
  pendingConv = new Map<string, { conv: ConvId; mid: string }>()

  readonly account: Account
  readonly key: string
  readonly id: Identity

  constructor(account: Account, key: string, id: Identity) {
    this.account = account
    this.key = key
    this.id = id
  }
}

let session: Session | null = null

function me(): string {
  return session!.account.name
}

const noop = () => {}

function serial<T>(s: Session, fn: () => Promise<T> | T): Promise<T> {
  const p = s.queue.then(fn)
  s.queue = p.then(noop, noop)
  return p
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

type AuthMode = { kind: 'login' } | { kind: 'register'; invite: string }

function connect(s: Session, mode: AuthMode): Promise<void> {
  return new Promise((resolve, reject) => {
    let welcomed = false
    let failure: string | null = null
    state.status = 'connecting'
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl(s.account.server))
    } catch {
      reject(new Error('Invalid server address'))
      return
    }
    s.ws = ws

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let msg: ServerMsg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'challenge') {
        const sig = signChallenge(s.id, msg.nonce)
        const out =
          mode.kind === 'register'
            ? {
                type: 'register',
                name: s.account.name,
                invite: mode.invite,
                signPk: b64(s.id.signPk),
                encPk: b64(s.id.encPk),
                sig,
              }
            : { type: 'login', name: s.account.name, sig }
        ws.send(JSON.stringify(out))
      } else if (msg.type === 'welcome') {
        welcomed = true
        s.retry = 0
        state.status = 'online'
        resolve()
      } else if (msg.type === 'error' && !welcomed) {
        failure = msg.message
      } else if (session === s) {
        const m = msg
        serial(s, () => handleServerMsg(s, m)).catch((e) => console.warn(`handling ${m.type} failed`, e))
      }
    }

    ws.onclose = () => {
      if (s.ws === ws) s.ws = null
      if (!welcomed) {
        reject(new Error(failure ?? `Could not reach ${s.account.server}`))
        return
      }
      if (session !== s || s.closed) return
      state.status = 'connecting'
      s.reconnectTimer = setTimeout(() => reconnect(s), Math.min(30_000, 1000 * 2 ** s.retry++))
    }
  })
}

function reconnect(s: Session) {
  if (session !== s || s.closed) return
  connect(s, { kind: 'login' }).catch((e: Error) => {
    if (session !== s || s.closed) return
    state.status = 'offline'
    if (/bad signature|Unknown user/i.test(e.message)) {
      state.error = e.message // permanent: don't hammer the server
      return
    }
    s.reconnectTimer = setTimeout(() => reconnect(s), Math.min(30_000, 1000 * 2 ** s.retry++))
  })
}

function wsSend(s: Session, obj: unknown): boolean {
  if (s.ws?.readyState !== WebSocket.OPEN) return false
  s.ws.send(JSON.stringify(obj))
  return true
}

async function handleServerMsg(s: Session, msg: ServerMsg) {
  if (session !== s) return
  switch (msg.type) {
    case 'directory': {
      let changed = false
      for (const u of Array.isArray(msg.users) ? msg.users : []) {
        try {
          changed = applyUser(s, u) || changed
        } catch (e) {
          console.warn('ignoring bad directory entry', e)
        }
      }
      if (changed) await set(k.pins(s.key), { ...s.pins })
      refreshConversations()
      break
    }
    case 'user':
      if (applyUser(s, msg.user)) await set(k.pins(s.key), { ...s.pins })
      refreshConversations()
      break
    case 'presence': {
      const c = validName(msg.name) ? state.contacts[msg.name] : undefined
      if (c) c.online = !!msg.online
      break
    }
    case 'deliver':
      await receive(s, msg.qid, msg.envelope)
      break
    case 'sent':
    case 'failed': {
      const p = isStr(msg.id) ? s.pendingConv.get(msg.id) : undefined
      if (p) {
        s.pendingConv.delete(msg.id)
        await updateMessageStatus(s, p.conv, p.mid, msg.type === 'sent' ? 'sent' : 'failed')
      }
      if (msg.type === 'failed') state.error = msg.message
      break
    }
    case 'error':
      state.error = msg.message
      if (/another window/i.test(msg.message)) {
        s.closed = true
        state.status = 'offline'
      }
      break
  }
}

// ---------------------------------------------------------------------------
// Contacts & key pinning (trust on first use, then explicit re-trust)
// ---------------------------------------------------------------------------

/** Updates contact state from a server directory entry. Returns true if a new pin was added. */
function applyUser(s: Session, u: ServerUser): boolean {
  if (!u || typeof u !== 'object' || !validName(u.name) || u.name === me()) return false
  if (!isStr(u.signPk) || !isStr(u.encPk)) return false
  const keys = { signPk: unb64(u.signPk), encPk: unb64(u.encPk) }
  if (keys.signPk.length !== 32 || keys.encPk.length !== 32) return false
  s.serverKeys[u.name] = keys
  let pin = s.pins[u.name]
  let added = false
  if (!pin) {
    pin = { signPk: u.signPk, encPk: u.encPk, verified: false }
    s.pins[u.name] = pin
    added = true
  }
  const changed = !sameKeys(pinKeys(pin), keys)
  state.contacts[u.name] = {
    name: u.name,
    online: !!u.online,
    fingerprint: fingerprint(pinKeys(pin)),
    verified: pin.verified,
    keyChanged: changed,
    pendingFingerprint: changed ? fingerprint(keys) : null,
  }
  return added
}

function recipientKeys(s: Session, names: string[]) {
  return names.map((name) => {
    const pin = s.pins[name]
    if (!pin) throw new Error(`Unknown user ${name}`)
    if (state.contacts[name]?.keyChanged) {
      throw new Error(`${name}'s security key changed. Verify it before sending.`)
    }
    return { name, encPk: unb64(pin.encPk) }
  })
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
  for (const c of Object.values(state.contacts)) add(`dm:${c.name}`, 'dm', c.name)
  list.sort((a, b) => b.lastTs - a.lastTs || a.title.localeCompare(b.title))
  state.conversations = list
}

function previewOf(m: ChatMessage): string {
  if (m.kind === 'file') return `📎 ${m.file?.name ?? 'file'}`
  if (m.kind === 'system') return m.text ?? ''
  const text = docToText(m.doc)
  return text.length > 80 ? text.slice(0, 80) + '…' : text
}

async function loadConv(s: Session, conv: ConvId): Promise<ChatMessage[]> {
  return (await get<ChatMessage[]>(k.conv(s.key, conv))) ?? []
}

async function appendMessage(s: Session, m: ChatMessage, countUnread: boolean) {
  const list = await loadConv(s, m.conv)
  // Keep sorted by time; queued messages may arrive out of order.
  let i = list.length
  while (i > 0 && list[i - 1]!.ts > m.ts) i--
  list.splice(i, 0, m)
  await set(k.conv(s.key, m.conv), list)

  const meta = s.meta[m.conv] ?? { unread: 0, lastTs: 0, preview: '' }
  if (m.ts >= meta.lastTs) {
    meta.lastTs = m.ts
    meta.preview = (m.from === me() || m.kind === 'system' ? '' : `${m.from}: `) + previewOf(m)
  }
  if (countUnread && state.active !== m.conv) meta.unread++
  s.meta[m.conv] = meta
  await saveMeta(s)

  if (state.active === m.conv && session === s) {
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
  const live = state.messages.find((m) => m.id === mid && m.conv === conv)
  if (live) live.status = status
  const list = await loadConv(s, conv)
  const m = list.find((x) => x.id === mid)
  if (m) {
    m.status = status
    await set(k.conv(s.key, conv), list)
  }
}

async function saveGroups(s: Session) {
  await set(k.groups(s.key), JSON.parse(JSON.stringify({ ...state.groups })))
}

async function saveMeta(s: Session) {
  await set(k.meta(s.key), { ...s.meta })
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

function pruneSeen(s: Session) {
  const cutoff = Date.now() - MAX_AGE_MS
  for (const [mid, ts] of s.seen) if (ts < cutoff) s.seen.delete(mid)
}

async function markSeen(s: Session, mid: string, ts: number) {
  // Kept until the envelope's own (signed) timestamp is too old to be accepted anyway.
  s.seen.set(mid, Math.max(ts, Date.now()))
  pruneSeen(s)
  await set(k.seen(s.key), [...s.seen])
}

/** Processes one queued envelope. Only call from inside serial(). */
async function receive(s: Session, qid: number, env: Envelope) {
  if (session !== s) return
  const ack = () => void wsSend(s, { type: 'ack', qids: [qid] })
  if (!env || typeof env !== 'object' || !isStr(env.id) || !validName(env.from) || env.from === me()) return ack()
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return ack()
  const mid = msgId(env.from, env.id)
  if (s.seen.has(mid)) return ack() // replay / duplicate
  if (env.ts < Date.now() - MAX_AGE_MS) {
    console.warn(`dropping stale message from ${env.from}`)
    return ack()
  }

  const sender = env.from
  const pin = s.pins[sender]
  if (!pin) return // unknown sender: leave queued, retry on next login
  if (state.contacts[sender]?.keyChanged) {
    s.held.push({ qid, env })
    return
  }

  let plain: Uint8Array
  try {
    plain = openEnvelope(s.id, me(), unb64(pin.signPk), env)
  } catch (e) {
    console.warn(`dropping undecryptable message from ${sender}:`, e)
    return ack()
  }
  // From here on the envelope is authentic: whatever happens, never process it twice.
  try {
    const { header, attachment } = decodePayload(plain)
    if (!validHeader(header)) throw new Error('invalid header')
    const ts = Math.min(env.ts, Date.now() + 60_000)
    await handlePayload(s, sender, recipientsOf(env), mid, ts, header, attachment)
  } catch (e) {
    console.warn(`dropping malformed message from ${sender}:`, e)
  }
  await markSeen(s, mid, env.ts)
  ack()
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
  // Group management messages.
  if (body.t === 'group') {
    if (pc.t !== 'g' || pc.id !== body.id) return
    const conv: ConvId = `g:${body.id}`
    const existing = state.groups[body.id]
    const proposed = [...new Set(body.members)]
    if (!existing) {
      if (!proposed.includes(me()) || !proposed.includes(sender)) return
      const name = cleanLabel(body.name, 64) || 'Group'
      state.groups[body.id] = { id: body.id, name, members: proposed }
      await saveGroups(s)
      await systemMessage(s, conv, `${sender} added you to “${name}”`, ts)
      return
    }
    if (!existing.members.includes(sender)) return
    const added = proposed.filter((n) => !existing.members.includes(n))
    // Updates can only add members; leaving is a separate, self-authored message.
    existing.members = [...existing.members, ...added]
    await saveGroups(s)
    if (added.length) await systemMessage(s, conv, `${sender} added ${added.join(', ')}`, ts)
    refreshConversations()
    return
  }
  if (body.t === 'leave') {
    const g = state.groups[body.id]
    if (!g || pc.t !== 'g' || pc.id !== body.id || !g.members.includes(sender)) return
    g.members = g.members.filter((n) => n !== sender)
    await saveGroups(s)
    await systemMessage(s, `g:${g.id}`, `${sender} left the group`, ts)
    return
  }

  // Chat content.
  let conv: ConvId
  if (pc.t === 'dm') {
    if (recipients.length !== 1) return
    conv = `dm:${sender}`
  } else {
    const g = state.groups[pc.id]
    if (!g || !g.members.includes(sender)) return
    conv = `g:${g.id}`
  }

  const msg: ChatMessage = { id: mid, conv, from: sender, ts, kind: 'text', status: 'received' }
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
    await set(k.file(s.key, mid), attachment)
  }
  await appendMessage(s, msg, true)
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function targetsOf(s: Session, conv: ConvId): { pc: PayloadConv; to: string[] } {
  if (conv.startsWith('dm:')) return { pc: { t: 'dm' }, to: [conv.slice(3)] }
  const g = state.groups[conv.slice(2)]
  if (!g) throw new Error('Group not found')
  return { pc: { t: 'g', id: g.id }, to: groupRecipients(s, g.members) }
}

/** Everyone in a member list except me, skipping names this server doesn't know. */
function groupRecipients(s: Session, members: string[]): string[] {
  const to = members.filter((n) => n !== me() && s.pins[n])
  const missing = members.filter((n) => n !== me() && !s.pins[n])
  if (missing.length) console.warn(`not sending to unknown group members: ${missing.join(', ')}`)
  if (to.length === 0) throw new Error('Nobody else is in this group')
  return to
}

function sendEnvelope(s: Session, to: string[], header: PayloadHeader, attachment?: Uint8Array): Envelope {
  const env = seal(s.id, me(), recipientKeys(s, to), encodePayload(header, attachment))
  if (!wsSend(s, { type: 'send', envelope: env })) throw new Error('Not connected to the server')
  return env
}

async function sendContent(
  header: (pc: PayloadConv) => PayloadHeader,
  local: Partial<ChatMessage>,
  attachment?: Uint8Array,
) {
  const s = requireSession()
  const conv = state.active // the conversation on screen when the user hit send
  if (!conv) throw new Error('Open a conversation first')
  await serial(s, async () => {
    const { pc, to } = targetsOf(s, conv)
    const id = randomId()
    const mid = msgId(me(), id)
    const ts = Date.now()
    const env = seal(s.id, me(), recipientKeys(s, to), encodePayload(header(pc), attachment), id, ts)
    const msg: ChatMessage = { id: mid, conv, from: me(), ts, kind: 'text', status: 'sending', ...local }
    if (attachment) await set(k.file(s.key, mid), attachment)
    await appendMessage(s, msg, false)
    s.pendingConv.set(id, { conv, mid })
    if (!wsSend(s, { type: 'send', envelope: env })) {
      s.pendingConv.delete(id)
      await updateMessageStatus(s, conv, mid, 'failed')
      throw new Error('Not connected to the server')
    }
  })
}

function requireSession(): Session {
  if (!session) throw new Error('Not signed in')
  return session
}

/** Runs a public API call on the session's serial queue. */
function withSession<T>(fn: (s: Session) => Promise<T> | T): Promise<T> {
  const s = requireSession()
  return serial(s, () => fn(s))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function startSession(account: Account, identity: Identity, mode: AuthMode) {
  if (session) logout()
  const s = new Session(account, acctKey(account), identity)
  s.pins = dict(await get(k.pins(s.key)))
  s.meta = dict(await get(k.meta(s.key)))
  const seen: unknown = await get(k.seen(s.key))
  s.seen = new Map(
    (Array.isArray(seen) ? seen : []).filter(
      (e): e is [string, number] => Array.isArray(e) && isStr(e[0]) && typeof e[1] === 'number',
    ),
  )
  pruneSeen(s)
  const groups = dict<Group>()
  for (const g of Object.values(dict<Group>(await get(k.groups(s.key))))) {
    if (validGroupId(g?.id) && isStr(g.name) && isNameList(g.members)) groups[g.id] = g
  }
  session = s
  state.contacts = dict()
  state.groups = groups
  // Ask the browser not to evict our keys and history under storage pressure.
  void navigator.storage?.persist?.().catch(noop)
  state.active = null
  state.messages = []
  try {
    await connect(s, mode)
  } catch (e) {
    if (session === s) {
      session = null
      state.status = 'offline'
    }
    s.closed = true
    s.ws?.close()
    throw e
  }
  state.account = account
  s.pingTimer = setInterval(() => wsSend(s, { type: 'ping' }), 25_000)
  refreshConversations()
}

export async function listAccounts(): Promise<Account[]> {
  return (await get<Account[]>(k.accounts)) ?? []
}

export async function createAccount(serverInput: string, nameInput: string, invite: string) {
  const server = normalizeServer(serverInput)
  const name = nameInput.trim().toLowerCase()
  if (!validName(name)) {
    throw new Error('Username must be 2-32 chars (a-z, 0-9, _ . -) and start with a letter or digit')
  }
  const account = { server, name }
  const key = acctKey(account)
  const existing = await listAccounts()
  if (existing.some((a) => acctKey(a) === key)) {
    throw new Error('That account already exists on this device. Sign in instead.')
  }
  // Save the keys before registering: once the server accepts them, losing them would lose the name.
  const identity = generateIdentity()
  await set(k.identity(key), identity)
  await set(k.accounts, [...existing, account])
  try {
    await startSession(account, identity, { kind: 'register', invite: invite.trim() })
  } catch (e) {
    await del(k.identity(key))
    await set(k.accounts, (await listAccounts()).filter((a) => acctKey(a) !== key))
    throw e
  }
}

export async function login(account: Account) {
  const identity = await get<Identity>(k.identity(acctKey(account)))
  if (!identity) throw new Error('Keys for this account are missing on this device')
  await startSession(account, identity, { kind: 'login' })
}

export function logout() {
  const s = session
  session = null
  if (s) {
    s.closed = true
    clearInterval(s.pingTimer)
    clearTimeout(s.reconnectTimer)
    s.ws?.close()
    for (const url of s.fileUrls.values()) URL.revokeObjectURL(url)
  }
  Object.assign(state, {
    status: 'offline',
    account: null,
    contacts: dict(),
    groups: dict(),
    conversations: [],
    active: null,
    messages: [],
  } satisfies Partial<ChatState>)
}

export async function forgetAccount(account: Account) {
  const key = acctKey(account)
  if (session?.key === key) logout()
  const all = (await idbKeys()).filter(
    (x): x is string => typeof x === 'string' && (x.endsWith(`:${key}`) || x.includes(`:${key}:`)),
  )
  await delMany(all)
  await del(k.identity(key))
  await set(k.accounts, (await listAccounts()).filter((a) => acctKey(a) !== key))
}

export function openConv(conv: ConvId) {
  return withSession(async (s) => {
    state.active = conv
    const meta = s.meta[conv]
    if (meta?.unread) {
      meta.unread = 0
      await saveMeta(s)
      refreshConversations()
    }
    const list = await loadConv(s, conv)
    if (state.active === conv) state.messages = list
  })
}

export async function sendText(doc: JSONContent) {
  await sendContent((conv) => ({ conv, body: { t: 'text', doc } }), { kind: 'text', doc })
}

export async function sendFile(file: File) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const name = file.name.slice(0, 200) || 'file'
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
  const bytes = await get<Uint8Array>(k.file(s.key, msg.id))
  if (!bytes || session !== s) return null
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: safeMime(msg.file.mime) }))
  s.fileUrls.set(msg.id, url)
  return url
}

export async function createGroup(nameInput: string, members: string[]): Promise<ConvId> {
  const conv = await withSession(async (s) => {
    const name = cleanLabel(nameInput, 64)
    if (!name) throw new Error('Give the group a name')
    const others = [...new Set(members)].filter((n) => validName(n) && n !== me() && state.contacts[n])
    if (others.length === 0) throw new Error('Pick at least one person')
    const group: Group = { id: randomId(), name, members: [me(), ...others] }
    sendEnvelope(s, others, { conv: { t: 'g', id: group.id }, body: { t: 'group', ...group } })
    state.groups[group.id] = group
    await saveGroups(s)
    const conv: ConvId = `g:${group.id}`
    await systemMessage(s, conv, `You created “${name}” with ${others.join(', ')}`)
    return conv
  })
  await openConv(conv)
  return conv
}

export function addMembers(groupId: string, members: string[]) {
  return withSession(async (s) => {
    const g = state.groups[groupId]
    if (!g) throw new Error('Group not found')
    const added = [...new Set(members)].filter((n) => validName(n) && !g.members.includes(n) && state.contacts[n])
    if (added.length === 0) return
    const all = [...g.members, ...added]
    sendEnvelope(s, groupRecipients(s, all), {
      conv: { t: 'g', id: g.id },
      body: { t: 'group', id: g.id, name: g.name, members: all },
    })
    g.members = all
    await saveGroups(s)
    await systemMessage(s, `g:${g.id}`, `You added ${added.join(', ')}`)
  })
}

export function leaveGroup(groupId: string) {
  return withSession(async (s) => {
    const g = state.groups[groupId]
    if (!g) return
    const others = g.members.filter((n) => n !== me() && s.pins[n])
    if (others.length) sendEnvelope(s, others, { conv: { t: 'g', id: g.id }, body: { t: 'leave', id: g.id } })
    const conv: ConvId = `g:${g.id}`
    const list = await loadConv(s, conv)
    await delMany([k.conv(s.key, conv), ...list.filter((m) => m.kind === 'file').map((m) => k.file(s.key, m.id))])
    delete state.groups[groupId]
    delete s.meta[conv]
    await saveMeta(s)
    await saveGroups(s)
    if (state.active === conv) {
      state.active = null
      state.messages = []
    }
    refreshConversations()
  })
}

export function myFingerprint(): string {
  const s = requireSession()
  return fingerprint(s.id)
}

export function setVerified(name: string, verified: boolean) {
  return withSession(async (s) => {
    const pin = s.pins[name]
    if (!pin) return
    pin.verified = verified
    await set(k.pins(s.key), { ...s.pins })
    const c = state.contacts[name]
    if (c) c.verified = verified
    await systemMessage(s, `dm:${name}`, verified ? `You marked ${name} as verified` : `You marked ${name} as not verified`)
  })
}

/**
 * Accept a contact's changed key. `seenFingerprint` is the pendingFingerprint the user
 * compared; if the server swapped the key again in the meantime, this throws.
 */
export function trustNewKey(name: string, seenFingerprint: string) {
  return withSession(async (s) => {
    const keys = s.serverKeys[name]
    if (!keys) throw new Error(`${name} is not on this server`)
    if (fingerprint(keys) !== seenFingerprint) {
      throw new Error(`${name}'s key changed again. Compare the new security code before accepting.`)
    }
    s.pins[name] = { signPk: b64(keys.signPk), encPk: b64(keys.encPk), verified: false }
    await set(k.pins(s.key), { ...s.pins })
    const c = state.contacts[name]
    if (c) {
      c.keyChanged = false
      c.pendingFingerprint = null
      c.verified = false
      c.fingerprint = fingerprint(keys)
    }
    await systemMessage(s, `dm:${name}`, `You accepted a new security key for ${name}`)
    const held = s.held.filter((h) => h.env.from === name)
    s.held = s.held.filter((h) => h.env.from !== name)
    for (const h of held) {
      try {
        await receive(s, h.qid, h.env)
      } catch (e) {
        console.warn('receive failed', e)
      }
    }
  })
}

export function defaultServer(): string {
  return isDesktop ? '' : location.origin
}

export const isDesktop = '__TAURI_INTERNALS__' in globalThis
