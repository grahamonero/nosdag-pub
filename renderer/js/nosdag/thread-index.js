// Nosdag Phase 5 · Slice 2 — Thread Index (kind 30782): author-curated, ordered reply sets.
//
// A post's Thread Index is a replaceable Nostr event, signed by the POST AUTHOR, listing the
// reply ids the author has endorsed onto that post, in display order (design §13.3, §6.4). It is
// the curation overlay the thread view applies: approved replies render (in tag order), while
// unendorsed direct replies are hidden from everyone EXCEPT the author (who triages them).
//
// Identifier choice — a deliberate deviation from §13.3's literal "<reply CID>": the `e` tag holds
// the reply's NOSTR EVENT ID, not its IPFS CID. A reply's CID is computed only AFTER signing (the
// envelope wraps the signed event), so it is absent from the reply signal and would need a walk of
// the replier's DAG to recover — unavailable for offline repliers and for vanilla-Nostr replies.
// The event id is always present, is the standard NIP-10 `e`-tag referent, and is exactly what
// thread.js matches replies on. The CID is still used, best-effort, for the approval PIN
// (availability, §6.6) and appended as an optional 5th tag element when it can be resolved.
//
// d = the post id this index curates (one index per post per author). Replaceable → latest wins.

import * as State from '../state.js'
import * as Relays from '../relays.js'
import * as Utils from '../utils.js'
import { resolveHeadCid, walkNotes } from './dag-read.js'

const KIND = 30782
const STORE_KEY = (pk) => `nosdag:threadindex:${pk}`

// my own indexes (source of truth for republish): { [postId]: { entries:[{id,cid,relay}], rootCid?, updated_at } }
let myIndexes = {}
let myPubkey = null

// cache of OTHER authors' indexes fetched from relays: `${author}:${postId}` -> { order:[ids], set:Set, event }
const fetched = new Map()
const inflight = new Map()

// reply ids the owner has already triaged (ignored/blocked) — injected by pending-queue so the
// owner's "unendorsed" disclosure doesn't keep showing replies they've already dismissed.
let ownerHandled = new Set()
export function setHandled (s) { ownerHandled = s instanceof Set ? s : new Set(s || []) }

function pk () { return State.publicKey || window.NostrState?.publicKey || null }
function readRelays () { try { return Relays.getReadRelays?.() || State.relays || [] } catch { return [] } }
function writeRelays () { try { return Relays.getWriteRelays?.() || [] } catch { return [] } }

// ---------- my store (per-pubkey, so accounts don't bleed) ----------
function ensureLoaded () {
  const me = pk()
  if (me && me !== myPubkey) { myPubkey = me; load() }
  return !!myPubkey
}
function load () {
  try { myIndexes = JSON.parse(localStorage.getItem(STORE_KEY(myPubkey)) || '{}') || {} }
  catch { myIndexes = {} }
}
function save () {
  if (!myPubkey) return
  try { localStorage.setItem(STORE_KEY(myPubkey), JSON.stringify(myIndexes)) } catch { /* private mode */ }
}

// ---------- build + publish ----------
function buildTemplate (postId, entry) {
  const tags = [['d', postId]]
  if (entry.rootCid) tags.push(['root', entry.rootCid])
  for (const e of entry.entries) {
    const t = ['e', e.id, e.relay || '', 'approved']
    if (e.cid) t.push(e.cid)   // optional content-address, when resolvable (durability, §13.3)
    tags.push(t)
  }
  return { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags, content: '' }
}

async function publish (postId) {
  if (!ensureLoaded()) return null
  const entry = myIndexes[postId]
  if (!entry) return null
  let signed
  try { signed = await Utils.signEvent(buildTemplate(postId, entry)) }
  catch (e) { console.warn('[nosdag] thread-index sign failed:', e); return null }
  try {
    const relays = writeRelays()
    if (State.pool && relays.length) State.pool.publish(relays, signed)
  } catch (e) { console.warn('[nosdag] thread-index publish failed:', e) }
  return signed
}

