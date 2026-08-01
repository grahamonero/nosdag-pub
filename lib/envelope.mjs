// envelope — build the canonical Nosdag post object (design §13.1).
// Ported verbatim in spirit from the Phase 0 spike; the only change is that the
// CIDs now come from a real Kubo daemon instead of an in-memory blockstore.
//
// The post is a thin dag-cbor envelope:
//     { v, event, links:{ prev:<CID>, skip:[<CID>…] } }
//   • event : a SIGNED Nostr event whose prev/skip ride as STRING tags
//             → id/sig verify under standard Nostr rules (any client).
//   • links : the SAME CIDs as REAL IPLD links (CID instances)
//             → Kubo's recursive pin follows them and replicates all history.
// The two are kept in lock-step; readers MUST check link === string-tag.

import { finalizeEvent } from 'nostr-tools/pure'

/**
 * Build a post envelope ready for kubo-manager.putEnvelope().
 * @param {Uint8Array} sk         author secret key
 * @param {string}     content    post text
 * @param {number}     createdAt  unix seconds
 * @param {CID|null}   prevCid    this author's previous post CID (omit on first post)
 * @param {CID[]}      skipCids   optional [prev-10, prev-100, prev-1000] back-pointers
 * @returns {{ envelope: object, event: object }}
 */
export function buildPost ({ sk, content, createdAt, prevCid = null, skipCids = [] }) {
  const tags = []
  if (prevCid) tags.push(['prev', prevCid.toString()])             // STRING tag — keeps it a valid Nostr event
  if (skipCids.length) tags.push(['skip', ...skipCids.map((c) => c.toString())])

  const event = finalizeEvent({ kind: 1, created_at: createdAt, tags, content }, sk)

  const links = {}
  if (prevCid) links.prev = prevCid                                // REAL IPLD link — what recursive pin follows
  if (skipCids.length) links.skip = skipCids

  return { envelope: { v: 1, event, links }, event }
}
