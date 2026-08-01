// Nosdag Phase 5 · Slice 4 — Consumption tiers (Axis 1): thread-follow.
//
// Design §6.2 / §3.4. Between full-follow (you subscribe to an author's whole log via their
// nosdag:head) and one-off thread viewing sits a third reader tier: "Follow this conversation."
// Following a conversation root:
//   • live-subscribes { kinds:[1], '#e':[root] } so new replies under it arrive without reopening;
//   • caches inbound replies into State.eventCache, so the next render of that thread is fresh;
//   • best-effort PINS the root + author-ENDORSED replies (availability / hosting, §6.2), capped;
//   • tags the root note in any feed with a "⌁ FOLLOWING" chip.
//
// Visibility decision (2026-06-07): AUTHOR-CURATED ONLY. Following keeps the thread fresh + hosts
// it, but never reveals what the author chose to hide — the thread-index curation overlay
// (thread-index.js) still governs what renders. So this module deliberately does NOT touch the
// render filter; it only pulls + pins + chips. Pure renderer-side; no on-wire format (§3.4).
//
// State: nosdag:threadfollow:<pubkey> — an array of followed conversation root ids.

import * as State from '../state.js'
import * as Relays from '../relays.js'
import { escapeHtml } from '../utils.js'
import * as ThreadIndex from './thread-index.js'

const KEY = (pk) => `nosdag:threadfollow:${pk}`
const PIN_CAP = 200          // max replies we host per followed conversation (bounds spam-hosting)
const REPAINT_MS = 1400      // debounce window for live re-render of an open followed thread

let started = false          // idempotent init() guard
let activePubkey = null
let followed = new Set()      // conversation root ids
const subs = new Map()        // rootId -> { sub, since }
const pinnedPerRoot = new Map() // rootId -> count of replies pinned (cap bookkeeping)

// which thread is on screen right now, so a live reply can repaint it
let openRoot = null
let reopenFn = null
let stillOpenFn = null
let repaintTimer = null

// ---------- identity / relays ----------
function myPub () { return State.publicKey || window.NostrState?.publicKey || null }
function readRelays () {
  try {
    const r = Relays.getReadRelays?.() || Relays.getActiveRelays?.() || State.relays || []
    return Array.isArray(r) ? r.filter(Boolean) : []
  } catch { return [] }
}

// ---------- persistence (per-pubkey, so accounts don't bleed) ----------
function load (pk) {
  try { followed = new Set(JSON.parse(localStorage.getItem(KEY(pk)) || '[]')) }
  catch { followed = new Set() }
}
function persist () {
  if (!activePubkey) return
  try { localStorage.setItem(KEY(activePubkey), JSON.stringify([...followed])) }
  catch { /* private mode — keep it in memory */ }
}

// ---------- NIP-10: the single note a reply DIRECTLY replies to (mirrors pending-queue) ----------
function directParentId (ev) {
  const tags = ev?.tags || []
  if (tags.some((t) => t[0] === 'q')) return null            // quote-repost, not a reply
  const eTags = tags.filter((t) => t[0] === 'e' && t[1] && t[3] !== 'mention')
  if (!eTags.length) return null
  const reply = eTags.find((t) => t[3] === 'reply')
  return (reply || eTags[eTags.length - 1])[1]
}

// ---------- public: relationship to a conversation ----------
/** The conversation ROOT for any note id: root-marked e-tag → first e-tag → the note itself. */
export function rootIdOf (noteId) {
  if (!noteId) return noteId
  const ev = State.eventCache?.[noteId]
  if (!ev || !Array.isArray(ev.tags)) return noteId
  const eTags = ev.tags.filter((t) => t[0] === 'e' && t[1] && t[3] !== 'mention')
  if (!eTags.length) return noteId                            // a root note has no parent e-tag
  const root = eTags.find((t) => t[3] === 'root')
  return (root ? root[1] : eTags[0][1]) || noteId
}

