// Nosdag — Electron main process (Phase 1 shell).
// Build scope §1 (process split), §4.1 (Kubo sidecar), §4.2 (RPC from main, no CORS),
// §4.6 (renderer over a privileged app:// protocol → secure context for crypto.subtle +
// SharedArrayBuffer, and ESM that won't load over file://).

import { app, BrowserWindow, protocol, ipcMain, dialog, shell, safeStorage, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { path as kuboPath } from 'kubo'
import { KuboSidecar } from './lib/kubo-sidecar.mjs'
import { connectKubo } from './lib/kubo-manager.mjs'
import { TorProcess } from './lib/tor-process.mjs'
import { createTorNode } from './lib/tor-node.mjs'
import { exportDeltaCar, exportMissingCar, exportClosureCar, importCar, MAX_SAFE_BLOCK_BYTES } from './lib/migrate.mjs'
import { sniffVideo, needsTranscode, stripIsoBmffMetadata, resolveFfmpeg, ffmpegStrip } from './lib/media-transcode.mjs'
import { openHeliaReader, openKuboReader } from './lib/store-reader.mjs'
import { scanBackupCar, chainContains } from './lib/history-backup.mjs'
import { createMoneroRelay } from './lib/monero-relay.mjs'
import { createWsTorBridge } from './lib/ws-tor-bridge.mjs'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { CID } from 'multiformats/cid'
import { randomBytes } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_DIR = path.join(__dirname, 'renderer')
const NOSMERO_API_ORIGIN = 'https://nosmero.com' // shared backend (Nosdag has no same-origin server)

// Per-launch capability token for the two loopback listeners (monero-relay + ws-tor-bridge). Loopback
// is reachable by every other local process AND, for HTTP/WS, cross-origin by any web page in any
// browser on the machine (browsers don't enforce same-origin on ws:// or on the *send* side of a POST).
// Without a secret, a hostile page could ride the user's Tor circuits and prove Nosdag is in anonymous
// mode — a deanon oracle. This token gates both: the renderer receives it (webPreferences
// additionalArguments → preload) and includes it; no other origin/process can guess it. (Security
// review 2026-07-03, H-A.)
const CAP_TOKEN = randomBytes(24).toString('hex')

// Anonymous-mode (Tor) ports — only active while Tor mode is, so they can't fight the Kubo node.
const TOR_SOCKS_PORT = 9350
const TOR_WS_PORT = 4311        // Helia ws listener; the onion forwards onion:4311 → here
const TOR_GATEWAY_PORT = 8201   // reuse the gateway port so the renderer's gateway URL works in both modes
const TOR_WS_BRIDGE_PORT = 9351 // loopback WebSocket→Tor-SOCKS bridge for renderer relays (Electron 42
                                // renderer WS ignores setProxy — electron#34810). Mirror in preload.cjs.

let mode = 'clearnet'  // 'clearnet' (Kubo) | 'tor' (Helia-over-Tor); the active posture
let switching = false  // a mode switch is in flight (teardown + boot of the other backend)
let sidecar = null     // KuboSidecar — owns the clearnet daemon process
let torProc = null     // TorProcess — owns the tor daemon (anonymous mode)
let torGateway = null  // http.Server serving IPFS media from the Helia node in Tor mode
let kubo = null        // the ACTIVE storage node surface (Kubo or Helia-over-Tor) — IPC calls this
let win = null
let cleanShutdown = false
let torAgent = null    // SOCKS agent for main's own backend fetches (/api, trending) while in Tor mode
let torDown = false    // H2 kill-switch latched: tor died unexpectedly, egress blackholed until restart
let nodeStartError = null // { kind, message } when the backend failed to start (e.g. Tor not installed)
let migration = { state: 'idle' } // shared-blockstore sync across a mode switch: idle|exporting|importing|done|failed
let backup = { state: 'idle' }    // "Download my history" .car export/restore: idle|exporting|importing|done|failed
let pendingRestore = null         // last-inspected backup ({ carPath, headCid, mediaRoots, blocks }) — what history:restore imports

// External Tor proxy (anonymous mode): a user-supplied, already-running SOCKS proxy — a tor
// router, Whonix-style gateway, or system tor — used INSTEAD of spawning the bundled daemon.
// Outbound-only: without control access there is no onion service, so the node can read the
// network but can't serve into it (no inbound Bitswap, no nosdag:onion pointer) — disclosed in
// the UI. Persisted in nosdag-mode.json; NOSDAG_TOR_SOCKS=host:port overrides for the session.
let torProxy = null      // { host, port } | null (null = bundled daemon)
let torProxyWatch = null // reachability poll — the kill-switch signal when the daemon isn't ours

// Accepts 'host:port' (IPv6 in brackets) or { host, port }; null/invalid → null.
function parseTorProxy (v) {
  if (!v) return null
  let host, port
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\[[0-9a-fA-F:]+\]|[^\s:/@]+):(\d{1,5})$/)
    if (!m) return null
    host = m[1]; port = Number(m[2])
  } else if (typeof v === 'object') {
    host = String(v.host || '').trim(); port = Number(v.port)
    if (!host || /[\s:/@]/.test(host.replace(/^\[.*\]$/, ''))) return null
  } else { return null }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}
const torSocksHost = () => (torProxy ? torProxy.host : '127.0.0.1')
const torSocksPort = () => (torProxy ? torProxy.port : TOR_SOCKS_PORT)

// Monero RPC relay (loopback): decouples the wallet from any single node + keeps payment traffic on
// its own Tor circuit (security review C1). The renderer points monero-ts at moneroRelay.url().
const moneroRelay = createMoneroRelay({
  getMode: () => mode,
  getTorSocksPort: () => torSocksPort(),
  getTorSocksHost: () => torSocksHost(),
  capToken: CAP_TOKEN,
  log: (m) => console.log('[monero-relay]', m)
})

// Loopback WebSocket→Tor-SOCKS bridge: in anonymous mode the renderer's relay WebSockets connect here
// (loopback, proxy-bypassed) and main forwards them to the real relay over Tor's SOCKS — because
// Electron 42's Chromium renderer no longer routes WebSockets through session.setProxy (electron#34810).
// Always listening; the renderer only routes to it in Tor posture (renderer/js/nosdag/ws-tor-shim.js).
const wsTorBridge = createWsTorBridge({
  port: TOR_WS_BRIDGE_PORT,
  getTorSocksPort: () => torSocksPort(),
  getTorSocksHost: () => torSocksHost(),
  capToken: CAP_TOKEN,
  log: (m) => console.log('[ws-bridge]', m)
})

// Hard guarantee neither daemon can outlive the app (no orphaned seeder): a SYNCHRONOUS SIGKILL on
// any process exit, in case the async before-quit handler doesn't run to completion. process.on('exit')
// only allows sync work, and process.kill is a sync syscall — exactly right.
const hardKill = () => {
  try { sidecar?.killNowSync?.() } catch { /* exiting anyway */ }
  try { torProc?.killNowSync?.() } catch { /* exiting anyway */ }
  try { torGateway?.close?.() } catch { /* exiting anyway */ }
}
process.on('exit', hardKill)
process.on('SIGINT', () => { hardKill(); process.exit(0) })
process.on('SIGTERM', () => { hardKill(); process.exit(0) })
process.on('SIGHUP', () => { hardKill(); process.exit(0) })

// --- §4.1: locate the Kubo binary, rewriting the asar path so the Go binary can exec ---
function resolveKuboBin () {
  let p = kuboPath()
  const packed = `app.asar${path.sep}`
  if (p.includes(packed)) p = p.replace(packed, `app.asar.unpacked${path.sep}`)
  return p
}

// --- §4.6: the privileged scheme MUST be registered before app 'ready' ---
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}])

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
}

function registerAppProtocol () {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)

    // Proxy /api/* to the shared Nosmero backend (no same-origin server in the shell).
    // Serves unsigned reads (Relatr / Web-of-Trust trust scores, trending) AND NIP-98-SIGNED
    // endpoints (login / paywall / tip verification / ipfs-upload): the renderer signs the
    // backend's reconstructed URL (https://nosmero.com/...) via js/api-origin.js while still
    // fetching the local app:// path, so the server's u-tag check matches. The Authorization
    // header and request body are forwarded below, so the signature survives the proxy hop.
    if (url.pathname.startsWith('/api/')) {
      const target = NOSMERO_API_ORIGIN + url.pathname + url.search
      const init = { method: request.method, headers: {} }
      const ct = request.headers.get('content-type'); if (ct) init.headers['content-type'] = ct
      const auth = request.headers.get('authorization'); if (auth) init.headers.authorization = auth
      if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer()
      try {
        const up = await backendFetch(target, init)
        const buf = await up.arrayBuffer()
        return new Response(buf, { status: up.status, headers: { 'content-type': up.headers.get('content-type') || 'application/json' } })
      } catch (e) {
        return new Response(JSON.stringify({ error: 'api proxy failed', detail: String(e?.message || e) }), { status: 502, headers: { 'content-type': 'application/json' } })
      }
    }

    // Trending Monero feed: the reused frontend fetches /trending-cache.json at a relative path,
    // which under app:// would resolve to the copy bundled at build time (a one-time snapshot that
    // never refreshes). Fetch it LIVE from the shared backend instead — the desktop regenerates it
    // every ~3h — and fall back to the bundled snapshot when offline so the feed is never empty.
    if (url.pathname === '/trending-cache.json') {
      try {
        const up = await backendFetch(NOSMERO_API_ORIGIN + '/trending-cache.json')
        if (up.ok) {
          return new Response(await up.arrayBuffer(), { headers: { 'content-type': 'application/json' } })
        }
      } catch { /* offline → fall through to the bundled snapshot */ }
      try {
        const data = await fs.promises.readFile(path.join(RENDERER_DIR, 'trending-cache.json'))
        return new Response(data, { headers: { 'content-type': 'application/json' } })
      } catch {
        return new Response('{"notes":[]}', { headers: { 'content-type': 'application/json' } })
      }
    }

    let pathname = decodeURIComponent(url.pathname)
    if (!pathname || pathname === '/') pathname = '/index.html'
    // monero-ts's bundle hard-codes its worker at /monero.worker.js (root); ours ships in /lib.
    // Serve it from there so the WASM wallet worker loads at the path the bundle baked in at load
    // (it's self-contained — WASM inlined — so location doesn't matter to it).
    if (pathname === '/monero.worker.js') pathname = '/lib/monero.worker.js'
    const filePath = path.normalize(path.join(RENDERER_DIR, pathname))
    if (!filePath.startsWith(RENDERER_DIR)) return new Response('forbidden', { status: 403 }) // no traversal
    try {
      const data = await fs.promises.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      return new Response(data, {
        headers: { 'content-type': MIME[ext] || 'application/octet-stream' }
        // NOTE: COOP/COEP intentionally OMITTED. The reused Nosmero frontend runs on plain
        // nosmero.com without cross-origin isolation (its monero-ts is the single-threaded IIFE),
        // and require-corp would block its third-party images/media. app:// (secure:true) already
        // gives a secure context, so crypto.subtle works. If a threaded wallet build is ever
        // adopted, re-add COEP as 'credentialless' (keeps isolation AND lets no-cors images load).
      })
    } catch {
      // SPA fallback: client-side routes (history.pushState) have no backing
      // file. A reload or deep-link on such a route must serve the app shell,
      // not 404 — otherwise e.g. logout (which reloads the current, routed URL)
      // shows "not found". Only extensionless paths get this; real missing
      // assets (*.js, *.png, …) still 404.
      if (!path.extname(pathname)) {
        try {
          const html = await fs.promises.readFile(path.join(RENDERER_DIR, 'index.html'))
          return new Response(html, { headers: { 'content-type': 'text/html' } })
        } catch {}
      }
      return new Response('not found', { status: 404 })
    }
  })
}

// Permanently remove a remote pinning service from the on-disk Kubo config. Kubo's own
// `pin remote service rm` only drops it from the running daemon's memory — FSRepo.SetConfig
// deep-merges over the file and a merge can't delete keys, so the service reappears on the next
// start (ipfs/kubo, all versions). The config file is the single source of truth at startup, so the
// only reliable purge is an offline edit: caller MUST have stopped the daemon first (else the edit
// races the daemon's writes). Atomic temp-write + rename. Returns true if a key was removed.
async function purgeRemoteServiceFromDisk (name) {
  if (!sidecar?.ipfsPath) return false
  const cfgFile = path.join(sidecar.ipfsPath, 'config')
  const cfg = JSON.parse(await fs.promises.readFile(cfgFile, 'utf8'))
  if (!cfg?.Pinning?.RemoteServices || !(name in cfg.Pinning.RemoteServices)) return false
  delete cfg.Pinning.RemoteServices[name]
  const tmp = cfgFile + '.nosdag-tmp'
  await fs.promises.writeFile(tmp, JSON.stringify(cfg, null, 2))
  await fs.promises.rename(tmp, cfgFile)
  return true
}

// ---- Cloud Bridge storage: per-account map (one bridge per npub) ----
// userData/nosdag-bridge.json: { v:2, accounts: { <hex pubkey>: { kind:'rpc'|'psa', endpoint, token } } }.
// Every account links its OWN bridge — a shared per-node bridge let any account that logged in on
// this machine auto-pin into (and be correlated with) the owner's provider bucket. 'rpc' (Filebase)
// pins via the provider's Kubo-RPC API; 'psa' pins via the standard IPFS Pinning Service API — both
// driven directly from main, so link/unlink never touch Kubo's config (whose service-rm can't
// persist — see purgeRemoteServiceFromDisk) and every credential lives in this one file.
// Pre-per-account configs — the old single-slot file shape (RPC) or a 'nosdag-bridge' service left
// in Kubo's config (PSA) — surface as `legacy` for an explicit claim-or-remove, never auto-assigned.
function bridgeFile () { return path.join(app.getPath('userData'), 'nosdag-bridge.json') }
const validPubkey = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)

async function readBridgeState () {
  let j = null
  try { j = JSON.parse(await fs.promises.readFile(bridgeFile(), 'utf8')) } catch { /* absent */ }
  if (j?.endpoint && j?.token && !j.accounts) {
    // pre-map single-slot file (always RPC-kind) → carry as an unclaimed legacy entry
    return { v: 2, accounts: {}, legacy: { kind: 'rpc', endpoint: j.endpoint, token: j.token } }
  }
  return { v: 2, accounts: j?.accounts || {}, ...(j?.legacy ? { legacy: j.legacy } : {}) }
}
async function writeBridgeState (state) {
  const tmp = bridgeFile() + '.tmp'
  await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.promises.rename(tmp, bridgeFile())
}
async function bridgeFor (pubkey) {
  if (!validPubkey(pubkey)) return null
  const cfg = (await readBridgeState()).accounts[pubkey.toLowerCase()]
  return (cfg?.endpoint && cfg?.token) ? cfg : null
}

// The pre-per-account bridge this node may still carry. The old file shape (RPC) wins over a
// 'nosdag-bridge' service in Kubo's config (PSA) — the same precedence the single-slot code had.
async function readLegacyBridge () {
  const st = await readBridgeState()
  if (st.legacy) return st.legacy
  if (!sidecar?.ipfsPath) return null
  try {
    const cfg = JSON.parse(await fs.promises.readFile(path.join(sidecar.ipfsPath, 'config'), 'utf8'))
    const api = cfg?.Pinning?.RemoteServices?.['nosdag-bridge']?.API
    return (api?.Endpoint && api?.Key) ? { kind: 'psa', endpoint: String(api.Endpoint), token: String(api.Key) } : null
  } catch { return null }
}

// Drop the legacy PSA service (and its token) from Kubo's config if one is on disk. Needs the
// stop → offline purge → restart dance; no-op without one.
async function purgeLegacyPsaService () {
  if (!sidecar?.ipfsPath) return false
  let hasSvc = false
  try {
    const cfg = JSON.parse(await fs.promises.readFile(path.join(sidecar.ipfsPath, 'config'), 'utf8'))
    hasSvc = !!cfg?.Pinning?.RemoteServices?.['nosdag-bridge']
  } catch { /* no config / unreadable */ }
  if (!hasSvc) return false
  await sidecar.stop()
  try { await purgeRemoteServiceFromDisk('nosdag-bridge') } finally {
    sidecar.stopping = false; sidecar.restarts = 0
    await sidecar.start()
  }
  return true
}

function providerOf (endpoint = '') {
  if (/filebase/i.test(endpoint)) return 'Filebase'
  if (/pinata/i.test(endpoint)) return 'Pinata'
  try { return new URL(endpoint).host } catch { return 'Custom' }
}

