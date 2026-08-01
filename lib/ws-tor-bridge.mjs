// ws-tor-bridge — a loopback WebSocket → Tor-SOCKS bridge.
//
// Electron 42's renderer Chromium stopped routing WebSocket connections through the SOCKS proxy set by
// session.setProxy — plain HTTP still tunnels, but WebSockets don't (electron/electron#34810, closed
// "not planned"). So in anonymous (Tor) mode every relay WebSocket — the nostr-tools pool, the
// onion-relay live checks, livestream — would time out, taking publish AND read down with it.
//
// This restores them the same way lib/monero-relay.mjs restores wallet RPC (security review C1): the
// renderer opens ws://127.0.0.1:<port>/?t=<realRelayUrl> (loopback is proxy-bypassed, so Chromium
// reaches it directly), and main pipes that socket to the real relay over the Node SocksProxyAgent —
// the SAME working Tor SOCKS path the Helia node + backendFetch already use. Each upstream rides its
// own circuit via a stable SOCKS credential (tor IsolateSOCKSAuth), so relay traffic never shares a
// circuit with wallet / IPFS / /api.
//
// Fail-closed: there is NO clearnet fallback — every upstream dials through the SocksProxyAgent, so if
// the tor daemon dies the upstreams just fail and relays stay dark (the renderer→bridge loopback hop
// carries nothing on its own).
//
// Deliberately ELECTRON-FREE — takes a port + getTorSocksPort so it's unit-smokable (pass agentFactory
// to bypass Tor). See smoke-ws-bridge.mjs.

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { SocksProxyAgent } from 'socks-proxy-agent'

const UPSTREAM_HANDSHAKE_TIMEOUT = 30000   // cold onion circuits can take ~10–30s to open
const MAX_PAYLOAD = 8 << 20                // relay events (incl. media metadata) are small; 8 MiB is ample
// Only the app:// renderer's ws-tor-shim legitimately dials this bridge. A browser page (any origin) or
// another local process must NOT — else it rides the user's Tor circuit as an open proxy and can prove
// Nosdag is in anonymous mode (a deanon oracle). The capToken (unguessable, renderer-only) is the gate;
// the Origin allowlist is defense-in-depth for the browser case. (Security review 2026-07-03, H-A.)
const APP_ORIGIN = 'app://bundle'

export function createWsTorBridge ({ port, getTorSocksPort, getTorSocksHost = () => '127.0.0.1', capToken = '', log = () => {}, agentFactory = null }) {
  let server = null
  let wss = null
  let socksAgent = null
  let boundPort = 0
  // stable per-session SOCKS credential → tor's IsolateSOCKSAuth keeps relay traffic on its own circuit,
  // off the wallet / IPFS / /api channels (mirrors monero-relay's torAuth).
  const torAuth = `nosdag-relays:${randomBytes(8).toString('hex')}`

  function agent () {
    if (agentFactory) return agentFactory()
    if (!socksAgent) socksAgent = new SocksProxyAgent(`socks5h://${torAuth}@${getTorSocksHost()}:${getTorSocksPort()}`)
    return socksAgent
  }
  const hostOf = (u) => { try { return new URL(u).host } catch { return u } }

  function onConnection (client, req) {
    // Reject anything that isn't the app renderer holding the per-launch token. A browser page sends its
    // own Origin (not app://bundle); no outside process can guess the token. Either failure → close, so
    // the bridge can't be used as an open Tor proxy or a Tor-mode presence oracle.
    const origin = req.headers.origin
    if (origin && origin !== APP_ORIGIN) { try { client.close(1008, 'forbidden') } catch { /* gone */ } return }
    let params = null
    try { params = new URL(req.url, 'http://127.0.0.1').searchParams } catch { /* malformed */ }
    if (!params || params.get('cap') !== capToken) {
      try { client.close(1008, 'forbidden') } catch { /* socket gone */ }
      return
    }
    const target = params.get('t')
    if (!target || !/^wss?:\/\//i.test(target)) {
      try { client.close(1008, 'bad target') } catch { /* socket gone */ }
      return
    }
    const host = hostOf(target)
    let up
    try {
      up = new WebSocket(target, { agent: agent(), handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT, followRedirects: false })
    } catch (e) {
      log(`✗ ${host}: ${e?.message || e}`)
      try { client.close(1011, 'upstream init failed') } catch { /* gone */ }
      return
    }

    let upOpen = false
    const queued = []   // client frames that land before the upstream finishes its (slow, over-Tor) handshake
    up.on('open', () => {
      upOpen = true
      for (const [d, bin] of queued.splice(0)) { try { up.send(d, { binary: bin }) } catch { /* closing */ } }
    })
    up.on('message', (d, isBinary) => { try { client.send(d, { binary: isBinary }) } catch { /* client gone */ } })
    up.on('close', () => { try { client.close(1000) } catch { /* gone */ } })
    up.on('error', (e) => { log(`✗ ${host}: ${e?.message || e}`); try { client.close(1011, 'upstream error') } catch { /* gone */ } })

    client.on('message', (d, isBinary) => {
      if (upOpen) { try { up.send(d, { binary: isBinary }) } catch { /* closing */ } }
      else queued.push([d, isBinary])
    })
    client.on('close', () => { try { up.close() } catch { /* gone */ } })
    client.on('error', () => { try { up.terminate() } catch { /* gone */ } })
  }

  return {
    start () {
      if (server) return Promise.resolve(boundPort)
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('websocket only') })
        wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD })
        wss.on('connection', onConnection)
        server.on('error', reject)
        server.listen(port, '127.0.0.1', () => {
          boundPort = server.address().port
          log(`relay bridge on 127.0.0.1:${boundPort}`)
          resolve(boundPort)
        })
      })
    },
    // a posture switch may have rotated Tor's circuits — drop the cached agent so the next upstream
    // dials fresh (mirrors moneroRelay.onModeChange()).
    onModeChange () { socksAgent = null },
    port: () => boundPort,
    stop () {
      try { wss?.close() } catch { /* not started */ }
      try { server?.close() } catch { /* not started */ }
      server = null; wss = null; socksAgent = null; boundPort = 0
    }
  }
}
