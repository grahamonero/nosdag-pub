// tor-node — the anonymous-mode storage backend: a Helia/js-libp2p node whose only
// transport is a WebSocket transport that dials peer .onion addresses through Tor's SOCKS
// proxy. This is the swap-in for the clearnet Kubo node — it exposes the SAME surface as
// lib/kubo-manager.mjs (id / swarmPeers / putEnvelope / getEnvelope / addBytes / catBytes /
// pinRecursive / …), so the IPC handlers in main.mjs and the renderer call it UNCHANGED.
//
// Why Helia and not Kubo for Tor: js-libp2p is modular, so we can slot a SOCKS-agent
// WebSocket transport into the stack. Stock Kubo's sealed Go binary can't — it forms a Tor
// connection but never moves a block (proven). Helia over Tor does (proven in tor-transport/).
//
// Lockdown: websockets is the ONLY transport, no DHT, no clearnet block source (bitswap-only
// broker) — the node only knows how to speak over Tor. Blocks persist to disk so notes
// survive a restart.

// Helia is built from @helia/utils directly — NOT the `helia` batteries package. helia's
// libp2p-defaults module statically imports @libp2p/tls → @peculiar/webcrypto, whose broken
// dual build Electron's Node-20 ESM loader can't resolve (crashes app load). We always pass
// our own libp2p, so helia's defaults were never used; this avoids importing that path at all.
import fs from 'node:fs'
import { Helia } from '@helia/utils'
import { libp2pRouting } from '@helia/routers'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { bitswap } from '@helia/block-brokers'
import { dagCbor } from '@helia/dag-cbor'
import { unixfs } from '@helia/unixfs'
import { UnixFS } from 'ipfs-unixfs'
import * as cborCodec from '@ipld/dag-cbor'
import * as pbCodec from '@ipld/dag-pb'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { multiaddr } from '@multiformats/multiaddr'
import { CID } from 'multiformats/cid'

const FETCH_TIMEOUT = 60_000 // bound a stalled Tor fetch instead of hanging forever

/**
 * Create the anonymous-mode node.
 * @param {object} o
 * @param {string} o.repoPath    dir for the persistent blockstore + datastore
 * @param {number} o.wsPort      local ws listener port (the onion forwards here)
 * @param {number} o.socksPort   Tor SOCKS5 port for outbound .onion dials
 * @param {string} [o.socksHost] Tor SOCKS5 host — 127.0.0.1 for the bundled daemon; an external
 *                               proxy (tor router / Whonix gateway) in external-proxy mode
 * @param {string} [o.announce]  this node's onion — advertised as /dns4/<onion>/tcp/<wsPort>/ws;
 *                               null in external-proxy mode (no control access → no onion → the
 *                               node is outbound-capable but inbound-invisible)
 */