// Authed POST to a Kubo-RPC endpoint: <endpoint>/api/v0/<apiPath>?<params>, Bearer token. Body is
// only read when needed (status/reachability checks skip it). Aborts after `timeout` ms.
async function rpcFetch (endpoint, token, apiPath, params = {}, { timeout = 30000, readBody = false } = {}) {
  const base = String(endpoint).replace(/\/+$/, '')
  const qs = new URLSearchParams(params).toString()
  const url = `${base}/api/v0/${apiPath}${qs ? '?' + qs : ''}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal })
    let text = ''
    if (readBody) { try { text = await res.text() } catch { /* ignore */ } }
    else { try { await res.body?.cancel?.() } catch { /* ignore */ } }
    return { ok: res.ok, status: res.status, statusText: res.statusText, text }
  } finally { clearTimeout(timer) }
}

// ---- Direct Pinning Service API driver (PSA bridges) ----
// The vendor-agnostic spec Kubo itself speaks: POST /pins {cid,origins} queues a pin (the service
// fetches in the background), GET /pins filters by cid/status, DELETE /pins/<requestid> unpins.
// Bearer auth throughout, same as cloud:test's probe.
async function psaFetch (cfg, method, pathPart, { query, body, timeout = 30000 } = {}) {
  const base = String(cfg.endpoint).replace(/\/+$/, '')
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(base + pathPart + qs, {
      method,
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
    let json = null
    try { json = await res.json() } catch { /* e.g. bodyless 202 on DELETE */ }
    return { ok: res.ok, status: res.status, statusText: res.statusText, json }
  } finally { clearTimeout(timer) }
}

// Live pin counts per status for the card (the spec's `count` field totals each filter).
async function psaCounts (cfg) {
  const counts = {}
  for (const s of ['pinned', 'pinning', 'queued', 'failed']) {
    const r = await psaFetch(cfg, 'GET', '/pins', { query: { status: s, limit: 1 }, timeout: 12000 })
    if (!r.ok) return { counts: null, reachable: false }
    counts[s] = r.json?.count ?? 0
  }
  return { counts, reachable: true }
}

// Which of these CIDs the service reports pinned (the spec caps the cid filter at 10 per request).
async function psaPinnedSet (cfg, cids) {
  const set = new Set()
  for (let i = 0; i < cids.length; i += 10) {
    const chunk = cids.slice(i, i + 10)
    const r = await psaFetch(cfg, 'GET', '/pins', { query: { cid: chunk.join(','), status: 'pinned', limit: 100 }, timeout: 20000 })
    if (!r.ok) throw new Error(`bridge ${r.status} ${r.statusText}`)
    for (const p of (r.json?.results || [])) { const c = p?.pin?.cid; if (c) set.add(String(c)) }
  }
  return set
}

// Every pin request the service holds for a CID, any status (a CID can carry several).
async function psaRequestsFor (cfg, cid) {
  const r = await psaFetch(cfg, 'GET', '/pins', { query: { cid, status: 'queued,pinning,pinned,failed', limit: 100 }, timeout: 20000 })
  if (!r.ok) throw new Error(`bridge ${r.status} ${r.statusText}`)
  return (r.json?.results || []).map((p) => p?.requestid).filter(Boolean)
}

// Pin a list of CIDs to an account's bridge. Pins are recursive, so a head CID covers all reachable
// envelopes/history; media CIDs (not IPLD-linked) must be listed explicitly.
// Returns { ok, kind, results:[{cid,ok,status?,body?,error?}] }.
async function pinCidsToBridge (cfg, cids) {
  const results = []
  if (cfg.kind === 'rpc') {
    for (const c of cids) {
      try { const r = await rpcFetch(cfg.endpoint, cfg.token, 'pin/add', { arg: c }, { timeout: 60000, readBody: true }); results.push({ cid: c, ok: r.ok, status: r.status, body: (r.text || '').slice(0, 240) }) }
      catch (e) { results.push({ cid: c, ok: false, error: e?.name === 'AbortError' ? 'timed out (60s) — the service could not fetch the CID' : String(e?.message || e) }) }
    }
    return { ok: true, kind: 'rpc', results }
  }
  const origins = kubo ? await kubo.nodeOrigins().catch(() => []) : []
  for (const c of cids) {
    try { CID.parse(c) } catch { results.push({ cid: c, ok: false, error: 'invalid CID' }); continue }
    try {
      const r = await psaFetch(cfg, 'POST', '/pins', { body: { cid: c, ...(origins.length ? { origins: origins.slice(0, 20) } : {}) }, timeout: 30000 })
      results.push(r.ok ? { cid: c, ok: true, status: r.status } : { cid: c, ok: false, status: r.status, body: JSON.stringify(r.json ?? '').slice(0, 240) })
    } catch (e) { results.push({ cid: c, ok: false, error: e?.name === 'AbortError' ? 'timed out' : String(e?.message || e) }) }
  }
  return { ok: true, kind: 'psa', results }
}

// Drop a CID's pin(s) from an account's bridge (a superseded head, or a Media-library unpin).
async function unpinFromBridge (cfg, cid) {
  if (cfg.kind === 'rpc') { await rpcFetch(cfg.endpoint, cfg.token, 'pin/rm', { arg: cid }, { timeout: 20000 }); return }
  for (const rid of await psaRequestsFor(cfg, cid)) {
    await psaFetch(cfg, 'DELETE', '/pins/' + encodeURIComponent(rid), { timeout: 20000 })
  }
}

// --- §4.2: all Kubo access is in main; the renderer reaches it only over IPC ---
// OS-keychain-backed at-rest encryption (Electron safeStorage) for renderer secrets that have
// no user-derived key to sit under — e.g. the Amber bunker URI (its connection secret must be
// readable at boot to restore the NIP-46 session, so it can't live behind a PIN). On Linux,
// basic_text means no real keyring is present — report unavailable so the renderer keeps such
// secrets session-only instead of persisting them effectively in plaintext.
function secretsAvailable () {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      return safeStorage.getSelectedStorageBackend() !== 'basic_text'
    }
    return true
  } catch { return false }
}

function setupIpc () {
  ipcMain.handle('secrets:available', () => ({ available: secretsAvailable() }))
  ipcMain.handle('secrets:encrypt', (_e, plaintext) => {
    try {
      if (typeof plaintext !== 'string' || !plaintext) return { error: 'nothing to encrypt' }
      if (!secretsAvailable()) return { error: 'no OS keychain available' }
      return { data: safeStorage.encryptString(plaintext).toString('base64') }
    } catch (e) { return { error: String(e?.message || e) } }
  })
  ipcMain.handle('secrets:decrypt', (_e, data) => {
    try {
      if (typeof data !== 'string' || !data) return { error: 'nothing to decrypt' }
      return { plaintext: safeStorage.decryptString(Buffer.from(data, 'base64')) }
    } catch (e) { return { error: String(e?.message || e) } }
  })

  ipcMain.handle('kubo:status', async () => {
    // not up yet — surface mode + tor bootstrap progress so the UI can show "Starting Tor… 60%"
    if (!kubo) return { ready: false, booting: !nodeStartError, mode, switching, torBootstrap: torProc?.bootstrap ?? null, migration, torDown, nodeStartError, torExternal: !!torProxy, torProxyAddr: torProxy ? `${torProxy.host}:${torProxy.port}` : null }
    try {
      const id = await kubo.id()
      const peers = await kubo.swarmPeers().catch(() => [])
      let version = null
      try { version = (await kubo.raw.version()).version } catch {}
      // repo + pin stats (BigInt → Number for IPC serialization); best-effort
      let repoSizeBytes = null, numObjects = null, pinned = null
      try { const rs = await kubo.repoStat(); repoSizeBytes = Number(rs.repoSize); numObjects = Number(rs.numObjects) } catch {}
      try { pinned = await kubo.pinnedCount() } catch {}
      const status = {
        ready: true,
        mode,
        switching,
        peerId: id.id?.toString?.() ?? String(id.id),
        agentVersion: id.agentVersion,
        version,
        peers: peers.length,
        apiPort: sidecar?.apiPort,
        repoSizeBytes,
        numObjects,
        pinned,
        migration,
        torDown
      }
      if (mode === 'tor') {
        const t = kubo.torInfo?.() || {}
        status.onion = t.onion
        status.onionMultiaddr = t.onionMultiaddr
        status.torBootstrap = torProc?.bootstrap ?? 100
        // external-proxy mode: outbound-only (no onion service) — UI shows the proxy + disclosure,
        // and the onion-announce loop stands down instead of waiting for an onion that never comes
        status.torExternal = !!torProxy
        status.torProxyAddr = torProxy ? `${torProxy.host}:${torProxy.port}` : null
      }
      return status
    } catch (e) {
      return { ready: false, error: String(e?.message || e), mode, switching }
    }
  })

  // ---- Anonymous (Tor) mode: get the active posture + switch between them ----
  // All-or-nothing: switching fully stops one backend before starting the other (the two transports
  // are never live at once). If Tor can't boot (no network egress), fall back to clearnet so the app
  // stays usable rather than stranding the user with no node.
  ipcMain.handle('mode:get', () => ({ mode, switching, torProxy: torProxy ? `${torProxy.host}:${torProxy.port}` : null }))
  // Persist the external-proxy setting (null clears it → bundled daemon). Takes effect the next
  // time anonymous mode starts; needsSwitch tells the UI a live Tor session must be re-entered.
  ipcMain.handle('mode:torProxy', async (_e, v) => {
    const p = v ? parseTorProxy(v) : null
    if (v && !p) return { error: 'Enter the proxy as host:port — for example 192.168.1.1:9050' }
    torProxy = p
    await writeMode(mode)
    return { ok: true, torProxy: p ? `${p.host}:${p.port}` : null, needsSwitch: mode === 'tor' && !!kubo }
  })

  // Monero RPC relay (C1): the renderer's wallet points monero-ts at this loopback URL; main forwards
  // to the selected node (health-checked, user-overridable) and, in Tor mode, on its own isolated circuit.
  ipcMain.handle('monero:relay-url', () => moneroRelay.start())            // → 'http://127.0.0.1:<port>' (idempotent)
  ipcMain.handle('monero:status', () => moneroRelay.status())
  ipcMain.handle('monero:set-node', async (_e, m, url) => { await moneroRelay.setUserNode(m, url); return moneroRelay.status() })
  ipcMain.handle('monero:repick', async () => { await moneroRelay.repick(); return moneroRelay.status() })

  // Boot-time posture choice from the mode-select page. Only valid before any backend has
  // started — after that, mode:set (the in-app switch, with history migration) is the path.
  // Tor choice applies the session proxy BEFORE the app page loads, so the first socket the
  // app ever opens is already fail-closed behind Tor.
  ipcMain.handle('mode:choose', async (_e, target, opts) => {
    if (kubo || sidecar || torProc || switching) return { error: 'node already started — switch from the Anonymous Mode page instead' }
    if (opts && 'torProxy' in opts) {
      const p = opts.torProxy ? parseTorProxy(opts.torProxy) : null
      if (opts.torProxy && !p) return { error: 'Enter the proxy as host:port — for example 192.168.1.1:9050' }
      torProxy = p
    }
    mode = target === 'tor' ? 'tor' : 'clearnet'
    await writeMode(mode)
    if (mode === 'tor') await applyTorProxy()
    else await clearProxy()
    startNode().catch((e) => console.error('[node] failed to start:', e))
    win?.loadURL('app://bundle/index.html')
    return { ok: true, mode }
  })
  ipcMain.handle('mode:set', async (_e, target, opts) => {
    const want = target === 'tor' ? 'tor' : 'clearnet'
    if (switching) return { error: 'a mode switch is already in progress', mode }
    if (opts && 'torProxy' in opts) {
      const p = opts.torProxy ? parseTorProxy(opts.torProxy) : null
      if (opts.torProxy && !p) return { error: 'Enter the proxy as host:port — for example 192.168.1.1:9050', mode }
      torProxy = p
    }
    if (want === mode && kubo) return { ok: true, mode, unchanged: true }
    switching = true

    // Shared blockstore: your history follows you across postures, both directions. The two
    // backends keep different on-disk stores (Kubo flatfs vs Helia blockstore-fs), so notes +
    // media move as a CAR: export the delta from the still-running source, import after the
    // destination boots. A per-pubkey watermark (lastMigratedHead) bounds each sync to what
    // you authored since the last one.
    const { headCid = null, pubkey = null, archiveCid = null } = opts || {}
    const from = mode
    let staged = null
    if (kubo && headCid && pubkey) {
      // Heal first: if a quit-relaunch flip left this store missing chain segments, pull
      // them from the other store's at-rest copy so the export below walks a complete
      // source instead of aborting at the first gap. (The archive crosses AFTER the switch,
      // into the destination — see below.)
      try { await catchUpCurrentStore({ pubkey, headCid }) } catch (e) {
        console.error('[migrate] pre-switch catch-up failed:', e?.message || e)
      }
    }
    if (kubo && headCid && pubkey) {
      migration = { state: 'exporting', headCid }
      try {
        const wm = (await readMigrateState())[pubkey]?.lastMigratedHead || null
        staged = await exportDeltaCar({
          node: kubo,
          headCid,
          stopAtCid: wm,
          carPath: path.join(app.getPath('userData'), 'nosdag-migrate.car'),
          onProgress: (p) => { migration = { state: 'exporting', headCid, blocks: p.blocks } }
        })
        if (!staged) migration = { state: 'done', headCid, notes: 0, blocks: 0, upToDate: true }
      } catch (e) {
        // Continue the switch — anonymity shouldn't be held hostage by a sync problem. The Tor
        // card surfaces the failure; putPost's fork guard keeps it from causing a second chain.
        migration = { state: 'failed', phase: 'export', error: String(e?.message || e) }
        console.error('[migrate] export failed:', e?.message || e)
      }
    } else {
      migration = { state: 'idle' }
    }

    try {
      await stopNode()
      mode = want
      await writeMode(want)
      await startNode()
      if (staged && kubo && (kubo.putBlock || kubo.dagImport)) {
        migration = { state: 'importing', headCid, total: staged.blocks, blocks: 0 }
        try {
          await importCar({
            node: kubo,
            carPath: staged.carPath,
            headCid,
            mediaRoots: staged.mediaRoots,
            onProgress: (p) => { migration = { ...migration, blocks: p.blocks } }
          })
          await writeMigrateWatermark(pubkey, headCid)
          migration = { state: 'done', headCid, notes: staged.notes, media: staged.media, blocks: staged.blocks, skippedMedia: staged.skippedMedia?.length || 0 }
          console.log(`[migrate] ${from}→${mode}: ${staged.notes} notes + ${staged.media} media (${staged.blocks} blocks) now servable in ${mode} mode`)
        } catch (e) {
          migration = { state: 'failed', phase: 'import', error: String(e?.message || e) }
          console.error('[migrate] import failed:', e?.message || e)
        }
      }
      // The timeline archive doesn't ride the chain export above — bring it into the
      // DESTINATION store now that it's up, from the just-stopped source's at-rest copy
      // (no-op when this posture already holds it, per the archive memo).
      if (archiveCid && pubkey) {
        try { await catchUpCurrentStore({ pubkey, archiveCid }) } catch (e) {
          console.warn('[migrate] archive did not cross the switch:', e?.message || e)
        }
      }
      // Re-health-check the Monero node for the new posture (clearnet nodes ⇄ Tor-routed/onion) so the
      // wallet's next daemon call rides the right circuit. Non-blocking; the relay URL is unchanged.
      moneroRelay.onModeChange().catch(() => {})
      wsTorBridge.onModeChange()   // drop the cached SOCKS agent so relay upstreams dial a fresh circuit
      // Drop sockets opened under the previous posture so they re-establish through the new proxy
      // setting (Tor SOCKS ⇄ direct); a lingering clearnet socket would otherwise keep leaking.
      try { await win?.webContents?.session?.closeAllConnections?.() } catch {}
      return { ok: true, mode, migration }
    } catch (e) {
      const failed = want
      migration = { state: 'idle' }
      // An explicit same-posture retry stays put on failure — node down, egress still fail-closed
      // behind the Tor proxy — instead of silently demoting to clearnet. The Anonymous Mode card
      // re-renders the failure with Retry still on offer.
      if (opts?.retry && want === 'tor') {
        try { await stopNode() } catch { /* already down */ }
        return { error: `could not start ${failed} mode: ${String(e?.message || e)}`, mode }
      }
      try { await stopNode(); mode = 'clearnet'; await writeMode('clearnet'); await startNode() } catch { /* leave it down */ }
      return { error: `could not start ${failed} mode: ${String(e?.message || e)}`, mode }
    } finally {
      switching = false
      if (staged?.carPath) fs.promises.rm(staged.carPath, { force: true }).catch(() => {})
    }
  })

  // Mixed-posture repair, renderer-triggered: called once the renderer knows the login's
  // chain head (boot with a session + every login). Exits in one file read when the head was
  // already verified for this posture; otherwise pulls the gaps from the other posture's
  // at-rest store. Also runs inside every in-app switch (mode:set) before the export.
  ipcMain.handle('migrate:catchUp', async (_e, { pubkey, headCid, archiveCid, deep } = {}) => {
    if (switching || migration.state === 'exporting' || migration.state === 'importing' ||
        backup.state === 'exporting' || backup.state === 'importing') return { busy: true }
    try {
      return await catchUpCurrentStore({ pubkey, headCid, archiveCid, deep: deep === true })
    } catch (e) {
      migration = { state: 'failed', phase: 'catch-up', error: String(e?.message || e) }
      console.error('[migrate] catch-up failed:', e?.message || e)
      return { error: String(e?.message || e) }
    }
  })

  // Deterministic reload from main — renderer-initiated location.reload() over a custom
  // scheme proved flaky on logout (window occasionally tore down). webContents.reload()
  // re-requests index.html through protocol.handle reliably.
  // Logout calls this. webContents.reload() would re-request the CURRENT URL,
  // but the app routes with history.pushState, so that's often a client route
  // (app://bundle/note/…) with no backing file → "not found". Load the shell at
  // root instead: lands anonymous on home, no 404.
  ipcMain.handle('app:reload', () => { win?.loadURL('app://bundle/index.html'); return true })

  // Open an external link in the OS browser — but NEVER in Tor mode, where the OS browser isn't on
  // Tor and would leak your real IP. The renderer copies the URL + warns instead. (The M9
  // will-navigate/window-open handlers are the safety net for links that bypass this path.)
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { error: 'unsupported' }
    if (mode === 'tor') return { blocked: 'tor' }
    shell.openExternal(url).catch(() => {})
    return { ok: true }
  })

  // ---- Phase 2: DAG write/read over IPC (the §1.5 kubo-manager surface) ----
  // Renderer signs the Nostr event (with string prev/skip tags) and sends it here; main wraps
  // it in the dag-cbor envelope { v, event, links } — links are REAL IPLD CID links — and stores
  // it, so one recursive pin of the head replicates all history (proven by the harness).
  ipcMain.handle('kubo:putPost', async (_e, payload) => {
    if (!kubo) return { error: 'node not ready' }
    // History sync in flight — a new head minted now couldn't be pinned (its prev chain isn't
    // in this store yet). The note still reaches relays; only the DAG write waits.
    if (migration.state === 'exporting' || migration.state === 'importing') {
      return { error: 'your note history is still syncing to this node — try again in a few seconds' }
    }
    try {
      const { event, prevCid, skipCids } = payload || {}
      // Fork guard: a genesis write (no prev) for a pubkey whose watermark proves an existing
      // chain would start a SECOND chain for that key (e.g. localStorage lost the head, or a
      // failed sync left this store without it). Refuse rather than silently fork.
      if (!prevCid && event?.pubkey) {
        const wm = (await readMigrateState())[event.pubkey]?.lastMigratedHead
        if (wm) return { error: 'this key already has a note history, but no prev link was given — your chain head may not have synced to this node yet' }
      }
      const links = {}
      if (prevCid) links.prev = CID.parse(prevCid)
      if (Array.isArray(skipCids) && skipCids.length) links.skip = skipCids.map((c) => CID.parse(c))
      const cid = await kubo.putEnvelope({ v: 1, event, links })
      return { cid: cid.toString() }
    } catch (e) { return { error: String(e?.message || e) } }
  })
  ipcMain.handle('kubo:getPost', async (_e, cidStr, opts) => {
    if (!kubo) return { error: 'node not ready' }
    try {
      // opts.timeout bounds the fetch: without it a block this store lacks sends Kubo on an
      // unbounded Bitswap search and the caller hangs forever (the Media-library scan bug).
      const timeout = Number(opts?.timeout) > 0 ? Number(opts.timeout) : undefined
      const env = await kubo.getEnvelope(CID.parse(cidStr), timeout ? { timeout } : {}) // { v, event, links } — links are CID instances
      const ls = (l) => (l == null ? null : (CID.asCID(l)?.toString() ?? String(l)))
      return { v: env?.v, event: env?.event, prev: ls(env?.links?.prev), skip: (env?.links?.skip || []).map(ls) }
    } catch (e) { return { error: String(e?.message || e) } }
  })

  // ---- Timeline import: pre-Nosdag notes archived into IPFS (no chain membership) ----
  // Old events are already signed — a prev tag can't be added without breaking the sig — so
  // they can never join the §13.1 chain (readers enforce link↔tag equality). They live as
  // standalone envelopes ({v, event, links:{}}) under an ARCHIVE MANIFEST: a dag-cbor node
  // whose `notes` array and `media` map hold real IPLD links, so ONE recursive pin covers
  // every imported note + mirrored media file. putPost's genesis fork guard doesn't apply —
  // nothing here moves the chain head. The renderer verifies each event's signature before
  // handing it over (same trust domain; the manifest only ever names sig-checked events).
  ipcMain.handle('archive:putNote', async (_e, { event } = {}) => {
    if (!kubo) return { error: 'node not ready' }
    if (!event?.pubkey || !event?.sig || !event?.id) return { error: 'signed event required' }
    try { return { cid: (await kubo.putEnvelope({ v: 1, event, links: {} })).toString() } }
    catch (e) { return { error: String(e?.message || e) } }
  })
  ipcMain.handle('archive:commit', async (_e, { pubkey, ids, notes, media, prevManifestCid } = {}) => {
    if (!kubo) return { error: 'node not ready' }
    if (!validPubkey(pubkey)) return { error: 'pubkey required' }
    if (!Array.isArray(notes) || !notes.length) return { error: 'no notes to commit' }
    if (!Array.isArray(ids) || ids.length !== notes.length) return { error: 'ids must pair with notes' }
    try {
      const manifest = {
        v: 1,
        type: 'nosdag-archive',
        pubkey: pubkey.toLowerCase(),
        count: notes.length,
        ids,
        notes: notes.map((c) => CID.parse(c)),
        media: Object.fromEntries(Object.entries(media || {}).map(([url, c]) => [url, CID.parse(c)]))
      }
      const cid = (await kubo.putEnvelope(manifest)).toString()
      await kubo.pinRecursive(CID.parse(cid), { timeout: 120000 }) // links are all local — a fast walk
      if (prevManifestCid && prevManifestCid !== cid) {
        try { await kubo.unpinRecursive(CID.parse(prevManifestCid)) } catch { /* superseded pin, best-effort */ }
      }
      try { await writeArchiveMemo(pubkey.toLowerCase(), mode, cid) } catch { /* memo only */ }
      return { cid }
    } catch (e) { return { error: String(e?.message || e) } }
  })
  ipcMain.handle('archive:get', async (_e, { cid } = {}) => {
    if (!kubo) return { error: 'node not ready' }
    if (!cid) return { error: 'cid required' }
    try {
      // Bounded: an absent manifest (e.g. it lives in the other posture's store) must fail
      // fast, not send Kubo on an endless Bitswap search with the import stuck.
      const m = await kubo.getEnvelope(CID.parse(cid), { timeout: 15000 })
      if (m?.type !== 'nosdag-archive') return { error: 'not an archive manifest' }
      return {
        v: m.v,
        pubkey: m.pubkey,
        count: m.count,
        ids: m.ids || [],
        notes: (m.notes || []).map((c) => CID.asCID(c)?.toString() ?? String(c)),
        media: Object.fromEntries(Object.entries(m.media || {}).map(([url, c]) => [url, CID.asCID(c)?.toString() ?? String(c)]))
      }
    } catch (e) { return { error: String(e?.message || e) } }
  })
  // Heal support: report each media CID's root-block shape from the LOCAL store so the
  // renderer can spot oversized raw blocks (media mirrored before chunked adds — Kubo
  // refuses them and Bitswap can't serve them; only re-mirroring cures one). dag-pb roots
  // are chunked and always fine; a block absent from this store reports nulls (unknown —
  // never a Bitswap search). Clearnet short-circuits: Kubo ingests blocks only through
  // `add` (chunks) or `dag import` (refuses >2MiB), so its store can't hold an oversized
  // raw block — and probing absent CIDs over the RPC would Bitswap-wait per block.
  ipcMain.handle('archive:checkMedia', async (_e, { cids } = {}) => {
    if (!kubo) return { error: 'node not ready' }
    if (!Array.isArray(cids) || !cids.length) return { blocks: {} }
    if (mode === 'clearnet') return { blocks: {} }
    const RAW_CODE = 0x55
    const blocks = {}
    for (const s of cids.slice(0, 5000)) {
      try {
        const cid = CID.parse(String(s))
        if (cid.code !== RAW_CODE) { blocks[s] = { codec: cid.code, size: null, oversized: false }; continue }
        const b = await kubo.getBlock(cid)
        blocks[s] = { codec: RAW_CODE, size: b.length, oversized: b.length > MAX_SAFE_BLOCK_BYTES }
      } catch { blocks[s] = { codec: null, size: null, oversized: null } }
    }
    return { blocks }
  })
  // Phase 2 media: add raw image/video bytes to the local node → CID. The renderer references
  // it as ipfs://<CID> in the note (portable, signed); on read the gateway serves it (Bitswap on
  // machine B). Bytes arrive over IPC as a Uint8Array/ArrayBuffer (structured clone).
  ipcMain.handle('kubo:addMedia', async (_e, payload) => {
    if (!kubo) return { error: 'node not ready' }
    try {
      const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
      if (!bytes.length) return { error: 'empty media' }
      const cid = await kubo.addBytes(bytes)
      return { cid: cid.toString() }
    } catch (e) { return { error: String(e?.message || e) } }
  })
  // Attachment prep BEFORE addMedia — video only (the renderer's canvas path covers images):
  // strip location/device/timestamp metadata from every ISO-BMFF file (pure JS, always), and
  // convert codecs most viewers can't decode (HEVC phone video, ProRes, …) to H.264 via
  // ffmpeg — with -map_metadata -1, so the transcode strips by construction. No ffmpeg +
  // undecodable codec = an actionable error (publishing it would be a dead player anyway).
  // webm/ogg (screen recorders; no GPS atoms by convention) remux-strip when ffmpeg is
  // around, pass through otherwise — same fail-open stance as the image path. The timeline
  // import deliberately does NOT run this: it mirrors already-public files byte-identical.
  ipcMain.handle('media:prepare', async (_e, { bytes, name = '', type = '' } = {}) => {
    try {
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      if (!buf.length) return { error: 'empty media' }
      const looksVideo = /^video\//i.test(type) || /\.(mov|mp4|m4v|webm|ogg|3gp)$/i.test(name)
      if (!looksVideo) return { bytes: buf }
      const sniff = sniffVideo(buf)
      const tmpDir = app.getPath('temp')
      if (sniff.container === 'iso-bmff') {
        if (needsTranscode(sniff.videoCodecs)) {
          const ffmpegBin = resolveFfmpeg()
          if (!ffmpegBin) {
            const codecs = [...sniff.videoCodecs].join('/') || 'an unknown codec'
            return { error: `This video uses ${codecs}, which most viewers can't play. Install ffmpeg (e.g. sudo apt install ffmpeg) so Nosdag can convert it to H.264, or attach an H.264 export instead.` }
          }
          const out = await ffmpegStrip({ ffmpegBin, bytes: buf, tmpDir, reencode: true })
          return { bytes: out, ext: 'mp4', converted: true, stripped: true }
        }
        return { bytes: stripIsoBmffMetadata(buf), stripped: true }
      }
      if (sniff.container === 'webm' || sniff.container === 'ogg') {
        const ffmpegBin = resolveFfmpeg()
        if (ffmpegBin) {
          const out = await ffmpegStrip({ ffmpegBin, bytes: buf, tmpDir, reencode: false, format: sniff.container })
          return { bytes: out, stripped: true }
        }
        console.warn('[media] no ffmpeg — %s attachment published with its container metadata', sniff.container)
      }
      return { bytes: buf }
    } catch (e) { return { error: String(e?.message || e) } }
  })
  ipcMain.handle('kubo:pinRecursive', async (_e, cidStr, timeoutMs) => {
    if (!kubo) return { error: 'node not ready' }
    try {
      await kubo.pinRecursive(CID.parse(cidStr), timeoutMs ? { timeout: timeoutMs } : {})
      return { ok: true }
    } catch (e) {
      const msg = String(e?.message || e)
      return { error: (e?.name === 'TimeoutError' || /time ?d? ?out|abort/i.test(msg)) ? 'timeout' : msg }
    }
  })
  ipcMain.handle('kubo:unpinRecursive', async (_e, cidStr) => {
    if (!kubo) return { error: 'node not ready' }
    try { await kubo.unpinRecursive(CID.parse(cidStr)); return { ok: true } } catch (e) { return { error: String(e?.message || e) } }
  })
  // Per-CID local pin check (Media library's "pinned here?" cell).
  ipcMain.handle('kubo:isPinned', async (_e, cidStr) => {
    if (!kubo) return { error: 'node not ready' }
    if (!kubo.isPinned) return { pinned: null }
    try { return { pinned: await kubo.isPinned(CID.parse(cidStr)) } } catch (e) { return { error: String(e?.message || e) } }
  })
  // Cumulative DAG size in bytes (altruistic-pin quota accounting, §5.1).
  ipcMain.handle('kubo:dagSize', async (_e, cidStr) => {
    if (!kubo) return { error: 'node not ready' }
    try { return { bytes: await kubo.dagSize(cidStr) } } catch (e) { return { error: String(e?.message || e) } }
  })
  // Distinct nodes providing a CID (DHT) — the "held by N nodes" durability signal (§7).
  ipcMain.handle('kubo:providers', async (_e, cidStr, opts) => {
    if (!kubo) return { error: 'node not ready' }
    try { return { count: await kubo.providerCount(CID.parse(cidStr), opts || {}) } } catch (e) { return { error: String(e?.message || e) } }
  })
  // Phase 6 — dial a peer multiaddr. The Tor backend (tor-node.mjs) routes the dial through Tor's
  // SOCKS proxy to an author's onion (resolved from their nosdag:onion pointer on relays), the only
  // way to reach a peer with no DHT. The clearnet backend implements this too, but discovery there
  // is the DHT, so onion-discovery only calls this in Tor mode.
  ipcMain.handle('kubo:swarmConnect', async (_e, ma) => {
    if (!kubo) return { error: 'node not ready' }
    if (typeof ma !== 'string' || !ma.startsWith('/')) return { error: 'invalid multiaddr' } // L6: format guard (limits renderer-driven dials)
    if (!kubo.swarmConnect) return { error: 'swarmConnect unsupported in this mode' }
    try { await kubo.swarmConnect(ma); return { ok: true } } catch (e) { return { error: String(e?.message || e) } }
  })

  // ---- Phase 3: Cloud Bridge — per-account, two mechanisms behind one card (§5.2 / build §4.3) ----
  //  • PSA (Pinata, most providers): the standard IPFS Pinning Service API, driven from main.
  //  • RPC (Filebase): provider only authenticates on a Kubo-RPC endpoint (/api/v0/…) — main pins
  //    to it directly.
  // Every op resolves the ACTIVE account's bridge from the userData map (the renderer passes the
  // pubkey — same trust domain); an account without an entry is simply unlinked.

  // Active account's bridge + live stats, for the Node-panel card. Also reports any unclaimed
  // pre-per-account legacy config so the card can offer claim-or-remove.
  ipcMain.handle('cloud:status', async (_e, { pubkey } = {}) => {
    if (mode === 'tor') return { linked: false, mode: 'tor' } // Cloud Bridge is a clearnet feature
    if (!validPubkey(pubkey)) return { linked: false, needsAccount: true }
    const cfg = await bridgeFor(pubkey)
    if (!cfg) {
      const legacy = await readLegacyBridge()
      return legacy
        ? { linked: false, legacy: { kind: legacy.kind, provider: providerOf(legacy.endpoint), endpoint: legacy.endpoint } }
        : { linked: false }
    }
    if (cfg.kind === 'rpc') {
      let counts = null, reachable = false
      try {
        const r = await rpcFetch(cfg.endpoint, cfg.token, 'pin/ls', { type: 'recursive' }, { timeout: 12000, readBody: true })
        reachable = r.ok
        if (r.ok) { try { counts = { pinned: Object.keys(JSON.parse(r.text)?.Keys || {}).length } } catch { counts = { pinned: null } } }
      } catch { /* unreachable */ }
      return { linked: true, kind: 'rpc', provider: providerOf(cfg.endpoint), endpoint: cfg.endpoint, counts, reachable }
    }
    try {
      const { counts, reachable } = await psaCounts(cfg)
      return { linked: true, kind: 'psa', provider: providerOf(cfg.endpoint), endpoint: cfg.endpoint, counts, reachable }
    } catch {
      return { linked: true, kind: 'psa', provider: providerOf(cfg.endpoint), endpoint: cfg.endpoint, counts: null, reachable: false }
    }
  })

  // Authenticated reachability probe for the link form — kind-specific, returns the real HTTP status
  // so the UI can say "token rejected (401)" instead of a vague failure. main has no CORS.
  ipcMain.handle('cloud:test', async (_e, { kind, endpoint, key } = {}) => {
    if (mode === 'tor') return { error: 'Cloud Bridge is unavailable in anonymous mode' }
    if (!endpoint || !key) return { error: 'endpoint and token required' }
    if (!/^https:\/\//i.test(String(endpoint))) return { error: 'endpoint must be an https:// URL' } // L6: no http/file/internal SSRF
    try {
      if (kind === 'rpc') {
        const r = await rpcFetch(endpoint, key, 'pin/ls', { type: 'recursive' }, { timeout: 15000 })
        return { ok: r.ok, status: r.status, statusText: r.statusText }
      }
      const url = String(endpoint).replace(/\/+$/, '') + '/pins?limit=1'
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000)
      try {
        const res = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: ctrl.signal })
        try { await res.body?.cancel?.() } catch { /* ignore */ }
        return { ok: res.ok, status: res.status, statusText: res.statusText }
      } finally { clearTimeout(timer) }
    } catch (e) { return { error: e?.name === 'AbortError' ? 'timed out' : String(e?.message || e) } }
  })

  // Link a bridge for one account — a map write, nothing else. Kubo's config is never touched.
  ipcMain.handle('cloud:link', async (_e, { pubkey, kind, endpoint, key } = {}) => {
    if (mode === 'tor') return { error: 'Cloud Bridge is unavailable in anonymous mode' }
    if (!validPubkey(pubkey)) return { error: 'log in first — a bridge links to one account' }
    if (kind !== 'rpc' && kind !== 'psa') return { error: 'unknown bridge kind' }
    if (!endpoint || !key) return { error: 'endpoint and token required' }
    if (!/^https:\/\//i.test(String(endpoint))) return { error: 'endpoint must be an https:// URL' } // L6: no http/file/internal SSRF
    try {
      const st = await readBridgeState()
      st.accounts[pubkey.toLowerCase()] = { kind, endpoint: String(endpoint), token: String(key) }
      await writeBridgeState(st)
      return { ok: true }
    } catch (e) { return { error: String(e?.message || e) } }
  })

  // Unlink one account's bridge — a map delete, instant for both kinds.
  ipcMain.handle('cloud:unlink', async (_e, { pubkey } = {}) => {
    if (mode === 'tor') return { ok: true }
    if (!validPubkey(pubkey)) return { ok: true } // nothing to unlink
    try {
      const st = await readBridgeState()
      const k = pubkey.toLowerCase()
      if (st.accounts[k]) { delete st.accounts[k]; await writeBridgeState(st) }
      return { ok: true }
    } catch (e) { return { error: String(e?.message || e) } }
  })

  // Adopt the node's pre-per-account bridge as THIS account's (the claim half of claim-or-remove).
  // A legacy PSA service left in Kubo's config is purged (node restart) once its credential is safe
  // in the map.
  ipcMain.handle('cloud:claimLegacy', async (_e, { pubkey } = {}) => {
    if (mode === 'tor') return { error: 'unavailable in anonymous mode' }
    if (!validPubkey(pubkey)) return { error: 'log in first' }
    try {
      const legacy = await readLegacyBridge()
      if (!legacy) return { error: 'no earlier bridge found on this node' }
      const st = await readBridgeState()
      st.accounts[pubkey.toLowerCase()] = { kind: legacy.kind, endpoint: legacy.endpoint, token: legacy.token }
      delete st.legacy
      await writeBridgeState(st)
      await purgeLegacyPsaService().catch(() => {}) // any Kubo service is dead config now
      return { ok: true, kind: legacy.kind }
    } catch (e) { return { error: String(e?.message || e) } }
  })

  // The remove half: drop the legacy config without assigning it to any account.
  ipcMain.handle('cloud:discardLegacy', async () => {
    if (mode === 'tor') return { error: 'unavailable in anonymous mode' }
    try {
      const st = await readBridgeState()
      if (st.legacy) { delete st.legacy; await writeBridgeState(st) }
      await purgeLegacyPsaService().catch(() => {})
      return { ok: true }
    } catch (e) { return { error: String(e?.message || e) } }
  })

  // Mirror a freshly-published note to the author's bridge: head CID (recursive → whole DAG) + each
  // media CID (media isn't IPLD-linked from the envelope, so the head pin won't cover it).
  ipcMain.handle('cloud:pinNote', async (_e, { pubkey, headCid, mediaCids, prevHeadCid } = {}) => {
    if (mode === 'tor') return { ok: true, skipped: 'tor' }
    if (!headCid) return { error: 'headCid required' }
    const cfg = await bridgeFor(pubkey)
    if (!cfg) return { ok: true, skipped: 'no bridge', results: [] }
    try {
      const out = await pinCidsToBridge(cfg, [headCid, ...(Array.isArray(mediaCids) ? mediaCids : [])])
      if (prevHeadCid && prevHeadCid !== headCid) { try { await unpinFromBridge(cfg, prevHeadCid) } catch { /* best-effort */ } }
      return out
    } catch (e) { return { error: String(e?.message || e) } }
  })

  // Bulk pin — used by "Pin all my notes" to back-fill the full history (head covers all note text
  // recursively; the renderer walks the DAG to also list every past media CID).
  ipcMain.handle('cloud:pinMany', async (_e, { pubkey, cids } = {}) => {
    if (mode === 'tor') return { ok: true, skipped: 'tor' }
    if (!Array.isArray(cids) || !cids.length) return { error: 'no cids' }
    const cfg = await bridgeFor(pubkey)
    if (!cfg) return { ok: true, skipped: 'no bridge', results: [] }
    try { return await pinCidsToBridge(cfg, cids) } catch (e) { return { error: String(e?.message || e) } }
  })

  // Which of these CIDs the account's bridge currently pins — one bridge round trip for a whole
  // list (Media library's bridge column). RPC: list all recursive pins once, intersect; PSA: a
  // filtered /pins listing.
  ipcMain.handle('cloud:pinStatus', async (_e, { pubkey, cids } = {}) => {
    if (mode === 'tor') return { skipped: 'tor' }
    if (!Array.isArray(cids) || !cids.length) return { pinned: [] }
    const cfg = await bridgeFor(pubkey)
    if (!cfg) return { skipped: 'no bridge' }
    try {
      if (cfg.kind === 'rpc') {
        const r = await rpcFetch(cfg.endpoint, cfg.token, 'pin/ls', { type: 'recursive' }, { timeout: 20000, readBody: true })
        if (!r.ok) return { error: `bridge ${r.status} ${r.statusText}` }
        let keys
        try { keys = new Set(Object.keys(JSON.parse(r.text || '{}')?.Keys || {})) } catch { keys = new Set() }
        return { kind: 'rpc', pinned: cids.filter((c) => keys.has(c)) }
      }
      const set = await psaPinnedSet(cfg, cids)
      return { kind: 'psa', pinned: cids.filter((c) => set.has(c)) }
    } catch (e) { return { error: e?.name === 'AbortError' ? 'bridge timed out' : String(e?.message || e) } }
  })

  // Drop one CID's pin from the account's bridge (Media library's per-item bridge unpin).
  ipcMain.handle('cloud:unpin', async (_e, { pubkey, cid } = {}) => {
    if (mode === 'tor') return { error: 'bridge unavailable in anonymous mode' }
    if (!cid) return { error: 'cid required' }
    const cfg = await bridgeFor(pubkey)
    if (!cfg) return { error: 'no bridge linked for this account' }
    try { await unpinFromBridge(cfg, cid); return { ok: true } } catch (e) { return { error: String(e?.message || e) } }
  })

  // ---- "Download my history": full-history .car backup + restore (lib/history-backup.mjs) ----
  // Export is the migration CAR with no watermark (head → genesis + media closures, via
  // exportDeltaCar); restore is the migration import (blocks + recursive head pin + per-media
  // pins, via importCar). Works in BOTH postures — the kubo surface hides Kubo vs Helia. The
  // node is shared with mode switches, so neither runs while a history sync is in flight.
  const historyBusy = () => switching ||
    migration.state === 'exporting' || migration.state === 'importing' ||
    backup.state === 'exporting' || backup.state === 'importing'

  // Save dialog + full-chain export. `toPath` (headless/smoke) skips the dialog.
  ipcMain.handle('history:export', async (_e, { headCid, suggestedName, toPath } = {}) => {
    if (!kubo) return { error: 'node not ready' }
    if (!headCid) return { error: 'headCid required' }
    if (historyBusy()) return { error: 'the node is busy with another sync — try again shortly' }
    // M3: only the smoke harness may name an absolute path; a real renderer (post-XSS) must go
    // through the OS save dialog so it can't write a CAR to an arbitrary location.
    let carPath = process.env.NOSDAG_SMOKE ? toPath : null
    if (!carPath) {
      const picked = await dialog.showSaveDialog(win, {
        title: 'Export my note history',
        defaultPath: path.join(app.getPath('downloads'), suggestedName || 'nosdag-history.car'),
        filters: [{ name: 'Content archive', extensions: ['car'] }]
      })
      if (picked.canceled || !picked.filePath) return { cancelled: true }
      carPath = picked.filePath.endsWith('.car') ? picked.filePath : picked.filePath + '.car'
    }
    backup = { state: 'exporting', op: 'export', blocks: 0 }
    try {
      const res = await exportDeltaCar({
        node: kubo,
        headCid,
        stopAtCid: null,
        carPath,
        onProgress: (p) => { backup = { state: 'exporting', op: 'export', blocks: p.blocks } }
      })
      if (!res) { backup = { state: 'idle' }; return { error: 'no notes found under that head' } }
      backup = { state: 'done', op: 'export' }
      return { ok: true, path: carPath, notes: res.notes, media: res.media, blocks: res.blocks, bytes: res.bytes, skippedMedia: res.skippedMedia.length }
    } catch (e) {
      await fs.promises.rm(carPath, { force: true }).catch(() => {}) // don't leave a truncated backup behind
      backup = { state: 'failed', op: 'export', error: String(e?.message || e) }
      return { error: String(e?.message || e) }
    }
  })

  // Open dialog + scan WITHOUT importing: whose history, how many notes/media, chain complete?
  // Stages the result; history:restore imports whatever was inspected last (so the renderer can
  // show a confirm step in between). `fromPath` (headless/smoke) skips the dialog.
  ipcMain.handle('history:inspect', async (_e, { fromPath } = {}) => {
    if (!kubo) return { error: 'node not ready' }
    if (historyBusy()) return { error: 'the node is busy with another sync — try again shortly' }
    // M3: smoke-only absolute path; a real renderer goes through the OS open dialog (read scope).
    let carPath = process.env.NOSDAG_SMOKE ? fromPath : null
    if (!carPath) {
      const picked = await dialog.showOpenDialog(win, {
        title: 'Restore note history from a backup',
        properties: ['openFile'],
        filters: [{ name: 'Content archive', extensions: ['car'] }]
      })
      if (picked.canceled || !picked.filePaths?.length) return { cancelled: true }
      carPath = picked.filePaths[0]
    }
    try {
      const scan = await scanBackupCar(carPath)
      // A partial file (chain continues below it) is only restorable when the older history is
      // already reachable from this node — else the head pin would hang hunting absent blocks.
      let priorAvailable = false
      if (scan.missingPrev) {
        try {
          const env = await kubo.getEnvelope(CID.parse(scan.missingPrev), { timeout: 5000 })
          priorAvailable = !!env?.event
        } catch { priorAvailable = false }
      }
      pendingRestore = { carPath, headCid: scan.headCid, mediaRoots: scan.mediaRoots, blocks: scan.blocks }
      return {
        path: carPath,
        headCid: scan.headCid,
        pubkey: scan.headEvent.pubkey,
        event: scan.headEvent,
        notes: scan.notes,
        media: scan.mediaRoots.length,
        missingMedia: scan.missingMedia.length,
        blocks: scan.blocks,
        bytes: scan.bytes,
        newestAt: scan.newestAt,
        oldestAt: scan.oldestAt,
        missingPrev: scan.missingPrev,
        priorAvailable
      }
    } catch (e) { return { error: String(e?.message || e) } }
  })

  // Import the last-inspected backup: every block lands, the head pins recursively, each media
  // root pins individually — importCar, the proven migration path.
  ipcMain.handle('history:restore', async () => {
    if (!kubo) return { error: 'node not ready' }
    if (!pendingRestore) return { error: 'no backup inspected — pick a file first' }
    if (historyBusy()) return { error: 'the node is busy with another sync — try again shortly' }
    const { carPath, headCid, mediaRoots, blocks } = pendingRestore
    backup = { state: 'importing', op: 'restore', blocks: 0, total: blocks }
    try {
      await importCar({
        node: kubo,
        carPath,
        headCid,
        mediaRoots,
        onProgress: (p) => { backup = { ...backup, blocks: p.blocks } }
      })
      backup = { state: 'done', op: 'restore' }
      pendingRestore = null
      return { ok: true, headCid }
    } catch (e) {
      backup = { state: 'failed', op: 'restore', error: String(e?.message || e) }
      return { error: String(e?.message || e) }
    }
  })

  // Is targetCid an ancestor of (or equal to) headCid? The renderer's head-adoption rule:
  // only a head whose chain contains the current one may replace it (a restore never forks).
  ipcMain.handle('history:contains', async (_e, { headCid, targetCid } = {}) => {
    if (!kubo) return { error: 'node not ready' }
    try { return { contains: await chainContains({ node: kubo, headCid, targetCid }) } } catch (e) { return { error: String(e?.message || e) } }
  })

  ipcMain.handle('history:status', () => backup)
}

