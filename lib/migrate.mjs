// migrate — shared-blockstore migration between the two node postures, both directions
// (clearnet Kubo ⇄ Tor Helia). Your note history is one recursive-pinnable DAG; the stores
// are different on-disk formats, so content moves between them as a CAR file: export the
// delta from the still-running source, stage it on disk, import into the destination after
// it boots. Kubo imports the CAR natively (dag import, pinning the head root); Helia gets
// it block-by-block into its blockstore.
//
// Incremental by design: a per-pubkey watermark (lastMigratedHead = the newest head CID
// known to be present in BOTH stores) bounds the walk, so after the first heavy sync each
// switch only moves what you authored since. Import is idempotent — content addressing
// means re-putting a block the destination already holds is a no-op.
//
// Like kubo-sidecar, this module is deliberately electron-free (paths are injected) so it
// runs headless under plain Node for verification. It only speaks the kubo-manager surface
// (getEnvelope / getBlock / refsRecursive on the source; putBlock / pinRecursive on the
// destination), so either backend can sit on either side.

import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CarWriter, CarBlockIterator } from '@ipld/car'
import { CID } from 'multiformats/cid'
import { decode as decodeCbor } from '@ipld/dag-cbor'

// Bound every source read: blocks we authored are local, so anything that stalls is a block
// this store never had (e.g. a sync that failed and left a gap) — fail honestly instead of
// hanging the mode switch on a Bitswap search. (The Helia source can't stall at all — its
// getBlock reads the raw on-disk blockstore — this bounds the Kubo side.)
const SOURCE_READ_TIMEOUT = 15_000

// Kubo refuses any block over 2MiB on import and Bitswap won't exchange one — a raw block
// above this limit (media stored before chunked adds) is content no other node can ever
// fetch. Export paths guard on it up front so a poisoned block fails with its CID named
// instead of aborting a whole CAR import at the destination; archive:checkMedia reports
// against the same limit so the timeline-import heal can re-mirror the file chunked.
export const MAX_SAFE_BLOCK_BYTES = 2 * 1024 * 1024

// Media CIDs referenced from a signed event. Media is NOT IPLD-linked from the envelope
// (it rides the event's imeta/content as ipfs://<CID>, and interop-publish rewrites that to
// a /ipfs/ gateway URL by publish time) — so match both forms, same as cloud-bridge.js.
export function extractMediaCids (event) {
  if (!event) return []
  const hay = JSON.stringify({ content: event.content || '', tags: event.tags || [] })
  const re = /(?:ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]{40,})/g
  const out = new Set()
  let m
  while ((m = re.exec(hay)) !== null) out.add(m[1])
  return [...out]
}

/**
 * Walk the prev-chain from headCid down to (not including) stopAtCid, collecting the
 * envelope CIDs and the media CIDs their events reference. skip links never need
 * following — every skip target is an older envelope the prev walk (or a prior
 * migration) already covers.
 * @returns {Promise<{envelopeCids: string[], mediaCids: string[]}>} newest → oldest
 */
export async function collectDelta ({ node, headCid, stopAtCid = null, limit = 10000 }) {
  const envelopeCids = []
  const mediaCids = new Set()
  const seen = new Set()
  let cur = headCid
  while (cur && cur !== stopAtCid && envelopeCids.length < limit) {
    if (seen.has(cur)) throw new Error(`cycle in prev-chain at ${cur}`)
    seen.add(cur)
    const env = await node.getEnvelope(CID.parse(cur), { timeout: SOURCE_READ_TIMEOUT })
    if (!env?.event) throw new Error(`unreadable envelope at ${cur}`)
    envelopeCids.push(cur)
    for (const c of extractMediaCids(env.event)) mediaCids.add(c)
    const prev = env.links?.prev
    cur = prev == null ? null : (CID.asCID(prev)?.toString() ?? String(prev))
  }
  if (cur && cur !== stopAtCid) throw new Error(`prev-chain walk exceeded ${limit} notes`)
  return { envelopeCids, mediaCids: [...mediaCids] }
}

/**
 * Export the delta (new envelopes + their media) from the LIVE source node into a CAR
 * file at carPath. Envelopes are mandatory — a failure there aborts the export. Media is
 * best-effort per root: a media CID we can't read locally (e.g. quoted from someone else's
 * note, never pinned here) is skipped with a note rather than failing your history sync.
 *
 * @returns {Promise<null | { carPath, headCid, blocks, notes, media, mediaRoots, skippedMedia, bytes }>}
 *          null when there is nothing to migrate (head already at the watermark, or no head).
 */
