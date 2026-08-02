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
import { startMediaGateway } from './lib/media-gateway.mjs'
import { sniffVideo, needsTranscode, stripIsoBmffMetadata, resolveFfmpeg, ffmpegStrip, sniffVideoFile, stripIsoBmffMetadataFile, ffmpegStripFile, transcodeTimeoutMs } from './lib/media-transcode.mjs'
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
// Paths issued by media:prepareFile, consumable by kubo:addMediaFromPath (which refuses
// anything else). temp:true entries are main-owned temp files, removed after the add or at exit.
const preparedMedia = new Map() // absolute path → { temp: boolean }
// Dev harness only: holds smoke-views.mjs once loaded (absent from public/packaged builds —
// NOSDAG_SMOKE behaviors all key off this, never off the env var directly).
let smokeDriver = null
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
  for (const [p, e] of preparedMedia) { if (e.temp) { try { fs.rmSync(p, { force: true }) } catch { /* exiting anyway */ } } }
  preparedMedia.clear()
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
  // Path-based twins of media:prepare + kubo:addMedia — the no-size-limit route. The renderer
  // hands over the picked file's OS path (webUtils.getPathForFile) instead of its bytes, so
  // the file never crosses IPC and never lands in memory whole: sniff/strip walk the file by
  // fd (only the small moov index is buffered), ffmpeg runs file→file, and the add streams
  // from disk into the node. addMediaFromPath only accepts paths this handler issued —
  // everything publishable is funneled through the video gate here, and temp cleanup stays
  // main's job. The buffered pair above remains for images and pathless (pasted/blob) files.
  ipcMain.handle('media:prepareFile', async (_e, { path: srcPath, name = '', type = '' } = {}) => {
    try {
      if (typeof srcPath !== 'string' || !srcPath) return { error: 'no file path' }
      const st = await fs.promises.stat(srcPath).catch(() => null)
      if (!st?.isFile() || !st.size) return { error: 'file missing or empty' }
      const register = (p, temp) => { preparedMedia.set(p, { temp }); return p }
      const looksVideo = /^video\//i.test(type) || /\.(mov|mp4|m4v|webm|ogg|3gp)$/i.test(name || srcPath)
      if (!looksVideo) return { path: register(srcPath, false) }
      const sniff = await sniffVideoFile(srcPath)
      const stamp = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      const outFor = (ext) => path.join(app.getPath('temp'), `nosdag-media-out-${stamp}.${ext}`)
      if (sniff.container === 'iso-bmff') {
        if (needsTranscode(sniff.videoCodecs)) {
          const ffmpegBin = resolveFfmpeg()
          if (!ffmpegBin) {
            const codecs = [...sniff.videoCodecs].join('/') || 'an unknown codec'
            return { error: `This video uses ${codecs}, which most viewers can't play. Install ffmpeg (e.g. sudo apt install ffmpeg) so Nosdag can convert it to H.264, or attach an H.264 export instead.` }
          }
          const outPath = outFor('mp4')
          try {
            await ffmpegStripFile({ ffmpegBin, inPath: srcPath, outPath, reencode: true, timeoutMs: transcodeTimeoutMs(st.size) })
          } catch (err) { fs.promises.rm(outPath, { force: true }).catch(() => {}); throw err }
          return { path: register(outPath, true), ext: 'mp4', converted: true, stripped: true }
        }
        const outPath = outFor('mp4')
        try { await stripIsoBmffMetadataFile(srcPath, outPath) } catch (err) { fs.promises.rm(outPath, { force: true }).catch(() => {}); throw err }
        return { path: register(outPath, true), stripped: true }
      }
      if (sniff.container === 'webm' || sniff.container === 'ogg') {
        const ffmpegBin = resolveFfmpeg()
        if (ffmpegBin) {
          const outPath = outFor(sniff.container)
          try {
            await ffmpegStripFile({ ffmpegBin, inPath: srcPath, outPath, reencode: false, format: sniff.container, timeoutMs: transcodeTimeoutMs(st.size) })
          } catch (err) { fs.promises.rm(outPath, { force: true }).catch(() => {}); throw err }
          return { path: register(outPath, true), stripped: true }
        }
        console.warn('[media] no ffmpeg — %s attachment published with its container metadata', sniff.container)
      }
      return { path: register(srcPath, false) }
    } catch (e) { return { error: String(e?.message || e) } }
  })
  ipcMain.handle('kubo:addMediaFromPath', async (_e, { path: mediaPath } = {}) => {
    if (!kubo) return { error: 'node not ready' }
    const entry = preparedMedia.get(mediaPath)
    if (!entry) return { error: 'unprepared media path — run media:prepareFile first' }
    try {
      const cid = await kubo.addFromPath(mediaPath)
      return { cid: cid.toString() }
    } catch (e) {
      return { error: String(e?.message || e) }
    } finally {
      preparedMedia.delete(mediaPath)
      if (entry.temp) fs.promises.rm(mediaPath, { force: true }).catch(() => {})
    }
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
    let carPath = smokeDriver ? toPath : null
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
    let carPath = smokeDriver ? fromPath : null
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
// The Tor-mode local media gateway lives in lib/media-gateway.mjs — it streams from the
// Helia node with Range support, so media of any size serves in bounded memory.

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
  torGateway = startMediaGateway(kubo, TOR_GATEWAY_PORT)
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
  torGateway = startMediaGateway(kubo, TOR_GATEWAY_PORT)
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
          ? { kind: 'no-tor', message: 'Anonymous mode needs Tor, which couldn’t be found. Install it (macOS: brew install tor · Debian/Ubuntu: sudo apt install tor) and retry — or point TOR_BIN at a tor binary. Clearnet mode works without it.' }
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
  if (smokeDriver || process.env.NOSDAG_DEBUG) {
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
  // Dev harness: the headless smoke driver lives in smoke-views.mjs, which ships in neither
  // the public repo nor packaged builds (smoke-*.mjs is excluded from both) — every
  // NOSDAG_SMOKE behavior keys off the loaded driver, so the env var is inert without it.
  if (process.env.NOSDAG_SMOKE) {
    smokeDriver = await import('./smoke-views.mjs').then((m) => m, () => null)
    if (!smokeDriver) console.log('[smoke] this build carries no smoke driver — NOSDAG_SMOKE ignored')
  }
  if (smokeDriver) {
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
  // Headless CI smoke: the driver boots a view in the live renderer, asserts, screenshots, quits.
  if (smokeDriver) smokeDriver.runSmokeViews({ win, app })
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
