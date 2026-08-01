// history-backup — "Download my history": full-history .car backup + restore.
//
// A Nosdag history is one recursive-pinnable DAG, so a backup is simply the migration
// CAR with no watermark: every envelope from the head down to genesis, plus the media
// closures those notes reference (exportDeltaCar with stopAtCid:null — migrate.mjs does
// the writing). This module owns the OTHER half: understanding a .car handed back to us.
//
// scanBackupCar reads a CAR without touching any node and answers: whose history is
// this, how many notes/media, and is the chain complete? Authentication leans on the
// §13.1 invariant — the signed head event's `prev` STRING tag hash-commits the entire
// chain, so a renderer that verifies the head signature (and this scan, which enforces
// link === tag at every hop) has authenticated the whole file.
//
// Like migrate.mjs, this file is deliberately electron-free (paths in, plain objects
// out) so it runs headless under plain Node for verification.

import fs from 'node:fs'
import { CarBlockIterator } from '@ipld/car'
import { CID } from 'multiformats/cid'
import { decode as decodeCbor } from '@ipld/dag-cbor'
import { sha256 } from 'multiformats/hashes/sha2'
import { extractMediaCids } from './migrate.mjs'

const DAG_CBOR_CODE = 0x71

// Bound walks against a live node (chainContains): every block we ask about should be
// local after an import, so anything that stalls is genuinely absent — fail fast.
const NODE_READ_TIMEOUT = 10_000

/**
 * Scan a backup CAR on disk: index its blocks, walk the envelope chain from the header
 * root, and report what a restore would mean — WITHOUT importing anything.
 *
 * @returns {Promise<{
 *   headCid: string, headEvent: object,
 *   notes: number, blocks: number, bytes: number,
 *   mediaRoots: string[], missingMedia: string[],
 *   missingPrev: string|null,           // chain continues below the CAR (delta/partial file)
 *   newestAt: number|null, oldestAt: number|null
 * }>}
 * @throws when the file is not a CAR, has no usable root, or violates the link↔tag invariant.
 */
export async function scanBackupCar (carPath) {
  const it = await CarBlockIterator.fromIterable(fs.createReadStream(carPath))
  const roots = await it.getRoots()
  if (!roots.length) throw new Error('no root in CAR header — not a Nosdag history backup')
  const headCid = roots[0].toString()

  const present = new Set()                 // every block CID in the file
  const envelopes = new Map()               // cidStr → { event, prevLink: string|null }
  let blocks = 0
  let bytes = 0
  for await (const { cid, bytes: data } of it) {
    // content-address integrity (H6/L1): the CAR format stores CIDs verbatim and does NOT check that
    // the bytes hash to them. Verify it ourselves, else a CAR could serve forged bytes under a
    // committed CID and slip a foreign envelope into the chain. (sha2-256 is the only multihash
    // Nosdag emits; anything else we can't recompute, so we don't index it as authentic.)
    if (cid.multihash.code === 0x12) {
      const computed = CID.create(cid.version, cid.code, await sha256.digest(data))
      if (!computed.equals(cid)) throw new Error(`block hash mismatch at ${cid} — backup fails the integrity check`)
    }
    present.add(cid.toString())
    blocks++
    bytes += data.length
    if (cid.code !== DAG_CBOR_CODE) continue // media block (raw / dag-pb) — indexed, not decoded
    try {
      const obj = decodeCbor(data)
      if (obj && typeof obj === 'object' && obj.event && typeof obj.event.pubkey === 'string') {
        const prev = obj.links?.prev
        envelopes.set(cid.toString(), {
          event: obj.event,
          prevLink: prev == null ? null : (CID.asCID(prev)?.toString() ?? String(prev))
        })
      }
    } catch { /* dag-cbor block that isn't an envelope — fine */ }
  }

  const head = envelopes.get(headCid)
  if (!head) throw new Error('CAR root is not a Nosdag note envelope — not a history backup')

  // Walk the chain newest → oldest inside the file, enforcing at every hop:
  //   • §13.1 consistency: the IPLD link we follow MUST equal the signed string tag;
  //   • author-continuity (H6/L1): every envelope MUST carry the same pubkey the head established.
  //     A single author's DAG never crosses authors, so a CAR that splices another author's (or
  //     fabricated) envelopes below a genuine head is rejected here rather than counted/restored as
  //     this author's history. The pubkey is trustworthy because every block's hash was verified
  //     against its CID above, and the renderer verifies the head event's signature on restore.
  const author = head.event.pubkey
  const mediaSet = new Set()
  const seen = new Set()
  let notes = 0
  let missingPrev = null
  let oldestAt = null
  let cur = headCid
  while (cur) {
    if (seen.has(cur)) throw new Error(`cycle in prev-chain at ${cur}`)
    seen.add(cur)
    const env = envelopes.get(cur)
    if (!env) { missingPrev = cur; break }   // chain continues below what this file holds
    if (env.event.pubkey !== author) throw new Error(`author mismatch at ${cur} (expected ${author} got ${env.event.pubkey}) — backup fails the integrity check`)
    const prevTag = env.event.tags?.find((t) => t[0] === 'prev')?.[1] ?? null
    if (prevTag !== env.prevLink) throw new Error(`link/tag mismatch at ${cur} (tag=${prevTag} link=${env.prevLink}) — backup fails the integrity check`)
    notes++
    oldestAt = env.event.created_at ?? oldestAt
    for (const m of extractMediaCids(env.event)) mediaSet.add(m)
    cur = env.prevLink
  }

  const mediaRoots = []
  const missingMedia = []
  for (const m of mediaSet) (present.has(m) ? mediaRoots : missingMedia).push(m)

  return {
    headCid,
    headEvent: head.event,
    notes,
    blocks,
    bytes,
    mediaRoots,
    missingMedia,
    missingPrev,
    newestAt: head.event.created_at ?? null,
    oldestAt
  }
}

/**
 * Does the chain under headCid contain targetCid? Decides whether a restored head may
 * replace the current local head pointer (only a descendant may — anything else would
 * fork the chain). Walks prev on the LIVE node; after a restore every hop is local, so
 * a missing block fails fast and answers "can't prove it" = false.
 */
export async function chainContains ({ node, headCid, targetCid, limit = 10000 }) {
  if (!headCid || !targetCid) return false
  const seen = new Set()
  let cur = headCid
  let n = 0
  let author = null // the head establishes the author; every hop must match before we vouch (H6)
  while (cur && n < limit) {
    if (seen.has(cur)) return false // cycle — corrupt chain, refuse to vouch
    seen.add(cur)
    let env
    try { env = await node.getEnvelope(CID.parse(cur), { timeout: NODE_READ_TIMEOUT }) } catch { return false }
    if (!env?.event) return false
    // Only vouch for a single-author, link↔tag-consistent chain (H6): a head whose ancestry splices
    // a foreign envelope must not be adopted over the local pointer. The node is content-addressed
    // (getEnvelope returns the block whose multihash IS the CID), so the pubkey field is authentic.
    // The target match is checked AFTER this hop's author is validated, so a same-author path to the
    // target is required — reaching a foreign-authored target returns false, not true.
    if (author == null) author = env.event.pubkey
    else if (env.event.pubkey !== author) return false
    if (cur === targetCid) return true
    const prevTag = env.event.tags?.find((t) => t[0] === 'prev')?.[1] ?? null
    const prev = env.links?.prev
    const prevLink = prev == null ? null : (CID.asCID(prev)?.toString() ?? String(prev))
    if (prevTag !== prevLink) return false // §13.1 link/tag mismatch — refuse to vouch
    cur = prevLink
    n++
  }
  return false
}
