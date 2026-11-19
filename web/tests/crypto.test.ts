import { describe, expect, test } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  type Envelope,
  b64,
  deriveFromPassword,
  fingerprint,
  generateIdentity,
  lockIdentity,
  open,
  openVault,
  seal,
  sealVault,
  unb64,
  unlockIdentity,
  utf8,
} from '../src/lib/crypto'

const alice = generateIdentity()
const bob = generateIdentity()
const carol = generateIdentity()
const eve = generateIdentity()
const msg = utf8('hello bob, this is secret')
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe('envelopes', () => {
  test('direct message round-trips', () => {
    const env = seal(alice, 'alice', [{ name: 'bob', encPk: bob.encPk }], msg)
    expect(dec(open(bob, 'bob', alice.signPk, env))).toBe('hello bob, this is secret')
  })

  test('ciphertext does not contain plaintext', () => {
    const env = seal(alice, 'alice', [{ name: 'bob', encPk: bob.encPk }], msg)
    expect(JSON.stringify(env)).not.toContain('secret')
    expect(dec(unb64(env.ct))).not.toContain('secret')
  })

  test('group message opens for every recipient', () => {
    const env = seal(alice, 'alice', [
      { name: 'bob', encPk: bob.encPk },
      { name: 'carol', encPk: carol.encPk },
    ], msg)
    expect(dec(open(bob, 'bob', alice.signPk, env))).toBe(dec(msg))
    expect(dec(open(carol, 'carol', alice.signPk, env))).toBe(dec(msg))
  })

  test('non-recipient cannot open', () => {
    const env = seal(alice, 'alice', [{ name: 'bob', encPk: bob.encPk }], msg)
    expect(() => open(eve, 'eve', alice.signPk, env)).toThrow('not addressed to me')
    // Even pretending to be bob, eve lacks bob's private key.
    expect(() => open(eve, 'bob', alice.signPk, env)).toThrow('decryption failed')
  })

  test('tampered ciphertext is rejected', () => {
    const env = seal(alice, 'alice', [{ name: 'bob', encPk: bob.encPk }], msg)
    const ct = unb64(env.ct)
    ct[0]! ^= 1
    expect(() => open(bob, 'bob', alice.signPk, { ...env, ct: b64(ct) })).toThrow('bad signature')
  })

  test('server cannot forge sender or alter fields', () => {
    const env = seal(alice, 'alice', [{ name: 'bob', encPk: bob.encPk }], msg)
    expect(() => open(bob, 'bob', alice.signPk, { ...env, from: 'mallory' })).toThrow('bad signature')
    expect(() => open(bob, 'bob', alice.signPk, { ...env, ts: env.ts + 1 })).toThrow('bad signature')
    expect(() => open(bob, 'bob', alice.signPk, { ...env, keys: [...env.keys, env.keys[0]!] })).toThrow('bad signature')
  })

  test('message signed by someone else is rejected', () => {
    // Eve encrypts to bob and claims to be alice; bob checks alice's pinned key.
    const env = seal(eve, 'alice', [{ name: 'bob', encPk: bob.encPk }], msg)
    expect(() => open(bob, 'bob', alice.signPk, env)).toThrow('bad signature')
  })

  test('wrapped keys must match the signed key commitment', () => {
    const resign = (e: Omit<Envelope, 'sig'>): Envelope => {
      const fields = ['e2ee-chat/envelope/v1', e.v, e.id, e.from, e.ts, e.eph, e.nonce, e.ct, e.kc, e.keys.map((k) => [k.to, k.nonce, k.ct])]
      return { ...e, sig: b64(ed25519.sign(utf8(JSON.stringify(fields)), alice.signSk)) }
    }
    const id = 'f'.repeat(32)
    const to = [{ name: 'bob', encPk: bob.encPk }]
    const { sig: _a, ...a } = seal(alice, 'alice', to, msg, id, 1)
    const { sig: _b, ...b } = seal(alice, 'alice', to, utf8('other'), id, 1)
    expect(dec(open(bob, 'bob', alice.signPk, resign(a)))).toBe(dec(msg)) // re-signing helper is faithful
    // A malicious sender pairs a's commitment with wrapped keys for a different content key.
    const forged = resign({ ...a, eph: b.eph, keys: b.keys })
    expect(() => open(bob, 'bob', alice.signPk, forged)).toThrow('key commitment mismatch')
  })

  test('fingerprints are stable and distinct', () => {
    expect(fingerprint(alice)).toBe(fingerprint({ signPk: alice.signPk, encPk: alice.encPk }))
    expect(fingerprint(alice)).not.toBe(fingerprint(bob))
    expect(fingerprint(alice)).toMatch(/^(\d{5} ){7}\d{5}$/)
  })
})

