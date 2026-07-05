/**
 * SQLite-backed Store (the default "registry"). Uses the built-in `node:sqlite`
 * module — zero external services — so it runs anywhere, including the 1 GB
 * Oracle AMD Micro and the local fallback.
 *
 * Requires Node >= 22.5 for `node:sqlite` (stable in Node 24; on Node 22.x it is
 * behind the `--experimental-sqlite` flag). If you're on older Node, upgrade or
 * set STORE=redis.
 *
 * Env:
 *   SQLITE_PATH   database file path (default ./data/registry.db)
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const createSqliteStore = async () => {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch (e) {
    throw new Error('STORE=sqlite requires Node >= 22.5 (node:sqlite). Upgrade Node or use STORE=redis.')
  }

  const path = process.env.SQLITE_PATH || './data/registry.db'
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allowlist (
      id_hash TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL,
      note TEXT
    );
  `)

  const selCounter = db.prepare('SELECT count, reset_at FROM counters WHERE key = ?')
  const resetCounter = db.prepare(
    'INSERT INTO counters (key, count, reset_at) VALUES (?, 1, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at'
  )
  const bumpCounter = db.prepare('UPDATE counters SET count = count + 1 WHERE key = ?')
  const pruneCounters = db.prepare('DELETE FROM counters WHERE reset_at <= ?')

  const selAllowed = db.prepare('SELECT 1 AS present FROM allowlist WHERE id_hash = ?')
  const insAllowed = db.prepare(
    'INSERT INTO allowlist (id_hash, added_at, note) VALUES (?, ?, ?) ' +
    'ON CONFLICT(id_hash) DO UPDATE SET note = excluded.note'
  )
  const delAllowed = db.prepare('DELETE FROM allowlist WHERE id_hash = ?')
  const allAllowed = db.prepare('SELECT id_hash, added_at, note FROM allowlist ORDER BY added_at')

  /**
   * Atomic fixed-window counter. Increments `key`; the window resets once
   * `reset_at` passes. node:sqlite is synchronous and the process is
   * single-threaded, so this read-modify-write is atomic in-process.
   *
   * @param {string} key
   * @param {number} windowSec
   * @param {number} limit
   * @return {{ count: number, allowed: boolean }}
   */
  const hit = (key, windowSec, limit) => {
    const now = Math.floor(Date.now() / 1000)
    const row = selCounter.get(key)
    let count
    if (!row || row.reset_at <= now) {
      resetCounter.run(key, now + windowSec)
      count = 1
    } else {
      bumpCounter.run(key)
      count = row.count + 1
    }
    return { count, allowed: count <= limit }
  }

  /** @param {string} idHash @return {boolean} */
  const isAllowed = idHash => selAllowed.get(idHash) !== undefined

  /** @param {string} idHash @param {string|null} [note] */
  const addAllowed = (idHash, note = null) => {
    insAllowed.run(idHash, Math.floor(Date.now() / 1000), note)
  }

  /** @param {string} idHash */
  const removeAllowed = idHash => {
    delAllowed.run(idHash)
  }

  const listAllowed = () =>
    allAllowed.all().map(r => ({ idHash: r.id_hash, addedAt: r.added_at, note: r.note }))

  const prune = () => {
    pruneCounters.run(Math.floor(Date.now() / 1000))
  }

  const close = () => {
    db.close()
  }

  return { hit, isAllowed, addAllowed, removeAllowed, listAllowed, prune, close }
}
