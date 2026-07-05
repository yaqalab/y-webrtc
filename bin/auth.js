/**
 * Stateless identity hashing and access-key signing for the signaling server.
 *
 * The signaling server does not authenticate *who* a user is — the client app
 * (yaqat) does that against a cloud provider and relays a trusted `id`. Here we
 * only:
 *   - hash that id (keyed, so a leaked store can't be reversed), and
 *   - mint / verify a short-lived signed key the client reuses to connect.
 *
 * Keys are stateless (HMAC over the payload), so any instance that shares the
 * same `KEY_SECRET` — the Oracle box and the local fallback — can verify a key
 * offline, with no shared datastore.
 *
 * Required env:
 *   ID_PEPPER   secret used to keyed-hash ids        (openssl rand -hex 32)
 *   KEY_SECRET  secret used to sign/verify keys       (openssl rand -hex 32)
 * Optional env:
 *   KEY_TTL     key lifetime in seconds (default 86400)
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * @param {string} name
 * @return {string}
 */
const requireSecret = name => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var ${name}`)
  }
  return value
}

/**
 * Keyed, deterministic hash of a trusted id. Plaintext ids are never stored;
 * only this hash is. Deterministic so the same id maps to the same hash across
 * every instance (they share ID_PEPPER).
 *
 * @param {string} id
 * @return {string} base64url HMAC-SHA256 digest
 */
export const hashId = id =>
  createHmac('sha256', requireSecret('ID_PEPPER')).update(String(id)).digest('base64url')

/**
 * Mint a signed, expiring access key for an already-hashed id.
 *
 * @param {string} idHash
 * @param {number} [ttlSeconds]
 * @return {{ key: string, expiresAt: number }}
 */
export const signKey = (idHash, ttlSeconds = Number(process.env.KEY_TTL) || 86400) => {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttlSeconds
  const payload = Buffer.from(JSON.stringify({ h: idHash, iat, exp })).toString('base64url')
  const sig = createHmac('sha256', requireSecret('KEY_SECRET')).update(payload).digest('base64url')
  return { key: `${payload}.${sig}`, expiresAt: exp }
}

/**
 * Verify a key's signature and expiry. Returns the claims on success, or null
 * for any malformed / tampered / expired key. No datastore lookup.
 *
 * @param {string|null} key
 * @return {{ idHash: string, exp: number }|null}
 */
export const verifyKey = key => {
  if (typeof key !== 'string') {
    return null
  }
  const dot = key.indexOf('.')
  if (dot < 0) {
    return null
  }
  const payload = key.slice(0, dot)
  const sig = key.slice(dot + 1)
  const expected = createHmac('sha256', requireSecret('KEY_SECRET')).update(payload).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expectedBuf = Buffer.from(expected)
  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null
  }
  let claims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (e) {
    return null
  }
  if (!claims || typeof claims.h !== 'string' || typeof claims.exp !== 'number') {
    return null
  }
  if (Math.floor(Date.now() / 1000) >= claims.exp) {
    return null
  }
  return { idHash: claims.h, exp: claims.exp }
}