export async function exportDeltaCar ({ node, headCid, stopAtCid = null, carPath, onProgress = null }) {
  if (!headCid || headCid === stopAtCid) return null
  const { envelopeCids, mediaCids } = await collectDelta({ node, headCid, stopAtCid })
  if (!envelopeCids.length) return null

  const roots = [CID.parse(headCid)]
  const { writer, out } = CarWriter.create(roots)
  const sink = pipeline(Readable.from(out), fs.createWriteStream(carPath))

  let blocks = 0
  let bytes = 0
  const skippedMedia = []
  const mediaRoots = []
  try {
    const written = new Set()
    const put = async (cidStr) => {
      if (written.has(cidStr)) return
      written.add(cidStr)
      const cid = CID.parse(cidStr)
      const data = await node.getBlock(cid, { timeout: SOURCE_READ_TIMEOUT })
      if (data.length > MAX_SAFE_BLOCK_BYTES) throw new Error(`block ${cidStr} is ${data.length} bytes — over the 2MiB transfer limit`)
      await writer.put({ cid, bytes: data })
      blocks++
      bytes += data.length
      onProgress?.({ phase: 'export', blocks })
    }

    // 1. the note chain — each envelope is a single dag-cbor block (links point at other
    //    envelopes, which are either in this delta or below the watermark = already migrated)
    for (const c of envelopeCids) await put(c)

    // 2. media — each root plus its closure (large files are chunked UnixFS DAGs in Kubo,
    //    so the root block alone isn't the file). refsRecursive on a single raw block is [].
    for (const m of mediaCids) {
      try {
        const children = await node.refsRecursive(CID.parse(m), { timeout: SOURCE_READ_TIMEOUT })
        await put(m)
        for (const ch of children) await put(String(ch))
        mediaRoots.push(m)
      } catch (e) {
        skippedMedia.push(m) // not ours / not local — history syncs without it
      }
    }
  } finally {
    await writer.close()
    await sink
  }

  return { carPath, headCid, blocks, notes: envelopeCids.length, media: mediaRoots.length, mediaRoots, skippedMedia, bytes }
}

/**
 * Mixed-posture repair (the quit-relaunch hole): a posture change made by quitting and
 * relaunching never migrates — only the in-app switch does — so a chain can span BOTH
 * stores. The current node then can't serve segments authored in the other posture, and
 * a later in-app switch's collectDelta walks into the gap and aborts, stranding blocks.
 *
 * This walks the prev-chain over both stores at once: presence-check each envelope in the
 * CURRENT store (hasLocal — cheap and local), read the gaps from the OTHER posture's
 * at-rest store (a store-reader.mjs reader), and stage ONLY what the current store lacks
 * into a CAR for the normal importCar path. Media is handled the same way per root, with
 * the whole closure pulled from the other store; media absent from both stores is skipped,
 * matching exportDeltaCar. An envelope absent from both stores is fatal — that chain
 * segment genuinely isn't on this machine, and pretending otherwise would publish a chain
 * we can't serve.
 *
 * @returns {Promise<null | { carPath, headCid, blocks, notes, media, mediaRoots, skippedMedia, bytes }>}
 *          null when the current store already holds the whole range (nothing staged).
 */
export async function exportMissingCar ({ node, hasLocal, other, headCid, stopAtCid = null, carPath, limit = 10000, onProgress = null }) {
  if (!headCid || headCid === stopAtCid) return null
  const { writer, out } = CarWriter.create([CID.parse(headCid)])
  const sink = pipeline(Readable.from(out), fs.createWriteStream(carPath))

  let blocks = 0
  let bytes = 0
  let notes = 0
  const mediaRoots = []
  const skippedMedia = []
  const written = new Set()
  const stage = async (cid, data) => {
    const k = cid.toString()
    if (written.has(k)) return
    written.add(k)
    if (data.length > MAX_SAFE_BLOCK_BYTES) throw new Error(`block ${k} is ${data.length} bytes — over the 2MiB transfer limit`)
    await writer.put({ cid, bytes: data })
    blocks++
    bytes += data.length
    onProgress?.({ phase: 'export', blocks })
  }

  try {
    const seen = new Set()
    const mediaSeen = new Set()
    let cur = headCid
    while (cur && cur !== stopAtCid && seen.size < limit) {
      if (seen.has(cur)) throw new Error(`cycle in prev-chain at ${cur}`)
      seen.add(cur)
      const cid = CID.parse(cur)
      let env
      if (await hasLocal(cid)) {
        env = decodeCbor(await node.getBlock(cid, { timeout: SOURCE_READ_TIMEOUT }))
      } else {
        let data
        try { data = await other.getBlock(cid) } catch (e) {
          throw new Error(`envelope ${cur} is missing from both stores — this chain segment cannot be repaired on this machine (${String(e?.message || e)})`)
        }
        env = decodeCbor(data)
        await stage(cid, data)
        notes++
      }
      if (!env?.event) throw new Error(`unreadable envelope at ${cur}`)
      for (const m of extractMediaCids(env.event)) {
        if (mediaSeen.has(m)) continue
        mediaSeen.add(m)
        let mcid
        try { mcid = CID.parse(m) } catch { continue }
        if (await hasLocal(mcid)) continue // root present → closure assumed intact, same as everywhere else
        try {
          let staged = 0
          for await (const blk of other.closure(mcid)) { await stage(blk.cid, blk.bytes); staged++ }
          if (staged) mediaRoots.push(m)
        } catch { skippedMedia.push(m) } // absent from the other store too — history heals without it
      }
      const prev = env.links?.prev
      cur = prev == null ? null : (CID.asCID(prev)?.toString() ?? String(prev))
    }
    if (cur && cur !== stopAtCid) throw new Error(`prev-chain walk exceeded ${limit} notes`)
  } finally {
    await writer.close()
    await sink
  }

  if (!blocks) {
    await fs.promises.rm(carPath, { force: true }).catch(() => {})
    return null
  }
  return { carPath, headCid, blocks, notes, media: mediaRoots.length, mediaRoots, skippedMedia, bytes }
}