export async function createTorNode ({ repoPath, wsPort, socksPort, socksHost = '127.0.0.1', announce = null }) {
  const agent = new SocksProxyAgent(`socks5h://${socksHost}:${socksPort}`)

  const blockstore = new FsBlockstore(`${repoPath}/blocks`)
  const datastore = new FsDatastore(`${repoPath}/data`)

  const libp2p = await createLibp2p({
    addresses: {
      listen: [`/ip4/127.0.0.1/tcp/${wsPort}/ws`],
      announce: announce ? [`/dns4/${announce}/tcp/${wsPort}/ws`] : []
    },
    transports: [
      // filters.all: allow dialing plain `ws` over a dns4 .onion (default filters reject
      // non-secure / non-DNS). The onion circuit is the encryption/auth boundary, so plain
      // ws inside Tor is fine. websocket.agent routes the dial through Tor SOCKS.
      webSockets({ filter: filters.all, websocket: { agent } })
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Tor chokes establishing many circuits at once — keep parallel dials low (Quiet's fix).
    connectionManager: { maxParallelDials: 1, minConnections: 0 },
    // no peerDiscovery, no DHT — discovery is Nostr relays; Tor-only lockdown
    services: { identify: identify() }
  })

  // Replicates createHelia()'s only relevant work for our case (we pass our own libp2p, so its
  // libp2p-defaults branch never runs): inject blockBrokers + routers + metrics, then start().
  const helia = new Helia({
    libp2p,
    blockstore,
    datastore,
    // bitswap ONLY — no trustless-gateway broker (it would fetch over clearnet, breaking lockdown)
    blockBrokers: [bitswap()],
    // libp2p-only routing. Deliberately NO httpGatewayRouting (heliaDefaults adds it) — it resolves
    // blocks via clearnet HTTP gateways, a Tor-leak vector that would break the anonymous lockdown.
    routers: [libp2pRouting(libp2p)],
    metrics: libp2p.metrics
  })
  await helia.start()

  const d = dagCbor(helia)
  const ufs = unixfs(helia)
  const toCid = (c) => (typeof c === 'string' ? CID.parse(c) : c)
  const onionMultiaddr = announce ? `/dns4/${announce}/tcp/${wsPort}/ws/p2p/${libp2p.peerId.toString()}` : null
  let repoStatCache = null

  return {
    helia,
    libp2p,
    mode: 'tor',

    // —— anonymous-mode specifics (for status / kind:0 discovery) ——
    onion: () => announce,
    /** the full dialable address other nodes resolve from kind:0 and dial over Tor */
    onionMultiaddr: () => onionMultiaddr,
    torInfo: () => ({ onion: announce, wsPort, socksPort, onionMultiaddr }),

    // —— identity / swarm (kubo-manager parity) ——
    // async to honor the kubo-manager contract (its id/swarmPeers return RPC promises); a
    // sync return here breaks callers that chain .catch/.then before awaiting (e.g. kubo:status).
    id: async () => ({ id: libp2p.peerId.toString(), addresses: libp2p.getMultiaddrs().map(String) }),
    swarmConnect: (ma) => libp2p.dial(typeof ma === 'string' ? multiaddr(ma) : ma),
    swarmPeers: async () => libp2p.getPeers().map((p) => ({ peer: p.toString() })),

    // —— DAG storage (the IPC putPost/getPost handlers call these unchanged) ——
    putEnvelope: (obj) => d.add(obj),
    getEnvelope: (cid, opts = {}) => d.get(toCid(cid), { signal: AbortSignal.timeout(opts.timeout || FETCH_TIMEOUT) }),
    pinRecursive: async (cid, opts = {}) => {
      const signal = opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined
      for await (const _ of helia.pins.add(toCid(cid), signal ? { signal } : {})) { /* drain */ }
    },
    unpinRecursive: async (cid) => { for await (const _ of helia.pins.rm(toCid(cid))) { /* drain */ } },
    isPinned: async (cid) => helia.pins.isPinned(toCid(cid)),

    // —— media (chunked UnixFS, kubo-manager parity) ——
    // A single-chunk file collapses to the same raw block the old sha256→raw path produced
    // (CID parity with existing media); anything larger becomes a dag-pb tree of ≤1MiB
    // leaves. One oversized raw block (>2MiB) can never cross to Kubo (block-size limit)
    // and no peer can fetch it over Bitswap — chunking is what makes Tor-authored media
    // real network content. Pinned per item like the Kubo path so media survives GC
    // independently of any chain/manifest pin.
    addBytes: async (bytes) => {
      const cid = await ufs.addBytes(bytes)
      try { for await (const _ of helia.pins.add(cid)) { /* drain */ } } catch { /* already pinned */ }
      return cid
    },
    /** addBytes from a file on disk, streamed through the same importer (identical chunking
     *  defaults → identical CID for identical content) — file size never lands in memory. */
    addFromPath: async (filePath) => {
      const cid = await ufs.addByteStream(fs.createReadStream(filePath))
      try { for await (const _ of helia.pins.add(cid)) { /* drain */ } } catch { /* already pinned */ }
      return cid
    },
    /** reassembled file bytes — handles legacy raw single blocks AND chunked dag-pb roots */
    catBytes: async (cid) => {
      const signal = AbortSignal.timeout(FETCH_TIMEOUT)
      const parts = []
      let total = 0
      for await (const chunk of ufs.cat(toCid(cid), { signal })) { parts.push(chunk); total += chunk.length }
      const out = new Uint8Array(total)
      let off = 0
      for (const p of parts) { out.set(p, off); off += p.length }
      return out
    },
    /** catBytes as an async iterable with byte-range support — the local gateway streams
     *  media from this instead of reassembling whole files. Caller owns the abort signal. */
    catStream: (cid, { offset, length, signal } = {}) => ufs.cat(toCid(cid), { offset, length, signal }),
    /** total file byte size from the root block alone (raw block → its length; chunked
     *  dag-pb → the advertised UnixFS fileSize). Bitswap-capable, unlike dagSize below —
     *  the gateway needs the size of media whose blocks may still be remote. */
    mediaSize: async (cid, { signal } = {}) => {
      const c = toCid(cid)
      const b = await helia.blockstore.get(c, signal ? { signal } : {})
      if (c.code === pbCodec.code) {
        const data = pbCodec.decode(b).Data
        if (data) {
          const s = UnixFS.unmarshal(data).fileSize()
          if (s != null) return Number(s)
        }
      }
      return b.length
    },

    // —— block-level access (migration: history CAR-moves between this store and Kubo's) ——
    // Reads go to the RAW FsBlockstore, not helia.blockstore: migration must be at-rest (the
    // "never a gateway" rule), and the raw store can't reach for the network — a missing block
    // throws NotFound immediately instead of starting a Bitswap search. Writes stay on
    // helia.blockstore for its GC/pin write-lock.
    putBlock: async (cid, bytes) => { await helia.blockstore.put(toCid(cid), bytes) },
    getBlock: async (cid) => blockstore.get(toCid(cid)),

    /** every block reachable from a CID by IPLD-link walk (children, deduped) — the Kubo
     *  `refs -r` equivalent, decoding dag-pb (chunked media) + dag-cbor (envelopes) links
     *  locally; raw blocks have none. Local-only, same rationale as getBlock. */
    refsRecursive: async (cid) => {
      const linksOf = (c, bytes) => {
        if (c.code === pbCodec.code) return pbCodec.decode(bytes).Links.map((l) => l.Hash)
        if (c.code === cborCodec.code) {
          const found = []
          const scan = (v) => {
            const asCid = CID.asCID(v)
            if (asCid) { found.push(asCid); return }
            if (Array.isArray(v)) v.forEach(scan)
            else if (v && typeof v === 'object') Object.values(v).forEach(scan)
          }
          scan(cborCodec.decode(bytes))
          return found
        }
        return [] // raw etc: leaf
      }
      const refs = []
      const seen = new Set()
      const walk = async (c) => {
        for (const child of linksOf(c, await blockstore.get(c))) {
          const key = child.toString()
          if (seen.has(key)) continue
          seen.add(key)
          refs.push(key)
          await walk(child)
        }
      }
      await walk(toCid(cid))
      return refs
    },

    // —— status helpers (best-effort; some clearnet signals don't exist over Tor) ——
    /** count pinned roots (for the status poll) */
    pinnedCount: async (cap = 100000) => {
      let n = 0
      for await (const _ of helia.pins.ls()) { if (++n >= cap) break }
      return n
    },
    /** repo stats — Helia has no repo-stat RPC, but FsBlockstore is one file per block, so the
     *  real byte total is a directory walk: blocks (counted as objects, like Kubo's NumObjects)
     *  + the datastore (pins etc., size only). Cached briefly — the status poll runs every few
     *  seconds and the walk shouldn't grow with poll frequency. */
    repoStat: async () => {
      const now = Date.now()
      if (repoStatCache && now - repoStatCache.at < 10_000) return repoStatCache.value
      let repoSize = 0
      let numObjects = 0
      for (const [dir, countObjects] of [[`${repoPath}/blocks`, true], [`${repoPath}/data`, false]]) {
        try {
          const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true })
          for (const e of entries) {
            if (!e.isFile()) continue
            try {
              const st = await fs.promises.stat(`${e.parentPath ?? e.path}/${e.name}`)
              repoSize += st.size
              if (countObjects) numObjects++
            } catch { /* unlinked mid-walk */ }
          }
        } catch { /* dir not created yet */ }
      }
      repoStatCache = { at: now, value: { repoSize, numObjects } }
      return repoStatCache.value
    },
    /** byte size best-effort: a raw block reports its length, a chunked unixfs file the
     *  fileSize its root advertises. Reads the raw local store only — a missing block
     *  returns 0 instantly instead of starting a Bitswap search. (Cumulative DAG sizing
     *  stays a clearnet/Hosted-Follows concern.) */
    dagSize: async (cidStr) => {
      try {
        const cid = toCid(cidStr)
        const b = await blockstore.get(cid)
        if (cid.code === pbCodec.code) {
          const data = pbCodec.decode(b).Data
          if (data) return Number(UnixFS.unmarshal(data).fileSize() ?? b.length)
        }
        return b?.length || 0
      } catch { return 0 }
    },
    /** DHT is off in Tor mode → no trustless provider count. Durability uses a different signal here. */
    providerCount: async () => 0,

    stop: async () => { try { await helia.stop() } catch { /* best-effort */ } }
  }
}