// ---------- mutations (approve / auto-append / revoke / reorder) ----------
/** Endorse a reply onto a post's thread (append to the end), then publish. No-op if unchanged. */
export async function add (postId, replyId, { cid = null, relay = '', rootCid = null } = {}) {
  if (!ensureLoaded() || !postId || !replyId) return null
  const entry = myIndexes[postId] || (myIndexes[postId] = { entries: [], updated_at: 0 })
  const existing = entry.entries.find((e) => e.id === replyId)
  let changed = false
  if (!existing) { entry.entries.push({ id: replyId, cid: cid || null, relay: relay || '' }); changed = true }
  else if (cid && !existing.cid) { existing.cid = cid; changed = true }
  if (rootCid && !entry.rootCid) { entry.rootCid = rootCid; changed = true }
  if (!changed) return null                         // already endorsed → don't republish (avoids session-replay chatter)
  entry.updated_at = Math.floor(Date.now() / 1000)
  save()
  return publish(postId)
}

/** Reversible de-attachment (design §6.4): drop a reply from the index + republish. */
export async function remove (postId, replyId) {
  if (!ensureLoaded()) return null
  const entry = myIndexes[postId]
  if (!entry) return null
  const before = entry.entries.length
  entry.entries = entry.entries.filter((e) => e.id !== replyId)
  if (entry.entries.length === before) return null
  entry.updated_at = Math.floor(Date.now() / 1000)
  save()
  return publish(postId)
}

/** Curated ranking: move one endorsed reply up (dir<0) or down (dir>0) a slot, then publish. */
export async function move (postId, replyId, dir) {
  if (!ensureLoaded()) return null
  const entry = myIndexes[postId]
  if (!entry) return null
  const i = entry.entries.findIndex((e) => e.id === replyId)
  const j = dir < 0 ? i - 1 : i + 1
  if (i < 0 || j < 0 || j >= entry.entries.length) return null
  ;[entry.entries[i], entry.entries[j]] = [entry.entries[j], entry.entries[i]]
  entry.updated_at = Math.floor(Date.now() / 1000)
  save()
  return publish(postId)
}

/** Full reorder to an explicit id order (any not listed keep trailing). Programmatic / future drag UI. */
export async function reorder (postId, orderedIds) {
  if (!ensureLoaded()) return null
  const entry = myIndexes[postId]
  if (!entry) return null
  const byId = new Map(entry.entries.map((e) => [e.id, e]))
  const next = []
  for (const id of orderedIds) { const e = byId.get(id); if (e) { next.push(e); byId.delete(id) } }
  for (const e of byId.values()) next.push(e)
  entry.entries = next
  entry.updated_at = Math.floor(Date.now() / 1000)
  save()
  return publish(postId)
}

export function isApproved (postId, replyId) {
  if (!ensureLoaded()) return false
  return !!myIndexes[postId]?.entries?.some((e) => e.id === replyId)
}

// ---------- read an index for a post (mine = local, others = fetched cache) ----------
function parseIndexEvent (ev, authorPubkey) {
  if (!ev || ev.kind !== KIND) return null
  if (ev.pubkey !== authorPubkey) return null        // §13.3: ignore an index not signed by the post author
  const order = []
  for (const t of ev.tags || []) if (t[0] === 'e' && t[1] && t[3] === 'approved') order.push(t[1])
  return { order, set: new Set(order), event: ev }
}

/** The applicable index for (postId, authorPubkey), or null if none known.
 *  Synchronous — returns local (mine) or already-cached (others); call prefetch() first for others. */
export function get (postId, authorPubkey) {
  if (!postId || !authorPubkey) return null
  if (authorPubkey === pk()) {
    ensureLoaded()
    const entry = myIndexes[postId]
    if (!entry) return null
    const order = entry.entries.map((e) => e.id)
    return { order, set: new Set(order) }
  }
  return fetched.get(`${authorPubkey}:${postId}`) || null
}