// --- Mode persistence: which posture the app boots into ('clearnet' | 'tor'), plus the
// external Tor proxy setting, in userData ---
function modeFile () { return path.join(app.getPath('userData'), 'nosdag-mode.json') }
async function readMode () {
  let m = 'clearnet'
  try {
    const j = JSON.parse(await fs.promises.readFile(modeFile(), 'utf8'))
    torProxy = parseTorProxy(j?.torProxy)
    m = j?.mode === 'tor' ? 'tor' : 'clearnet'
  } catch { /* first run / unreadable → clearnet, no proxy */ }
  const env = parseTorProxy(process.env.NOSDAG_TOR_SOCKS)
  if (env) { torProxy = env; console.log(`[tor] external proxy from NOSDAG_TOR_SOCKS: ${env.host}:${env.port} (session only)`) }
  return m
}
async function writeMode (m) {
  const tmp = modeFile() + '.tmp'
  await fs.promises.writeFile(tmp, JSON.stringify({ mode: m, torProxy: torProxy ? `${torProxy.host}:${torProxy.port}` : null }))
  await fs.promises.rename(tmp, modeFile())
}

// --- Shared-blockstore watermark: per pubkey, the newest head CID present in BOTH stores ---
// Keyed per-pubkey so an identity only ever syncs its own history — which is also the same-npub
// gate from the design: migration is only safe while both postures use the same key. If a
// separate-Tor-identity feature ever ships, that identity gets its own isolated store and this
// migration must be suppressed for it (a shared store would bridge the two identities).
function migrateFile () { return path.join(app.getPath('userData'), 'nosdag-migrate.json') }
async function readMigrateState () {
  try { return JSON.parse(await fs.promises.readFile(migrateFile(), 'utf8')) || {} } catch { return {} }
}
async function writeMigrateState (all) {
  const tmp = migrateFile() + '.tmp'
  await fs.promises.writeFile(tmp, JSON.stringify(all))
  await fs.promises.rename(tmp, migrateFile())
}
async function writeMigrateWatermark (pubkey, headCid) {
  const all = await readMigrateState()
  all[pubkey] = { ...(all[pubkey] || {}), lastMigratedHead: headCid, updatedAt: Math.floor(Date.now() / 1000) }
  await writeMigrateState(all)
}
// The catch-up memo: the newest head whose full chain is KNOWN present in this posture's
// store — lets the login-time repair walk exit in one file read when nothing changed.
async function writeVerifiedHead (pubkey, posture, headCid) {
  const all = await readMigrateState()
  const e = all[pubkey] || {}
  e.verifiedHead = { ...(e.verifiedHead || {}), [posture]: headCid }
  all[pubkey] = e
  await writeMigrateState(all)
}
// Same memo for the timeline archive: which manifest is known present + pinned in which
// posture's store (the archive doesn't ride the chain migration).
async function writeArchiveMemo (pubkey, posture, cid) {
  const all = await readMigrateState()
  const e = all[pubkey] || {}
  e.archive = { ...(e.archive || {}), [posture]: cid }
  all[pubkey] = e
  await writeMigrateState(all)
}

