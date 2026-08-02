// kubo-manager — the §1.5 interface. THE ONE PLACE that talks to Kubo.
//
// Every Kubo access in Nosdag goes through this surface. Swap the body per
// deployment target; call sites (dag-writer / dag-reader / head-pointer /
// mirror-fetch) never change:
//   • Harness (here):  dials an EXTERNAL daemon's RPC directly (this file).
//   • Electron main:   spawns+supervises the bundled daemon, same methods,
//                      reached by the renderer over IPC.
//   • Web (if ever):   dials the user's own local node — CORS/PNA territory.
//
// So this file is the literal embryo of the Electron main-process module.

import fs from 'node:fs'
import http from 'node:http'
import { create } from 'kubo-rpc-client'

/**
 * Connect to a running Kubo daemon's RPC and return the Nosdag storage surface.
 * @param {number} apiPort  the daemon's Addresses.API TCP port (e.g. 5001)
 */
export function connectKubo (apiPort) {
  const client = create({ url: `http://127.0.0.1:${apiPort}` })

  return {
    /** raw client — for the rare call the interface doesn't wrap yet */
    raw: client,

    /** node identity: { id, addresses } */
    id: () => client.id(),

    /** open a libp2p connection to a multiaddr (Phase 1: local swarm) */
    swarmConnect: (multiaddr) => client.swarm.connect(multiaddr),

    /** list peers we're connected to */
    swarmPeers: () => client.swarm.peers(),

    /**
     * Store a dag-cbor envelope. CID instances inside `obj` (envelope.links)
     * are encoded as REAL IPLD links — what recursive pin/refs traverse.
     * Returns the envelope's CID (= the "post CID" that other posts' prev point at).
     */
    putEnvelope: (obj) =>
      client.dag.put(obj, { storeCodec: 'dag-cbor', hashAlg: 'sha2-256', pin: false }),

    /**
     * Fetch + decode a dag-cbor envelope by CID. If the block is not local,
     * Kubo pulls it over Bitswap from a connected peer — THIS is the live
     * cross-node replication the harness proves (risk #1).
     * links.prev / links.skip come back as CID instances.
     */
    getEnvelope: async (cid, opts = {}) => (await client.dag.get(cid, opts)).value,

    /** raw block bytes by CID (any codec) — the migration export path. opts may carry a
     *  `timeout` (ms) so a block this store never had fails fast instead of Bitswap-searching. */
    getBlock: (cid, opts = {}) => client.block.get(cid, opts),

    /**
     * Add raw media bytes (image/video) to the local node as a UnixFS block and pin it.
     * Returns the CIDv1. Media is referenced from a note by its `ipfs://<CID>` (design §13.1
     * imeta tag), NOT via the envelope's IPLD links — so it is pinned per-item here rather than
     * covered by the head's recursive pin. (Quota-aware pin management arrives in Phase 3.)
     */
    addBytes: async (bytes) => {
      const res = await client.add(bytes, { pin: true, cidVersion: 1 })
      return res.cid
    },

    /** addBytes from a file on disk, streamed. Hand-rolled chunked multipart straight to the
     *  RPC API — client.add() BUFFERS stream inputs whole (measured: a 3 GB add peaked >3 GB
     *  RSS), which would cap media size at RAM. Same add options as addBytes (pin,
     *  cid-version=1; Kubo chunks server-side) → identical CID for identical content;
     *  the smoke asserts the parity. Returns the CID as a string. */
    addFromPath: (filePath) => new Promise((resolve, reject) => {
      const boundary = '----nosdag-' + Math.random().toString(36).slice(2)
      const req = http.request({
        host: '127.0.0.1',
        port: apiPort,
        method: 'POST',
        path: '/api/v0/add?pin=true&cid-version=1',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
      }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) return reject(new Error(`add failed: HTTP ${res.statusCode} ${body.slice(0, 200)}`))
            const lines = body.trim().split('\n')
            resolve(String(JSON.parse(lines[lines.length - 1]).Hash))
          } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.write(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="media"\r\ncontent-type: application/octet-stream\r\n\r\n`)
      const src = fs.createReadStream(filePath)
      src.on('error', (e) => { req.destroy(); reject(e) })
      src.on('end', () => { req.end(`\r\n--${boundary}--\r\n`) })
      src.pipe(req, { end: false })
    }),

    /** ipfs pin add --recursive <cid> : one pin covers the whole reachable DAG (§5.2). opts may carry
     *  a `timeout` (ms) so altruistic-pin doesn't hang forever fetching unreachable content. */
    pinRecursive: (cid, opts = {}) => client.pin.add(cid, { recursive: true, ...opts }),

    /** ipfs refs -r <cid> : every block reachable by IPLD-link walk (children, deduped) */
    refsRecursive: async (cid, opts = {}) => {
      const refs = []
      for await (const r of client.refs(cid, { recursive: true, ...opts })) {
        if (r.err) throw new Error(`refs error: ${r.err}`)
        refs.push(r.ref)
      }
      return refs
    },

    /** repo.stat → { repoSize, numObjects, storageMax, … } (values are BigInt) */
    repoStat: () => client.repo.stat(),

    /** cumulative byte size of the DAG under a CID — for altruistic-pin quota accounting (§5.1).
     *  files.stat on an /ipfs/<cid> path returns CumulativeSize without touching MFS. */
    dagSize: async (cidStr) => {
      const st = await client.files.stat(`/ipfs/${cidStr}`)
      return Number(st.cumulativeSize ?? st.size ?? 0)
    },

    /** Count distinct nodes the DHT says provide a CID — the trustless "held by N nodes" durability
     *  signal (§7). Bounded by time + max so it never hangs. cid = CID instance. */
    providerCount: async (cid, { timeoutMs = 8000, max = 40 } = {}) => {
      const ids = new Set()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        for await (const ev of client.routing.findProvs(cid, { numProviders: max, signal: ctrl.signal })) {
          // Only PROVIDER events are actual providers; PEER_RESPONSE also fills `providers` with the
          // DHT-walk peers it visited (kubo-rpc-client quirk), which are NOT providers — ignore those.
          if (ev?.name === 'PROVIDER' && ev.providers) for (const p of ev.providers) { const id = p?.id?.toString?.(); if (id) ids.add(id) }
          if (ids.size >= max) break
        }
      } catch { /* aborted/timeout — return what we found */ } finally { clearTimeout(timer) }
      return ids.size
    },

    /** count recursive pin roots (capped so a huge pinset can't stall the status poll) */
    pinnedCount: async (cap = 100000) => {
      let n = 0
      for await (const _ of client.pin.ls({ type: 'recursive' })) { if (++n >= cap) break }
      return n
    },

    /** ipfs pin rm -r <cid> — drop the recursive pin on a now-superseded head (content stays pinned via the new head) */
    unpinRecursive: (cid) => client.pin.rm(cid, { recursive: true }),

    /** is this CID pinned on the node (any pin type)? pin ls with a path throws when it isn't. */
    isPinned: async (cid) => {
      try { for await (const _ of client.pin.ls({ paths: [cid] })) return true; return false } catch { return false }
    },

    /** ipfs dag import — stream a CAR file's blocks into the repo, recursive-pinning the CAR
     *  roots (migration: Tor-authored history lands here). Yields per-root results; a failed
     *  root pin reports in pinErrorMsg rather than throwing. */
    dagImport: (source, opts = {}) => client.dag.import(source, { pinRoots: true, ...opts }),

    // --- Cloud Bridge: Kubo native remote pinning (design §5.2 / build §4.3) ---
    // Kubo natively speaks the vendor-agnostic IPFS Pinning Service API (Filebase / Pinata / …),
    // so there is no custom pinning client — register a service once, then pin head + media CIDs.

    /** register a remote pinning service. endpoint = string URL, key = the service token. */
    remoteServiceAdd: (name, endpoint, key) =>
      client.pin.remote.service.add(name, { endpoint: new URL(endpoint), key }),

    /** list registered services; stat:true also fetches live pin counts (best-effort, may be slow/absent). */
    remoteServiceList: (withStat = true) =>
      client.pin.remote.service.ls(withStat ? { stat: true } : {}),

    /** unregister a service by name (noop if absent). */
    remoteServiceRm: (name) => client.pin.remote.service.rm(name),

    /**
     * Remote-pin a CID to a service. Pinning-Service pins are recursive, so one head pin covers the
     * whole DAG. `origins` = our dialable multiaddr strings so the service can pull a freshly-published
     * CID directly instead of waiting on DHT discovery. `cid` MUST be a CID instance.
     */
    remotePinAdd: (cid, { service, name, origins, background = true }) =>
      client.pin.remote.add(cid, { service, name, origins, background }),

    /** list remote pins on a service; status = subset of ['queued','pinning','pinned','failed']; cid = CID[] filter. */
    remotePinList: async ({ service, status, cid } = {}) => {
      const out = []
      for await (const p of client.pin.remote.ls({ service, status, cid })) out.push(p)
      return out
    },

    /** remove all remote pins matching a CID on a service (tolerates 0 or many matches). cid = CID|CID[]. */
    remotePinRm: ({ service, cid }) =>
      client.pin.remote.rmAll({ service, cid: cid ? (Array.isArray(cid) ? cid : [cid]) : undefined }),

    /** stream every block CID in the local repo — the offline presence oracle for mixed-posture
     *  repair walks (⚠ multihash-keyed store: dag-cbor blocks re-emit under the raw codec, so
     *  consumers must compare by MULTIHASH, not full CID). */
    refsLocal: () => client.refs.local(),

    /** our node's routable multiaddr strings (for pin `origins`); loopback/private filtered out, best-effort. */
    nodeOrigins: async () => {
      try {
        const info = await client.id()
        return (info.addresses || [])
          .map((a) => a.toString())
          .filter((a) => !/(\/127\.0\.0\.1\/|\/::1\/|\/192\.168\.|\/10\.\d|\/172\.(1[6-9]|2\d|3[01])\.)/.test(a))
      } catch { return [] }
    }
  }
}
