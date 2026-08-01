// Nosdag Phase 5 — the relationship gate (design §6.4).
//
// Decides what happens to a reply on YOUR content based solely on your relationship to its
// author. Per the design table, "mutual" (A↔S) and "followed-by-A" (A→S) have the IDENTICAL
// outcome — both auto-attach — so the gate needs ONLY your following set, not a followers set:
//
//   followed by you      → 'auto'   (auto-attaches to your thread; Slice 2 publishes the index)
//   not followed by you  → 'queue'  (a stranger; goes to your Pending requests for review)
//
// 'self' (your own reply) and 'ignore' (no author) are housekeeping outcomes, not gate tiers.
//
// That's the whole gate. A cosmetic "mutual" badge would need to fetch the author's kind-3 to
// see if you're in it, but the gate OUTCOME never branches on it — deliberately omitted.

import * as State from '../state.js'

function myPubkey () {
  return State.publicKey || window.NostrState?.publicKey || null
}

/** @returns {'auto'|'queue'|'self'|'ignore'} */
export function classifyReply (authorPubkey) {
  if (!authorPubkey) return 'ignore'
  if (authorPubkey === myPubkey()) return 'self'
  return State.followingUsers?.has(authorPubkey) ? 'auto' : 'queue'
}