export function isFollowing (rootId) { return !!rootId && followed.has(rootId) }
export function followedRoots () { return [...followed] }

export function toggle (rootId) {
  if (!rootId) return false
  if (followed.has(rootId)) { unfollow(rootId); return false }
  follow(rootId); return true
}

export function follow (rootId) {
  if (!rootId || followed.has(rootId)) return
  followed.add(rootId)
  persist()
  openSub(rootId)
  // host the root itself straight away (best-effort; vanilla-Nostr roots have no CID and no-op)
  const root = State.eventCache?.[rootId]
  if (root?.pubkey) ThreadIndex.resolveAndPin({ id: rootId, pubkey: root.pubkey }).catch(() => {})
  paintChips()
}

export function unfollow (rootId) {
  if (!rootId) return
  followed.delete(rootId)
  persist()
  const e = subs.get(rootId)
  if (e) { try { e.sub?.close() } catch { /* ignore */ } subs.delete(rootId) }
  pinnedPerRoot.delete(rootId)
  paintChips()
}

// ---------- live subscription: keep a followed conversation fresh ----------
function openSub (rootId) {
  if (subs.has(rootId)) return
  const relays = readRelays()
  if (!State.pool || !relays.length) {
    setTimeout(() => { if (followed.has(rootId)) openSub(rootId) }, 2500)   // retry until the pool is up
    return
  }
  const since = Math.floor(Date.now() / 1000)
  const sub = State.pool.subscribeMany(relays, [{ kinds: [1], '#e': [rootId] }], {
    onevent: (ev) => onReply(rootId, ev)
  })
  subs.set(rootId, { sub, since })
}

function onReply (rootId, ev) {
  if (!ev || ev.kind !== 1 || !ev.id) return
  const fresh = !State.eventCache?.[ev.id]
  if (State.eventCache && fresh) State.eventCache[ev.id] = ev          // cache so the next render has it
  maybePinReply(rootId, ev)
  // Only repaint for genuinely-new activity (created after we started following) on the open thread —
  // backfill of pre-existing replies must not yank the user around.
  const since = subs.get(rootId)?.since || 0
  if (fresh && openRoot === rootId && (ev.created_at || 0) >= since - 60) scheduleRepaint()
}

// Host a reply ONLY if its parent author endorsed it (matches the author-curated-only decision) —
// never host an unendorsed stranger reply. Best-effort, capped per conversation.
function maybePinReply (rootId, ev) {
  if ((pinnedPerRoot.get(rootId) || 0) >= PIN_CAP) return
  const parentId = directParentId(ev)
  if (!parentId) return
  const parentAuthor = State.eventCache?.[parentId]?.pubkey
  if (!parentAuthor) return
  const idx = ThreadIndex.get(parentId, parentAuthor)        // sync: mine, or another author's cached index
  if (!idx || !idx.set?.has(ev.id)) return                   // not endorsed (or index not yet fetched) → skip
  ThreadIndex.resolveAndPin({ id: ev.id, pubkey: ev.pubkey })
    .then((cid) => { if (cid) pinnedPerRoot.set(rootId, (pinnedPerRoot.get(rootId) || 0) + 1) })
    .catch(() => {})
}

// ---------- live repaint of the currently-open followed thread ----------
/** Renderers call this right after drawing a thread: which root, how to redraw it, and a predicate
 *  that says whether that view is still on screen (so we never re-render a thread the user left). */
export function markOpenThread (rootId, redraw, isStillOpen) {
  openRoot = rootId || null
  reopenFn = typeof redraw === 'function' ? redraw : null
  stillOpenFn = typeof isStillOpen === 'function' ? isStillOpen : null
}
function scheduleRepaint () {
  if (repaintTimer) clearTimeout(repaintTimer)
  repaintTimer = setTimeout(() => {
    repaintTimer = null
    if (!reopenFn) return
    if (stillOpenFn && !stillOpenFn()) return                // user navigated away — don't yank them back
    try { reopenFn() } catch { /* ignore */ }
  }, REPAINT_MS)
}