describe('password-locked keys', () => {
  test('bundle round-trips only with the right password', async () => {
    const salt = new Uint8Array(16).fill(3)
    const right = await deriveFromPassword('correct horse battery', salt)
    const wrong = await deriveFromPassword('correct horse batterz', salt)
    const bundle = lockIdentity(alice, right.lockKey, 'alice')
    const back = unlockIdentity(bundle, right.lockKey, 'alice')
    expect(b64(back.signPk)).toBe(b64(alice.signPk))
    expect(b64(back.encPk)).toBe(b64(alice.encPk))
    expect(() => unlockIdentity(bundle, wrong.lockKey, 'alice')).toThrow()
    expect(() => unlockIdentity(bundle, right.lockKey, 'mallory')).toThrow()
    // The server-facing key reveals nothing about the lock key.
    expect(b64(right.authKey)).not.toBe(b64(right.lockKey))
  }, 30_000)

  test('vault opens only with the same identity', () => {
    const sealed = sealVault(alice, { pins: { X: 1 } })
    expect(openVault(alice, sealed)).toEqual({ pins: { X: 1 } })
    expect(() => openVault(bob, sealed)).toThrow()
  })
})

describe('backups and notices', () => {
  test('backup records only open with the same key, position and backup', async () => {
    const { backupKey, sealRecord, openRecord } = await import('../src/lib/crypto')
    const key = backupKey(alice, 'ctx')
    const sealed = sealRecord(key, utf8('hello'), utf8('a\n0'))
    expect(new TextDecoder().decode(openRecord(key, sealed, utf8('a\n0')))).toBe('hello')
    expect(() => openRecord(key, sealed, utf8('a\n1'))).toThrow()
    expect(() => openRecord(backupKey(bob, 'ctx'), sealed, utf8('a\n0'))).toThrow()
  })

  test('notices verify only for the signer and the exact text', async () => {
    const { signNotice, verifyNotice } = await import('../src/lib/crypto')
    const sig = signNotice(alice, 'revoke A device1')
    expect(verifyNotice(alice.signPk, 'revoke A device1', sig)).toBe(true)
    expect(verifyNotice(alice.signPk, 'revoke A device2', sig)).toBe(false)
    expect(verifyNotice(bob.signPk, 'revoke A device1', sig)).toBe(false)
    expect(verifyNotice(alice.signPk, 'revoke A device1', 'not base64!')).toBe(false)
    expect(verifyNotice(alice.signPk, 'revoke A device1', undefined)).toBe(false)
  })
})

describe('changing keys', () => {
  test('earlier keys survive locking and still open the vault', async () => {
    const { rotateIdentity } = await import('../src/lib/crypto')
    const first = generateIdentity()
    sealVault(first, { hello: 1 })
    const second = rotateIdentity(first, 10)
    const third = rotateIdentity(second, 20)
    expect(third.old?.map((o) => b64(o.encPk))).toEqual([b64(second.encPk), b64(first.encPk)])
    const lockKey = new Uint8Array(32).fill(5)
    const back = unlockIdentity(lockIdentity(third, lockKey, 'alice'), lockKey, 'alice')
    expect(b64(back.signPk)).toBe(b64(third.signPk))
    expect(back.old?.length).toBe(2)
    expect(back.old?.[1]?.old).toBeUndefined()
    expect(back.old?.map((o) => o.until)).toEqual([20, 10])
    // The vault only opens with the current key (an old, maybe leaked key can't plant settings).
    expect(() => openVault(back, vault)).toThrow()
    expect(openVault(back, sealVault(back, { hello: 1 }))).toEqual({ hello: 1 })
    // Notices are signed by every generation, so a device that only has an old key can check them.
    const { signNotice, verifyNotice } = await import('../src/lib/crypto')
    const sig = signNotice(back, 'revoke X d1')
    expect(verifyNotice(first.signPk, 'revoke X d1', sig)).toBe(true)
    expect(verifyNotice(third.signPk, 'revoke X d1', sig)).toBe(true)
    expect(verifyNotice(bob.signPk, 'revoke X d1', sig)).toBe(false)
    // A message sealed to the first key opens with it, found among the earlier keys.
    const env = seal(bob, 'bob', [{ name: 'alice', encPk: first.encPk }], utf8('old'), 'id1', 1)
    expect(new TextDecoder().decode(open(back.old![1]!, 'alice', bob.signPk, env))).toBe('old')
    expect(() => open(back, 'alice', bob.signPk, env)).toThrow()
  })
})
