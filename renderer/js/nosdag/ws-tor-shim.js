// ws-tor-shim — route the renderer's relay WebSockets through main's loopback Tor bridge in anonymous
// mode. Electron 42's Chromium renderer ignores session.setProxy for WebSocket connections (plain HTTP
// still tunnels) — electron/electron#34810, "not planned" — so without this every relay (nostr-tools
// pool, onion-relay checks, livestream) goes dark in Tor mode.
//
// We patch the global WebSocket so that, IN TOR POSTURE ONLY, a remote ws://|wss:// relay URL becomes
// ws://127.0.0.1:<bridge>/?t=<url>; lib/ws-tor-bridge.mjs forwards it over the working Node SOCKS path.
// Loopback targets (the bridge itself, the local gateway) and clearnet posture pass through untouched —
// a strict no-op outside Tor. Loaded as a CLASSIC script BEFORE nostr-tools so the pool, and anything
// else that calls `new WebSocket(...)`, picks up the patched constructor.
(function () {
  'use strict'
  var Native = window.WebSocket
  var BRIDGE_PORT = window.nosdag && window.nosdag.tor && window.nosdag.tor.wsBridgePort
  var BRIDGE_TOKEN = (window.nosdag && window.nosdag.tor && window.nosdag.tor.wsBridgeToken) || ''
  var BOOT_POSTURE = (window.nosdag && window.nosdag.tor && window.nosdag.tor.bootPosture) || ''
  if (!Native || !BRIDGE_PORT || window.__nosdagWsShimmed) return
  window.__nosdagWsShimmed = true

  function posture () {
    // 1) The live flag — main writes it in lockstep with the session proxy (applyTorProxy/clearProxy)
    //    and onion-relays.js pushes it on every in-app switch; persisted, so it's authoritative when set.
    try {
      var p = localStorage.getItem('nosdag:posture')
      if (p === 'tor' || p === 'clearnet') return p
    } catch (e) { /* private mode — fall through */ }
    // 2) This window's boot posture, handed synchronously via preload (fresh window: smoke / re-open).
    if (BOOT_POSTURE === 'tor' || BOOT_POSTURE === 'clearnet') return BOOT_POSTURE
    // 3) Genuinely unknown → FAIL CLOSED (default-to-Tor): never dial a remote relay in the clear when
    //    we can't prove we're on clearnet. If we're actually clearnet, the bridge upstream (a stopped
    //    Tor) just fails and the socket retries once syncPosture settles the flag — a hiccup, not a leak.
    return 'tor'
  }
  function isLoopback (u) {
    return /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(u)
  }
  function bridged (u) {
    return 'ws://127.0.0.1:' + BRIDGE_PORT + '/?t=' + encodeURIComponent(u) + '&cap=' + encodeURIComponent(BRIDGE_TOKEN)
  }

  function Bridged (url, protocols) {
    var target = url
    try {
      if (typeof url === 'string' && /^wss?:\/\//i.test(url) && !isLoopback(url) && posture() === 'tor') {
        target = bridged(url)
      }
    } catch (e) { /* leave target as the raw url */ }
    return protocols === undefined ? new Native(target) : new Native(target, protocols)
  }
  Bridged.prototype = Native.prototype
  Bridged.CONNECTING = Native.CONNECTING
  Bridged.OPEN = Native.OPEN
  Bridged.CLOSING = Native.CLOSING
  Bridged.CLOSED = Native.CLOSED
  try { window.WebSocket = Bridged } catch (e) { /* global frozen — nothing we can do */ }

  // Mirror the posture onto the root element for CSS-driven posture-aware UI (the composers'
  // anonymous-mode media advisory). Cosmetic only — sockets use posture() above, which fails
  // closed; here we stamp only a KNOWN posture, never the fail-closed default, so a clearnet
  // boot with a not-yet-seeded flag doesn't flash a false Tor warning. Main re-stamps on every
  // posture change (seedRendererPosture).
  try {
    var vis = null
    try { vis = localStorage.getItem('nosdag:posture') } catch (e) { /* private mode */ }
    if (vis !== 'tor' && vis !== 'clearnet') vis = (BOOT_POSTURE === 'tor' || BOOT_POSTURE === 'clearnet') ? BOOT_POSTURE : null
    if (vis) document.documentElement.setAttribute('data-nd-posture', vis)
  } catch (e) { /* cosmetic */ }
})()
