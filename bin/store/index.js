/**
 * Store factory (the "registry"). One db-agnostic interface, two interchangeable
 * backends selected by the STORE env var (default "sqlite"):
 *
 *   STORE=sqlite   built-in node:sqlite, zero external services (default)
 *   STORE=redis    local redis, needs the optional `redis` package
 *
 * The Store backs rate-limit counters and the optional allowlist. Backends are
 * imported lazily so that e.g. a redis deployment on older Node never touches
 * node:sqlite, and a sqlite deployment never needs the redis package.
 *
 * Interface (async-compatible — always `await` the calls):
 *   hit(key, windowSec, limit) -> { count, allowed }
 *   isAllowed(idHash)          -> boolean
 *   addAllowed(idHash, note?)  -> void
 *   removeAllowed(idHash)      -> void
 *   listAllowed()              -> Array<{ idHash, ... }>
 *   prune()                    -> void
 *   close()                    -> void
 */

export const createStore = async () => {
  const kind = (process.env.STORE || 'sqlite').toLowerCase()
  if (kind === 'sqlite') {
    const { createSqliteStore } = await import('./sqlite.js')
    return createSqliteStore()
  }
  if (kind === 'redis') {
    const { createRedisStore } = await import('./redis.js')
    return createRedisStore()
  }
  throw new Error(`Unknown STORE backend "${kind}" (use "sqlite" or "redis")`)
}
