#!/usr/bin/env node

import { WebSocketServer } from 'ws'
import http from 'http'
import { timingSafeEqual } from 'node:crypto'
import * as map from 'lib0/map'
import { hashId, signKey, verifyKey } from './auth.js'
import { createStore } from './store/index.js'

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1
const wsReadyStateClosing = 2 // eslint-disable-line
const wsReadyStateClosed = 3 // eslint-disable-line

const pingTimeout = 30000

const port = process.env.PORT || 4444

// --- Config -----------------------------------------------------------------

// App-level secret. Held by the real client app (yaqat); gates /register so only
// it can mint per-identity keys. No longer used on the WS connection itself.
const signalingToken = process.env.SIGNALING_TOKEN

// Optional allowlist gate — off by default. When on, an id must be present in
// the registry (see bin/allow.js) or /register refuses to mint a key.
const requireAllowlist = process.env.REQUIRE_ALLOWLIST === 'true'

// Rate limits (all per-window; tunable via env).
const regLimit = Number(process.env.REG_LIMIT) || 30 // /register calls per IP
const regWindow = Number(process.env.REG_WINDOW) || 60 // seconds
const connLimit = Number(process.env.CONN_LIMIT) || 60 // new WS connections per idHash
const connWindow = Number(process.env.CONN_WINDOW) || 60 // seconds
const msgLimit = Number(process.env.MSG_LIMIT) || 50 // inbound messages/sec per connection

// CORS: browser origins allowed to call /register. Loopback (localhost /
// 127.0.0.1 / ::1) is always allowed so local dev needs no config; production
// origins are listed in ALLOWED_ORIGINS (comma-separated exact origins, e.g.
// "https://app.yourdomain.com"). The matched origin is echoed back — never "*".
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
)

for (const name of ['SIGNALING_TOKEN', 'ID_PEPPER', 'KEY_SECRET']) {
  if (!process.env[name]) {
    console.error(`Missing required env var ${name}`)
    process.exit(1)
  }
}

const wss = new WebSocketServer({ noServer: true })
/**
 * The rate-limit / allowlist registry. Assigned in start() before the server
 * begins listening, so all request handlers see a ready store.
 * @type {any}
 */
let store

// --- Helpers ----------------------------------------------------------------

/**
 * Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
const timingEqual = (a, b) => {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Best-effort client IP, honouring the proxy chain (Caddy / Cloudflare).
 * @param {http.IncomingMessage} request
 * @return {string}
 */
const clientIp = request => {
  const xff = request.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim()
  }
  return request.socket.remoteAddress || 'unknown'
}

/**
 * @param {http.IncomingMessage} request
 * @return {string} the presented app token, or ''
 */
const getAppToken = request => {
  const header = request.headers['x-app-token']
  if (typeof header === 'string' && header.length > 0) {
    return header
  }
  const auth = request.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7)
  }
  return ''
}

/**
 * Is this browser Origin allowed CORS access? Loopback is always allowed (local
 * dev); every other origin must be listed in ALLOWED_ORIGINS.
 * @param {string} origin
 * @return {boolean}
 */
const isAllowedOrigin = origin => {
  if (allowedOrigins.has(origin)) {
    return true
  }
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch (e) {
    return false
  }
}

/**
 * Set CORS headers when the request's Origin is allowed, echoing that exact
 * origin (never "*") so the browser's /register preflight + POST succeed.
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 */
const applyCors = (request, response) => {
  const origin = request.headers.origin
  if (typeof origin === 'string' && isAllowedOrigin(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Headers', 'content-type, x-app-token, authorization')
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  }
}

/**
 * @param {http.IncomingMessage} request
 * @param {number} [maxBytes]
 * @return {Promise<any>}
 */
const readJsonBody = (request, maxBytes = 4096) => new Promise((resolve, reject) => {
  let size = 0
  /** @type {Array<Buffer>} */
  const chunks = []
  request.on('data', chunk => {
    size += chunk.length
    if (size > maxBytes) {
      reject(new Error('payload too large'))
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
    } catch (e) {
      reject(e)
    }
  })
  request.on('error', reject)
})

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 * @param {object} obj
 */
const sendJson = (response, status, obj) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(obj))
}

// --- /register: exchange a trusted id for a signed access key ---------------

/**
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 */
const handleRegister = async (request, response) => {
  // 1. App-level gate: only the real app (which holds SIGNALING_TOKEN) mints keys.
  if (!timingEqual(getAppToken(request), signalingToken)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return
  }
  // 2. Throttle key minting per source IP. Fail-open on store error.
  try {
    const { allowed } = await store.hit(`reg:${clientIp(request)}`, regWindow, regLimit)
    if (!allowed) {
      sendJson(response, 429, { error: 'rate_limited' })
      return
    }
  } catch (e) {
    console.error('[register] rate-limit check failed, allowing:', e.message)
  }
  // 3. Parse the trusted id.
  let body
  try {
    body = await readJsonBody(request)
  } catch (e) {
    sendJson(response, 400, { error: 'bad_request' })
    return
  }
  const id = body && body.id
  if (typeof id !== 'string' || id.length === 0) {
    sendJson(response, 400, { error: 'missing_id' })
    return
  }
  const idHash = hashId(id) // plaintext id is discarded here
  // 4. Optional allowlist gate (off by default). Fails closed on store error.
  if (requireAllowlist) {
    let ok = false
    try {
      ok = await store.isAllowed(idHash)
    } catch (e) {
      console.error('[register] allowlist check failed, denying:', e.message)
      sendJson(response, 503, { error: 'unavailable' })
      return
    }
    if (!ok) {
      sendJson(response, 403, { error: 'not_allowed' })
      return
    }
  }
  // 5. Mint the stateless, expiring key.
  const { key, expiresAt } = signKey(idHash)
  sendJson(response, 200, { key, expiresAt })
}

