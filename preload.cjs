// preload — the contextBridge between the sandboxed renderer and main (build scope §1).
// CommonJS (.cjs) because sandboxed preloads must be CJS. Exposes a tiny, explicit surface;
// the renderer never touches Node, Kubo, or ipcRenderer directly.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Per-launch capability token for main's loopback listeners (ws-tor-bridge + monero-relay), delivered
// via webPreferences.additionalArguments so it's readable synchronously here — before any renderer
// script runs — and never exposed to another origin. (Security review 2026-07-03, H-A.)
const CAP_ARG = '--nosdag-cap='
const capToken = (process.argv || []).find((a) => a.startsWith(CAP_ARG))?.slice(CAP_ARG.length) || ''

// Boot posture for THIS window's initial load, handed down the same synchronous channel. The ws-tor-shim
// reads it as a fail-closed fallback when the persisted localStorage flag is absent (a fresh window: smoke
// or app re-open), so it never dials a relay in the clear during the pre-syncPosture gap. (Review M-A.)
const POSTURE_ARG = '--nosdag-posture='
const bootPosture = (process.argv || []).find((a) => a.startsWith(POSTURE_ARG))?.slice(POSTURE_ARG.length) || ''

contextBridge.exposeInMainWorld('nosdag', {
  shell: { version: '0.2.0' },
  app: {
    // deterministic reload from main (used by logout — renderer location.reload() over app:// was flaky)
    reload: () => ipcRenderer.invoke('app:reload'),
    // open an external link in the OS browser → { ok } | { blocked:'tor' } | { error }
    // ('tor' = refused, since the OS browser would bypass Tor and leak the IP)
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url)
  },
  mode: {
    // anonymous (Tor) mode is all-or-nothing: switching fully restarts the node backend.
    get: () => ipcRenderer.invoke('mode:get'),               // → { mode:'clearnet'|'tor', switching }
    // opts { headCid, pubkey } lets the switch migrate your history into the destination store
    // (shared blockstore); omit when not logged in / nothing published.
    set: (target, opts) => ipcRenderer.invoke('mode:set', target, opts), // 'tor'|'clearnet' → { ok, mode, migration } | { error, mode }
    // boot-time posture pick (mode-select page only — before the node starts); main then loads the app.
    // opts { torProxy: 'host:port' | null } selects an external Tor proxy for this and future sessions.
    choose: (target, opts) => ipcRenderer.invoke('mode:choose', target, opts), // 'tor'|'clearnet' → { ok, mode } | { error }
    // External Tor proxy setting (anonymous mode, outbound-only): 'host:port' sets, null clears →
    // bundled daemon. Applies the next time anonymous mode starts ({ needsSwitch } when live on Tor).
    torProxy: (v) => ipcRenderer.invoke('mode:torProxy', v),
    // H2 kill-switch: main fires this if the Tor daemon dies in anonymous mode (egress is already
    // blackholed in main); the renderer shows a blocking banner. Returns an unsubscribe fn.
    onDown: (cb) => { const h = () => { try { cb() } catch { /* listener best-effort */ } }; ipcRenderer.on('tor:down', h); return () => ipcRenderer.removeListener('tor:down', h) }
  },
  tor: {
    // Loopback WebSocket→Tor-SOCKS bridge port (lib/ws-tor-bridge.mjs). renderer/js/nosdag/ws-tor-shim.js
    // routes relay WebSockets here in anonymous mode, because Electron 42's renderer ignores setProxy
    // for WS (electron#34810). A constant (mirrors TOR_WS_BRIDGE_PORT in main.mjs) so the shim can read
    // it synchronously, before any relay connects.
    wsBridgePort: 9351,
    // Capability token the shim appends (?cap=…) so the bridge accepts the connection; without it a
    // hostile local page could open its own socket to the bridge and ride the user's Tor circuit.
    wsBridgeToken: capToken,
    // Synchronous boot posture ('tor'|'clearnet'|'') for the shim's fail-closed fallback (M-A).
    bootPosture: bootPosture
  },
  secrets: {
    // OS-keychain-backed at-rest encryption (main's safeStorage) for renderer secrets that
    // have no user-derived key to sit under (e.g. the Amber bunker URI). Base64 in/out.
    available: () => ipcRenderer.invoke('secrets:available'),                 // → { available }
    encrypt: (plaintext) => ipcRenderer.invoke('secrets:encrypt', plaintext), // string → { data } | { error }
    decrypt: (data) => ipcRenderer.invoke('secrets:decrypt', data)            // base64 → { plaintext } | { error }
  },
  monero: {
    // The wallet talks to main's loopback Monero RPC relay (lib/monero-relay.mjs): node selection,
    // reachability, CORS and Tor stream isolation all live in main. monero-ts connects to relayUrl().
    relayUrl: () => ipcRenderer.invoke('monero:relay-url'),                 // → 'http://127.0.0.1:<port>'
    status: () => ipcRenderer.invoke('monero:status'),                     // → { url, selected, mode, viaTorExit, userNode, candidates }
    setNode: (mode, url) => ipcRenderer.invoke('monero:set-node', mode, url), // ('clearnet'|'tor', url|null) → status
    repick: () => ipcRenderer.invoke('monero:repick')                      // re-health-check → status
  },
  kubo: {
    // mirrors the §1.5 kubo-manager surface, marshalled over IPC.
    status: () => ipcRenderer.invoke('kubo:status'),
    // local gateway base — the renderer rewrites ipfs://<CID> to this to display IPFS media
    // (matches the sidecar's gatewayPort default, 8201).
    gateway: 'http://127.0.0.1:8201/ipfs/',
    // Phase 2 DAG ops: renderer signs the event; main wraps it in the dag-cbor envelope + stores.
    putPost: (payload) => ipcRenderer.invoke('kubo:putPost', payload),       // { event, prevCid?, skipCids? } → { cid } | { error }
    getPost: (cid, opts) => ipcRenderer.invoke('kubo:getPost', cid, opts),   // (cidStr, {timeout?}) → { v, event, prev, skip } | { error } — timeout bounds the Bitswap search for a non-local block
    addMedia: (bytes) => ipcRenderer.invoke('kubo:addMedia', bytes),         // Uint8Array → { cid } | { error }
    // video attachment prep (strip GPS/device metadata; transcode HEVC → H.264) — run before addMedia
    prepareMedia: (p) => ipcRenderer.invoke('media:prepare', p),             // { bytes, name, type } → { bytes, ext?, converted?, stripped? } | { error }
    // Path-based twins — the no-size-limit route for picked files: the OS path crosses IPC
    // instead of the bytes, prep + add stream from disk in main. Pasted/blob files have no
    // path (pathForFile returns '') and stay on the buffered pair above.
    pathForFile: (file) => { try { return webUtils.getPathForFile(file) || '' } catch { return '' } },
    prepareMediaFile: (p) => ipcRenderer.invoke('media:prepareFile', p),     // { path, name, type } → { path, ext?, converted?, stripped? } | { error }
    addMediaFromPath: (p) => ipcRenderer.invoke('kubo:addMediaFromPath', p), // { path } → { cid } | { error } (path must come from prepareMediaFile)
    pinRecursive: (cid, timeoutMs) => ipcRenderer.invoke('kubo:pinRecursive', cid, timeoutMs), // (cidStr, timeoutMs?) → { ok } | { error:'timeout'|… }
    unpinRecursive: (cid) => ipcRenderer.invoke('kubo:unpinRecursive', cid), // cidStr → { ok } | { error }
    isPinned: (cid) => ipcRenderer.invoke('kubo:isPinned', cid),             // cidStr → { pinned: bool|null } | { error }
    dagSize: (cid) => ipcRenderer.invoke('kubo:dagSize', cid),               // cidStr → { bytes } | { error } (cumulative DAG size)
    providers: (cid, opts) => ipcRenderer.invoke('kubo:providers', cid, opts), // (cidStr, {timeoutMs,max}?) → { count } | { error } (DHT providers)
    // Phase 6 — dial a peer multiaddr. In Tor mode this dials an author's onion (resolved from
    // their nosdag:onion pointer) over Tor so Bitswap can pull from them; no DHT to find them.
    swarmConnect: (ma) => ipcRenderer.invoke('kubo:swarmConnect', ma)         // multiaddrStr → { ok } | { error }
  },
  archive: {
    // Timeline import — pre-Nosdag notes stored as standalone envelopes under one archive
    // manifest (a dag-cbor node whose note/media links make a single recursive pin cover all).
    putNote: (p) => ipcRenderer.invoke('archive:putNote', p), // { event } → { cid } | { error }
    commit: (p) => ipcRenderer.invoke('archive:commit', p),   // { pubkey, ids:[…], notes:[cid…], media:{url:cid}, prevManifestCid? } → { cid } | { error }
    get: (p) => ipcRenderer.invoke('archive:get', p),         // { cid } → { pubkey, count, ids, notes, media } | { error }
    checkMedia: (p) => ipcRenderer.invoke('archive:checkMedia', p) // { cids:[…] } → { blocks: { cid: { codec, size, oversized } } } | { error }
  },
  migrate: {
    // Mixed-posture repair: pull chain/media blocks THIS posture's store lacks from the other
    // posture's at-rest store (quit-relaunch flips never migrate — only in-app switches do).
    // Renderer fires it at boot/login; cheap no-op once the head is verified for this posture.
    catchUp: (p) => ipcRenderer.invoke('migrate:catchUp', p) // { pubkey, headCid, deep? } → { ok, upToDate? | notes, media, blocks } | { busy } | { error } — deep ignores the watermark/memo and verifies the whole chain
  },
  history: {
    // "Download my history" — full-history .car backup/restore (lib/history-backup.mjs in main).
    export: (p) => ipcRenderer.invoke('history:export', p),     // { headCid, suggestedName?, toPath? } → { ok, path, notes, media, blocks, bytes, skippedMedia } | { cancelled } | { error }
    inspect: (p) => ipcRenderer.invoke('history:inspect', p),   // { fromPath? } → { path, headCid, pubkey, event, notes, media, missingMedia, blocks, bytes, newestAt, missingPrev, priorAvailable } | { cancelled } | { error }
    restore: () => ipcRenderer.invoke('history:restore'),       // imports the last-inspected backup → { ok, headCid } | { error }
    contains: (p) => ipcRenderer.invoke('history:contains', p), // { headCid, targetCid } → { contains } | { error } (is target an ancestor of head?)
    status: () => ipcRenderer.invoke('history:status')          // → { state, op, blocks, total?, error? }
  },
  cloudBridge: {
    // Phase 3 — Cloud Bridge, per-account: every op resolves the pubkey's own bridge from the
    // userData map (no entry = unlinked). Two mechanisms behind one card: 'psa' (standard Pinning
    // Service API) and 'rpc' (Kubo-RPC endpoint, e.g. Filebase) — both driven from main.
    status: (p) => ipcRenderer.invoke('cloud:status', p),     // { pubkey } → { linked, kind, provider, endpoint, counts, reachable } | { linked:false, legacy?, needsAccount? } | { error }
    test: (cfg) => ipcRenderer.invoke('cloud:test', cfg),     // { kind, endpoint, key } → { ok, status, statusText } | { error }
    link: (cfg) => ipcRenderer.invoke('cloud:link', cfg),     // { pubkey, kind, endpoint, key } → { ok } | { error }
    unlink: (p) => ipcRenderer.invoke('cloud:unlink', p),     // { pubkey } → { ok } | { error }
    claimLegacy: (p) => ipcRenderer.invoke('cloud:claimLegacy', p), // { pubkey } → { ok, kind } | { error } (adopt the pre-per-account bridge)
    discardLegacy: () => ipcRenderer.invoke('cloud:discardLegacy'), // → { ok } | { error } (drop it without claiming)
    pinNote: (p) => ipcRenderer.invoke('cloud:pinNote', p),   // { pubkey, headCid, mediaCids?, prevHeadCid? } → { ok, kind, results } | { skipped } | { error }
    pinMany: (p) => ipcRenderer.invoke('cloud:pinMany', p),   // { pubkey, cids:[…] } → { ok, kind, results } | { skipped } | { error }
    pinStatus: (p) => ipcRenderer.invoke('cloud:pinStatus', p), // { pubkey, cids:[…] } → { kind, pinned:[…] } | { skipped } | { error }
    unpin: (p) => ipcRenderer.invoke('cloud:unpin', p)        // { pubkey, cid } → { ok } | { error }
  }
})