// --- Mixed-posture repair: make the CURRENT store serve the whole chain ---
// A quit-relaunch posture flip never migrates (only the in-app switch does), so a chain can
// span both stores: this node then can't serve the segments authored in the other posture,
// and the next in-app switch's export walks into the gap and aborts (the 2026-07-25 field
// failure). Heal by walking the chain over BOTH stores — the live node plus the other
// posture's at-rest store — and importing only what the current store lacks. The watermark
// is NOT advanced: it means "present in BOTH stores", and the other store may still lack
// notes authored here — its own heal runs when the user is next in that posture.
const mhKey = (cid) => Buffer.from(cid.multihash.bytes).toString('base64')
async function catchUpCurrentStore ({ pubkey, headCid, archiveCid, deep = false }) {
  if (!kubo) return { error: 'node not ready' }
  if (!validPubkey(pubkey) || (!headCid && !archiveCid)) return { error: 'pubkey and a head or archive CID required' }
  const st = (await readMigrateState())[pubkey] || {}
  // deep = ignore the watermark AND the memo: walk the whole chain. The escape hatch for a
  // gap BELOW the watermark (a pre-repair migration that never completed) — a chain reader
  // that hits a missing envelope requests this once.
  const chainDone = !headCid || (!deep && st.verifiedHead?.[mode] === headCid)
  const archiveDone = !archiveCid || (!deep && st.archive?.[mode] === archiveCid)
  if (chainDone && archiveDone) return { ok: true, upToDate: true }

  // Presence oracle for the current store. Kubo: one refs-local enumeration → Set (its live
  // getBlock would Bitswap-hunt for misses; ⚠ the store is multihash-keyed, so compare by
  // multihash). Helia: getBlock reads the raw FsBlockstore — instant NotFound.
  let hasLocal
  if (mode === 'clearnet') {
    const set = new Set()
    for await (const r of kubo.refsLocal()) {
      const s = r?.ref ?? String(r)
      try { set.add(mhKey(CID.parse(s))) } catch { /* skip malformed */ }
    }
    hasLocal = async (cid) => set.has(mhKey(cid))
  } else {
    hasLocal = async (cid) => { try { await kubo.getBlock(cid); return true } catch { return false } }
  }

  const other = mode === 'clearnet'
    ? await openHeliaReader(path.join(app.getPath('userData'), 'helia', 'blocks'))
    : openKuboReader({ binPath: resolveKuboBin(), ipfsPath: path.join(app.getPath('userData'), 'ipfs'), scratchDir: app.getPath('userData') })
  const carPath = path.join(app.getPath('userData'), 'nosdag-catchup.car')
  const result = { ok: true, upToDate: true }
  try {
    if (!chainDone) {
      const wm = deep ? null : (st.lastMigratedHead || null)
      migration = { state: 'exporting', headCid, catchUp: true }
      const staged = await exportMissingCar({
        node: kubo,
        hasLocal,
        other,
        headCid,
        stopAtCid: wm,
        carPath,
        onProgress: (p) => { migration = { state: 'exporting', headCid, catchUp: true, blocks: p.blocks } }
      })
      if (!staged) {
        migration = { state: 'idle' }
        await writeVerifiedHead(pubkey, mode, headCid)
      } else {
        migration = { state: 'importing', headCid, catchUp: true, total: staged.blocks, blocks: 0 }
        await importCar({
          node: kubo,
          carPath,
          headCid,
          mediaRoots: staged.mediaRoots,
          onProgress: (p) => { migration = { ...migration, blocks: p.blocks } }
        })
        migration = { state: 'done', headCid, catchUp: true, notes: staged.notes, media: staged.media, blocks: staged.blocks, skippedMedia: staged.skippedMedia?.length || 0 }
        await writeVerifiedHead(pubkey, mode, headCid)
        console.log(`[migrate] catch-up: healed ${staged.notes} notes + ${staged.media} media (${staged.blocks} blocks) into the ${mode} store`)
        Object.assign(result, { upToDate: false, notes: staged.notes, media: staged.media, blocks: staged.blocks })
      }
    }
    // The timeline archive doesn't ride the chain migration — but its manifest's IPLD links
    // cover every archived note + mirrored media file, so copying the closure blocks this
    // store lacks from the other posture's store brings the whole archive across; then it's
    // pinned here too. Best-effort: an archive absent from BOTH stores just logs (a
    // re-import rebuilds it from relays), and never fails the chain heal.
    if (!archiveDone) {
      const acar = path.join(app.getPath('userData'), 'nosdag-catchup-archive.car')
      try {
        const staged = await exportClosureCar({
          other,
          hasLocal,
          rootCid: archiveCid,
          carPath: acar,
          onProgress: (p) => { migration = { state: 'exporting', headCid: archiveCid, catchUp: true, archive: true, blocks: p.blocks } }
        })
        if (staged) {
          migration = { state: 'importing', headCid: archiveCid, catchUp: true, archive: true, total: staged.blocks, blocks: 0 }
          await importCar({
            node: kubo,
            carPath: acar,
            headCid: archiveCid,
            onProgress: (p) => { migration = { ...migration, blocks: p.blocks } }
          })
          migration = { state: 'done', headCid: archiveCid, catchUp: true, archive: true, blocks: staged.blocks }
          console.log(`[migrate] catch-up: timeline archive (${staged.blocks} blocks) now in the ${mode} store`)
          Object.assign(result, { upToDate: false, archiveBlocks: staged.blocks })
        } else {
          // whole closure already local — just make sure it's pinned in this store too
          try { await kubo.pinRecursive(CID.parse(archiveCid), { timeout: 120000 }) } catch { /* already pinned */ }
        }
        await writeArchiveMemo(pubkey, mode, archiveCid)
      } catch (e) {
        console.warn('[migrate] archive catch-up skipped:', e?.message || e)
      } finally {
        fs.promises.rm(acar, { force: true }).catch(() => {})
      }
    }
    return result
  } finally {
    try { await other.close?.() } catch { /* release only */ }
    fs.promises.rm(carPath, { force: true }).catch(() => {})
  }
}

// --- Clearnet posture: the bundled Kubo node (today's default) ---
async function startClearnet () {
  sidecar = new KuboSidecar({
    binPath: resolveKuboBin(),
    ipfsPath: path.join(app.getPath('userData'), 'ipfs'),
    onLog: (m) => console.log('[sidecar]', m)
  })
  await sidecar.start()
  kubo = connectKubo(sidecar.apiPort)
  await clearProxy() // clearnet posture: the renderer talks to relays + backend directly
}

// Sniff an image content-type from magic bytes so <img> renders gateway-served media in Tor mode.
function sniffMime (b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length > 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return 'application/octet-stream'
}

// Minimal local gateway for Tor mode: the renderer fetches ipfs media at 127.0.0.1:8201/ipfs/<cid>
// (the same gateway URL as the Kubo path). Kubo is stopped in Tor mode, so we serve the bytes from the
// Helia node here. catBytes reassembles both media shapes — legacy raw single blocks and chunked
// UnixFS dag-pb files — buffered whole per request (bounded by the composer's attachment cap).
function startTorGateway (node, port) {
  const server = http.createServer(async (req, res) => {
    const m = (req.url || '').match(/^\/ipfs\/([^/?#]+)/)
    if (!m) { res.writeHead(404); res.end('not found'); return }
    try {
      const bytes = Buffer.from(await node.catBytes(m[1]))
      res.writeHead(200, { 'content-type': sniffMime(bytes), 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000, immutable' })
      res.end(bytes)
    } catch { res.writeHead(502); res.end('media unavailable') }
  })
  server.on('error', (e) => console.error('[tor-gw]', e?.message || e))
  server.listen(port, '127.0.0.1')
  return server
}

// --- Anonymous posture: tor + a Helia node whose only transport dials .onion over Tor ---
async function startTorMode () {
  const dataDir = app.getPath('userData')
  if (torProxy) return startTorModeExternal(dataDir)
  torProc = new TorProcess({
    dataDir: path.join(dataDir, 'tor'),
    socksPort: TOR_SOCKS_PORT,
    hiddenServices: [{ name: 'self', dir: path.join(dataDir, 'tor', 'hs_self'), virtPort: TOR_WS_PORT, targetPort: TOR_WS_PORT }],
    onLog: (m) => console.log('[tor]', m),
    onExit: () => { engageTorKillSwitch().catch((e) => console.error('[tor] kill-switch:', e?.message || e)) } // H2
  })
  await torProc.start()
  const onion = torProc.onions.self
  kubo = await createTorNode({
    repoPath: path.join(dataDir, 'helia'),
    wsPort: TOR_WS_PORT,
    socksPort: TOR_SOCKS_PORT,
    announce: onion
  })
  torGateway = startTorGateway(kubo, TOR_GATEWAY_PORT)
  // Route the RENDERER's clearnet traffic (relays, search, media, wallet, DNS) over Tor too, so a
  // relay or the backend can't see your real IP next to your pubkey. Loopback (the gateway) stays direct.
  await applyTorProxy()
  console.log(`[tor] anonymous node up — onion ${onion}, peer ${(await kubo.id()).id}`)
}

// External-proxy variant: the user already runs Tor (tor router / Whonix-style gateway / system
// tor); every SOCKS consumer points at it and nothing is spawned. Outbound-only — no control
// access means no onion service, so the node can pull authors' DAGs but nobody can dial us and
// no nosdag:onion pointer publishes (the announce loop sees torExternal and stands down).
// Circuit isolation (Monero vs relay traffic, security review C1) rides the proxy's own
// IsolateSOCKSAuth — tor's default, but a hardened router may disable it; disclosed in the UI.
async function startTorModeExternal (dataDir) {
  await probeTorProxy(torProxy) // fail fast with a classified error instead of hanging on a dead proxy
  kubo = await createTorNode({
    repoPath: path.join(dataDir, 'helia'),
    wsPort: TOR_WS_PORT,
    socksPort: torProxy.port,
    socksHost: torProxy.host,
    announce: null // outbound-capable, inbound-invisible
  })
  torGateway = startTorGateway(kubo, TOR_GATEWAY_PORT)
  await applyTorProxy()
  startTorProxyWatch() // the daemon isn't ours to supervise — poll reachability instead (H2 degraded)
  console.log(`[tor] anonymous node up via external proxy ${torProxy.host}:${torProxy.port} — outbound-only, peer ${(await kubo.id()).id}`)
}

// Reachability probe: a plain TCP connect (5s) — enough to distinguish "proxy is there" from
// "wrong address / not running / firewalled", which is what the classified error needs to say.
function probeTorProxy ({ host, port }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    const fail = (why) => { try { sock.destroy() } catch {} ; reject(new Error(`external tor proxy unreachable at ${host}:${port} (${why})`)) }
    sock.setTimeout(5000, () => fail('timeout'))
    sock.once('connect', () => { try { sock.destroy() } catch {} ; resolve() })
    sock.once('error', (e) => fail(e?.code || e?.message || 'error'))
  })
}

// Kill-switch signal for external-proxy mode: we can't watch a process we don't own, so probe
// the proxy every 10s; two consecutive misses → the same blackhole + banner as a daemon death.
// Egress already fails closed in the gap (everything routes AT the dead proxy) — the switch
// just makes it loud and latched.
function startTorProxyWatch () {
  stopTorProxyWatch()
  let misses = 0
  torProxyWatch = setInterval(() => {
    if (mode !== 'tor' || !torProxy) return stopTorProxyWatch()
    probeTorProxy(torProxy).then(() => { misses = 0 }).catch(() => {
      misses += 1
      if (misses >= 2) {
        stopTorProxyWatch()
        engageTorKillSwitch().catch((e) => console.error('[tor] kill-switch:', e?.message || e))
      }
    })
  }, 10_000)
}
function stopTorProxyWatch () { if (torProxyWatch) { clearInterval(torProxyWatch); torProxyWatch = null } }

// Boot whichever posture `mode` selects. Errors are surfaced but non-fatal — the shell still runs.
async function startNode () {
  torDown = false // a fresh node start clears any latched kill-switch state
  nodeStartError = null
  try {
    if (mode === 'tor') return await startTorMode()
    return await startClearnet()
  } catch (e) {
    // Surface a friendly cause so the renderer can explain it (esp. "Tor isn't installed", the most
    // common stumble for someone running anonymous mode from source without TOR_BIN). Re-throw so
    // existing callers still log it.
    const msg = String(e?.message || e)
    nodeStartError = (mode === 'tor' && /proxy unreachable/i.test(msg))
      ? { kind: 'proxy-down', message: `Couldn’t reach your external Tor proxy at ${torProxy ? `${torProxy.host}:${torProxy.port}` : 'the configured address'}. Check the address, that the proxy is running, and that it accepts connections from this machine — or clear the proxy setting to use the bundled Tor.`, detail: msg }
      : (mode === 'tor' && /did not reach 100%/i.test(msg))
        ? { kind: 'tor-timeout', message: 'Tor didn’t finish connecting in time. A first bootstrap can be slow — Tor saves its progress, so retrying usually completes.', detail: msg }
        : (mode === 'tor' && /could not start tor|TOR_BIN|tor \(/i.test(msg))
          ? { kind: 'no-tor', message: 'Anonymous mode needs Tor, which isn’t installed or couldn’t be found. Install Tor (or the Tor Expert Bundle), then start Nosdag with TOR_BIN=/path/to/tor. Clearnet mode works without it.' }
          : { kind: 'failed', message: msg }
    throw e
  }
}

// Tear down the ACTIVE backend completely (and only that one). Used on mode switch + shutdown.
// Sequential: the two transports are never live at once (the anonymous-mode invariant).
async function stopNode () {
  stopTorProxyWatch()
  try { if (torGateway) { torGateway.close(); torGateway = null } } catch {}
  try { if (kubo?.mode === 'tor' && kubo.stop) await kubo.stop() } catch (e) { console.error('[tor] helia stop:', e?.message || e) }
  try { if (torProc) { await torProc.stop(); torProc = null } } catch (e) { console.error('[tor] stop:', e?.message || e) }
  try { if (sidecar) { await sidecar.stop(); sidecar = null } } catch (e) { console.error('[sidecar] stop:', e?.message || e) }
  kubo = null
}

// --- Anonymous mode: route the RENDERER's whole network through Tor (relays, search, media, wallet,
// DNS) — not just the IPFS layer. setProxy points the session at Tor's SOCKS port; loopback is
// bypassed so the local media gateway (127.0.0.1:8201) stays direct, and a WebRTC guard blocks the
// classic STUN IP leak. Fail-closed: with the proxy set but Tor not yet up, requests hang rather
// than fall back to clearnet. DNS (security review H1): VERIFIED via a local SOCKS probe that
// session.setProxy's socks5:// sends the destination HOSTNAME to the proxy (remote DNS at Tor) — NOT
// a local lookup — so connections don't leak DNS. (A `host-resolver-rules` catch-all was tried and
// reverted: `MAP * ~NOTFOUND` NOTFOUND'd the proxy's own 127.0.0.1, breaking the proxy entirely; it
// only works with `EXCLUDE 127.0.0.1`, and being a command-line switch it'd force a relaunch — not
// worth it since connection DNS is already remote.) The speculative DNS prefetcher (the one path
// that could resolve locally) is disabled via the x-dns-prefetch-control meta in index.html.
async function applyTorProxy () {
  torAgent = new SocksProxyAgent(`socks5h://${torSocksHost()}:${torSocksPort()}`)
  if (!win) return
  // Flip the renderer's posture flag to 'tor' BEFORE the proxy so any relay socket that reconnects
  // once the proxy changes reads 'tor' and rides the Tor bridge. Otherwise it'd read the stale flag
  // (persisted from the last run, or absent on first launch), and since Electron 42's renderer WS
  // ignore setProxy, a direct dial would leak the real IP. (Security review 2026-07-03, M-A.)
  await seedRendererPosture('tor')
  try {
    await win.webContents.session.setProxy({
      proxyRules: `socks5://${torSocksHost()}:${torSocksPort()}`,
      proxyBypassRules: '127.0.0.1;localhost'
    })
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  } catch (e) { console.error('[tor] setProxy:', e?.message || e) }
}

// Keep the renderer's ws-tor-shim posture flag in lockstep with the session proxy. The shim reads
// localStorage['nosdag:posture'] SYNCHRONOUSLY to decide whether a relay socket must ride the Tor
// bridge; onion-relays.js only pushes it async (syncPosture), so on a cold Tor boot — or whenever the
// last run's posture differs from this one — the flag is stale/absent when the first relay connects.
// We write it here, before the proxy flips (and, on boot, before index.html loads: mode-select and
// index share the app://bundle origin, so this value carries across the navigation). executeJavaScript
// on a not-yet-loaded page rejects → caught; the shim's fail-closed default + the preload boot posture
// cover that window. (Security review 2026-07-03, M-A.)
async function seedRendererPosture (p) {
  const v = p === 'tor' ? 'tor' : 'clearnet'
  // Also stamp the root attribute driving CSS posture-aware UI (composer media advisory).
  try { await win?.webContents?.executeJavaScript(`try{localStorage.setItem('nosdag:posture','${v}');document.documentElement.setAttribute('data-nd-posture','${v}')}catch(e){}`) } catch { /* no live page yet */ }
}

// H2 kill-switch: if the tor daemon dies while we're in anonymous mode, NEVER fall back to clearnet.
// Blackhole the renderer session at a dead loopback port (every proxied connection is refused →
// fail-closed), drop live sockets, and tell the renderer to show a blocking banner. Loopback stays
// bypassed (harmless; its data source — the Helia-over-Tor node — is gone anyway).
async function engageTorKillSwitch () {
  if (mode !== 'tor') return
  console.error('[tor] tor went away unexpectedly — engaging kill-switch (blocking all egress)')
  stopTorProxyWatch()
  torProc = null
  torDown = true // latched: survives a renderer reload so the banner re-shows + status reports down
  try {
    await win?.webContents?.session?.setProxy({ proxyRules: 'socks5://127.0.0.1:1', proxyBypassRules: '127.0.0.1;localhost' })
    await win?.webContents?.session?.closeAllConnections?.()
  } catch (e) { console.error('[tor] kill-switch proxy:', e?.message || e) }
  try { win?.webContents?.send('tor:down') } catch {}
}
async function clearProxy () {
  torAgent = null
  if (!win) return
  await seedRendererPosture('clearnet') // posture flag tracks the proxy: direct dials are correct now
  try {
    await win.webContents.session.setProxy({ mode: 'direct' })
    win.webContents.setWebRTCIPHandlingPolicy('default')
  } catch (e) { console.error('[tor] clearProxy:', e?.message || e) }
}
// Main fetches /api + the trending cache itself (they're proxied from the app:// origin, so the
// renderer's session proxy never sees them). Route those through Tor's SOCKS in anonymous mode too,
// else they'd leak the real IP to the backend. Returns a Response so callers stay posture-agnostic.
function backendFetch (target, init = {}) {
  if (mode !== 'tor') return fetch(target, init)
  return new Promise((resolve, reject) => {
    const req = https.request(target, {
      method: init.method || 'GET',
      headers: init.headers || {},
      agent: torAgent || new SocksProxyAgent(`socks5h://${torSocksHost()}:${torSocksPort()}`)
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode || 502,
        headers: { 'content-type': res.headers['content-type'] || 'application/json' }
      })))
    })
    req.on('error', reject)
    if (init.body != null) req.write(Buffer.from(init.body))
    req.end()
  })
}