/**
 * Copy an IPLD closure (e.g. the timeline-archive manifest) from the OTHER posture's
 * at-rest store: stage into carPath every closure block the current store lacks. The
 * archive does NOT ride the chain migration — but its manifest holds real IPLD links to
 * every archived note + mirrored media file, so "the root's closure" IS the whole archive.
 * Returns null when the current store already holds the full closure; throws when the
 * other store lacks the root (the archive isn't over there either).
 */
export async function exportClosureCar ({ other, hasLocal, rootCid, carPath, onProgress = null }) {
  const root = CID.parse(rootCid)
  const { writer, out } = CarWriter.create([root])
  const sink = pipeline(Readable.from(out), fs.createWriteStream(carPath))
  let blocks = 0
  let bytes = 0
  try {
    for await (const blk of other.closure(root)) {
      if (await hasLocal(blk.cid)) continue
      // The manifest links every closure block, so an oversized one can't be skipped — an
      // incomplete closure must never be pinned. Name the block and point at the cure.
      if (blk.bytes.length > MAX_SAFE_BLOCK_BYTES) {
        throw new Error(`archive block ${blk.cid} is ${blk.bytes.length} bytes — over the 2MiB transfer limit (media stored before chunked adds); run "Update timeline archive" in the posture that holds the archive to re-mirror it, then switch again`)
      }
      await writer.put({ cid: blk.cid, bytes: blk.bytes })
      blocks++
      bytes += blk.bytes.length
      onProgress?.({ phase: 'export', blocks })
    }
  } finally {
    await writer.close()
    await sink
  }
  if (!blocks) {
    await fs.promises.rm(carPath, { force: true }).catch(() => {})
    return null
  }
  return { carPath, rootCid, blocks, bytes }
}

/**
 * Import a staged CAR into the destination node, then recursive-pin the head so the
 * migrated history is GC-safe and seeds as one DAG. The pin walk is local-fast: every link
 * target is either in this CAR or below the watermark from an earlier sync. Kubo destinations
 * take the CAR natively (dag import, which also pins the head root); Helia destinations get
 * it block-by-block.
 */
export async function importCar ({ node, carPath, headCid, mediaRoots = [], pinTimeout = 60_000, onProgress = null }) {
  let blocks = 0
  if (node.dagImport) {
    // Kubo: native CAR import handles every codec in one shot. No per-block progress from
    // the RPC, but it's local disk → fast. A failed root pin surfaces in pinErrorMsg.
    // (dag.import takes an iterable of CAR streams, hence the array.)
    for await (const res of node.dagImport([fs.createReadStream(carPath)], { pinRoots: true })) {
      const pinErr = res?.root?.pinErrorMsg
      if (pinErr) throw new Error(`pin failed for ${res.root?.cid}: ${pinErr}`)
    }
  } else {
    const it = await CarBlockIterator.fromIterable(fs.createReadStream(carPath))
    for await (const { cid, bytes } of it) {
      await node.putBlock(cid, bytes)
      blocks++
      onProgress?.({ phase: 'import', blocks })
    }
    if (headCid) {
      try { await node.pinRecursive(CID.parse(headCid), { timeout: pinTimeout }) } catch (e) {
        if (!/already pinned/i.test(String(e?.message || e))) throw e // re-running a sync is fine
      }
    }
  }
  // Media is NOT IPLD-linked from the head, so pin each media root separately — parity with
  // the clearnet authoring path (addBytes pins per item), and what keeps Kubo's GC off
  // migrated media. Best-effort: a pin hiccup shouldn't fail a sync whose blocks all landed.
  for (const m of mediaRoots) {
    try { await node.pinRecursive(CID.parse(m), { timeout: pinTimeout }) } catch { /* already pinned / no walker */ }
  }
  return { blocks }
}
