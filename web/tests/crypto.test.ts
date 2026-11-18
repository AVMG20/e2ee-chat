import { describe, expect, test } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { type Envelope, b64, fingerprint, generateIdentity, open, seal, unb64, utf8 } from '../src/lib/crypto'

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