async function createWindow (startUrl = 'app://bundle/index.html') {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1280,   // rail (210) + feed (~620) + right deck (400) must all fit, no cutoff
    minHeight: 700,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hand the loopback capability token to the sandboxed preload via process.argv — synchronous and
      // available before any renderer script runs, so the ws-tor-shim can include it on the very first
      // relay connection. Not exposed to any other origin/process. (Security review 2026-07-03, H-A.)
      // The boot posture rides the same channel so the shim knows — synchronously, before the first
      // relay socket — whether THIS window's initial load is anonymous, without waiting for the async
      // syncPosture() round-trip. Authoritative only for a fresh window's first load (smoke / re-open);
      // reloads + in-app switches are covered by main seeding localStorage. (M-A.)
      additionalArguments: ['--nosdag-cap=' + CAP_TOKEN, '--nosdag-posture=' + mode]
    }
  })
  win.once('ready-to-show', () => win.show())
  // Surface the renderer's own diagnostics into the main stdout — but only under the smoke harness
  // or an explicit NOSDAG_DEBUG=1, not in normal runs: renderer logs can carry user activity
  // (relay names, note ids) and a terminal launch shouldn't transcribe them by default.
  // Electron 35+ passes a single ConsoleMessageEvent (message/level/lineNumber/sourceId) — the old
  // (event, level, message, …) positional signature was removed.
  if (process.env.NOSDAG_SMOKE || process.env.NOSDAG_DEBUG) {
    win.webContents.on('console-message', (e, level, message) => {
      // Electron's console-message moved its fields onto the event object (e.message); the dual form still
      // passes the text as the 3rd positional arg. Prefer e.message, fall back to the positional message —
      // the prior single-arg `e.message` handler logged "[renderer] undefined" for EVERY renderer log on
      // Electron 42, swallowing all renderer output to the terminal.
      console.log('[renderer]', e?.message ?? message)
    })
  }
  // M9: lock the window down post-XSS. Never open a child window, and never let the top frame
  // navigate off app:// (an attacker page would otherwise inherit the preload bridge). External
  // links open in the OS browser — but NOT in Tor mode, where the OS browser would bypass Tor and
  // leak your IP; there they're simply blocked.
  const openExternalSafe = (url) => { if (mode !== 'tor' && /^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {}) }
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('app://')) return // in-app routing / reloads
    e.preventDefault()
    openExternalSafe(url)
  })
  // L4: deny the powerful web permissions the app never uses (camera/mic, geolocation, Web
  // Notifications, MIDI/HID/serial/USB/Bluetooth, etc.) instead of letting the privileged scheme
  // default-grant them. Clipboard + fullscreen + the rest stay allowed (copying keys, video).
  const DENIED_PERMS = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'bluetooth', 'idle-detection', 'speaker-selection', 'window-management', 'storage-access'])
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(!DENIED_PERMS.has(perm)))
  win.webContents.session.setPermissionCheckHandler((_wc, perm) => !DENIED_PERMS.has(perm))
  // Boot-in-Tor: set the proxy BEFORE the page can open a socket, so relay/backend connections
  // fail-closed (hang until Tor is up) instead of leaking over clearnet during bootstrap.
  // (The mode-select chooser makes zero network requests, so it loads proxy-less either way.)
  if (mode === 'tor' && !startUrl.includes('mode-select')) await applyTorProxy()
  win.loadURL(startUrl)
}