const server = http.createServer((request, response) => {
  const path = (request.url || '/').split('?')[0]
  applyCors(request, response)
  if (request.method === 'OPTIONS') {
    // CORS preflight — headers already set by applyCors; no body needed.
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === 'POST' && path === '/register') {
    handleRegister(request, response).catch(err => {
      console.error('[register] unexpected error:', err)
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'internal' })
      }
    })
    return
  }
  // Unauthenticated health check (used by Caddy / uptime probes).
  response.writeHead(200, { 'Content-Type': 'text/plain' })
  response.end('okay')
})

/**
 * Map froms topic-name to set of subscribed clients.
 * @type {Map<string, Set<any>>}
 */
const topics = new Map()

/**
 * @param {any} conn
 * @param {object} message
 */
const send = (conn, message) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    conn.close()
  }
  try {
    conn.send(JSON.stringify(message))
  } catch (e) {
    conn.close()
  }
}

/**
 * Setup a new client
 * @param {any} conn
 */
const onconnection = conn => {
  /**
   * @type {Set<string>}
   */
  const subscribedTopics = new Set()
  let closed = false
  // Check if connection is still alive
  let pongReceived = true
  // Per-connection inbound-message flood guard (fixed 1s window). Cheap and
  // in-process, so the hot signaling path never waits on the store.
  let msgWindowStart = Date.now()
  let msgCount = 0
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      conn.close()
      clearInterval(pingInterval)
    } else {
      pongReceived = false
      try {
        conn.ping()
      } catch (e) {
        conn.close()
      }
    }
  }, pingTimeout)
  conn.on('pong', () => {
    pongReceived = true
  })
  conn.on('close', () => {
    subscribedTopics.forEach(topicName => {
      const subs = topics.get(topicName) || new Set()
      subs.delete(conn)
      if (subs.size === 0) {
        topics.delete(topicName)
      }
    })
    subscribedTopics.clear()
    closed = true
  })
  conn.on('message', /** @param {object} message */ message => {
    const now = Date.now()
    if (now - msgWindowStart >= 1000) {
      msgWindowStart = now
      msgCount = 0
    }
    // Drop excess messages from a flooding client; a sustained flood stops
    // answering pings and gets reaped by pingInterval.
    if (++msgCount > msgLimit) {
      return
    }
    if (typeof message === 'string' || message instanceof Buffer) {
      message = JSON.parse(message)
    }
    if (message && message.type && !closed) {
      switch (message.type) {
        case 'subscribe':
          /** @type {Array<string>} */ (message.topics || []).forEach(topicName => {
            if (typeof topicName === 'string') {
              // add conn to topic
              const topic = map.setIfUndefined(topics, topicName, () => new Set())
              topic.add(conn)
              // add topic to conn
              subscribedTopics.add(topicName)
            }
          })
          break
        case 'unsubscribe':
          /** @type {Array<string>} */ (message.topics || []).forEach(topicName => {
            const subs = topics.get(topicName)
            if (subs) {
              subs.delete(conn)
            }
          })
          break
        case 'publish':
          if (message.topic) {
            const receivers = topics.get(message.topic)
            if (receivers) {
              message.clients = receivers.size
              receivers.forEach(receiver =>
                send(receiver, message)
              )
            }
          }
          break
        case 'ping':
          send(conn, { type: 'pong' })
      }
    }
  })
}
wss.on('connection', onconnection)

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const claims = verifyKey(url.searchParams.get('token'))
  if (!claims) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  // Rate-limit new connections per identity. Fail-open on store error so a store
  // hiccup can't take signaling down.
  Promise.resolve()
    .then(() => store.hit(`conn:${claims.idHash}`, connWindow, connLimit))
    .then(result => result.allowed, err => {
      console.error('[upgrade] rate-limit check failed, allowing:', err.message)
      return true
    })
    .then(allowed => {
      if (!allowed) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, /** @param {any} ws */ ws => {
        ws.idHash = claims.idHash
        wss.emit('connection', ws, request)
      })
    })
    .catch(err => {
      console.error('[upgrade] error:', err)
      try {
        socket.destroy()
      } catch (e) {}
    })
})

const start = async () => {
  store = await createStore()

  // Periodically drop expired rate-limit counters (no-op for the redis backend).
  setInterval(() => {
    Promise.resolve(store.prune()).catch(err =>
      console.error('[store] prune failed:', err.message)
    )
  }, 60000)

  server.listen(port)
  console.log(`Signaling server running on localhost: ${port} (store=${process.env.STORE || 'sqlite'}, allowlist=${requireAllowlist ? 'on' : 'off'})`)
}

start().catch(err => {
  console.error('Failed to start signaling server:', err)
  process.exit(1)
})