/** Fetch + cache the indexes for a batch of {postId, author} pairs from relays. Skips mine + cached. */
export async function prefetch (pairs) {
  const relays = readRelays()
  if (!State.pool || !relays.length || !Array.isArray(pairs)) return
  const me = pk()
  const byAuthor = new Map()                          // author -> Set(postId), grouped for compact filters
  for (const p of pairs) {
    const postId = p?.postId, author = p?.author
    if (!postId || !author || author === me) continue
    const key = `${author}:${postId}`
    if (fetched.has(key) || inflight.has(key)) continue
    if (!byAuthor.has(author)) byAuthor.set(author, new Set())
    byAuthor.get(author).add(postId)
  }
  const jobs = []
  for (const [author, idSet] of byAuthor) {
    const ids = [...idSet]
    for (const id of ids) inflight.set(`${author}:${id}`, true)
    jobs.push((async () => {
      try {
        const evs = await State.pool.querySync(relays, { kinds: [KIND], authors: [author], '#d': ids })
        const latest = new Map()                       // newest per d wins (replaceable)
        for (const ev of evs || []) {
          const d = ev.tags?.find((t) => t[0] === 'd')?.[1]
          if (!d) continue
          const cur = latest.get(d)
          if (!cur || ev.created_at > cur.created_at) latest.set(d, ev)
        }
        for (const id of ids) {
          const parsed = latest.has(id) ? parseIndexEvent(latest.get(id), author) : null
          if (parsed) fetched.set(`${author}:${id}`, parsed)
          inflight.delete(`${author}:${id}`)
        }
      } catch (e) {
        for (const id of ids) inflight.delete(`${author}:${id}`)
        console.warn('[nosdag] thread-index prefetch failed:', e)
      }
    })())
  }
  await Promise.all(jobs)
}

// ---------- the overlay: order + partition a node's direct replies (design §6.4) ----------
/** Pure: split replyNodes into the index `order` (kept first, in order) vs the rest. Exported for tests. */
export function partition (order, replyNodes) {
  const byId = new Map(replyNodes.map((n) => [n.post.id, n]))
  const shown = []
  for (const id of order) { const n = byId.get(id); if (n) { shown.push(n); byId.delete(id) } }
  return { shown, unendorsed: [...byId.values()] }
}

/**
 * Apply the curation overlay to one node's direct replies (design §6.4).
 *  - endorsed replies render first, in the author's index order;
 *  - the AUTHOR additionally sees their followees' replies inline (followees auto-attach, §6.4) even
 *    if not yet in the index, and everyone else's replies as `unendorsed` (their triage queue);
 *  - a NON-author with no index for this post gets a passthrough (no curation signal on the wire →
 *    raw thread). On an indexed post, non-authors get the endorsed replies as `shown` and the rest
 *    as `unendorsed` — which the thread renderers display de-emphasized, never hidden.
 * @returns {{ shown:Array, unendorsed:Array, hasIndex:boolean }}
 */
export function curate (nodePostId, nodeAuthor, replyNodes) {
  let idx = get(nodePostId, nodeAuthor)
  // An index with zero approvals is no curation signal: hiding on it turns every
  // reply invisible to every non-author (the wire is full of empty indexes from
  // the era when a stranger reply auto-published one before any triage happened).
  if (idx && !idx.order.length) idx = null
  const me = pk()
  const isOwner = !!me && me === nodeAuthor
  const follows = (isOwner && State.followingUsers?.size) ? State.followingUsers : null
  if (!idx && !follows) return { shown: replyNodes.slice(), unendorsed: [], hasIndex: false }
  const { shown, unendorsed: rest } = partition(idx ? idx.order : [], replyNodes)
  const unendorsed = []
  for (const n of rest) {
    if (isOwner && ownerHandled.has(n.post.id)) continue        // I already ignored/blocked it → don't resurface
    if (follows && follows.has(n.post.pubkey)) shown.push(n)    // author's followee → auto-show
    else unendorsed.push(n)
  }
  return { shown, unendorsed, hasIndex: !!idx }
}

// ---------- best-effort CID resolution for the approval pin (§6.6) ----------
/** Resolve a reply's envelope CID by walking its author's DAG, then recursive-pin it. Best-effort. */
export async function resolveAndPin (replyEvent) {
  try {
    if (!window.nosdag?.kubo?.pinRecursive) return null
    const author = replyEvent?.pubkey, id = replyEvent?.id
    if (!author || !id) return null
    const head = await resolveHeadCid(author, State.pool, readRelays())
    if (!head) return null
    // verify signatures AND bind to the reply author (H6/H7): never pin an envelope reached through
    // an unverified or cross-author walk.
    const notes = await walkNotes(head, { limit: 300, verify: true, author })
    const hit = notes.find((n) => n.id === id)
    if (!hit?._nosdagCid) return null
    await window.nosdag.kubo.pinRecursive(hit._nosdagCid)
    return hit._nosdagCid
  } catch (e) { console.warn('[nosdag] approve pin (best-effort) failed:', e); return null }
}

export function reset () { myPubkey = null; myIndexes = {}; fetched.clear(); inflight.clear(); ownerHandled = new Set() }
