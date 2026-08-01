// Nosdag Phase 5 · Slice 3 — the reciprocal channel (design §6.3).
//
// When YOU reply to or react to someone, you implicitly open a short-lived, LOCAL channel with
// that peer for that conversation. While it's open, their replies back IN THE SAME THREAD skip
// your Requests queue (pending-queue.js) and attach to your thread directly — because you already
// signalled you want to talk to them. Nothing is signed or published: this is a pure client-side
// routing table. After the TTL, or for a reply in a different thread, that peer is a stranger
// again and their reply lands in Pending for manual review.
//
// Knobs (decided 2026-06-07): TTL = 72h; reciprocal replies are auto-hosted (pinned) with no cap.

import * as State from '../state.js'

const KEY = (pk) => `nosdag:reciprocal:${pk}`
const TTL_SEC = 72 * 60 * 60       // 72h conversation window (design §7 knob)
const TABLE_CAP = 500              // most-recent channels retained (state hygiene, §8 risk #6)

let activePubkey = null
let channels = new Map()           // `${threadRoot}|${peer}` -> { threadRoot, peer, anchors, expiresAt }

function myPub () { return State.publicKey || window.NostrState?.publicKey || null }
function nowSec () { return Math.floor(Date.now() / 1000) }
function keyOf (threadRoot, peer) { return `${threadRoot}|${peer}` }

// ---------- persistence (per-pubkey so accounts don't bleed) ----------
function load (pk) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(pk)) || '[]')
    channels = new Map(raw.map((c) => [keyOf(c.threadRoot, c.peer), c]))
  } catch { channels = new Map() }
}
function persist () {
  if (!activePubkey) return
  try { localStorage.setItem(KEY(activePubkey), JSON.stringify([...channels.values()])) }
  catch { /* private mode — keep it in memory */ }
}

// Lazily re-sync in-memory state to the logged-in account (no login/logout event wiring needed).
function sync () {
  const me = myPub()
  if (me === activePubkey) return
  activePubkey = me
  if (me) load(me); else channels = new Map()
}

// Drop expired channels + cap the table (keep the freshest). Returns whether anything changed.
function prune () {
  const now = nowSec()
  let changed = false
  for (const [k, c] of channels) if (!(c.expiresAt > now)) { channels.delete(k); changed = true }
  if (channels.size > TABLE_CAP) {
    const keep = [...channels.values()].sort((a, b) => b.expiresAt - a.expiresAt).slice(0, TABLE_CAP)
    channels = new Map(keep.map((c) => [keyOf(c.threadRoot, c.peer), c]))
    changed = true
  }
  return changed
}

// ---------- NIP-10 thread root (shared by both ends so they agree on the same key) ----------
// explicit 'root' marker → positional first e-tag (2+ tags) → walk the single parent through the
// local event cache → fall back to the parent id / the note's own id. 'mention'/'q' tags excluded.
export function threadRootId (note, _seen) {
  if (!note) return null
  const eTags = (note.tags || []).filter((t) => t[0] === 'e' && t[1] && t[3] !== 'mention')
  if (!eTags.length) return note.id || null            // top-level note → it IS the root
  const root = eTags.find((t) => t[3] === 'root')
  if (root) return root[1]
  if (eTags.length >= 2) return eTags[0][1]             // positional NIP-10: first e-tag is the root
  const parentId = eTags[0][1]                          // single reply/unmarked tag → walk it up
  const seen = _seen || new Set()
  if (seen.has(parentId)) return parentId               // cycle guard
  seen.add(parentId)
  const parent = State.eventCache?.[parentId]
  return parent ? threadRootId(parent, seen) : parentId  // parent uncached → best we can do
}

// ---------- open / refresh a channel ----------
// You engaged `peer` in the thread rooted at `threadRoot`. `anchors` are note ids the peer is
// likely to reply to (e.g. the reply you just published) — matched in ADDITION to the root so the
// channel still works when the cache can't reconstruct the root (e.g. across sessions).
export function openChannel (threadRoot, peer, anchors = []) {
  sync()
  if (!activePubkey || !threadRoot || !peer || peer === activePubkey) return
  prune()
  const k = keyOf(threadRoot, peer)
  const merged = new Set([...(channels.get(k)?.anchors || []), ...anchors].filter(Boolean))
  channels.set(k, { threadRoot, peer, anchors: [...merged], expiresAt: nowSec() + TTL_SEC })
  persist()
}

// Convenience: open from the note you just engaged (its author = peer, its thread = root).
export function openFromNote (note, anchors = []) {
  if (!note) return
  openChannel(threadRootId(note), note.pubkey, anchors)
}

// ---------- queries ----------
// Is there a live channel letting `peer` reach the thread rooted at `threadRoot`?
export function isOpen (threadRoot, peer) {
  sync()
  if (!activePubkey || !threadRoot || !peer) return false
  const c = channels.get(keyOf(threadRoot, peer))
  return !!(c && c.expiresAt > nowSec())
}

// Should an inbound reply `ev` bypass Requests? True when you hold a live channel with its author
// covering this thread. `parentId` = the note ev directly replies to (NIP-10, computed by the
// caller) — matched against channel anchors so a direct reply to your reply always routes.
export function routes (ev, parentId) {
  sync()
  if (!activePubkey || !ev || !ev.pubkey || ev.pubkey === activePubkey) return false
  const peer = ev.pubkey
  const root = threadRootId(ev)
  const now = nowSec()
  for (const c of channels.values()) {
    if (c.peer !== peer || !(c.expiresAt > now)) continue
    if (root && c.threadRoot === root) return true
    if (parentId && c.anchors?.includes(parentId)) return true
  }
  return false
}

export function reset () { activePubkey = null; channels = new Map() }

// test / debug seam
export function _dump () { sync(); return [...channels.values()] }
