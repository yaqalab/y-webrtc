# Self-Hosting a y-webrtc Signaling Server on Oracle Cloud (Free Tier)

A step-by-step guide to deploy the [`yaqalab/y-webrtc`](https://github.com/yaqalab/y-webrtc)
signaling server on an Oracle Cloud **Always Free** instance, with secure `wss://`
TLS via Caddy and Cloudflare.

> **What you'll end up with:** a permanently free, always-on WebSocket signaling
> server reachable at `wss://signal.yourdomain.com`, token-protected, running under
> systemd, behind Cloudflare.

---

## Table of Contents

1. [Background & Key Facts](#1-background--key-facts)
2. [Prerequisites](#2-prerequisites)
3. [Choose Your Compute Shape](#3-choose-your-compute-shape)
4. [Create the Network (VCN)](#4-create-the-network-vcn)
5. [Create the Compute Instance](#5-create-the-compute-instance)
6. [Connect via SSH](#6-connect-via-ssh)
7. [Server Setup](#7-server-setup)
8. [Run as a systemd Service](#8-run-as-a-systemd-service)
9. [Add TLS with Caddy](#9-add-tls-with-caddy)
10. [Cloudflare DNS & Proxy](#10-cloudflare-dns--proxy)
11. [Connect Your Client](#11-connect-your-client)
12. [Capacity & Scaling Notes](#12-capacity--scaling-notes)
13. [Updating an Existing Deployment](#13-updating-an-existing-deployment)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Background & Key Facts

A few things that shape every decision in this guide:

- **This fork gates access with per-identity keys.** Unlike upstream
  `yjs/y-webrtc`, the trusted client app calls a `POST /register` endpoint
  (authenticated with the shared `SIGNALING_TOKEN`) to exchange a verified user
  `id` for a short-lived, signed **access key**. The WebSocket then connects with
  that key as `?token=<key>`; the server verifies it offline and applies
  per-identity **rate limits** backed by a local SQLite (default) or Redis
  "registry". An optional **allowlist** can further restrict access to known ids.
  This raises the abuse bar well beyond a single shared token — see
  [Section 7.8](#78-access-keys-registry-store-and-allowlist).
- **The signaling server is lightweight.** It only relays small JSON messages
  (room joins, SDP offers/answers, ICE candidates). Once peers connect, their
  actual data flows **peer-to-peer** and never touches your server.
- **Two free compute options exist** (see [Section 3](#3-choose-your-compute-shape)):
  - **AMD Micro** — always available, provisions instantly, weaker.
  - **Ampere A1 (ARM)** — much stronger, but frequently "out of capacity."
- **Free tier is genuinely free** at these limits, but has **no SLA** — Oracle can
  reclaim resources at its discretion. Don't build mission-critical uptime on it
  without a fallback.

### Free Tier allowances (as of mid-2026)

| Resource | Always Free allowance |
|---|---|
| AMD Micro instances | 2× (1/8 OCPU, 1 GB RAM each) |
| Ampere A1 (ARM) | 2 OCPU / 12 GB RAM total *(halved from 4/24 in June 2026)* |
| Block/boot storage | 200 GB total (shared across all instances) |
| Outbound bandwidth | 10 TB/month |

---

## 2. Prerequisites

- An **Oracle Cloud account** ([cloud.oracle.com](https://cloud.oracle.com)) —
  requires a credit/debit card for identity verification (no charge on a free
  account).
- A **domain** with DNS you control (this guide uses **Cloudflare**).
- An **SSH client** (OpenSSH, MobaXterm, PuTTY, etc.).

> **Home region matters:** During signup you pick a **home region**, and Always
> Free compute can *only* be created there — permanently. If you want to use
> Ampere A1, prefer a large region with **3 availability domains** (e.g. Ashburn,
> Phoenix, Frankfurt, London) — they have far better A1 capacity than single-AD
> regions.

---

## 3. Choose Your Compute Shape

| | AMD Micro | Ampere A1 (max free) |
|---|---|---|
| Specs | 1/8 OCPU, 1 GB RAM | 2 OCPU, 12 GB RAM |
| Architecture | x86_64 | aarch64 (ARM) |
| Capacity availability | **Instant, reliable** | Often "out of capacity" |
| Realistic capacity¹ | ~1,000–2,000 easy; low thousands max | tens of thousands |

¹ For typical small-room usage with the file-descriptor limit raised. See
[Section 12](#12-capacity--scaling-notes) for detail.

**Recommendation:** Start with **AMD Micro**. It provisions instantly with no
capacity fight and comfortably handles low thousands of concurrent users for
typical collaborative-doc signaling. Migrate to Ampere later if you ever see
sustained CPU pressure — only the shape changes; everything else stays identical.

> The rest of this guide uses the **AMD Micro** path. Notes for Ampere are flagged
> inline.

---

## 4. Create the Network (VCN)

The instance needs a **public subnet** with an internet gateway. Oracle's inline
"quick create" network flow is unreliable about this, so build the network
manually first — it's foolproof.

### 4.1 Create the VCN

1. Console menu (☰) → **Networking** → **Virtual Cloud Networks**
2. Confirm the **compartment** (top-left filter) matches where you'll build the instance.
3. Click **Create VCN**.
4. Set:
   - **Name:** `y-webrtc-vcn`
   - **IPv4 CIDR Blocks:** `10.0.0.0/16`
   - Leave DNS options at defaults.
5. **Create VCN.**

### 4.2 Add an Internet Gateway

1. Open the VCN → left panel → **Internet Gateways** → **Create Internet Gateway**
2. Name it (e.g. `igw`) → **Create**.

### 4.3 Add a Route Rule

1. VCN → **Route Tables** → click the **Default Route Table**.
2. **Add Route Rules:**
   - **Target Type:** Internet Gateway
   - **Destination CIDR:** `0.0.0.0/0`
   - **Target:** your internet gateway
3. **Add Route Rules.**

### 4.4 Create a Public Subnet

1. VCN → **Subnets** → **Create Subnet**
2. Set:
   - **Name:** `public-subnet`
   - **CIDR Block:** `10.0.0.0/24`
   - **Route Table:** Default Route Table (the one you just edited)
   - **Subnet Access:** **Public Subnet** ← critical
3. **Create Subnet.**

### 4.5 Open Firewall Ports (Security List)

1. VCN → **Security Lists** → **Default Security List**
2. **Add Ingress Rules** — one per port, each with **Source CIDR** `0.0.0.0/0`,
   **IP Protocol** TCP:

   | Port | Purpose |
   |---|---|
   | 22 | SSH (usually present by default) |
   | 4444 | Signaling WebSocket |
   | 80 | Let's Encrypt HTTP challenge (Caddy) |
   | 443 | HTTPS / `wss://` |

---

## 5. Create the Compute Instance

1. Console menu (☰) → **Compute** → **Instances** → **Create instance**
2. **Name:** `y-webrtc-signal`
3. **Image and shape** → **Edit**:
   - **Image:** Canonical Ubuntu 24.04 (**x86_64** for Micro; **aarch64** for Ampere)
   - **Shape:** Change shape → **VM.Standard.E2.1.Micro**
     *(For Ampere: Ampere tab → VM.Standard.A1.Flex → set 2 OCPU / 12 GB.)*
4. **Networking** (Primary VNIC):
   - **Select existing virtual cloud network** → `y-webrtc-vcn`
   - **Subnet:** `public-subnet`
   - **Assign a public IPv4 address:** **ON**
5. **SSH keys:** *Generate a key pair for me* → **Save the private key**
   (you cannot retrieve it later).
6. **Boot volume:** leave defaults.
7. **Create.**

Wait for state **Running**, then copy the **Public IP address** from the instance
detail page.

> **Ignore the "Estimated cost" box.** It shows a phantom storage price and
> explicitly *"does not reflect any tier unit pricing."* On a free account with an
> Always-Free-eligible shape and default boot volume, your real cost is **¥0 / $0**.

> **Ampere "out of capacity"?** Retry (no fault domain pinned), try other
> availability domains if your region has them, or retry off-peak. If it won't
> land, use Micro now and treat Ampere as a later upgrade.

---

## 6. Connect via SSH

### OpenSSH (Linux/macOS/Windows terminal)

```bash
chmod 400 /path/to/your-key.key
ssh -i /path/to/your-key.key ubuntu@<PUBLIC_IP>
```

- Default user is `ubuntu`.
- Accept the host fingerprint on first connect.

### MobaXterm

1. **Session** → **SSH**
2. **Remote host:** your public IP
3. Check **Specify username** → `ubuntu`
4. **Advanced SSH settings** → check **Use private key** → select your `.key` file
5. **OK**

---

## 7. Server Setup

Run these on the instance over SSH.

### 7.1 Update & install essentials

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl
```

### 7.2 Install Node.js (LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node --version && npm --version   # verify
```

### 7.3 Open the OS firewall

Oracle's Ubuntu images block everything except port 22 at the iptables level,
**even though the security list allows the ports**. Open them:

```bash
sudo iptables -I INPUT -p tcp --dport 4444 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 7.4 Raise the file-descriptor limit

Each WebSocket uses one file descriptor; Ubuntu defaults to 1024, so you'd hit a
wall around ~1,000 connections. Raise it:

```bash
echo "* soft nofile 65536" | sudo tee -a /etc/security/limits.conf
echo "* hard nofile 65536" | sudo tee -a /etc/security/limits.conf
```

*(The systemd service below also sets `LimitNOFILE`, which is what actually
applies to the daemon.)*

### 7.5 Clone the repo & install dependencies

```bash
cd ~
git clone https://github.com/yaqalab/y-webrtc.git
cd y-webrtc
npm install
```

### 7.6 Generate your secrets

The server needs **three** secrets. Generate each with:

```bash
openssl rand -hex 32   # run three times
```

| Env var | Role | Must be identical across instances? |
|---|---|---|
| `SIGNALING_TOKEN` | Gates `POST /register`; held by the trusted client app | Yes (the app uses one value) |
| `ID_PEPPER` | Keyed-hashes user ids before storage (`HMAC`) | **Yes** — same on Oracle *and* the local fallback |
| `KEY_SECRET` | Signs/verifies the access keys | **Yes** — same on Oracle *and* the local fallback |

> **Why "identical across instances"?** A client connects to *all* your signaling
> URLs at once (Oracle primary + local fallback). Because access keys are
> stateless and signed, every instance can verify a key offline **only if they
> share `KEY_SECRET`** (and `ID_PEPPER`, so an id hashes the same everywhere). No
> shared database is needed — which is what keeps the local fallback independent.

### 7.7 Smoke test (optional)

```bash
PORT=4444 SIGNALING_TOKEN=APP_TOKEN ID_PEPPER=PEPPER KEY_SECRET=KEYSECRET \
  node ./bin/server.js
```

Expected output:
`Signaling server running on localhost: 4444 (store=sqlite, allowlist=off)`.
Press **Ctrl+C** to stop.

> **Node version:** the default SQLite store uses the built-in `node:sqlite`,
> which needs **Node ≥ 22.5** (stable in Node 24 — this guide's version). On Node
> 22.x add the `--experimental-sqlite` flag. On older Node, use `STORE=redis`
> (Section 7.8).

### 7.8 Access keys, registry store, and allowlist

**How access works.** The static token model is replaced by a two-step flow:

1. The trusted app `POST`s the user's verified `id` to `/register` with the
   `SIGNALING_TOKEN` (header `x-app-token: <token>` or `Authorization: Bearer`).
   The server keyed-hashes the id (plaintext is never stored), applies a
   per-IP registration limit, optionally checks the allowlist, and returns
   `{ key, expiresAt }`.
2. The app connects the WebSocket with `?token=<key>`. The server verifies the
   signature + expiry offline and rate-limits new connections per identity.

```bash
# Example: mint a key, then use it. The Origin header is required once Caddy is in
# front (Section 9.2) — it 403s requests whose Origin doesn't match your domain,
# including requests with none. Testing Node directly (http://localhost:4444)
# needs no Origin.
curl -X POST https://signal.yourdomain.com/register \
  -H 'Origin: https://app.yourdomain.com' \
  -H 'x-app-token: YOUR_SIGNALING_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"id":"user@example.com"}'
# -> {"key":"<payload>.<sig>","expiresAt":1770000000}
```

**The registry store** holds rate-limit counters and the allowlist. It is
**always local per instance** — never a shared/central store, which would break
the fallback. Pick one with `STORE`:

- `STORE=sqlite` *(default)* — built-in `node:sqlite`, zero extra services. The
  DB file is `SQLITE_PATH` (default `./data/registry.db`); ensure `data/` is
  writable by the service user.
- `STORE=redis` — a **local** Redis. Install it and cap memory on the 1 GB Micro:
  ```bash
  sudo apt install -y redis-server
  # /etc/redis/redis.conf:  maxmemory 128mb   /   maxmemory-policy allkeys-lru
  npm install redis          # the client is an optional dependency
  ```
  Point at it with `REDIS_URL` (default `redis://127.0.0.1:6379`).

**Optional allowlist (ships off).** Set `REQUIRE_ALLOWLIST=true` to refuse keys
for ids not in the registry. Seed it with the admin CLI (run with the same
`ID_PEPPER` and `STORE`/`SQLITE_PATH` as the server):

```bash
ID_PEPPER=PEPPER STORE=sqlite SQLITE_PATH=./data/registry.db \
  node ./bin/allow.js add user@example.com
node ./bin/allow.js list       # shows id hashes only — never plaintext
node ./bin/allow.js remove user@example.com
```

**Tunable limits** (all optional, sensible defaults): `KEY_TTL` (key lifetime s,
default 86400), `REG_LIMIT`/`REG_WINDOW` (registrations per IP), `CONN_LIMIT`/
`CONN_WINDOW` (new WS connections per identity), `MSG_LIMIT` (inbound messages/s
per connection).

---

## 8. Run as a systemd Service

### 8.1 Create the service file

```bash
sudo nano /etc/systemd/system/y-webrtc.service
```

Paste (replace the three `PASTE_..._HERE` values with your secrets from
[Section 7.6](#76-generate-your-secrets)):

```ini
[Unit]
Description=y-webrtc signaling server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/y-webrtc
Environment=PORT=4444
Environment=SIGNALING_TOKEN=PASTE_APP_TOKEN_HERE
Environment=ID_PEPPER=PASTE_ID_PEPPER_HERE
Environment=KEY_SECRET=PASTE_KEY_SECRET_HERE
Environment=STORE=sqlite
# CORS: the app's exact origin(s) so browser /register preflights pass (echoed
# back, never "*"). Comma-separate multiple. Loopback is always allowed.
Environment=ALLOWED_ORIGINS=https://app.yourdomain.com
# Environment=REQUIRE_ALLOWLIST=true    # uncomment to enforce the allowlist
ExecStart=/usr/bin/node ./bin/server.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

> The default `STORE=sqlite` writes to `./data/registry.db` under
> `WorkingDirectory`; the `ubuntu` user owns that path, so it's writable as-is.
> `ID_PEPPER` and `KEY_SECRET` must match your local fallback server's values.

Save & exit: **Ctrl+O**, **Enter**, **Ctrl+X**.

> Confirm Node's path with `which node`. If it isn't `/usr/bin/node`, update the
> `ExecStart` line to match.

### 8.2 Enable & start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now y-webrtc
sudo systemctl status y-webrtc   # should show "active (running)"
```

### 8.3 Verify reachability

```bash
curl http://localhost:4444        # on the server → returns "okay"
```

From your laptop/browser:

```
http://<PUBLIC_IP>:4444           # → "okay"
```

---

## 9. Add TLS with Caddy

Browsers require secure `wss://` on HTTPS pages, so we put Caddy in front to
handle TLS on 443 with an auto-renewing Let's Encrypt certificate.

> **Do this after your DNS A record exists** (see [Section 10.1](#101-add-the-dns-record))
> and while the record is **grey cloud (DNS only)** — Caddy needs a direct path to
> Let's Encrypt for the first certificate.

### 9.1 Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

### 9.2 Configure Caddy

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace all contents with (use your subdomain):

```
signal.yourdomain.com {
	@blocked not header_regexp Origin `^https://([a-z0-9-]+\.)?yourdomain\.com$`
	respond @blocked 403

	reverse_proxy localhost:4444
}
```

Caddy auto-obtains/renews the cert, terminates TLS on 443, and proxies everything
(including the WebSocket upgrade) to Node on 4444. No extra WebSocket config needed.

The `@blocked` matcher rejects any request whose `Origin` header isn't your domain
or one of its subdomains — see [Section 11.1](#111-restricting-access-by-origin)
for why this matters when your token is public.

Save & exit.

### 9.3 Reload & watch it obtain the cert

```bash
sudo systemctl reload caddy
sudo journalctl -u caddy -f
```

Look for `certificate obtained successfully`. Press **Ctrl+C** to stop watching.

### 9.4 Verify HTTPS

From your browser:

```
https://signal.yourdomain.com     # → "okay", with a valid padlock
```

---

## 10. Cloudflare DNS & Proxy

### 10.1 Add the DNS record

Do this **before** installing Caddy (Section 9).

1. Cloudflare → your domain → **DNS** → **Add record**
2. Set:
   - **Type:** A
   - **Name:** `signal` (or your chosen subdomain)
   - **IPv4 address:** your instance's public IP
   - **Proxy status:** **DNS only (grey cloud)** ← required for first cert issuance
3. **Save.**

### 10.2 Switch to the Proxy (orange cloud) — optional but recommended

Once Caddy has its certificate and HTTPS works:

1. Cloudflare → **SSL/TLS** → **Overview** → set mode to **Full (strict)**
   *(do this first, or you'll get redirect loops)*.
2. Cloudflare → **DNS** → click the cloud icon on the `signal` record → **orange (Proxied)**.
3. Verify `https://signal.yourdomain.com` still returns `okay`, then test your app.

**Benefits of orange cloud:** hides your Oracle IP, DDoS protection, and the
ability to add rate-limiting / WAF rules. Cloudflare's free plan supports
WebSockets by default, so `wss://` keeps working.

> **Certificate renewal note:** With the proxy on, Caddy's TLS-ALPN renewal
> challenge on 443 can be intercepted by Cloudflare. If you see renewal failures
> (~60 days out), switch Caddy to the **DNS-01 challenge** with a Cloudflare API
> token. Not needed until renewal time.

---

## 11. Connect Your Client

The client first exchanges a verified user `id` for an access key, then uses that
key in the `wss://` signaling URL:

```js
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'

// 1. Mint an access key (in your app, which holds the app token).
const res = await fetch('https://signal.yourdomain.com/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-app-token': APP_TOKEN },
  body: JSON.stringify({ id: verifiedUserId })
})
const { key } = await res.json()   // store it; re-register on 401 (expired key)

// 2. Connect using the key.
const ydoc = new Y.Doc()
const provider = new WebrtcProvider('your-room-name', ydoc, {
  signaling: [`wss://signal.yourdomain.com?token=${key}`]
})
```

- Your app authenticates the user (e.g. via their cloud provider) and passes that
  verified `id` to `/register`. The server hashes it — plaintext ids are never stored.
- Handle `401` from `/register` as "wrong app token", and `403` (only when the
  allowlist is on) as "this id isn't permitted".
- Replace `your-room-name` with your app's room identifier.

**Test:** open your app in two browser windows in the same room and confirm peers
find each other.

> **On secrets being client-side:** for a static SPA the `SIGNALING_TOKEN` in your
> app JS is still readable — it stops random scanners, not a determined actor. The
> real protections are the per-identity **rate limits**, the **Origin check**
> below, and (optionally) the **allowlist**. Access keys are short-lived and
> signed, so a leaked key expires and can't be re-minted without the app token.

### 11.1 Restricting Access by Origin

If your app is **static JS**, the token is effectively **public** — anyone can read
it in devtools. So the token alone can't stop someone from reusing your signaling
server for their own app. The practical defense is an **Origin check** (already in
the Caddyfile in [Section 9.2](#92-configure-caddy)).

**Why Origin checking works:** for requests from *browsers*, the `Origin` header is
set by the browser and **cannot be forged by page JavaScript**. A website at
`evil.com` running in a normal browser cannot make its requests appear to come from
`yourdomain.com`. So the check blocks other websites from freeloading via their
visitors' browsers — even if they copied your public token.

**What it stops (and doesn't):**

| Threat | Blocked by Origin check? |
|---|---|
| Another website reusing your server via their users' browsers | ✅ Yes |
| Casual bots / scanners | ✅ Mostly (no valid Origin) |
| A **script / native app** spoofing `Origin: https://yourdomain.com` | ❌ No — non-browsers can set any header |

The last row is an unavoidable gap for any public signaling server backing a static
app: you **cannot** fully block a determined actor with a script. That residual risk
is best *managed* with rate limiting ([Section 11.2](#112-optional-cloudflare-rate-limiting)),
not eliminated. In practice it rarely matters — per-request signaling cost is tiny,
so casual freeloading is mostly harmless; you'd only care about a deliberate flood,
which rate limiting handles.

**Test the Origin check:**

```bash
# Your own origin → 200
curl -I -H "Origin: https://yourdomain.com" https://signal.yourdomain.com

# Foreign origin → 403
curl -I -H "Origin: https://evil.com" https://signal.yourdomain.com
```

> **Regex note:** the pattern `^https://([a-z0-9-]+\.)?yourdomain\.net$` allows
> `https://yourdomain.com` and any single-level subdomain (`app.yourdomain.com`,
> etc.). It requires `https://`, so `http://localhost` won't match — expected in
> production, but remember it during local development.

### 11.2 (Optional) Cloudflare Rate Limiting

The one gap Origin checking can't close — a script spoofing your Origin — is best
handled by **rate limiting** at Cloudflare's edge, so no single source can hammer
your server. This is optional hardening; skip it unless you're seeing abuse.

1. Cloudflare → your domain → **Security** → **WAF** → **Rate limiting rules**
   → **Create rule**.
2. Example rule:
   - **Name:** `signal-ratelimit`
   - **If incoming requests match:** Hostname equals `signal.yourdomain.com`
   - **Rate:** e.g. 100 requests per 1 minute **per IP**
   - **Then:** Block (or Managed Challenge) for a chosen duration
3. **Deploy.**

Tune the threshold to your app's real connection pattern — signaling is bursty at
connect time, so set it high enough not to trip legitimate users. Cloudflare's free
plan includes basic rate limiting; more granular rules may require a paid plan.

> You can also add a **WAF custom rule** to block requests whose `Origin` header
> doesn't match `*.yourdomain.com` at the edge — the same check as Caddy, but it
> offloads the work from your server. Expression example:
> `not http.request.headers["origin"][0] matches "^https://([a-z0-9-]+\.)?yourdomain\.net$"`
> → Action: Block.

---

## 12. Capacity & Scaling Notes

The signaling load splits into two regimes: **idle connected users** (cheap — a
held socket + a ping every 30 s) versus **connection churn** (people joining/
leaving rooms, triggering the `publish` fanout — the real CPU cost).

| Metric | AMD Micro (1/8 OCPU, 1 GB) | Ampere A1 (2 OCPU, 12 GB) |
|---|---|---|
| File-descriptor wall | ~1,024 → raise to 65,536 | ~1,024 → raise to 65,536 |
| Mostly-idle users (small rooms) | ~3,000–8,000 | tens of thousands |
| High-churn users | ~300–1,000 | ~5,000–20,000 |
| "Don't think about it" zone | ~1,000–2,000 | ~10,000–30,000 |

**Key caveats:**

- **The server is a single Node process** (single-threaded event loop). Ampere's
  second core doesn't help a plain run unless you use **cluster mode**. Its real
  edge is a much stronger single core + ~12× the RAM.
- **Keep rooms small.** y-webrtc's WebRTC mesh doesn't scale past ~20–35 peers per
  room (that's the `maxConns` default), and the per-message `publish` fanout grows
  with room size. This is a client-side design constraint no server upgrade fixes.
- **Bandwidth is a non-issue.** Signaling payloads are tiny; peer media/data never
  transits your server. You won't approach the 10 TB/month egress cap.

**Monitor before you hit a wall:**

```bash
sudo apt install -y htop
htop
```

Watch CPU/RAM under real load. If CPU stays high, that's the signal to migrate to
Ampere (or run Micro in cluster mode).

---

## 13. Updating an Existing Deployment

Use this when you've already got a box running and want to pull a newer version of
the server code from the repo (for example, moving an older single-token box up to
the access-key + rate-limiting model in this guide).

> **This particular update is a breaking change.** The old model connected the
> WebSocket with the static token directly (`?token=<SIGNALING_TOKEN>`). The new
> model requires the client to `POST /register` first and connect with the
> **minted access key** (`?token=<key>`). A client still sending the raw token
> gets `401` on the WS upgrade. **Update your client app in step with the server**
> (see [Section 11](#11-connect-your-client)) — ideally deploy the client change
> right after Step 13.5 verifies the server.
>
> The server also now **requires `ID_PEPPER` and `KEY_SECRET`** in addition to
> `SIGNALING_TOKEN`, and **exits on startup** if any are missing. You must add them
> to the service file (Step 13.3) *before* restarting, or the service won't come
> back up.

### 13.1 Pull the new code

```bash
cd ~/y-webrtc
git pull
npm install          # picks up new/optional deps; a safe no-op if nothing changed
```

> If `git pull` complains about local changes, you edited a tracked file in place
> (config lives in the systemd unit, *not* the repo, so this is unusual). Inspect
> with `git status`; `git stash` or `git checkout -- <file>` to discard, then pull.
>
> The SQLite registry (`data/registry.db`) is created automatically on first start
> and is gitignored, so `git pull` never touches it — no manual data step.

### 13.2 Check your Node version

The default SQLite store uses the built-in `node:sqlite`, which needs **Node ≥ 22.5**:

```bash
node --version
```

If it's older, upgrade (otherwise the store won't load and the server won't start):

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

*(Alternatively, keep the old Node and set `STORE=redis` — see [Section 7.8](#78-access-keys-registry-store-and-allowlist).)*

### 13.3 Add the new env vars to the service

Your existing unit from [Section 8](#8-run-as-a-systemd-service) likely only sets
`SIGNALING_TOKEN`. Edit it:

```bash
sudo nano /etc/systemd/system/y-webrtc.service
```

Add these lines under `[Service]` (generate each new secret with `openssl rand -hex 32`):

```ini
Environment=ID_PEPPER=PASTE_ID_PEPPER_HERE
Environment=KEY_SECRET=PASTE_KEY_SECRET_HERE
Environment=STORE=sqlite
# The app's exact origin(s) so browser /register preflights pass. Comma-separate
# multiple; loopback is always allowed.
Environment=ALLOWED_ORIGINS=https://app.yourdomain.com
```

> **Reuse, don't regenerate, if you have a fallback.** `ID_PEPPER` and `KEY_SECRET`
> must be **identical** on every instance a client connects to (Oracle primary +
> local fallback) so a key minted anywhere verifies everywhere. If a fallback
> already runs the new model, copy *its* values here. If this is your first box on
> the new model, generate fresh values now and set the same ones on the fallback
> when you upgrade it. `SIGNALING_TOKEN` can stay as-is.

Save & exit (**Ctrl+O**, **Enter**, **Ctrl+X**).

### 13.4 Reload & restart

```bash
sudo systemctl daemon-reload     # required: the unit file changed
sudo systemctl restart y-webrtc
sudo systemctl status y-webrtc   # should show "active (running)"
```

Confirm it started in the new model:

```bash
sudo journalctl -u y-webrtc -n 20 --no-pager
# → Signaling server running on localhost: 4444 (store=sqlite, allowlist=off)
```

If instead you see `Missing required env var …`, you skipped a secret in Step 13.3.

### 13.5 Smoke-test the new flow

Mint a key end-to-end. Going through the public URL also exercises TLS, Caddy's
Origin gate, and the CORS echo — but that gate means you **must send a matching
`Origin` header**. A request with none is a `403` from Caddy (same as a foreign
origin — a missing header fails the regex; see
[Section 11.1](#111-restricting-access-by-origin)), so it never reaches `/register`:

```bash
curl -X POST https://signal.yourdomain.com/register \
  -H 'Origin: https://app.yourdomain.com' \
  -H 'x-app-token: YOUR_SIGNALING_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"id":"test@example.com"}'
# → {"key":"<payload>.<sig>","expiresAt":...}
```

> **Just want to check Node, without the proxy?** Run this on the box against
> loopback — Caddy isn't involved and `/register` itself doesn't check Origin
> (only the app token):
> ```bash
> curl -X POST http://localhost:4444/register \
>   -H 'x-app-token: YOUR_SIGNALING_TOKEN' \
>   -H 'content-type: application/json' \
>   -d '{"id":"test@example.com"}'
> ```

A `200` with a `key` means the upgraded server is live. Now deploy the matching
client change and confirm two browser windows still pair in the same room.

### 13.6 Rolling back

The previous version is one commit back:

```bash
cd ~/y-webrtc
git log --oneline -5             # find the commit before the update
git checkout <previous-commit>
sudo systemctl restart y-webrtc
```

Because the client change is **coupled** to this update, a real rollback means
reverting **both** the server *and* the client to the static-token model — a rolled-
back server rejects the minted keys a new client sends. The added env vars are
harmless if left in place (an older server just ignores the ones it doesn't read).

---

## 14. Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| **SSH times out** | Port 22 missing from security list, or wrong key file. |
| **`http://IP:4444` hangs** | iptables rule missing (redo [7.3](#73-open-the-os-firewall)) or security-list rule missing for 4444. Check: `sudo iptables -L INPUT -n --line-numbers \| grep 4444` |
| **Public IP slider disabled at instance creation** | Subnet isn't public. Build the network manually ([Section 4](#4-create-the-network-vcn)) and select `public-subnet`. |
| **Ampere "out of host capacity"** | Retry (no fault domain), try other ADs, retry off-peak, or use Micro. |
| **"Too many requests for the user" (429)** | API rate limit. Stop retrying for ~10 min, then retry no faster than once/60–90 s. |
| **Caddy won't get a cert** | Port 80/443 not reachable, or DNS record on orange cloud during first issuance. Set grey cloud, confirm 80/443 open, reload Caddy. |
| **Redirect loops after enabling Cloudflare proxy** | Cloudflare SSL mode not set to **Full (strict)**. |
| **Client won't connect** | Invalid/expired access key (re-`POST /register`), missing `?token=<key>`, or `ws://` instead of `wss://`. |
| **Server exits at startup** | `Missing required env var …` — set `SIGNALING_TOKEN`, `ID_PEPPER`, and `KEY_SECRET` in the service file. |
| **`Cannot find module 'node:sqlite'`** | Node < 22.5, or Node 22.x without `--experimental-sqlite`. Upgrade to Node 24, add the flag, or set `STORE=redis`. |
| **`403` from `/register`** | Allowlist is on (`REQUIRE_ALLOWLIST=true`) and the id isn't seeded. Add it with `bin/allow.js add <id>` using the same `ID_PEPPER`/`STORE`. |
| **Cert renewal fails (~60 days)** | Cloudflare proxy intercepting TLS-ALPN. Switch Caddy to DNS-01 challenge with a Cloudflare API token. |

---

## Quick Reference

**Service management:**

```bash
sudo systemctl status y-webrtc      # check status
sudo systemctl restart y-webrtc     # restart
sudo journalctl -u y-webrtc -f      # live logs
```

**Update to the latest code** (full runbook in [Section 13](#13-updating-an-existing-deployment)):

```bash
cd ~/y-webrtc && git pull && npm install
# first time on the access-key model? add ID_PEPPER, KEY_SECRET, STORE,
# ALLOWED_ORIGINS to the unit — see Section 13.3
sudo systemctl daemon-reload && sudo systemctl restart y-webrtc
```

**Key file locations:**

| File | Path |
|---|---|
| Server code | `/home/ubuntu/y-webrtc` |
| systemd service | `/etc/systemd/system/y-webrtc.service` |
| Caddy config | `/etc/caddy/Caddyfile` |
| Registry DB (sqlite) | `/home/ubuntu/y-webrtc/data/registry.db` |

**Mint a key:** `POST /register` with `x-app-token: <SIGNALING_TOKEN>` and body
`{"id":"..."}` → `{ key, expiresAt }`.

**Signaling URL format:** `wss://signal.yourdomain.com?token=<access-key>`
(see [Section 7.8](#78-access-keys-registry-store-and-allowlist))

**Manage the allowlist:** `node ./bin/allow.js add|remove|list <id>` (dormant
unless `REQUIRE_ALLOWLIST=true`).

---

*Setup verified on Ubuntu 24.04, Node.js 24 LTS, VM.Standard.E2.1.Micro,
Oracle Cloud Always Free.*
