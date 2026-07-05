/**
 * Redis-backed Store, for higher-throughput atomic counters when a local Redis
 * is available. Always a *local* Redis per instance — never a shared/central
 * one, which would couple the local fallback to the primary and defeat its
 * purpose.
 *
 * Requires the optional `redis` dependency (loaded only when STORE=redis).
 *
 * Env:
 *   REDIS_URL   connection url (default redis://127.0.0.1:6379)
 */

// Atomic INCR + first-hit EXPIRE, so a crash can't leave a counter without a TTL.
const HIT_LUA = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return c
`

export const createRedisStore = async () => {
  let createClient
  try {
    ({ createClient } = await import('redis'))
  } catch (e) {
    throw new Error('STORE=redis requires the "redis" package. Run: npm install redis')
  }

  const client = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' })
  client.on('error', err => console.error('[store:redis] client error:', err.message))
  await client.connect()

  /**
   * @param {string} key
   * @param {number} windowSec
   * @param {number} limit
   * @return {Promise<{ count: number, allowed: boolean }>}
   */
  const hit = async (key, windowSec, limit) => {
    const count = Number(await client.eval(HIT_LUA, {
      keys: [`rl:${key}`],
      arguments: [String(windowSec)]
    }))
    return { count, allowed: count <= limit }
  }

  /** @param {string} idHash @return {Promise<boolean>} */
  const isAllowed = async idHash => (await client.sIsMember('allowlist', idHash)) === true

  /** @param {string} idHash */
  const addAllowed = async idHash => {
    await client.sAdd('allowlist', idHash)
  }

  /** @param {string} idHash */
  const removeAllowed = async idHash => {
    await client.sRem('allowlist', idHash)
  }

  const listAllowed = async () =>
    (await client.sMembers('allowlist')).map(idHash => ({ idHash }))

  // Redis expires counters itself.
  const prune = async () => {}

  const close = async () => {
    await client.quit()
  }

  return { hit, isAllowed, addAllowed, removeAllowed, listAllowed, prune, close }
}
