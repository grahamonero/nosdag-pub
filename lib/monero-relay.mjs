// monero-relay — a loopback Monero RPC relay (security review C1).
//
// The wallet (monero-ts, in the renderer) connects to url() = http://127.0.0.1:<port>; this module
// transparently forwards each RPC to the selected upstream node. It exists because a renderer-direct
// connection can't satisfy C1:
//   • Most public Monero nodes are HTTP-only → mixed-content-blocked from the secure app:// renderer.
//     A loopback http://127.0.0.1 origin is mixed-content-EXEMPT, so the renderer can always reach it,
//     and we forward to http OR https upstreams freely from the main process.
//   • Public nodes don't send CORS headers for app://bundle → we add them here.
//   • In Tor mode we forward on our OWN isolated SOCKS circuit (distinct credentials), so the Monero
//     RPC never shares a Tor circuit with the npub's relay / /api traffic — closing the payment⇄identity
//     correlation that is C1.
//
// Node selection (health-check + lock onto fastest, user-overridable) lives entirely here; the renderer
// hardcodes no node. nosmero.com is deliberately NOT a default — decoupling from the operator is the point.

import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import { SocksProxyAgent } from 'socks-proxy-agent'

// Reputable public nodes, probed alive 2026-06-13. The picker health-checks these and locks onto the
// fastest; a user-set node overrides. Expand via a live probe on a real machine (clearnet + onion).
const CLEARNET_CANDIDATES = [
  'http://node.monerodevs.org:18089',
  'http://nodes.hashvault.pro:18081',
  'https://xmr-node.cakewallet.com:18081',
  'https://xmr.cryptostorm.is:18081'
]
// Onion nodes pending a live probe over Tor (mirror the onion-relays work). Until filled, Tor mode
// forwards the clearnet candidates through Tor with isolation — status.viaTorExit flags the residual
// (rides a Tor exit to a clearnet node; the same-circuit npub correlation is already closed).
const ONION_CANDIDATES = []

const PROBE_TIMEOUT = 6000
const FORWARD_TIMEOUT = 60000   // a slow node's first get_blocks.bin batch can take a while
const MAX_PROBE_BYTES = 1 << 20

// hop-by-hop headers must NOT be forwarded by a proxy (RFC 7230 §6.1). Passing Connection /
// Transfer-Encoding straight through can wedge a proxied request — notably the binary
// get_blocks.bin calls the wallet sync depends on.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']

// Only the app:// renderer legitimately calls the relay; anything else (a browser tab, another local
// process) is hostile. The capToken in the URL path is the real gate; the Origin allowlist + scoped CORS
// are defense-in-depth for the browser case. (Security review 2026-07-03, H-A.)
const APP_ORIGIN = 'app://bundle'