// ---------- the "Follow this conversation" control (shared by both thread renderers) ----------
export function followControlHtml (rootId) {
  const on = isFollowing(rootId)
  return `<div class="nd-tf-bar" data-nd-tf-root="${escapeHtml(rootId || '')}">
    <button class="nd-tf-btn${on ? ' nd-tf-on' : ''}" data-nd-tf-toggle title="${on ? 'You follow this conversation — new replies are pulled + hosted' : 'Get new replies as they land, and host this conversation'}">
      <span class="nd-tf-ic">${on ? '⌁' : '+'}</span>
      <span class="nd-tf-label nd-mono">${on ? 'FOLLOWING CONVERSATION' : 'FOLLOW CONVERSATION'}</span>
    </button>
    <span class="nd-tf-hint nd-mono">${on ? 'new replies pulled + hosted' : 'get new replies as they land'}</span>
  </div>`
}

export function wireFollowControl (container, rootId) {
  if (!container || !rootId) return
  const btn = container.querySelector('[data-nd-tf-toggle]')
  if (!btn) return
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    toggle(rootId)
    const bar = btn.closest('.nd-tf-bar')
    if (bar) { bar.outerHTML = followControlHtml(rootId); wireFollowControl(container, rootId) }
  })
}

// ---------- feed chip on followed conversation roots ----------
export async function markFollowedThreads (containerId) {
  if (!followed.size) return
  const container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId
  if (!container) return
  const posts = container.querySelectorAll('.post[data-post-id]:not([data-nd-tf])')
  posts.forEach((p) => {
    const id = p.dataset.postId
    if (!id || !followed.has(id)) return                     // only mark the conversation ROOT you follow
    p.dataset.ndTf = '1'
    // attach to the post's OWN header, never a nested .parent-post (the quoted/replied-to note)
    let slot = null
    for (const el of p.querySelectorAll('.post-header .post-info')) { if (!el.closest('.parent-post')) { slot = el; break } }
    if (!slot) { for (const el of p.querySelectorAll('.post-header')) { if (!el.closest('.parent-post')) { slot = el; break } } }
    if (!slot) slot = p
    if (slot.querySelector('.nd-tf-chip')) return
    const chip = document.createElement('span')
    chip.className = 'nd-tf-chip nd-mono'
    chip.textContent = '⌁ FOLLOWING'
    chip.title = 'You follow this conversation — new replies are pulled + hosted. Click to open.'
    chip.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault()
      if (typeof window.openThreadView === 'function') window.openThreadView(id)
    })
    slot.appendChild(chip)
  })
}
function paintChips () {
  // repaint chips across whatever feed/thread/profile containers are mounted
  for (const cid of ['feed', 'threadPageContent', 'profilePageContent']) {
    try { markFollowedThreads(cid) } catch { /* ignore */ }
  }
}

// ---------- lifecycle ----------
function onLogin () {
  const me = myPub()
  if (!me) return
  if (activePubkey === me && subs.size) return               // already running for this user
  stopSubs()
  activePubkey = me
  load(me)
  for (const rootId of followed) openSub(rootId)
}
function stopSubs () { for (const e of subs.values()) { try { e.sub?.close() } catch { /* ignore */ } } subs.clear() }
function onLogout () {
  stopSubs()
  activePubkey = null
  followed = new Set()
  pinnedPerRoot.clear()
  openRoot = null; reopenFn = null; stillOpenFn = null
  if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null }
}

export function init () {
  if (started) return
  started = true
  window.addEventListener('nosmero:login', onLogin)
  window.addEventListener('nosmero:logout', onLogout)
  window.NosdagThreadFollow = { toggle, isFollowing, follow, unfollow, roots: followedRoots }
  if (myPub()) onLogin()
}
