#!/usr/bin/env node

/**
 * Allowlist admin CLI for the signaling registry.
 *
 * The identity allowlist ships dormant — it only takes effect when the server
 * runs with REQUIRE_ALLOWLIST=true. Use this tool to seed / manage it. Ids are
 * keyed-hashed with ID_PEPPER before storage (plaintext is never stored), so run
 * it with the SAME `ID_PEPPER` and `STORE` env as the server.
 *
 *   node bin/allow.js add <id> [note]
 *   node bin/allow.js remove <id>
 *   node bin/allow.js list
 */

import { hashId } from './auth.js'
import { createStore } from './store/index.js'

const usage = () => {
  console.log(
    'Usage:\n' +
    '  node bin/allow.js add <id> [note]\n' +
    '  node bin/allow.js remove <id>\n' +
    '  node bin/allow.js list'
  )
}

const main = async () => {
  const [cmd, id, note] = process.argv.slice(2)
  const store = await createStore()
  try {
    switch (cmd) {
      case 'add':
        if (!id) {
          usage()
          process.exitCode = 1
          break
        }
        await store.addAllowed(hashId(id), note || null)
        console.log(`added: ${id}`)
        break
      case 'remove':
        if (!id) {
          usage()
          process.exitCode = 1
          break
        }
        await store.removeAllowed(hashId(id))
        console.log(`removed: ${id}`)
        break
      case 'list': {
        const rows = await store.listAllowed()
        console.log(`${rows.length} allowed id hash(es):`)
        for (const r of rows) {
          console.log(`  ${r.idHash}${r.note ? '  # ' + r.note : ''}`)
        }
        break
      }
      default:
        usage()
        process.exitCode = 1
    }
  } finally {
    await store.close()
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