export function createMoneroRelay ({ getMode, getTorSocksPort, getTorSocksHost = () => '127.0.0.1', capToken = '', log = () => {} }) {
  let server = null
  let port = 0
  let selected = null      // upstream node URL string, or null if none reachable
  let viaTorExit = false
  let torAgent = null
  const userNode = { clearnet: null, tor: null }
  // keep upstream connections warm — sync fires many sequential get_blocks.bin calls back-to-back
  const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 8 })
  const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 8 })
  // a stable per-session SOCKS credential → tor's IsolateSOCKSAuth gives the Monero channel its own circuit
  const torAuth = `nosdag-monero:${randomBytes(8).toString('hex')}`

  const isTor = () => getMode() === 'tor'
  function agent (protocol) {
    if (isTor()) {
      if (!torAgent) torAgent = new SocksProxyAgent(`socks5h://${torAuth}@${getTorSocksHost()}:${getTorSocksPort()}`)
      return torAgent
    }
    return protocol === 'https:' ? keepAliveHttps : keepAliveHttp
  }
  function candidates () {
    const u = userNode[isTor() ? 'tor' : 'clearnet']
    if (u) return [u]
    if (isTor()) return ONION_CANDIDATES.length ? ONION_CANDIDATES : CLEARNET_CANDIDATES
    return CLEARNET_CANDIDATES
  }

  // probe one node's /get_info; resolve to latency ms (alive) or null (down/unreachable)
  function probe (nodeUrl) {
    return new Promise((resolve) => {
      let u
      try { u = new URL('/get_info', nodeUrl) } catch { return resolve(null) }
      const mod = u.protocol === 'https:' ? https : http
      const t0 = Date.now()
      const req = mod.request(u, { method: 'GET', agent: agent(u.protocol), timeout: PROBE_TIMEOUT }, (res) => {
        let n = 0
        res.on('data', (c) => { n += c.length; if (n > MAX_PROBE_BYTES) req.destroy() })
        res.on('end', () => resolve(res.statusCode === 200 ? Date.now() - t0 : null))
        res.on('error', () => resolve(null))
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.end()
    })
  }

  async function pick () {
    const cands = candidates()
    const haveOnion = isTor() && ONION_CANDIDATES.length > 0
    const scored = await Promise.all(cands.map(async (url) => ({ url, ms: await probe(url) })))
    const alive = scored.filter((r) => r.ms != null).sort((a, b) => a.ms - b.ms)
    if (alive.length) {
      selected = alive[0].url
      viaTorExit = isTor() && !haveOnion && !userNode.tor
      log(`node → ${selected} (${alive[0].ms}ms)${viaTorExit ? ' [via Tor exit — onion defaults pending]' : ''}`)
    } else {
      selected = null
      log(`no node reachable among ${cands.length} candidate(s)`)
    }
    return selected
  }

  function fail (res, code, msg) {
    if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain', 'access-control-allow-origin': APP_ORIGIN })
    try { res.end(msg) } catch { /* socket gone */ }
  }

  const nodeHost = (u) => { try { return new URL(u).host } catch { return u } }

  // monero-ts's JS-side daemon client is handed url() = http://127.0.0.1:<port>/<capToken> and
  // string-concats the RPC path onto it (…/<capToken>/json_rpc). Verify + strip that prefix; a request
  // without the exact token resolves to null — the caller then falls back to the header transport
  // (onRequest) used by the WASM wallet, and anything with neither (any other local process, any
  // browser page that guessed the port) is 403'd.
  // Also collapses the "absolute-form req.url forwards to an arbitrary host" hole: an absolute URL can't
  // start with /<capToken>/. Returns the origin-form path to forward, or null to reject.
  function stripCap (rawUrl) {
    const prefix = '/' + capToken
    if (rawUrl === prefix) return '/'
    if (capToken && (rawUrl.startsWith(prefix + '/') || rawUrl.startsWith(prefix + '?'))) return rawUrl.slice(prefix.length) || '/'
    return null
  }

  // buffer the (small) RPC request body so it can be replayed across failover attempts
  function collectBody (req) {
    return new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', () => resolve(Buffer.concat(chunks)))
    })
  }

  // one upstream attempt: resolves with the response stream on a usable (<500) reply, else null
  function attempt (node, method, path, headers, body) {
    return new Promise((resolve) => {
      let up
      try { up = new URL(path, node) } catch { return resolve(null) }
      // path is origin-form (stripCap guarantees a leading '/'), so `up` can only ever be the selected
      // node — but assert it, so no future change can turn this into an open forward proxy.
      if (up.host !== nodeHost(node)) return resolve(null)
      const mod = up.protocol === 'https:' ? https : http
      const upReq = mod.request(up, { method, headers, agent: agent(up.protocol), timeout: FORWARD_TIMEOUT }, (upRes) => {
        if ((upRes.statusCode || 0) >= 500) { upRes.resume(); resolve(null) }   // server error → fail over
        else resolve(upRes)
      })
      upReq.on('error', () => resolve(null))
      upReq.on('timeout', () => { upReq.destroy(); resolve(null) })
      if (body && body.length) upReq.end(body); else upReq.end()
    })
  }

  // Forward with transparent failover: try the locked node first, then the other candidates. A node
  // that drops, times out, or 5xx's must NOT break sync — we move on and keep `selected` on one that
  // answers, so the wallet always sees a working daemon (including on its post-error reconnect, which
  // is exactly where going nodeless used to surface as "Failed to connect to daemon").
  async function forward (req, res) {
    const path = req._relPath   // capToken already verified + stripped in onRequest
    const tag = `${req.method} ${path.split('?')[0]}`
    const headers = { ...req.headers }
    for (const h of HOP_BY_HOP) delete headers[h]
    delete headers.origin; delete headers.referer; delete headers.host   // server-to-server now, not a browser request
    delete headers['x-nosdag-cap']   // the capability token never leaves the machine
    headers['accept-encoding'] = 'identity'   // never gzip binary block data — rules out a decode mismatch the WASM can't recover from
    const body = await collectBody(req)
    const order = [selected, ...candidates().filter((c) => c && c !== selected)].filter(Boolean)
    for (const node of order) {
      const t0 = Date.now()
      const upRes = await attempt(node, req.method, path, headers, body)
      if (upRes) {
        if (node !== selected) { selected = node; log(`failover → ${node}`) }
        const h = { ...upRes.headers }
        for (const x of HOP_BY_HOP) delete h[x]
        delete h['access-control-allow-origin']; delete h['access-control-allow-credentials']
        h['access-control-allow-origin'] = APP_ORIGIN   // only the app:// renderer may read the response
        res.writeHead(upRes.statusCode || 502, h)
        upRes.on('error', () => res.destroy())   // mid-stream drop → error the client cleanly (no truncated block batch)
        upRes.pipe(res)
        return
      }
      log(`${tag} ✗ ${nodeHost(node)} (${Date.now() - t0}ms)`)
    }
    fail(res, 502, 'no monero node served the request')
  }

  function onRequest (req, res) {
    // Reject any browser page that isn't the app, and any request missing the capability token. Do this
    // BEFORE emitting CORS headers so a hostile origin never even learns the relay is here.
    const origin = req.headers.origin
    if (origin && origin !== APP_ORIGIN) return fail(res, 403, 'forbidden')
    // JSON-POST preflight. Answered BEFORE the token gate: Chromium generates preflights internally
    // and on some Electron versions they bypass the webRequest header stamp, so they can arrive
    // token-less. Harmless — an OPTIONS forwards nothing; the actual request still needs the token.
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-origin', APP_ORIGIN)
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.writeHead(204); res.end(); return
    }
    let relPath = stripCap(req.url)
    // Second token transport: the WASM wallet (wallet2/epee) issues origin-form paths and drops the
    // path-borne token, so main's webRequest hook stamps the token as a header onto relay-bound
    // requests from the app's own session. Origin-form paths only — never absolute-form.
    if (relPath == null && capToken && req.headers['x-nosdag-cap'] === capToken && req.url.startsWith('/')) {
      relPath = req.url
    }
    if (relPath == null) return fail(res, 403, 'forbidden')
    req._relPath = relPath
    res.setHeader('access-control-allow-origin', APP_ORIGIN)
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    forward(req, res).catch((e) => fail(res, 502, 'relay: ' + e.message))
  }

  // The capToken rides in the path for monero-ts's JS-side calls (string-concats /json_rpc etc. onto
  // this base). The WASM wallet drops the path — its requests authenticate via the x-nosdag-cap header
  // stamped by main's webRequest hook instead. (Security review 2026-07-03, H-A; regression fix 2026-07-25.)
  function url () { return port ? `http://127.0.0.1:${port}/${capToken}` : null }

  return {
    start () {
      if (server) return Promise.resolve(url())
      return new Promise((resolve, reject) => {
        server = http.createServer(onRequest)
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port
          log(`listening on 127.0.0.1:${port}`)
          pick().catch(() => {})   // kick off the first health-check (non-blocking)
          resolve(url())
        })
      })
    },
    url,
    status: () => ({ url: url(), selected, mode: getMode(), viaTorExit, userNode: { ...userNode }, candidates: candidates() }),
    setUserNode: (m, u) => { userNode[m === 'tor' ? 'tor' : 'clearnet'] = (u && String(u).trim()) || null; return pick() },
    repick: () => { selected = null; return pick() },
    onModeChange: () => { selected = null; torAgent = null; return pick() },
    stop () { try { server?.close() } catch { /* not started */ } server = null; port = 0 }
  }
}