app.whenReady().then(async () => {
  registerAppProtocol()
  setupIpc()
  mode = await readMode() // last-used posture — shown as a "last used" tag on the chooser
  await moneroRelay.start().catch((e) => console.error('[monero-relay] start:', e?.message || e))
  // The WASM wallet (wallet2/epee) issues origin-form paths — /json_rpc, never /<capToken>/json_rpc —
  // so full-wallet requests arrive at the relay without the path-borne token and were 403'd (Tip Jar
  // sync dead in both postures). Stamp the token as a header, at the network layer, onto every request
  // this app's session sends to the relay port: other local processes and foreign browser pages never
  // get the stamp, and the relay's Origin check still rejects third-party frames inside this session.
  if (moneroRelay.url()) {
    const relayPort = new URL(moneroRelay.url()).port
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: [`http://127.0.0.1:${relayPort}/*`] },
      (details, cb) => cb({ requestHeaders: { ...details.requestHeaders, 'x-nosdag-cap': CAP_TOKEN } })
    )
  }
  await wsTorBridge.start().catch((e) => console.error('[ws-bridge] start:', e?.message || e))
  if (process.env.NOSDAG_SMOKE) {
    // Smokes boot straight to the app on clearnet (deterministic; tests that need Tor switch
    // themselves) — and a prior Tor-mode run can never leak its posture into the next test.
    mode = 'clearnet'
    torProxy = null // deterministic baseline: a persisted external proxy must never leak into a smoke
    await writeMode('clearnet')
    await createWindow()
    startNode().catch((e) => console.error('[node] failed to start:', e))
  } else {
    // The user picks the posture each launch (mode-select.html, zero network requests);
    // the node + proxy start on mode:choose, so a Tor choice is fail-closed from the
    // very first socket the app opens.
    await createWindow('app://bundle/mode-select.html')
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow((kubo || sidecar || torProc) ? 'app://bundle/index.html' : 'app://bundle/mode-select.html')
    }
  })
  // Headless CI smoke: boot, optionally navigate to a view, screenshot it, then quit.
  if (process.env.NOSDAG_SMOKE) {
    const view = process.env.NOSDAG_SMOKE_VIEW // e.g. 'node'; default = feed
    setTimeout(async () => {
      try {
        if (view === 'clicktest') {
          // Click-routing regression: a username click in a feed card must open the
          // right-panel profile and must NOT open the thread.
          await new Promise((r) => setTimeout(r, 5000)) // let the feed render
          const result = await win.webContents.executeJavaScript(`(async () => {
            const spy = { thread: null, profile: null };
            const origT = window.openThreadView;
            window.openThreadView = (id) => { spy.thread = id; return origT?.(id); };
            const RP = window.RightPanel;
            const origP = RP?.openProfile?.bind(RP);
            if (RP) RP.openProfile = (pk, u) => { spy.profile = pk; return origP?.(pk, u); };
            // Prefer a parent-preview username (the historical gap); fall back to a main header one.
            const el = document.querySelector('.parent-post .username') || document.querySelector('.post .username');
            if (!el) return 'CLICKTEST FAIL | no .username in feed';
            const which = el.closest('.parent-post') ? 'parent-preview' : 'header';
            el.click();
            await new Promise(r => setTimeout(r, 2500));
            const profileActive = !!document.querySelector('#rightPanelContent .right-panel-profile.active');
            const ok = !spy.thread && !!spy.profile && profileActive;
            return 'CLICKTEST ' + (ok ? 'PASS' : 'FAIL') + ' | clicked=' + which + ' thread=' + spy.thread + ' profile=' + (spy.profile || '').slice(0, 8) + ' profileActive=' + profileActive;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'node') {
          await win.webContents.executeJavaScript('window.loadNodePage && window.loadNodePage()').catch(() => {})
          await new Promise((r) => setTimeout(r, 4500)) // let it render + poll the sidecar
        } else if (view === 'hosted') {
          await win.webContents.executeJavaScript('window.loadHostedFollowsPage && window.loadHostedFollowsPage()').catch(() => {})
          await new Promise((r) => setTimeout(r, 4000))
        } else if (view === 'concept') {
          await win.loadURL('app://bundle/design/feed-concept.html')
          await new Promise((r) => setTimeout(r, 1500))
        } else if (view === 'dagtest') {
          // Phase 2 round-trip: renderer → main → Kubo. Write a 2-post DAG and read it back,
          // verifying the prev IPLD link survives the envelope.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const k = window.nosdag.kubo;
            const ev1 = { id:'a1', pubkey:'pk', created_at:1, kind:1, tags:[], content:'phase2 post #1', sig:'s1' };
            const r1 = await k.putPost({ event: ev1, prevCid: null });
            if (r1.error) return 'putPost#1 ERR: ' + r1.error;
            const ev2 = { id:'a2', pubkey:'pk', created_at:2, kind:1, tags:[['prev', r1.cid]], content:'phase2 post #2', sig:'s2' };
            const r2 = await k.putPost({ event: ev2, prevCid: r1.cid });
            if (r2.error) return 'putPost#2 ERR: ' + r2.error;
            const back = await k.getPost(r2.cid);
            if (back.error) return 'getPost ERR: ' + back.error;
            const ok = back.event.content === 'phase2 post #2' && back.prev === r1.cid;
            return 'DAGTEST ' + (ok ? 'PASS' : 'FAIL') + ' | head=' + r2.cid + ' | prev-link=' + back.prev + ' | content=' + JSON.stringify(back.event.content);
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'authtest') {
          // Local-only username/password: signup writes a NIP-49 blob to localStorage, login
          // decrypts it — no server. Round-trip + wrong-password + unknown-user + availability +
          // no-plaintext-leak, against the real auth-client in the renderer.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools; if (!NT) return 'AUTHTEST FAIL | no NostrTools';
            const A = await import('/js/auth/auth-client.js');
            const sk = NT.generateSecretKey(); const pkhex = NT.getPublicKey(sk);
            const nsec = NT.nip19.nsecEncode(sk); const npub = NT.nip19.npubEncode(pkhex);
            const u = 'smoketest'; const pw = 'Str0ng-Passw0rd!2026';
            try { localStorage.removeItem('nosdag:accounts'); } catch {}
            await A.signup({ nsec, npub, password: pw, username: u });
            const r = await A.login(u, pw);
            const okLogin = r.nsec === nsec && r.npub === npub;
            let wrongRej = false; try { await A.login(u, 'wrong-password'); } catch { wrongRej = true; }
            let unknownRej = false; try { await A.login('nobody', pw); } catch { unknownRej = true; }
            const taken = await A.checkAvailability('username', u);          // false (exists)
            const free = await A.checkAvailability('username', 'someoneelse'); // true
            const blob = localStorage.getItem('nosdag:accounts');
            const noPlain = !!blob && blob.indexOf(nsec) === -1;             // ciphertext only, no nsec
            // Local-only: a weak (short) password is ACCEPTED (warning, not a block); empty still rejected.
            let weakOk = false; try { await A.signup({ nsec, npub, password: 'abc', username: 'weakuser' }); const rw = await A.login('weakuser', 'abc'); weakOk = rw.nsec === nsec; } catch { weakOk = false; }
            let emptyRej = false; try { await A.signup({ nsec, npub, password: '', username: 'emptyuser' }); } catch { emptyRej = true; }
            try { localStorage.removeItem('nosdag:accounts'); } catch {}
            const ok = okLogin && wrongRej && unknownRej && taken === false && free === true && noPlain && weakOk && emptyRej;
            return 'AUTHTEST ' + (ok ? 'PASS' : 'FAIL') + ' | login=' + okLogin + ' wrongRej=' + wrongRej + ' unknownRej=' + unknownRej + ' taken=' + (taken === false) + ' free=' + (free === true) + ' noPlain=' + noPlain + ' weakOk=' + weakOk + ' emptyRej=' + emptyRej;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'feedmark') {
          // Phase 2 Step 4: only the user's OWN notes that are in their DAG get the IPFS chip.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools; if (!NT) return 'no NostrTools';
            const M = await import('/js/nosdag/dag-publish.js');
            const FM = await import('/js/nosdag/feed-marks.js');
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            try { localStorage.removeItem('nosdag:head:'+pk); localStorage.removeItem('nosdag:posts:'+pk); } catch {}
            const sign = async (t) => NT.finalizeEvent({ created_at:1, content:'', ...t }, sk);
            const noStore = { publish: () => {} };
            const e1 = NT.finalizeEvent({ kind:1, created_at:1, tags:[['client','nosdag']], content:'feed mark #1' }, sk);
            const h1 = await M.publishToDag({ signedEvent:e1, prevCid:null, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
            const e2 = NT.finalizeEvent({ kind:1, created_at:2, tags:[['client','nosdag'],['prev',h1]], content:'feed mark #2' }, sk);
            await M.publishToDag({ signedEvent:e2, prevCid:h1, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
            const otherpk = '00'.repeat(32);
            const c = document.createElement('div'); c.id = 'feedmarktest';
            const card = (pub,id,client) => '<div class="post" data-pubkey="'+pub+'" data-post-id="'+id+'" data-client="'+(client||'')+'"><div class="post-header"><div class="post-info"></div></div></div>';
            // e2 as a REPLY: a .parent-post (the quoted note) nested above the post's own header
            const replyCard = (pub,id,client) => '<div class="post" data-pubkey="'+pub+'" data-post-id="'+id+'" data-client="'+(client||'')+'">'
              + '<div class="parent-post"><div class="post-header"><div class="post-info"><span class="username">parent</span></div></div></div>'
              + '<div class="post-header"><div class="post-info"><span class="username">me</span></div></div></div>';
            c.innerHTML = card(pk, e1.id, 'nosdag')          // mine (in my DAG) → CID badge
                        + replyCard(pk, e2.id, 'nosdag')      // mine + parent block → badge on own header
                        + card(otherpk, 'beefnosdag', 'nosdag') // other author, client=nosdag → badge (read-from-IPFS)
                        + card(otherpk, 'beefplain', '');     // other author, NOT nosdag → no badge
            document.body.appendChild(c);
            await FM.markIpfsNotes('feedmarktest', pk);
            const chips = c.querySelectorAll('.nd-ipfs-chip').length;
            const inParent = c.querySelector('.parent-post .nd-ipfs-chip') ? 1 : 0;
            const plain = c.querySelector('.post[data-post-id="beefplain"] .nd-ipfs-chip') ? 1 : 0;
            const otherNosdag = c.querySelector('.post[data-post-id="beefnosdag"] .nd-ipfs-chip') ? 1 : 0;
            return 'FEEDMARK ' + (chips===3 && inParent===0 && plain===0 && otherNosdag===1 ? 'PASS' : 'FAIL') + ' | chips='+chips+' inParent='+inParent+' plain='+plain+' otherNosdag='+otherNosdag;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'readtest') {
          // Phase 2 Step 3: write a 3-note chain, then walk it back from the head THROUGH THE
          // IPFS (getPost per hop) and verify the notes reconstruct newest→oldest, sigs intact.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools; if (!NT) return 'no NostrTools';
            const M = await import('/js/nosdag/dag-publish.js');
            const R = await import('/js/nosdag/dag-read.js');
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            try { localStorage.removeItem('nosdag:head:'+pk); localStorage.removeItem('nosdag:posts:'+pk); } catch {}
            const sign = async (t) => NT.finalizeEvent({ created_at:1, content:'', ...t }, sk);
            const noStore = { publish: () => {} };
            let prev = null;
            for (let i=1;i<=3;i++) {
              const tags = prev ? [['client','nosdag'],['prev',prev]] : [['client','nosdag']];
              const ev = NT.finalizeEvent({ kind:1, created_at:i, tags, content:'read note #'+i }, sk);
              prev = await M.publishToDag({ signedEvent:ev, prevCid:prev, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
            }
            const head = M.getLocalHead(pk);
            const notes = await R.walkNotes(head, {});
            const ok = notes.length===3 && notes[0].content==='read note #3' && notes[2].content==='read note #1' && notes.every(n=>NT.verifyEvent(n));
            return 'READTEST ' + (ok?'PASS':'FAIL') + ' | walked='+notes.length+' | newest='+notes[0]?.content+' | oldest='+notes[notes.length-1]?.content;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'ipfsnotesview') {
          // Phase 2 Step 3 UI: write 3 notes, open the "notes from IPFS" modal, count cards.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools; if (!NT) return 'no NostrTools';
            const M = await import('/js/nosdag/dag-publish.js');
            const V = await import('/js/nosdag/ipfs-notes-view.js');
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            try { localStorage.removeItem('nosdag:head:'+pk); localStorage.removeItem('nosdag:posts:'+pk); } catch {}
            const sign = async (t) => NT.finalizeEvent({ created_at:1, content:'', ...t }, sk);
            const noStore = { publish: () => {} };
            let prev = null;
            for (let i=1;i<=3;i++) {
              const tags = prev ? [['client','nosdag'],['prev',prev]] : [['client','nosdag']];
              const ev = NT.finalizeEvent({ kind:1, created_at:i, tags, content:'**IPFS view** note #'+i+' — read back from IPFS' }, sk);
              prev = await M.publishToDag({ signedEvent:ev, prevCid:prev, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
            }
            await V.showIpfsNotes(pk);
            await new Promise(r => setTimeout(r, 1200));
            const cards = document.querySelectorAll('.nd-ipfsnote-note').length;
            return 'IPFSVIEW ' + (cards===3 ? 'PASS' : 'FAIL') + ' | cards=' + cards;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'mediatest') {
          // Phase 2 media: add real image bytes to the local node, then prove (a) the bytes
          // round-trip back through the LOCAL GATEWAY (the path machine B uses to display IPFS
          // media), (b) the ipfs:// ref rewrites to a gateway URL the feed's image regex matches,
          // and (c) addImetaTags derives a NIP-92 imeta tag from the note content.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const Media = await import('/js/nosdag/media.js');
            if (!Media.inNosdagShell()) return 'MEDIATEST FAIL | no shell bridge';
            // a tiny but valid PNG (1x1, red) as bytes
            const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const bin = atob(b64); const bytes = new Uint8Array(bin.length);
            for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
            const file = new File([bytes], 'red.png', { type: 'image/png' });
            const ref = await Media.addFileToIpfs(file);              // ipfs://<CID>#media.png
            const cid = ref.replace('ipfs://','').split('#')[0];
            // (a) fetch the bytes back through the local gateway
            let gotBytes = 0, gwOk = false;
            try { const r = await fetch('http://127.0.0.1:8201/ipfs/'+cid); const buf = new Uint8Array(await r.arrayBuffer()); gotBytes = buf.length; gwOk = r.ok && gotBytes === bytes.length; } catch (e) { return 'MEDIATEST FAIL | gateway fetch: '+e.message; }
            // (b) ipfs:// rewrites to a gateway URL the feed image regex matches
            const rendered = Media.rewriteIpfsMedia(ref);
            const imgRe = /(https?:\\/\\/[^\\s<]+\\.(jpg|jpeg|png|gif|webp|svg)(\\?[^\\s<]*)?)/gi;
            const imgMatch = imgRe.test(rendered);
            // (c) imeta derivation from content carrying the ref
            const tmpl = { tags: [], content: 'look at this\\n\\n'+ref };
            Media.addImetaTags(tmpl);
            const imeta = tmpl.tags.find(t => t[0]==='imeta');
            const imetaOk = !!imeta && imeta.includes('url ipfs://'+cid) && imeta.includes('m image/png');
            const ok = gwOk && imgMatch && imetaOk && cid.startsWith('bafk');
            return 'MEDIATEST ' + (ok?'PASS':'FAIL') + ' | cid='+cid.slice(0,16)+'… gwBytes='+gotBytes+' imgMatch='+imgMatch+' imeta='+imetaOk+' rendered='+rendered.slice(0,46);
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'mirrortest') {
          // Phase 2 mirror-fetch + tombstone (§3.2/§7): a real local CID loads (no tombstone); a
          // bogus CID fails local + (fake) mirror → "media resting" tombstone; clicking "Notify me"
          // for a now-available CID swaps the media back in.
          const result = await win.webContents.executeJavaScript(`(async () => {
            await import('/js/nosdag/mirror-fetch.js');
            const MF = window.nosdagMirror; const k = window.nosdag.kubo;
            if (!MF || !k?.addMedia) return 'MIRRORTEST FAIL | no bridge';
            window.__nosdagMirror = { publicGateways:['http://127.0.0.1:9/ipfs/'], localTimeout:500, mirrorTimeout:350, retryInterval:250, retryMax:8 };
            const gw = k.gateway;
            const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const bin=atob(b64); const by=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) by[i]=bin.charCodeAt(i);
            const realCid=(await k.addMedia(by)).cid;
            const bogusCid=realCid.slice(0,-6)+'aaaaaa';
            const host=document.createElement('div'); host.id='mh'; document.body.appendChild(host);
            const imgOk=document.createElement('img'); imgOk.src=gw+realCid+'#media.png'; host.appendChild(imgOk);
            const imgBad=document.createElement('img'); imgBad.src=gw+bogusCid+'#media.png'; host.appendChild(imgBad);
            MF.scan();
            await new Promise(r=>setTimeout(r,2200));
            const caseB = host.contains(imgOk) && imgOk.tagName==='IMG' && !host.querySelector('.nd-tombstone[data-cid="'+realCid+'"]');
            const tomb = host.querySelector('.nd-tombstone');
            const caseA = !!tomb && tomb.dataset.cid===bogusCid && !host.contains(imgBad);
            const placeholder=document.createElement('img'); host.appendChild(placeholder);
            MF.installTombstone(placeholder, realCid, '#media.png');
            const ts=[...host.querySelectorAll('.nd-tombstone')].find(t=>t.dataset.cid===realCid);
            ts.querySelector('.nd-tombstone-retry').click();
            await new Promise(r=>setTimeout(r,2000));
            const recovered = host.querySelector('img.nd-recovered-media');
            const caseC = !!recovered && recovered.src.indexOf(realCid)!==-1 && !ts.isConnected;
            const ok = caseB && caseA && caseC;
            return 'MIRRORTEST '+(ok?'PASS':'FAIL')+' | caseA_tombstone='+caseA+' caseB_localLoads='+caseB+' caseC_recovers='+caseC;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'feedrendertest') {
          // The user's exact scenario: a note with unreachable IPFS media, rendered through the
          // REAL path (parseContent → innerHTML → processEmbeddedNotes, which bootstraps
          // mirror-fetch) must show a "Locating media…" box and then a tombstone — never a blank.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const k = window.nosdag.kubo; const U = window.NostrUtils;
            if (!U?.parseContent || !U?.processEmbeddedNotes) return 'FEEDRENDER FAIL | no utils';
            window.__nosdagMirror = { publicGateways:['http://127.0.0.1:9/ipfs/'], localTimeout:400, mirrorTimeout:300, locatingDelay:150, retryInterval:250, retryMax:5 };
            const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const bin=atob(b64); const by=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) by[i]=bin.charCodeAt(i);
            const realCid=(await k.addMedia(by)).cid;
            const bogus=realCid.slice(0,-6)+'aaaaaa';
            const list=document.createElement('div'); list.id='feedrender'; document.body.appendChild(list);
            list.innerHTML = '<div class="post"><div class="post-content">'+U.parseContent('look at this\\n\\nipfs://'+bogus+'#media.png')+'</div></div>';
            const img = list.querySelector('img');
            const imgViaGateway = !!img && /127\\.0\\.0\\.1:8201\\/ipfs\\//.test(img.getAttribute('src')||'');
            await U.processEmbeddedNotes('feedrender');
            await new Promise(r=>setTimeout(r,600));
            const locating = !!list.querySelector('.nd-locating');
            await new Promise(r=>setTimeout(r,1800));
            const tomb = list.querySelector('.nd-tombstone');
            const tombShown = !!tomb && tomb.dataset.cid===bogus;
            const ok = imgViaGateway && tombShown;
            return 'FEEDRENDER '+(ok?'PASS':'FAIL')+' | imgViaGateway='+imgViaGateway+' locatingShown='+locating+' tombstone='+tombShown;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'workertest') {
          // Diagnose the monero.worker.js failure under app://: where does the file resolve, does a
          // direct app:// Worker run, does a Blob-URL Worker run? Determines the fix (path vs loader).
          const result = await win.webContents.executeJavaScript(`(async () => {
            const out = [];
            const probe = async (u) => { try { const r = await fetch(u); return r.status; } catch(e){ return 'ERR'; } };
            out.push('root='+(await probe('app://bundle/monero.worker.js')));
            out.push('lib='+(await probe('app://bundle/lib/monero.worker.js')));
            const tryWorker = (url) => new Promise((resolve) => {
              let w; try { w = new Worker(url); } catch(e){ resolve('ctor-throw'); return; }
              let done=false; const fin=(v)=>{ if(!done){done=true; try{w.terminate()}catch{}; resolve(v); } };
              w.onerror = () => fin('onerror');
              w.onmessage = () => fin('message');
              setTimeout(()=>fin('loaded-ok'), 2500);
            });
            out.push('appWorker='+(await tryWorker('app://bundle/lib/monero.worker.js')));
            let blobRes;
            try {
              const txt = await (await fetch('app://bundle/lib/monero.worker.js')).text();
              const url = URL.createObjectURL(new Blob([txt], {type:'text/javascript'}));
              blobRes = await tryWorker(url);
            } catch(e){ blobRes = 'blob-ERR'; }
            out.push('blobWorker='+blobRes);
            return 'WORKERTEST | ' + out.join(' | ');
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'walletcreatetest') {
          // Prove the fix: point monero-ts at /lib/monero.worker.js, then actually create a wallet
          // through the worker (offline, random keys). If it returns an address, the worker works.
          const result = await win.webContents.executeJavaScript(`(async () => {
            if (typeof MoneroTS === 'undefined') return 'WALLETCREATE FAIL | no MoneroTS';
            let createRes;
            try {
              const w = await MoneroTS.createWalletFull({ networkType: MoneroTS.MoneroNetworkType.MAINNET, password:'x', proxyToWorker:true });
              const addr = await w.getPrimaryAddress();
              createRes = (addr && addr[0]==='4') ? 'WALLET-OK addr='+addr.slice(0,6)+'…' : 'addr?='+addr;
              try { await w.close(); } catch {}
            } catch(e){ createRes = 'CREATE-ERR:'+(e.message||e); }
            return 'WALLETCREATE | ' + createRes;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'xmraddrtest') {
          // L7: the client-side Monero address validator now base58-decodes + checks structure. Test
          // it against a REAL mainnet address generated by the wallet (so a decoder bug can't silently
          // false-reject and break tipping) plus a few invalid inputs.
          const result = await win.webContents.executeJavaScript(`(async () => {
            if (typeof MoneroTS === 'undefined') return 'XMRADDR FAIL | no MoneroTS';
            const MC = await import('/js/wallet/monero-client.js');
            const w = await MoneroTS.createWalletFull({ networkType: MoneroTS.MoneroNetworkType.MAINNET, password:'x', proxyToWorker:true });
            const addr = await w.getPrimaryAddress();
            try { await w.close(); } catch {}
            const real = MC.isValidMoneroAddress(addr);                  // real mainnet addr → true
            const garbage = !MC.isValidMoneroAddress('not_an_address');  // → false
            const short = !MC.isValidMoneroAddress(addr.slice(0, 90));   // wrong length → false
            const longer = !MC.isValidMoneroAddress(addr + 'A');         // length off → false
            const ok = real && garbage && short && longer;
            return 'XMRADDR ' + (ok?'PASS':'FAIL') + ' | real='+real+' garbage='+garbage+' short='+short+' longer='+longer+' addr='+addr.slice(0,6);
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'daemontest') {
          // Confirm the wallet's Monero daemon is reachable from the renderer (origin app://bundle)
          // now that CORS is injected — a get_info JSON-RPC should return the chain height.
          const result = await win.webContents.executeJavaScript(`(async () => {
            try {
              const r = await fetch('https://nosmero.com:18089/json_rpc', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ jsonrpc:'2.0', id:'0', method:'get_info' })
              });
              const j = await r.json();
              const h = j?.result?.height;
              return 'DAEMONTEST ' + (h > 0 ? 'PASS' : 'FAIL') + ' | status='+r.status+' height='+(h||'none');
            } catch(e) { return 'DAEMONTEST FAIL | ' + (e.message || e); }
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'publishtest') {
          // Phase 2 Step 2: exercise dag-publish.publishToDag end-to-end — two chained posts,
          // verify the second's prev IPLD link points at the first and the local head advances.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools; if (!NT) return 'no NostrTools';
            const M = await import('/js/nosdag/dag-publish.js');
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            try { localStorage.removeItem('nosdag:head:' + pk); localStorage.removeItem('nosdag:posts:' + pk); } catch {}
            const sign = async (t) => NT.finalizeEvent({ created_at: 1, content: '', ...t }, sk);
            const noStore = { publish: () => {} };
            const e1 = NT.finalizeEvent({ kind:1, created_at:1, tags:[['client','nosdag']], content:'dag post #1' }, sk);
            const h1 = await M.publishToDag({ signedEvent:e1, prevCid:null, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
            const prev = M.getLocalHead(pk);
            const e2 = NT.finalizeEvent({ kind:1, created_at:2, tags:[['client','nosdag'],['prev',prev]], content:'dag post #2' }, sk);
            const h2 = await M.publishToDag({ signedEvent:e2, prevCid:prev, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
            const back = await window.nosdag.kubo.getPost(h2);
            const notes = M.getPostCount(pk);
            const ok = !!h1 && !!h2 && h1!==h2 && prev===h1 && back.event.content==='dag post #2' && back.prev===h1 && M.getLocalHead(pk)===h2 && notes===2;
            return 'PUBLISHTEST ' + (ok?'PASS':'FAIL') + ' | notes='+notes+' | head2='+h2+' | #2.prev-link='+back.prev;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'pendingtest') {
          // Phase 5 Slice 1: the relationship gate (who lands in Pending) + NIP-10 direct-parent
          // resolution (which replies count as a reply to YOUR note), against the real modules.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const RG = await import('/js/nosdag/relationship-gate.js');
            const PQ = await import('/js/nosdag/pending-queue.js');
            const S  = await import('/js/state.js');
            const me = 'aa'.repeat(32), friend = 'bb'.repeat(32), stranger = 'cc'.repeat(32);
            S.setPublicKey(me);
            S.setFollowingUsers(new Set([friend]));
            // gate: followed -> auto, not-followed -> queue, self -> self, none -> ignore
            const g = [RG.classifyReply(friend), RG.classifyReply(stranger), RG.classifyReply(me), RG.classifyReply(null)];
            const gateOk = g[0]==='auto' && g[1]==='queue' && g[2]==='self' && g[3]==='ignore';
            // NIP-10 direct parent
            const myNote='note1';
            const dp = {
              marked:  PQ.directParentId({tags:[['e','root1','','root'],['e',myNote,'','reply']]}),       // myNote (marked reply wins)
              topReply:PQ.directParentId({tags:[['e',myNote,'','root']]}),                                 // myNote (top-level reply to root)
              deep:    PQ.directParentId({tags:[['e',myNote,'','root'],['e','other','','reply']]}),         // 'other' (descendant, NOT a reply to me)
              positional:PQ.directParentId({tags:[['e',myNote]]}),                                          // myNote (positional fallback)
              quote:   PQ.directParentId({tags:[['q','x'],['e',myNote]]}),                                  // null (quote-repost)
              mention: PQ.directParentId({tags:[['e',myNote,'','mention']]}),                               // null (mention, not a reply)
              none:    PQ.directParentId({tags:[['p',me]]})                                                 // null (no e-tag)
            };
            const dpOk = dp.marked===myNote && dp.topReply===myNote && dp.deep==='other' && dp.positional===myNote && dp.quote===null && dp.mention===null && dp.none===null;
            // DOM render: seed one pending item, mount into the deck, assert panel row + rail badge
            const seeded=[{id:'r1',author:stranger,content:'hello from a stranger',created_at:1,parentId:myNote}];
            try { localStorage.setItem('nosdag:pending:'+me, JSON.stringify(seeded)); } catch {}
            PQ.mountIntoDeck();
            await new Promise(r=>setTimeout(r,300));
            const panel=document.getElementById('ndReqPanel'), badge=document.getElementById('ndRequestsCount');
            const rows=panel?panel.querySelectorAll('.nd-req-item').length:0;
            const domOk = !!panel && rows===1 && !!badge && badge.style.display!=='none' && badge.textContent==='1';
            try { localStorage.removeItem('nosdag:pending:'+me); } catch {}
            return 'PENDINGTEST ' + (gateOk&&dpOk&&domOk?'PASS':'FAIL') + ' | gate='+JSON.stringify(g) + ' | parent='+JSON.stringify(dp) + ' | dom={panel:'+!!panel+',rows:'+rows+',badge:'+(badge&&badge.textContent)+'}';
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'threadindextest') {
          // Phase 5 Slice 2: the curation overlay's pure ordering/partition + no-index passthrough.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const TI = await import('/js/nosdag/thread-index.js');
            const nodes = ['a','b','c','d'].map(id => ({ post: { id, pubkey: 'zz' } }));
            // index order ['c','a'] -> shown [c,a] in that order; b,d unendorsed (in input order)
            const p = TI.partition(['c','a'], nodes);
            const partOk = p.shown.map(n=>n.post.id).join(',')==='c,a' && p.unendorsed.map(n=>n.post.id).join(',')==='b,d';
            // ids not present are ignored ('x'); a duplicate id is kept once ('b')
            const p2 = TI.partition(['x','b','b'], nodes);
            const part2Ok = p2.shown.map(n=>n.post.id).join(',')==='b' && p2.unendorsed.map(n=>n.post.id).join(',')==='a,c,d';
            // no known index -> passthrough: show all, none unendorsed, hasIndex=false
            const c = TI.curate('unknownpost','unknownauthor', nodes);
            const curateOk = c.hasIndex===false && c.unendorsed.length===0 && c.shown.length===nodes.length;
            const ok = partOk && part2Ok && curateOk;
            return 'THREADINDEXTEST ' + (ok?'PASS':'FAIL') + ' | part='+partOk + ' part2='+part2Ok + ' curate='+curateOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'reciprocaltest') {
          // Phase 5 Slice 3: the reciprocal-channel routing logic (thread-root resolution, open,
          // route-by-root, route-by-anchor, peer/self rejection, expiry) against the real module.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const R = await import('/js/nosdag/reciprocal-channel.js');
            const S = await import('/js/state.js');
            const me = 'aa'.repeat(32), peer = 'dd'.repeat(32), other = 'ee'.repeat(32);
            S.setPublicKey(me);
            try { localStorage.removeItem('nosdag:reciprocal:' + me); } catch {}
            R.reset();
            // threadRootId: top-level note is its own root; root-marker wins; positional first e-tag
            const tr = {
              top:  R.threadRootId({ id:'root1', pubkey:peer, tags:[] }),
              mark: R.threadRootId({ id:'x', pubkey:peer, tags:[['e','R','','root'],['e','P','','reply']] }),
              pos:  R.threadRootId({ id:'y', pubkey:peer, tags:[['e','R2'],['e','P2']] })
            };
            const trOk = tr.top==='root1' && tr.mark==='R' && tr.pos==='R2';
            // open a channel for thread root1 with peer; the reply you published is anchor 'myreply1'
            R.openChannel('root1', peer, ['myreply1']);
            const openOk = R.isOpen('root1', peer)===true && R.isOpen('root1', other)===false && R.isOpen('otherroot', peer)===false;
            // route by thread root (inbound reply tagged root1) and by anchor (reply to your reply)
            const byRoot   = R.routes({ pubkey:peer,  tags:[['e','root1','','reply']] }, 'root1');
            const byAnchor = R.routes({ pubkey:peer,  tags:[['e','myreply1','','reply']] }, 'myreply1');
            const wrongPeer= R.routes({ pubkey:other, tags:[['e','root1','','reply']] }, 'root1');
            const selfNo   = R.routes({ pubkey:me,    tags:[['e','root1','','reply']] }, 'root1');
            const routeOk = byRoot===true && byAnchor===true && wrongPeer===false && selfNo===false;
            // expiry: a channel past expiresAt never opens or routes
            try { localStorage.setItem('nosdag:reciprocal:' + me, JSON.stringify([{ threadRoot:'oldroot', peer, anchors:[], expiresAt: 1 }])); } catch {}
            R.reset();
            const expOk = R.isOpen('oldroot', peer)===false && R.routes({ pubkey:peer, tags:[['e','oldroot','','reply']] }, 'oldroot')===false;
            try { localStorage.removeItem('nosdag:reciprocal:' + me); } catch {}
            const ok = trOk && openOk && routeOk && expOk;
            return 'RECIPROCALTEST ' + (ok?'PASS':'FAIL') + ' | root='+JSON.stringify(tr) + ' open='+openOk + ' route={byRoot:'+byRoot+',byAnchor:'+byAnchor+',wrongPeer:'+wrongPeer+',self:'+selfNo+'} exp='+expOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'threadfollowtest') {
          // Phase 5 Slice 4: thread-follow state machine — root resolution, follow/unfollow/toggle
          // scoping, and per-pubkey persistence (no relays/Kubo needed; openSub just no-ops + retries).
          const result = await win.webContents.executeJavaScript(`(async () => {
            const CT = await import('/js/nosdag/consumption-tiers.js');
            const S = await import('/js/state.js');
            const me = 'aa'.repeat(32);
            S.setPublicKey(me);
            try { localStorage.removeItem('nosdag:threadfollow:' + me); } catch {}
            // rootIdOf: a root note is its own root; root-marker wins; else positional first e-tag; miss = self
            S.eventCache['root1']  = { id:'root1',  pubkey:'bb', tags:[] };
            S.eventCache['reply1'] = { id:'reply1', pubkey:'cc', tags:[['e','R','','root'],['e','P','','reply']] };
            S.eventCache['reply2'] = { id:'reply2', pubkey:'cc', tags:[['e','R2'],['e','P2']] };
            const rootOk = CT.rootIdOf('root1')==='root1' && CT.rootIdOf('reply1')==='R' && CT.rootIdOf('reply2')==='R2' && CT.rootIdOf('missing')==='missing';
            CT.init();
            CT.follow('root1');
            const followOk = CT.isFollowing('root1')===true && CT.isFollowing('nope')===false;
            const persistOk = JSON.parse(localStorage.getItem('nosdag:threadfollow:'+me)||'[]').includes('root1');
            const offOk = CT.toggle('root1')===false && CT.isFollowing('root1')===false;  // toggle returns the new state
            const onOk  = CT.toggle('root1')===true  && CT.isFollowing('root1')===true;
            const rootsOk = CT.followedRoots().includes('root1');
            try { localStorage.removeItem('nosdag:threadfollow:'+me); } catch {}
            const ok = rootOk && followOk && persistOk && offOk && onOk && rootsOk;
            return 'THREADFOLLOWTEST ' + (ok?'PASS':'FAIL') + ' | root='+rootOk+' follow='+followOk+' persist='+persistOk+' toggle='+(offOk&&onOk)+' roots='+rootsOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'interoptest') {
          // Phase 5 Slice 5: smart-publish (option C) — applyInterop ALWAYS rewrites ipfs:// media
          // (body + NIP-92 imeta url) to a dweb.link gateway URL so any client renders it, and the
          // shell's parseContent re-points BOTH ipfs:// and that gateway URL at the local node so
          // Nosdag keeps serving the CID P2P. No toggle, no per-account mode (no relays/Kubo needed).
          const result = await win.webContents.executeJavaScript(`(async () => {
            const IP = await import('/js/nosdag/interop-publish.js');
            const U = await import('/js/utils.js');
            const G = 'https://dweb.link/ipfs/';
            // publish: body + imeta rewritten unconditionally, extension preserved (body frag / imeta mime)
            const ev = { content:'pic ipfs://Qmabc#media.png and ipfs://Qmvid#media.mp4 !', tags:[['imeta','url ipfs://Qmabc','m image/png']] };
            IP.applyInterop(ev);
            const bodyOk = ev.content === 'pic '+G+'Qmabc?filename=media.png and '+G+'Qmvid?filename=media.mp4 !';
            const imetaOk = ev.tags[0][1] === 'url '+G+'Qmabc?filename=media.png';
            // plain text (no media) untouched
            const evP = { content:'just text, no media', tags:[] };
            IP.applyInterop(evP);
            const plainOk = evP.content==='just text, no media';
            // render: parseContent re-points media at the local gateway for BOTH forms — the portable
            // ipfs:// ref AND the published dweb.link gateway URL — so the shell serves the CID P2P
            // while vanilla clients (no window.nosdag) keep the gateway URL.
            const LG = window.nosdag.kubo.gateway;
            const hN = U.parseContent('pic ipfs://Qmabc#media.png !');
            const hI = U.parseContent('pic '+G+'Qmabc?filename=media.png !');
            const renderNativeOk = hN.includes('<img') && hN.includes(LG+'Qmabc') && !hN.includes('ipfs://');
            const renderInteropOk = hI.includes('<img') && hI.includes(LG+'Qmabc') && !hI.includes('dweb.link');
            const ok = bodyOk && imetaOk && plainOk && renderNativeOk && renderInteropOk;
            return 'INTEROPTEST ' + (ok?'PASS':'FAIL') + ' | body='+bodyOk+' imeta='+imetaOk+' plain='+plainOk+' renderNative='+renderNativeOk+' renderInterop='+renderInteropOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'trendingtest') {
          // Trending Monero feed: the app:// handler fetches /trending-cache.json LIVE from the
          // backend (not the frozen build-time snapshot). Compare the served generated_at to the
          // bundled snapshot's (2026-05-30T02:00:28.133Z) — live should be newer, with notes.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const SNAPSHOT = '2026-05-30T02:00:28.133Z';
            const r = await fetch('/trending-cache.json');
            const okStatus = r.ok;
            const j = await r.json();
            const hasNotes = Array.isArray(j.notes) && j.notes.length > 0;
            const isLive = typeof j.generated_at === 'string' && j.generated_at > SNAPSHOT;
            const ok = okStatus && hasNotes && isLive;
            return 'TRENDINGTEST ' + (ok?'PASS':'FAIL') + ' | status='+okStatus+' notes='+(j.notes?j.notes.length:0)+' generated_at='+j.generated_at+' live='+isLive;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'cloudbridgetest') {
          // Phase 3: Cloud Bridge — per-account map. Auth probes hit the REAL Filebase endpoints
          // with a bogus token (must be rejected). Two fake accounts link one bridge kind each and
          // must never see each other's: A links RPC while B stays unlinked, B links PSA while A
          // keeps RPC, unlinking A leaves B linked. No-pubkey status reports needsAccount. Plus
          // media-CID extraction + pinNote no-op-when-unlinked.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const CB = await import('/js/nosdag/cloud-bridge.js');
            const b = window.nosdag.cloudBridge;
            const A = '11'.repeat(32), B = '22'.repeat(32);
            await b.unlink({ pubkey:A }).catch(()=>{}); await b.unlink({ pubkey:B }).catch(()=>{}); // clean slate
            const s0 = await b.status({ pubkey:A }); const unlinked0 = !!(s0 && !s0.linked);
            const sn = await b.status({}); const needsAcct = !!(sn && !sn.linked && sn.needsAccount);
            // auth probes against the REAL Filebase endpoints — a bogus token must be rejected
            const tr = await b.test({ kind:'rpc', endpoint:'https://rpc.filebase.io', key:'bogus' });
            const rpcProbe = !!(tr && (tr.status===401||tr.status===403));
            const tp = await b.test({ kind:'psa', endpoint:'https://api.filebase.io/v1/ipfs', key:'bogus' });
            const psaProbe = !!(tp && (tp.status===401||tp.status===403));
            // A links RPC → A linked, B still unlinked (the isolation this feature exists for)
            await b.link({ pubkey:A, kind:'rpc', endpoint:'https://rpc.filebase.io', key:'dummy' });
            const sa1 = await b.status({ pubkey:A }); const aLinked = !!(sa1?.linked && sa1.kind==='rpc' && sa1.provider==='Filebase');
            const sb1 = await b.status({ pubkey:B }); const bIsolated = !!(sb1 && !sb1.linked);
            // B links PSA → both coexist, each seeing only their own
            await b.link({ pubkey:B, kind:'psa', endpoint:'https://api.pinata.cloud/psa', key:'dummy' });
            const sb2 = await b.status({ pubkey:B }); const bLinked = !!(sb2?.linked && sb2.kind==='psa' && sb2.provider==='Pinata');
            const sa2 = await b.status({ pubkey:A }); const aStill = !!(sa2?.linked && sa2.kind==='rpc');
            // unlink A → only A's entry goes
            const ua = await b.unlink({ pubkey:A });
            const sa3 = await b.status({ pubkey:A }); const aGone = !!(ua?.ok && sa3 && !sa3.linked);
            const sb3 = await b.status({ pubkey:B }); const bSurvives = !!(sb3?.linked);
            const ub = await b.unlink({ pubkey:B });
            const sb4 = await b.status({ pubkey:B }); const bGone = !!(ub?.ok && sb4 && !sb4.linked);
            // media CID extraction (ipfs:// AND interop dweb.link forms, deduped)
            const C1='QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
            const C2='bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
            const ev = { pubkey:A, content:'a https://dweb.link/ipfs/'+C1+'?filename=media.png b ipfs://'+C2+'#media.mp4', tags:[['imeta','url https://dweb.link/ipfs/'+C1]] };
            const cids = CB.extractMediaCids(ev);
            const extractOk = cids.includes(C1) && cids.includes(C2) && cids.length===2;
            let noopOk = true; try { await CB.pinNote(ev,'Qmhead',null); } catch { noopOk=false; }
            const ok = unlinked0 && needsAcct && rpcProbe && psaProbe && aLinked && bIsolated && bLinked && aStill && aGone && bSurvives && bGone && extractOk && noopOk;
            return 'CLOUDBRIDGETEST ' + (ok?'PASS':'FAIL') + ' | unlinked='+unlinked0+' needsAcct='+needsAcct
              +' rpcProbe='+rpcProbe+'('+(tr&&(tr.status||tr.error))+') psaProbe='+psaProbe
              +' aLink='+aLinked+' bIsolated='+bIsolated+' bLink='+bLinked+' aStill='+aStill
              +' aGone='+aGone+' bSurvives='+bSurvives+' bGone='+bGone+' extract='+extractOk+' noop='+noopOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'hostedfollowstest') {
          // Phase 3 Slice 2: altruistic-pin engine — dagSize over a real unixfs blob, default caps
          // (250 MB/acct · 5 GB global), the autoNewFollows toggle, isHosted, and hostAccount's
          // graceful no-content error (anonymous, so resolveHeadCid finds nothing → the safe path).
          const result = await win.webContents.executeJavaScript(`(async () => {
            const AP = await import('/js/nosdag/altruistic-pin.js');
            const k = window.nosdag.kubo;
            const big = new Uint8Array(300*1024); for (let i=0;i<big.length;i++) big[i]=i&255;
            const am = await k.addMedia(big);
            const sz = am.cid ? await k.dagSize(am.cid) : { error:'no media cid' };
            const sizeOk = !!(sz && !sz.error && sz.bytes >= 300*1024);
            const u = AP.usage();
            const capsOk = u.capBytes === 5120*1024*1024 && u.perAccountBytes === 250*1024*1024 && u.count === 0;
            const autoDefault = AP.autoNewFollows() === true;
            AP.setAutoNewFollows(false); const autoOff = AP.autoNewFollows() === false; AP.setAutoNewFollows(true);
            const notHosted = AP.isHosted('00'.repeat(32)) === false;
            const ha = await AP.hostAccount('00'.repeat(32));
            const gracefulOk = !!(ha && ha.ok === false && ha.error);
            const ok = sizeOk && capsOk && autoDefault && autoOff && notHosted && gracefulOk;
            return 'HOSTEDFOLLOWSTEST ' + (ok?'PASS':'FAIL') + ' | size='+sizeOk+'('+(sz&&(sz.bytes||sz.error))+')'
              +' caps='+capsOk+' autoDefault='+autoDefault+' autoOff='+autoOff+' notHosted='+notHosted+' graceful='+gracefulOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'durabilitytest') {
          // Phase 3 Slice 3: durability ("who hosts you") tracks the bridge state — at-risk when only
          // your device holds your notes, backed-up + You/Filebase host list when a bridge is linked.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const D = await import('/js/nosdag/durability.js');
            const S = await import('/js/state.js');
            const b = window.nosdag.cloudBridge;
            const pk = '33'.repeat(32); S.setPublicKey(pk); // bridges are per-account — durability needs a "you"
            await b.unlink({ pubkey:pk }).catch(()=>{}); await D.refreshBridge();
            const atRisk0 = D.isAtRisk()===true;
            const h0 = D.hosts(); const hosts0Ok = h0.length===1 && h0[0].kind==='local';
            await b.link({ pubkey:pk, kind:'rpc', endpoint:'https://rpc.filebase.io', key:'dummy' }); await D.refreshBridge();
            const linkedNotRisk = D.isAtRisk()===false;
            const h1 = D.hosts(); const hosts1Ok = h1.length===2 && h1[1].kind==='bridge' && h1[1].label==='Filebase';
            await b.unlink({ pubkey:pk }).catch(()=>{}); await D.refreshBridge();
            const backToRisk = D.isAtRisk()===true;
            // node-count plumbing: providers() returns a numeric DHT provider count for a real CID
            const ev = { id:'pv1', pubkey:'pk', created_at:1, kind:1, tags:[], content:'prov test', sig:'s' };
            const pr0 = await window.nosdag.kubo.putPost({ event: ev, prevCid: null });
            const pc = pr0.cid ? await window.nosdag.kubo.providers(pr0.cid, { timeoutMs: 6000, max: 10 }) : { error:'no cid' };
            const provOk = !!(pc && !pc.error && typeof pc.count === 'number' && pc.count >= 0);
            const ok = atRisk0 && hosts0Ok && linkedNotRisk && hosts1Ok && backToRisk && provOk;
            return 'DURABILITYTEST ' + (ok?'PASS':'FAIL') + ' | atRisk0='+atRisk0+' hosts0='+hosts0Ok+' linkedNotRisk='+linkedNotRisk+' hosts1='+hosts1Ok+'('+(h1[1]&&h1[1].label)+') backToRisk='+backToRisk+' providers='+provOk+'('+(pc&&(pc.count!==undefined?pc.count:pc.error))+')';
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'tormode') {
          // Anonymous mode end-to-end: switch the live app into Tor mode (tears down Kubo, boots
          // tor + the Helia node), wait for the onion, then round-trip a signed DAG + media block
          // through the Helia-over-Tor backend and the Tor-mode media gateway.
          const result = await win.webContents.executeJavaScript(`(async () => {
            if (!window.nosdag?.mode) return 'TORMODE FAIL | no mode bridge';
            const setRes = await window.nosdag.mode.set('tor');
            if (setRes?.error) return 'TORMODE FAIL | switch error: ' + setRes.error;
            let s = null;
            for (let i=0;i<180;i++){ s = await window.nosdag.kubo.status(); if (s?.ready && s.mode==='tor') break; await new Promise(r=>setTimeout(r,1000)); }
            if (!(s?.ready && s.mode==='tor')) return 'TORMODE FAIL | node not ready · last=' + JSON.stringify(s);
            const onionOk = /^[a-z2-7]{56}\\.onion$/.test(s.onion||'');
            // signed DAG round-trip over the Helia-over-Tor backend (prev IPLD link must survive)
            const ev1 = { id:'t1', pubkey:'pk', created_at:1, kind:1, tags:[], content:'tor note #1', sig:'s1' };
            const r1 = await window.nosdag.kubo.putPost({ event: ev1, prevCid: null });
            if (r1.error) return 'TORMODE FAIL | putPost: ' + r1.error;
            const ev2 = { id:'t2', pubkey:'pk', created_at:2, kind:1, tags:[['prev',r1.cid]], content:'tor note #2', sig:'s2' };
            const r2 = await window.nosdag.kubo.putPost({ event: ev2, prevCid: r1.cid });
            const back = await window.nosdag.kubo.getPost(r2.cid);
            const dagOk = !back.error && back.event.content==='tor note #2' && back.prev===r1.cid;
            // media round-trips through the Tor-mode local gateway
            const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const bin=atob(b64); const by=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) by[i]=bin.charCodeAt(i);
            const am = await window.nosdag.kubo.addMedia(by);
            let gwOk=false; try { const r=await fetch(window.nosdag.kubo.gateway+am.cid); const buf=new Uint8Array(await r.arrayBuffer()); gwOk=r.ok && buf.length===by.length; } catch(e){}
            const ok = onionOk && dagOk && gwOk;
            return 'TORMODE ' + (ok?'PASS':'FAIL') + ' | onion='+onionOk+'('+(s.onion||'').slice(0,16)+'…) dag='+dagOk+' gateway='+gwOk+' peers='+s.peers+' head='+r2.cid;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'torproxy') {
          // External-proxy variant of TORMODE: spawn a PRIVATE tor daemon (no hidden services) that
          // plays the user's "already-running proxy", then switch the app into anonymous mode
          // pointed at it. Asserts the external branch: ready on tor, torExternal, NO onion,
          // DAG + gateway still work (outbound-capable, inbound-invisible).
          const extPort = 9377
          let ext = null
          try {
            ext = new TorProcess({
              dataDir: path.join(app.getPath('userData'), 'tor-ext-smoke'),
              socksPort: extPort,
              hiddenServices: [],
              onLog: (m) => console.log('[ext-tor]', m)
            })
            await ext.start()
          } catch (e) { console.log('[smoke] TORPROXY FAIL | external tor spawn: ' + (e?.message || e)) }
          if (ext?.ready) {
            const result = await win.webContents.executeJavaScript(`(async () => {
              if (!window.nosdag?.mode) return 'TORPROXY FAIL | no mode bridge';
              const pr = await window.nosdag.mode.torProxy('127.0.0.1:${extPort}');
              if (pr?.error) return 'TORPROXY FAIL | set proxy: ' + pr.error;
              const setRes = await window.nosdag.mode.set('tor');
              if (setRes?.error) return 'TORPROXY FAIL | switch error: ' + setRes.error;
              let s = null;
              for (let i=0;i<60;i++){ s = await window.nosdag.kubo.status(); if (s?.ready && s.mode==='tor') break; await new Promise(r=>setTimeout(r,1000)); }
              if (!(s?.ready && s.mode==='tor')) return 'TORPROXY FAIL | node not ready · last=' + JSON.stringify(s);
              const extOk = s.torExternal === true && s.torProxyAddr === '127.0.0.1:${extPort}';
              const noOnion = !s.onion && !s.onionMultiaddr;
              const ev1 = { id:'x1', pubkey:'pk', created_at:1, kind:1, tags:[], content:'proxy note #1', sig:'s1' };
              const r1 = await window.nosdag.kubo.putPost({ event: ev1, prevCid: null });
              if (r1.error) return 'TORPROXY FAIL | putPost: ' + r1.error;
              const ev2 = { id:'x2', pubkey:'pk', created_at:2, kind:1, tags:[['prev',r1.cid]], content:'proxy note #2', sig:'s2' };
              const r2 = await window.nosdag.kubo.putPost({ event: ev2, prevCid: r1.cid });
              const back = await window.nosdag.kubo.getPost(r2.cid);
              const dagOk = !back.error && back.event.content==='proxy note #2' && back.prev===r1.cid;
              const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
              const bin=atob(b64); const by=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) by[i]=bin.charCodeAt(i);
              const am = await window.nosdag.kubo.addMedia(by);
              let gwOk=false; try { const r=await fetch(window.nosdag.kubo.gateway+am.cid); const buf=new Uint8Array(await r.arrayBuffer()); gwOk=r.ok && buf.length===by.length; } catch(e){}
              const cleared = await window.nosdag.mode.torProxy(null); // leave no proxy behind for later smokes
              const ok = extOk && noOnion && dagOk && gwOk && !!cleared?.ok;
              return 'TORPROXY ' + (ok?'PASS':'FAIL') + ' | external='+extOk+'('+(s.torProxyAddr||'')+') noOnion='+noOnion+' dag='+dagOk+' gateway='+gwOk+' cleared='+!!cleared?.ok;
            })()`).catch((e) => 'EXEC ERR: ' + e.message)
            console.log('[smoke]', result)
          }
          try { await ext?.stop() } catch {}
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'wstest') {
          // Can the renderer open a plain ws:// (non-TLS) WebSocket from the app:// secure
          // context? Onion relays are ws:// (the onion address IS the encryption+auth), so
          // Chromium's mixed-content rules decide whether onion relays can be dialed straight
          // from the renderer or need a main-process bridge. Constructor-level check — a
          // blocked scheme throws SecurityError synchronously, no network needed.
          const result = await win.webContents.executeJavaScript(`(() => {
            const out = {};
            try { const w = new WebSocket('ws://mixed-content-probe.invalid/'); out.ws = 'allowed'; try { w.close() } catch {} }
            catch (e) { out.ws = 'BLOCKED: ' + e.message; }
            try { const w2 = new WebSocket('wss://tls-probe.invalid/'); out.wss = 'allowed'; try { w2.close() } catch {} }
            catch (e) { out.wss = 'BLOCKED: ' + e.message; }
            return 'WSTEST | ws=' + out.ws + ' | wss=' + out.wss;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'onioncard') {
          // visual: the Anonymous Mode page (posture switch + onion relay picker)
          await win.webContents.executeJavaScript('window.loadAnonModePage && window.loadAnonModePage()').catch(() => {})
          await new Promise((r) => setTimeout(r, 3000))
        } else if (view === 'chooser') {
          // visual: the boot-time posture chooser (normally shown before the app loads)
          await win.loadURL('app://bundle/mode-select.html')
          await new Promise((r) => setTimeout(r, 1200))
        } else if (view === 'medialibview') {
          // visual: the Media library page in the real layout, seeded with two media notes
          await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools;
            const M = await import('/js/nosdag/dag-publish.js');
            const ML = await import('/js/nosdag/media-library.js');
            const S = await import('/js/state.js');
            const k = window.nosdag.kubo;
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            const sign = async (t) => NT.finalizeEvent({ created_at:1, content:'', ...t }, sk);
            const noStore = { publish: () => {} };
            const mk = (seed) => { const by = new Uint8Array(900); for (let i=0;i<by.length;i++) by[i]=(i*seed)&255; return by; };
            const mA = (await k.addMedia(mk(3))).cid;
            const mB = (await k.addMedia(mk(7))).cid;
            let prev = null;
            const contents = ['shot of the rig ipfs://'+mA+'#media.png', 'and the build ipfs://'+mB+'#media.png'];
            for (let i=0;i<2;i++) {
              const tags = prev ? [['client','nosdag'],['prev',prev]] : [['client','nosdag']];
              const ev = NT.finalizeEvent({ kind:1, created_at: 1749700000+i, tags, content: contents[i] }, sk);
              prev = await M.publishToDag({ signedEvent:ev, prevCid:prev, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
            }
            S.setPublicKey(pk);
            await window.loadMediaLibraryPage(); // media tab of the My Node page
          })()`).catch((e) => console.log('[smoke] medialibview ERR:', e.message))
          await new Promise((r) => setTimeout(r, 2500))
        } else if (view === 'settingsview') {
          // visual: the Settings category panes in the real layout (stubbed login).
          // NOSDAG_SMOKE_PANE=payments|relays|privacy|data|profile|feed picks the pane.
          const pane = /^[a-z]+$/.test(process.env.NOSDAG_SMOKE_PANE || '') ? process.env.NOSDAG_SMOKE_PANE : ''
          await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools;
            const S = await import('/js/state.js');
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            S.setPublicKey(pk);
            await window.loadSettings();
            ${pane ? `window.switchSettingsPane && window.switchSettingsPane('${pane}');` : ''}
          })()`).catch((e) => console.log('[smoke] settingsview ERR:', e.message))
          await new Promise((r) => setTimeout(r, 2500))
        } else if (view === 'relaypilltest') {
          // The header relay pill follows the posture: clearnet shows the configured count,
          // Tor shows the onion selection — and setPosture refreshes it immediately.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const OR = await import('/js/nosdag/onion-relays.js');
            const el = document.getElementById('relayCount');
            if (!el) return 'RELAYPILL FAIL | no element';
            OR.setPosture('clearnet');
            window.updateRelayIndicator(5);
            const clearOk = el.textContent === '5 relays connected';
            OR.setPosture('tor'); // setPosture refreshes the pill on its own
            const torOk = /onion relay/.test(el.textContent) && /Tor/.test(el.textContent);
            OR.setPosture('clearnet');
            const backOk = /relays connected/.test(el.textContent);
            const ok = clearOk && torOk && backOk;
            return 'RELAYPILL ' + (ok?'PASS':'FAIL') + ' | clear='+clearOk+' tor='+torOk+'('+el.textContent+') back='+backOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'chiptest') {
          // The "show my own notes" chip is Following-feed-only: hidden on every page nav
          // (Media, Node, …), shown again on home (logged in) and on the Following feed tab,
          // hidden on other feed tabs.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const S = await import('/js/state.js');
            S.setPublicKey('aa'.repeat(32));
            const chip = document.getElementById('followingFeedChip');
            if (!chip) return 'CHIPTEST FAIL | no chip element';
            chip.style.display = 'block'; // simulate logged-in user sitting on Following
            window.navigateTo('media');
            await new Promise(r=>setTimeout(r,700));
            const onMedia = chip.style.display === 'none';
            window.navigateTo('node');
            await new Promise(r=>setTimeout(r,700));
            const onNode = chip.style.display === 'none';
            window.navigateTo('home');
            await new Promise(r=>setTimeout(r,900));
            const onHome = chip.style.display === 'block';
            await window.handleFeedTabClick('trending', null);
            await new Promise(r=>setTimeout(r,700));
            const onTrending = chip.style.display === 'none';
            await window.handleFeedTabClick('following', null);
            await new Promise(r=>setTimeout(r,700));
            const onFollowing = chip.style.display === 'block';
            const ok = onMedia && onNode && onHome && onTrending && onFollowing;
            return 'CHIPTEST ' + (ok?'PASS':'FAIL') + ' | media='+onMedia+' node='+onNode+' home='+onHome+' trending='+onTrending+' following='+onFollowing;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'medialibtest') {
          // Media library E2E: publish a 2-note chain referencing 2 media files (one referenced
          // twice — must dedupe), enumerate from the DAG, round-trip the local pin toggle
          // (isPinned → unpin → re-pin), confirm the bridge column degrades gracefully with no
          // bridge linked, then render the real page and count rows.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools; if (!NT) return 'no NostrTools';
            const M = await import('/js/nosdag/dag-publish.js');
            const ML = await import('/js/nosdag/media-library.js');
            const S = await import('/js/state.js');
            const k = window.nosdag.kubo;
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            try { localStorage.removeItem('nosdag:head:'+pk); localStorage.removeItem('nosdag:posts:'+pk); } catch {}
            const sign = async (t) => NT.finalizeEvent({ created_at:1, content:'', ...t }, sk);
            const noStore = { publish: () => {} };
            const mk = (seed) => { const by = new Uint8Array(600); for (let i=0;i<by.length;i++) by[i]=(i+seed)&255; return by; };
            const mA = (await k.addMedia(mk(1))).cid;
            const mB = (await k.addMedia(mk(99))).cid;
            let prev = null;
            const contents = ['note one ipfs://'+mA+'#media.png', 'note two ipfs://'+mA+'#media.png and ipfs://'+mB+'#media.png'];
            for (let i=0;i<2;i++) {
              const tags = prev ? [['client','nosdag'],['prev',prev]] : [['client','nosdag']];
              const ev = NT.finalizeEvent({ kind:1, created_at:i+1, tags, content: contents[i] }, sk);
              prev = await M.publishToDag({ signedEvent:ev, prevCid:prev, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
            }
            // enumerate: 2 distinct media, deduped
            const items = await ML.collectMedia(pk);
            const cids = items.map(i=>i.cid);
            const enumOk = items.length===2 && cids.includes(mA) && cids.includes(mB);
            // local pin round-trip
            const p0 = await k.isPinned(mA); const wasPinned = p0.pinned===true;
            await k.unpinRecursive(mA); const p1 = await k.isPinned(mA);
            await k.pinRecursive(mA, 15000); const p2 = await k.isPinned(mA);
            const pinOk = wasPinned && p1.pinned===false && p2.pinned===true;
            // bridge column degrades gracefully with nothing linked
            const bs = await window.nosdag.cloudBridge.pinStatus({ pubkey: pk, cids });
            const bridgeOk = !!(bs && (bs.skipped || Array.isArray(bs.pinned)) && !bs.error);
            // the real page renders rows
            S.setPublicKey(pk);
            const host = document.createElement('div'); document.body.appendChild(host);
            await ML.renderMediaLibrary(host);
            await new Promise(r=>setTimeout(r,1500));
            const rows = host.querySelectorAll('.nd-ml-row').length;
            const pills = host.querySelectorAll('.nd-ml-pill[data-cell=local]').length;
            const uiOk = rows===2 && pills===2;
            const ok = enumOk && pinOk && bridgeOk && uiOk;
            return 'MEDIALIBTEST ' + (ok?'PASS':'FAIL') + ' | enum='+enumOk+'('+items.length+') pin='+pinOk+'('+wasPinned+','+p1.pinned+','+p2.pinned+') bridge='+bridgeOk+'('+(bs.skipped||bs.kind||'?')+') ui='+uiOk+'(rows='+rows+')';
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'archivetest') {
          // Timeline import — the storage half, relay-free: crafted signed kind-1s become
          // archive envelopes under one pinned manifest; chain notes (signed prev tag) are
          // skipped; a forged signature is rejected; a re-run is a no-op; an added note grows
          // the archive and supersedes the old manifest pin.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const TI = await import('/js/nosdag/timeline-import.js');
            const NT = window.NostrTools;
            const k = window.nosdag.kubo;
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            try { localStorage.removeItem('nosdag:archive:'+pk); } catch {}
            const mk = (content, at, tags=[]) => NT.finalizeEvent({ kind:1, created_at:at, tags, content }, sk);
            const e1 = mk('old note one', 1000);
            const e2 = mk('old note two with https://example.com/pic.png media ref', 2000);
            const chainNote = mk('a nosdag chain note', 3000, [['prev','bafyfake']]);
            // JSON round-trip strips finalizeEvent's verified-symbol (spread would copy it and
            // short-circuit verifyEvent) — relay-delivered events never carry it either.
            const forged = JSON.parse(JSON.stringify(mk('forged', 1500))); forged.sig = 'ab'.repeat(64);
            const s1 = await TI.importEvents(pk, [e1, e2, chainNote, forged], { mirrorMedia:false });
            const importOk = s1.imported===2 && s1.skippedChain===1 && s1.badSig===1 && !!s1.manifestCid;
            const man = await window.nosdag.archive.get({ cid: s1.manifestCid });
            const manOk = !man.error && man.pubkey===pk && man.count===2 && man.ids.length===2 && man.notes.length===2;
            const pinned = await k.isPinned(s1.manifestCid);
            const pinOk = pinned.pinned===true;
            const back = await k.getPost(man.notes[0]);
            const envOk = !back.error && back.event.content==='old note one' && back.prev===null;
            const s2 = await TI.importEvents(pk, [e1, e2, chainNote], { mirrorMedia:false });
            const rerunOk = s2.upToDate===true && s2.imported===0 && s2.alreadyArchived===2 && s2.manifestCid===s1.manifestCid;
            const e3 = mk('old note three', 2500);
            const s3 = await TI.importEvents(pk, [e1, e2, e3], { mirrorMedia:false });
            const growOk = s3.imported===1 && s3.total===3 && s3.manifestCid!==s1.manifestCid;
            const man3 = await window.nosdag.archive.get({ cid: s3.manifestCid });
            const grow2 = !man3.error && man3.count===3 && man3.ids.includes(e3.id);
            const oldPin = await k.isPinned(s1.manifestCid);
            const supersededOk = oldPin.pinned===false; // envelopes stay covered by the new manifest's pin
            // heal support: clearnet short-circuits checkMedia (Kubo can't hold an oversized
            // raw block, and probing absent CIDs would Bitswap-wait) — and the reworked
            // importEvents flow above already proved a heal no-op keeps re-runs up-to-date
            const cm = await window.nosdag.archive.checkMedia({ cids: man3.notes.slice(0,1) });
            const checkOk = !cm.error && cm.blocks && Object.keys(cm.blocks).length===0;
            const ok = importOk && manOk && pinOk && envOk && rerunOk && growOk && grow2 && supersededOk && checkOk;
            return 'ARCHIVETEST ' + (ok?'PASS':'FAIL') + ' | import='+importOk+'('+s1.imported+','+s1.skippedChain+','+s1.badSig+') man='+manOk
              +' pin='+pinOk+' env='+envOk+' rerun='+rerunOk+' grow='+(growOk&&grow2)+' superseded='+supersededOk+' checkMedia='+checkOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'archivereadtest') {
          // Archive READ side, relay-free: import → readAuthorArchive returns verified,
          // newest-first notes with manifest-mapped media URLs swapped to the local gateway;
          // a forged-signature envelope is skipped; a manifest bound to a different author
          // is refused outright.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const TI = await import('/js/nosdag/timeline-import.js');
            const DR = await import('/js/nosdag/dag-read.js');
            const NT = window.NostrTools;
            const A = window.nosdag.archive;
            const gw = window.nosdag.kubo.gateway;
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            const otherPk = NT.getPublicKey(NT.generateSecretKey());
            const KEY = 'nosdag:archive:'+pk, OKEY = 'nosdag:archive:'+otherPk;
            try { localStorage.removeItem(KEY); localStorage.removeItem(OKEY); } catch {}
            const mk = (content, at) => NT.finalizeEvent({ kind:1, created_at:at, tags:[], content }, sk);
            const MEDIA_URL = 'https://example.com/pic.png';
            const e1 = mk('archived one', 1000);
            const e2 = mk('archived two with ' + MEDIA_URL + ' inline', 2000);
            const s1 = await TI.importEvents(pk, [e1, e2], { mirrorMedia:false });
            if (!s1.manifestCid) return 'ARCHIVEREADTEST FAIL | import failed';
            // Re-commit with a media map entry (points at an existing local block — the
            // manifest just needs a pinnable CID) so the reader's URL swap is exercised.
            const man1 = await A.get({ cid: s1.manifestCid });
            const mediaCid = man1.notes[0];
            const c2 = await A.commit({ pubkey: pk, ids: man1.ids, notes: man1.notes, media: { [MEDIA_URL]: mediaCid }, prevManifestCid: s1.manifestCid });
            if (c2.error) return 'ARCHIVEREADTEST FAIL | media commit: ' + c2.error;
            try { localStorage.setItem(KEY, c2.cid); } catch {}
            const r1 = await DR.readAuthorArchive(pk, {});
            const readOk = r1.manifestCid===c2.cid && r1.count===2 && r1.notes.length===2 && r1.skipped===0;
            const sortOk = r1.notes[0]?.created_at===2000 && r1.notes[1]?.created_at===1000;
            const swapped = r1.notes[0]?.content || '';
            const mediaOk = swapped.includes(gw + mediaCid) && !swapped.includes(MEDIA_URL);
            const provOk = r1.notes.every((n) => !!n._nosdagCid);
            // Forged signature: stored fine (putNote trusts its caller), but the READER must skip it.
            const forged = JSON.parse(JSON.stringify(mk('forged', 1500))); forged.sig = 'ab'.repeat(64);
            const pf = await A.putNote({ event: forged });
            const c3 = await A.commit({ pubkey: pk, ids: [...man1.ids, forged.id], notes: [...man1.notes, pf.cid], media: {}, prevManifestCid: c2.cid });
            try { localStorage.setItem(KEY, c3.cid); } catch {}
            const r2 = await DR.readAuthorArchive(pk, {});
            const forgeOk = r2.notes.length===2 && r2.skipped===1;
            // Author binding: a manifest naming a different pubkey is refused whole.
            try { localStorage.setItem(OKEY, c3.cid); } catch {}
            const r3 = await DR.readAuthorArchive(otherPk, {});
            const bindOk = r3.notes.length===0 && !r3.manifestCid;
            try { localStorage.removeItem(KEY); localStorage.removeItem(OKEY); } catch {}
            const ok = readOk && sortOk && mediaOk && provOk && forgeOk && bindOk;
            return 'ARCHIVEREADTEST ' + (ok?'PASS':'FAIL') + ' | read='+readOk+' sort='+sortOk+' media='+mediaOk+' prov='+provOk+' forge='+forgeOk+'('+r2.notes.length+','+r2.skipped+') bind='+bindOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'onionrelaytest') {
          // Onion relays end-to-end: clearnet getters untouched → switch the live app into Tor
          // mode → relay getters swap to the onion selection (mirror semantics included) → a
          // REAL NIP-01 REQ reaches live onion relays through the session-wide Tor proxy →
          // switch back, getters revert. This is the scope's verification #1.
          const result = await win.webContents.executeJavaScript(`(async () => {
            const OR = await import('/js/nosdag/onion-relays.js');
            const Relays = await import('/js/relays.js');
            const isOnion = (u) => u.includes('.onion');
            // establish the clearnet baseline ourselves — a previous Tor-mode smoke may have
            // quit without switching back, leaving userData's mode file (and so this boot) on tor
            let m0 = await window.nosdag.mode.get();
            if (m0?.mode !== 'clearnet') {
              await window.nosdag.mode.set('clearnet');
              let s0 = null;
              for (let i=0;i<60;i++){ s0 = await window.nosdag.kubo.status(); if (s0?.ready && s0.mode==='clearnet') break; await new Promise(r=>setTimeout(r,1000)); }
              await OR.syncPosture();
            }
            // known list + defaults shaped right
            const listOk = OR.KNOWN_ONION_RELAYS.length === 25 && OR.DEFAULT_SELECTION.length === 5;
            // clearnet posture: no override anywhere
            const clearReadOk = !Relays.getReadRelays().some(isOnion) && !Relays.getWriteRelays().some(isOnion);
            // selection persists (drop one, re-read, restore defaults)
            const d0 = OR.selectedUrls();
            OR.setSelected(d0.slice(1));
            const persistOk = OR.selectedUrls().length === 4;
            OR.restoreDefaults();
            const restoreOk = OR.selectedUrls().length === 5;
            // → Tor mode (no migrate opts; logged out)
            const setRes = await window.nosdag.mode.set('tor');
            if (setRes?.error) return 'ONIONRELAYTEST FAIL | switch: ' + setRes.error;
            let s = null;
            for (let i=0;i<180;i++){ s = await window.nosdag.kubo.status(); if (s?.ready && s.mode==='tor') break; await new Promise(r=>setTimeout(r,1000)); }
            if (!(s?.ready && s.mode==='tor')) return 'ONIONRELAYTEST FAIL | tor node not ready';
            await OR.syncPosture();
            const postureOk = OR.getPosture() === 'tor';
            // getters swapped: reads = onions only; writes = onion writes + clearnet mirror (default ON)
            const reads = Relays.getReadRelays();
            const readsOk = reads.length === 5 && reads.every(isOnion);
            const wMirror = Relays.getWriteRelays();
            const mirrorOk = wMirror.filter(isOnion).length >= 3 && wMirror.some(u => !isOnion(u));
            OR.setMirror(false);
            const wStrict = Relays.getWriteRelays();
            const strictOk = wStrict.length > 0 && wStrict.every(isOnion) && OR.filterInbox(['wss://nos.lol','ws://abc.onion']).join()==='ws://abc.onion';
            OR.setMirror(true);
            // the real thing: NIP-01 REQ to the live defaults through the session Tor proxy
            const checks = await Promise.all(OR.selectedUrls().map(async (u) => ({ u, r: await OR.checkRelay(u) })));
            const up = checks.filter(c => c.r.ok);
            const liveOk = up.length >= 1;
            const liveDetail = checks.map(c => c.u.slice(5,13)+(c.r.ok?'✓'+c.r.openMs+'ms':'✗')).join(' ');
            // back to clearnet; getters revert
            const backRes = await window.nosdag.mode.set('clearnet');
            for (let i=0;i<60;i++){ s = await window.nosdag.kubo.status(); if (s?.ready && s.mode==='clearnet') break; await new Promise(r=>setTimeout(r,1000)); }
            await OR.syncPosture();
            const revertOk = !backRes?.error && OR.getPosture() === 'clearnet' && !Relays.getReadRelays().some(isOnion);
            const ok = listOk && clearReadOk && persistOk && restoreOk && postureOk && readsOk && mirrorOk && strictOk && liveOk && revertOk;
            return 'ONIONRELAYTEST ' + (ok?'PASS':'FAIL') + ' | list='+listOk+' clearnet='+clearReadOk+' persist='+(persistOk&&restoreOk)
              + ' posture='+postureOk+' reads='+readsOk+' mirror='+mirrorOk+' strict='+strictOk
              + ' live='+up.length+'/5('+liveDetail+') revert='+revertOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        } else if (view === 'backuptest') {
          // "Download my history" E2E over the real IPC bridge: publish a 3-note chain (one note
          // referencing real media), export the full history to a CAR, then inspect (whose backup?
          // complete? counts?) and restore — and prove the chain walks back signature-verified.
          // Dialogs are skipped via toPath/fromPath; a non-CAR file must be refused.
          fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true })
          const tmpCar = JSON.stringify(path.join(__dirname, '.tmp', 'backuptest.car'))
          const badFile = JSON.stringify(path.join(__dirname, 'package.json'))
          const result = await win.webContents.executeJavaScript(`(async () => {
            const NT = window.NostrTools; if (!NT) return 'no NostrTools';
            const M = await import('/js/nosdag/dag-publish.js');
            const HB = window.nosdag.history; const k = window.nosdag.kubo;
            if (!HB) return 'BACKUPTEST FAIL | no history bridge';
            const sk = NT.generateSecretKey(); const pk = NT.getPublicKey(sk);
            try { localStorage.removeItem('nosdag:head:'+pk); localStorage.removeItem('nosdag:posts:'+pk); } catch {}
            const sign = async (t) => NT.finalizeEvent({ created_at:1, content:'', ...t }, sk);
            const noStore = { publish: () => {} };
            // real media for note #2 to reference
            const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const bin=atob(b64); const by=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) by[i]=bin.charCodeAt(i);
            const am = await k.addMedia(by);
            let prev = null; const heads = [];
            for (let i=1;i<=3;i++) {
              const content = i===2 ? 'backup note #2 ipfs://'+am.cid+'#media.png' : 'backup note #'+i;
              const tags = prev ? [['client','nosdag'],['prev',prev]] : [['client','nosdag']];
              const ev = NT.finalizeEvent({ kind:1, created_at:i, tags, content }, sk);
              prev = await M.publishToDag({ signedEvent:ev, prevCid:prev, pubkey:pk, signEvent:sign, pool:noStore, writeRelays:[] });
              heads.push(prev);
            }
            // export the full chain
            const exp = await HB.export({ headCid: prev, toPath: ${tmpCar} });
            if (!exp || !exp.ok) return 'BACKUPTEST FAIL | export: ' + (exp && exp.error || 'no response');
            const expOk = exp.notes===3 && exp.media===1 && exp.blocks>=4;
            // a non-CAR file must be refused
            const bad = await HB.inspect({ fromPath: ${badFile} });
            const badOk = !!(bad && bad.error);
            // inspect: ownership + integrity + counts, before any import
            const ins = await HB.inspect({ fromPath: exp.path });
            if (ins.error) return 'BACKUPTEST FAIL | inspect: ' + ins.error;
            const insOk = ins.notes===3 && ins.media===1 && ins.pubkey===pk && !ins.missingPrev && NT.verifyEvent(ins.event) && ins.headCid===prev;
            // restore (idempotent into the same node) — the IPC the Settings button drives
            const res = await HB.restore();
            const resOk = !!(res && res.ok && res.headCid===prev);
            // the no-fork rule's engine: ancestor checks both ways
            const c1 = await HB.contains({ headCid: prev, targetCid: heads[0] });
            const c2 = await HB.contains({ headCid: heads[0], targetCid: prev });
            const containsOk = c1.contains===true && c2.contains===false;
            // the restored chain walks back fully verified
            const R = await import('/js/nosdag/dag-read.js');
            const notes = await R.walkNotes(prev, {});
            const walkOk = notes.length===3 && notes.every(n=>NT.verifyEvent(n));
            // the Settings section (the real index.html markup) mounts in-shell: unhides + renders both buttons
            const HBU = await import('/js/nosdag/history-backup.js');
            await HBU.mountBackupSection();
            const sec = document.getElementById('ndHistoryBackupSection');
            const uiOk = !!sec && sec.style.display==='' && !!sec.querySelector('#nd-hb-export') && !!sec.querySelector('#nd-hb-restore');
            const ok = expOk && badOk && insOk && resOk && containsOk && walkOk && uiOk;
            return 'BACKUPTEST ' + (ok?'PASS':'FAIL') + ' | export='+expOk+'('+exp.notes+'n/'+exp.media+'m/'+exp.blocks+'b) badRefused='+badOk+' inspect='+insOk+' restore='+resOk+' contains='+containsOk+' walk='+walkOk+' ui='+uiOk;
          })()`).catch((e) => 'EXEC ERR: ' + e.message)
          console.log('[smoke]', result)
          await new Promise((r) => setTimeout(r, 400))
        }
        // NOSDAG_SMOKE_THEME=light|dark flips the theme before capture (visual QA of both worlds);
        // NOSDAG_SMOKE_ACCENT="accent,hi,deep" trials an accent candidate on top.
        const smokeTheme = process.env.NOSDAG_SMOKE_THEME
        if (smokeTheme === 'light' || smokeTheme === 'dark') {
          await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', '${smokeTheme}')`)
          const acc = (process.env.NOSDAG_SMOKE_ACCENT || '').split(',')
          if (acc.length === 3 && acc.every((c) => /^#[0-9a-f]{6}$/i.test(c))) {
            await win.webContents.executeJavaScript(`{
              const s = document.documentElement.style
              s.setProperty('--nd-accent', '${acc[0]}')
              s.setProperty('--nd-accent-hi', '${acc[1]}')
              s.setProperty('--nd-accent-deep', '${acc[2]}')
              s.setProperty('--nd-accent-soft', 'color-mix(in srgb, ${acc[0]} 12%, transparent)')
            }`)
          }
          await new Promise((r) => setTimeout(r, 600))
        }
        const img = await win.webContents.capturePage()
        const out = path.join(__dirname, 'smoke-screenshot.png')
        fs.writeFileSync(out, img.toPNG())
        console.log('[smoke] screenshot →', out)
      } catch (e) { console.error('[smoke] capture failed:', e?.message || e) }
      console.log('[smoke] auto-quit')
      app.quit()
    }, view === 'node' ? 10000 : 16000)
  }
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// Graceful daemon shutdown before the app exits — stops whichever backend (Kubo or tor+Helia) is active.
app.on('before-quit', async (e) => {
  if (cleanShutdown || (!sidecar && !torProc)) return
  e.preventDefault()
  await stopNode()
  cleanShutdown = true
  app.quit()
})
