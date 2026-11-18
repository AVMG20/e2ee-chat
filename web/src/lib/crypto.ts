/**
 * End-to-end encryption for e2ee-chat.
 *
 * Every user has two long-term key pairs, generated on their own device:
 *   - Ed25519 "sign" key: authenticates to the server and signs every envelope.
 *   - X25519 "enc" key: receives per-message content keys.
 *
 * Sending a message (to one or many recipients):
 *   1. Pick a fresh random 32-byte content key and encrypt the payload with
 *      XChaCha20-Poly1305 (AAD binds envelope id + sender).
 *   2. Make a fresh ephemeral X25519 key. For each recipient, derive a wrap key
 *      HKDF-SHA256(X25519(eph, recipient.enc), info = eph | recipient.enc | id)
 *      and encrypt the content key with it.
 *   3. Sign the whole envelope (version, id, sender, time, ciphertext, a hash
 *      commitment to the content key, and the full recipient list with wrapped keys) with the sender's Ed25519 key.
 *
 * Recipients verify the signature against the sender's *pinned* key before
 * decrypting, so the server can neither read, forge, nor alter messages.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'

export const ENVELOPE_VERSION = 1
const WRAP_SALT = utf8('e2ee-chat/wrap/v1')
const SIG_CONTEXT = 'e2ee-chat/envelope/v1'
const AUTH_CONTEXT = 'e2ee-chat-auth-v1:' // must match server
const KC_CONTEXT = utf8('e2ee-chat/kc/v1')

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function randomId(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface Identity {
  signSk: Uint8Array
  signPk: Uint8Array
  encSk: Uint8Array
  encPk: Uint8Array
}

export interface PublicKeys {
  signPk: Uint8Array
  encPk: Uint8Array
}

export function generateIdentity(): Identity {
  const signSk = ed25519.utils.randomSecretKey()
  const encSk = x25519.utils.randomSecretKey()
  return {
    signSk,
    signPk: ed25519.getPublicKey(signSk),
    encSk,
    encPk: x25519.getPublicKey(encSk),
  }
}

/** Signature over the server's login challenge. */
export function signChallenge(id: Identity, nonce: string): string {
  return b64(ed25519.sign(utf8(AUTH_CONTEXT + nonce), id.signSk))
}

/** Human-comparable fingerprint of a user's public keys: 8 groups of 5 digits. */
export function fingerprint(keys: PublicKeys): string {
  const h = sha256(concat(utf8('e2ee-chat/fp/v1'), keys.signPk, keys.encPk))
  const groups: string[] = []
  for (let i = 0; i < 8; i++) {
    const n = ((h[i * 3]! << 16) | (h[i * 3 + 1]! << 8) | h[i * 3 + 2]!) % 100000
    groups.push(n.toString().padStart(5, '0'))
  }
  return groups.join(' ')
}

export function sameKeys(a: PublicKeys, b: PublicKeys): boolean {
  return equalBytes(a.signPk, b.signPk) && equalBytes(a.encPk, b.encPk)
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface WrappedKey {
  to: string
  nonce: string
  ct: string
}

/** What travels over the wire. The server only reads `id`, `from` and `keys[].to`. */
export interface Envelope {
  v: number
  id: string
  from: string
  ts: number
  eph: string
  nonce: string
  ct: string
  /** Commitment to the content key, so every recipient provably decrypts the same message. */
  kc: string
  keys: WrappedKey[]
  sig: string
}

export interface Recipient {
  name: string
  encPk: Uint8Array
}

function signedBytes(e: Omit<Envelope, 'sig'>): Uint8Array {
  // JSON of a fixed-order array is a deterministic, unambiguous encoding.
  const fields = [
    SIG_CONTEXT,
    e.v,
    e.id,
    e.from,
    e.ts,
    e.eph,
    e.nonce,
    e.ct,
    e.kc,
    e.keys.map((k) => [k.to, k.nonce, k.ct]),
  ]
  return utf8(JSON.stringify(fields))
}

function wrapKey(shared: Uint8Array, eph: Uint8Array, recipientEncPk: Uint8Array, id: string): Uint8Array {
  return hkdf(sha256, shared, WRAP_SALT, concat(eph, recipientEncPk, utf8(id)), 32)
}

function keyCommitment(contentKey: Uint8Array): Uint8Array {
  return sha256(concat(KC_CONTEXT, contentKey))
}

function contentAad(id: string, from: string): Uint8Array {
  return utf8(`${id}\n${from}`)
}

export function seal(
  sender: Identity,
  senderName: string,
  recipients: Recipient[],
  payload: Uint8Array,
  id: string = randomId(),
  ts: number = Date.now(),
): Envelope {
  if (recipients.length === 0) throw new Error('no recipients')
  const contentKey = randomBytes(32)
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(contentKey, nonce, contentAad(id, senderName)).encrypt(payload)

  const ephSk = x25519.utils.randomSecretKey()
  const ephPk = x25519.getPublicKey(ephSk)
  const keys = recipients.map((r) => {
    const shared = x25519.getSharedSecret(ephSk, r.encPk)
    const k = wrapKey(shared, ephPk, r.encPk, id)
    const n = randomBytes(24)
    const wrapped = xchacha20poly1305(k, n).encrypt(contentKey)
    return { to: r.name, nonce: b64(n), ct: b64(wrapped) }
  })
  ephSk.fill(0)

  const unsigned = {
    v: ENVELOPE_VERSION,
    id,
    from: senderName,
    ts,
    eph: b64(ephPk),
    nonce: b64(nonce),
    ct: b64(ct),
    kc: b64(keyCommitment(contentKey)),
    keys,
  }
  const sig = b64(ed25519.sign(signedBytes(unsigned), sender.signSk))
  contentKey.fill(0)
  return { ...unsigned, sig }
}

export class OpenError extends Error {}

/**
 * Verify and decrypt an envelope addressed to `me`.
 * `senderSignPk` must be the sender's pinned key, never one taken from the envelope.
 */
export function open(me: Identity, myName: string, senderSignPk: Uint8Array, env: Envelope): Uint8Array {
  if (env.v !== ENVELOPE_VERSION) throw new OpenError('unsupported envelope version')
  const { sig, ...unsigned } = env
  let ok = false
  try {
    ok = ed25519.verify(unb64(sig), signedBytes(unsigned), senderSignPk, { zip215: false })
  } catch {
    ok = false
  }
  if (!ok) throw new OpenError('bad signature')

  const mine = env.keys.find((k) => k.to === myName)
  if (!mine) throw new OpenError('not addressed to me')
  let contentKey: Uint8Array
  try {
    const ephPk = unb64(env.eph)
    const shared = x25519.getSharedSecret(me.encSk, ephPk)
    const k = wrapKey(shared, ephPk, me.encPk, env.id)
    contentKey = xchacha20poly1305(k, unb64(mine.nonce)).decrypt(unb64(mine.ct))
  } catch {
    throw new OpenError('decryption failed')
  }
  // Without this a sender could wrap different keys for different recipients
  // so that one ciphertext decrypts to different messages for each of them.
  if (!equalBytes(keyCommitment(contentKey), unb64(env.kc))) throw new OpenError('key commitment mismatch')
  try {
    return xchacha20poly1305(contentKey, unb64(env.nonce), contentAad(env.id, env.from)).decrypt(unb64(env.ct))
  } catch {
    throw new OpenError('decryption failed')
  }
}

/** Recipient names an envelope was addressed to (signed, so trustworthy after open()). */
export function recipientsOf(env: Envelope): string[] {
  return env.keys.map((k) => k.to)
}
