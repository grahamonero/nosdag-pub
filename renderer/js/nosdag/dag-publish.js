// Nosdag Phase 2 — publish a note into the IPFS DAG and announce the nosdag:head pointer.
//
// Flow (called from posts.js sendPost, after the note is signed + published to relays):
//   1. store the signed event as a dag-cbor envelope (real IPLD links) via the main-process
//      kubo:putPost IPC → new head CID
//   2. recursive-pin the head → seeds the whole chain locally (one pin covers all history)
//   3. publish the nosdag:head pointer (NIP-78 kind 30078, d:nosdag:head) to relays so
//      followers can find the head and walk back
//   4. remember the new head locally so the NEXT post's prev tag chains to it
//
// The signed event must already carry a STRING `prev` tag matching prevCid (the §13.1
// consistency invariant); main builds links.prev from prevCid so the two agree.

const HEAD_KEY = (pubkey) => `nosdag:head:${pubkey}`
const POSTS_KEY = (pubkey) => `nosdag:posts:${pubkey}`

export function getLocalHead (pubkey) {
  try { return localStorage.getItem(HEAD_KEY(pubkey)) || null } catch { return null }
}
/** exported for history-backup restore, which adopts a verified backup's head as the local pointer */
export function setLocalHead (pubkey, cid) {
  try { localStorage.setItem(HEAD_KEY(pubkey), cid) } catch { /* private mode */ }
}

/** how many notes this user has written into IPFS (the meaningful per-note count) */
export function getPostCount (pubkey) {
  try { return parseInt(localStorage.getItem(POSTS_KEY(pubkey)) || '0', 10) || 0 } catch { return 0 }
}
function bumpPostCount (pubkey) {
  try { localStorage.setItem(POSTS_KEY(pubkey), String(getPostCount(pubkey) + 1)) } catch { /* private mode */ }
}
/** Reconcile the cached count to the real chain length (e.g. after a DAG walk) — self-heals
 *  drift from notes posted before the counter existed. */
export function setPostCount (pubkey, n) {
  try { localStorage.setItem(POSTS_KEY(pubkey), String(Math.max(0, n | 0))) } catch { /* private mode */ }
}

/**
 * @returns {Promise<string|null>} the new head CID, or null if the IPFS bridge is unavailable / failed.
 */
export async function publishToDag ({ signedEvent, prevCid, pubkey, signEvent, pool, writeRelays }) {
  if (!window.nosdag?.kubo?.putPost) {
    console.warn('[nosdag] no IPFS bridge (running outside the Nosdag shell?) — skipping DAG publish')
    return null
  }

  // 1. store the post object (dag-cbor envelope) in the local Kubo node
  const res = await window.nosdag.kubo.putPost({ event: signedEvent, prevCid: prevCid || null })
  if (!res || res.error) {
    console.error('[nosdag] putPost failed:', res?.error || 'no response')
    return null
  }
  const headCid = res.cid

  // 2. recursive-pin the new head (covers the whole chain), then drop the previous head's
  //    now-redundant recursive pin so the node keeps exactly ONE tip pin (design §5.2).
  window.nosdag.kubo.pinRecursive(headCid)
    .then(() => { if (prevCid) return window.nosdag.kubo.unpinRecursive(prevCid) })
    .catch((e) => console.warn('[nosdag] pin/unpin failed:', e))

  // 2b. (Phase 3 · Slice 1) mirror the note to the linked Cloud Bridge, if any — head (recursive)
  //     + media CIDs to a 24/7 pinning service. Best-effort; never blocks or fails the post.
  import('./cloud-bridge.js')
    .then((CB) => CB.pinNote(signedEvent, headCid, prevCid))
    .catch(() => { /* bridge optional */ })

  // 3. announce the nosdag:head pointer so followers can find + backfill the DAG
  try {
    const pointer = await signEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'nosdag:head'], ['head', headCid]],
      content: ''
    })
    if (pool && Array.isArray(writeRelays) && writeRelays.length) {
      pool.publish(writeRelays, pointer)
    }
  } catch (e) {
    console.warn('[nosdag] head-pointer publish failed (post still stored locally):', e)
  }

  // 4. remember the head for the next post's prev link + bump the post count
  setLocalHead(pubkey, headCid)
  bumpPostCount(pubkey)
  console.log(`[nosdag] 📦 note in IPFS: ${headCid}  (prev: ${prevCid || 'genesis'}, total notes: ${getPostCount(pubkey)})`)
  return headCid
}
