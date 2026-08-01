// Nosdag Phase 5 · Slice 1 — Pending queue (read-only triage of stranger replies).
//
// Subscribes to replies aimed at YOUR notes (#e = your recent note ids), runs each through the
// relationship gate (relationship-gate.js):
//   • replies from people you FOLLOW are counted as "auto" (Slice 2 will auto-attach them);
//   • replies from everyone else land in PENDING — a stranger asking to attach to your wall.
//
// Slice 1 only SURFACES pending replies — a count badge on the left rail + a "Requests" panel
// in the right-panel telemetry deck, with a read-only "view in thread" link. No publishing, no
// pinning, no signing: Approve / Ignore / Block + the Thread Index (kind 30782) arrive in Slice 2.
//
// Known Slice-1 limits (closed later): replies to notes you write THIS session aren't watched
// until the next launch (the watched note-id set is fetched once at login); and a followee reply
// that arrives before your contact list finishes loading is briefly mis-bucketed as a stranger —
// reconcileFollows() self-heals it on the next render/badge tick.
//
// Slice 4 broadens this into a true mentions inbox: a second subscription (#p = you, recent only)
// surfaces stranger notes that @-mention you but aren't replies to your own notes. Those items
// have no note of yours to attach to, so they carry no Approve — just Dismiss / Block / view.
// (#p propagation is noisy by nature; the §9.2 spam controls are the lever if it gets loud.)

import * as State from '../state.js'
import * as Relays from '../relays.js'
import * as Posts from '../posts.js'
import { escapeHtml } from '../utils.js'
import { classifyReply } from './relationship-gate.js'
import * as ThreadIndex from './thread-index.js'
import * as Reciprocal from './reciprocal-channel.js'

const PENDING_KEY = (pk) => `nosdag:pending:${pk}`
const HANDLED_KEY = (pk) => `nosdag:reqhandled:${pk}`
const MY_NOTES_CAP = 120        // how many of your recent notes we watch for replies
const SNIPPET_MAX = 280         // chars of reply text we retain
const HANDLED_CAP = 500         // most-recent triaged reply ids we remember (so they don't re-queue)
const MENTION_LOOKBACK = 14 * 24 * 3600 // only surface @-mentions from the last 14 days (Slice 4)

let started = false             // idempotent init() guard
let bringingUp = false          // re-entrancy guard for bringUp()
let bringUpTries = 0
let activePubkey = null
let myNoteIds = new Set()
let pending = new Map()          // replyId -> { id, author, content, created_at, parentId }
let handled = new Set()          // reply ids already approved/ignored/blocked — never re-queue them
let autoCount = 0               // followee replies auto-attached this session (demonstrates the gate)
let subs = []                   // open relay subscriptions, closed on stop/logout

// ---------- identity / relays ----------
function myPub () { return State.publicKey || window.NostrState?.publicKey || null }
function readRelays () {
  try {
    const r = Relays.getReadRelays?.() || Relays.getActiveRelays?.() || State.relays || []
    return Array.isArray(r) ? r.filter(Boolean) : []
  } catch { return [] }
}

// ---------- persistence (keyed per-pubkey so accounts don't bleed) ----------
function loadPending (pk) {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY(pk)) || '[]')
    pending = new Map(raw.map((it) => [it.id, it]))
  } catch { pending = new Map() }
}
function savePending () {
  if (!activePubkey) return
  try { localStorage.setItem(PENDING_KEY(activePubkey), JSON.stringify([...pending.values()])) }
  catch { /* private mode — keep it in memory */ }
}
function loadHandled (pk) {
  try { handled = new Set(JSON.parse(localStorage.getItem(HANDLED_KEY(pk)) || '[]')) }
  catch { handled = new Set() }
  ThreadIndex.setHandled(handled)            // so the thread overlay won't resurface dismissed replies
}
function markHandled (replyId) {
  if (!replyId) return
  handled.add(replyId)
  if (handled.size > HANDLED_CAP) handled = new Set([...handled].slice(-HANDLED_CAP)) // keep most recent
  ThreadIndex.setHandled(handled)
  if (!activePubkey) return
  try { localStorage.setItem(HANDLED_KEY(activePubkey), JSON.stringify([...handled])) }
  catch { /* private mode */ }
}

// ---------- NIP-10: the single note a reply DIRECTLY replies to ----------
// Mirrors posts.js: a marked 'reply' e-tag wins; otherwise the last e-tag (positional fallback).
// Quote-reposts (NIP-18 q-tag, or an e-tag marked 'mention') are not replies.
// Exported so Slice 2 (and the smoke harness) can reuse the same NIP-10 parent resolution.
export function directParentId (ev) {
  const tags = ev.tags || []
  if (tags.some((t) => t[0] === 'q')) return null
  const eTags = tags.filter((t) => t[0] === 'e' && t[1] && t[3] !== 'mention')
  if (!eTags.length) return null
  const reply = eTags.find((t) => t[3] === 'reply')
  return (reply || eTags[eTags.length - 1])[1]
}

// ---------- gate + store one inbound reply ----------
function gateAndStore (ev) {
  if (!ev || ev.kind !== 1) return
  if (ev.pubkey === activePubkey) return            // your own reply
  if (pending.has(ev.id) || handled.has(ev.id)) return // already queued or already triaged
  const parentId = directParentId(ev)
  if (!parentId || !myNoteIds.has(parentId)) return // not a DIRECT reply to one of your notes

  const decision = classifyReply(ev.pubkey)
  if (decision === 'auto') {
    // People you follow auto-attach (design §6.4): endorse straight into the post's Thread Index.
    // Mark handled so a session replay doesn't re-process it. (Hosting/pin is reserved for explicit
    // approval, §6.6 — auto-pinning every followee reply would walk each replier's DAG.)
    markHandled(ev.id)
    autoCount++
    ThreadIndex.add(parentId, ev.id).catch(() => {})
    updateBadge(); renderDeckPanel(); return
  }
  if (decision !== 'queue') return                  // 'self' / 'ignore'

  // Reciprocal channel (design §6.3): you replied to / reacted to this peer recently in this
  // thread, so let their reply through instead of parking it in Requests — attach it to your
  // thread (publishes the index so other readers see it) and host it (auto-pin, no cap).
  if (Reciprocal.routes(ev, parentId)) {
    // Don't bump autoCount — that line is labelled "people you follow"; reciprocal stays invisible
    // (§7). The visible effect is simply the reply appearing, endorsed, in the thread.
    markHandled(ev.id)
    ThreadIndex.add(parentId, ev.id).catch(() => {})
    ThreadIndex.resolveAndPin({ id: ev.id, pubkey: ev.pubkey }).catch(() => {})
    updateBadge(); renderDeckPanel(); return
  }

  pending.set(ev.id, {
    id: ev.id,
    author: ev.pubkey,
    content: (ev.content || '').slice(0, SNIPPET_MAX),
    created_at: ev.created_at || 0,
    parentId
  })
  savePending()
  // Publish a curation signal for this note so OTHER clients hide the stranger's reply until you
  // approve it (without a Thread Index on the wire, third readers fall back to the raw thread).
  ThreadIndex.ensurePublished(parentId).catch(() => {})
  updateBadge()
  renderDeckPanel() // renders npub immediately; backfillProfiles repaints with the name
}

// ---------- gate + store one inbound @-mention (Slice 4: broaden Requests to a mentions inbox) ----------
// A stranger note that p-tags you but ISN'T a direct reply to one of YOUR notes (those go through
// gateAndStore). There's no note of yours to attach it to, so it's an inform-only "mention" item
// (no Approve). Reply-propagation p-tags make this noisy — §9.2 spam controls are the lever.
function gateMention (ev) {
  if (!ev || ev.kind !== 1) return
  if (ev.pubkey === activePubkey) return                  // your own note
  if (pending.has(ev.id) || handled.has(ev.id)) return    // already queued or triaged
  if (!(ev.tags || []).some((t) => t[0] === 'p' && t[1] === activePubkey)) return // must actually tag you
  const parentId = directParentId(ev)
  if (parentId && myNoteIds.has(parentId)) return         // a reply to YOUR note → gateAndStore owns it
  if (classifyReply(ev.pubkey) !== 'queue') return        // followees aren't "requests"; self/ignore skip too

  pending.set(ev.id, {
    id: ev.id,
    author: ev.pubkey,
    content: (ev.content || '').slice(0, SNIPPET_MAX),
    created_at: ev.created_at || 0,
    parentId: parentId || null,
    type: 'mention'
  })
  savePending()
  updateBadge()
  renderDeckPanel() // renders npub immediately; backfillProfiles repaints with the name
}

// A followee reply that beat the contact-list load got bucketed as a stranger — move it back.
function reconcileFollows () {
  const f = State.followingUsers
  if (!f || !f.size || !pending.size) return false
  let changed = false
  for (const [id, it] of pending) {
    if (f.has(it.author)) {
      pending.delete(id); markHandled(id); changed = true
      // A reply auto-attaches to your thread once its author is a followee (§6.4); a bare mention
      // has no note of yours to attach to — just drop it from the queue (you follow them now).
      if (it.type !== 'mention' && it.parentId) { autoCount++; ThreadIndex.add(it.parentId, id).catch(() => {}) }
    }
  }
  if (changed) savePending()
  return changed
}

// ---------- relay bring-up ----------
async function bringUp () {
  const me = myPub()
  if (!me || activePubkey !== me) return
  if (bringingUp) return
  const relays = readRelays()
  if (!State.pool || !relays.length) {
    if (bringUpTries++ < 6) setTimeout(() => bringUp().catch(() => {}), 2000)
    return
  }
  bringingUp = true
  bringUpTries = 0
  try {
    // 1. learn your recent note ids (the things strangers reply TO)
    myNoteIds = new Set()
    await new Promise((resolve) => {
      let done = false
      let s = null
      const finish = () => { if (done) return; done = true; try { s?.close() } catch {} resolve() }
      s = State.pool.subscribeMany(relays, [{ kinds: [1], authors: [me], limit: MY_NOTES_CAP }], {
        onevent: (ev) => { if (ev?.id) myNoteIds.add(ev.id) },
        oneose: finish
      })
      setTimeout(finish, 6000) // don't hang if a relay never EOSEs
    })
    if (activePubkey !== me) return // logged out / switched mid-fetch

    // 2. live-subscribe to replies to those notes
    if (myNoteIds.size) {
      const sub = State.pool.subscribeMany(relays, [{ kinds: [1], '#e': [...myNoteIds] }], {
        onevent: gateAndStore
      })
      subs.push(sub)
    }
    // 2b. Slice 4 — live-subscribe to @-mentions of you (#p), bounded to the recent window so an
    // active account's whole mention history doesn't flood the queue. Strangers only (gateMention
    // skips followees + replies to your own notes, which the #e sub already covers).
    {
      const since = Math.floor(Date.now() / 1000) - MENTION_LOOKBACK
      const msub = State.pool.subscribeMany(relays, [{ kinds: [1], '#p': [me], since }], {
        onevent: gateMention
      })
      subs.push(msub)
    }
    reconcileFollows()
    updateBadge()
    renderDeckPanel()
    // Ensure a curation signal exists for every note that already has a pending stranger reply, so
    // other clients hide those replies until you approve them (covers items queued before this — and
    // the live subscription skips them via the pending dedupe, so it can't publish for them).
    for (const it of pending.values()) ThreadIndex.ensurePublished(it.parentId).catch(() => {})
    // contacts usually finish loading within a few seconds — re-bucket once they have
    setTimeout(() => { if (reconcileFollows()) { updateBadge(); renderDeckPanel() } }, 4000)
  } finally {
    bringingUp = false
  }
}

function stopSubs () { for (const s of subs) { try { s.close() } catch {} } subs = [] }

// ---------- lifecycle ----------
function onLogin () {
  const me = myPub()
  if (!me) return
  if (activePubkey === me && subs.length) return // already running for this user
  stopSubs()
  activePubkey = me
  autoCount = 0
  bringUpTries = 0
  loadPending(me)
  loadHandled(me)
  updateBadge()
  renderDeckPanel()
  bringUp().catch((e) => console.warn('[nosdag] pending bring-up failed:', e))
}

function onLogout () {
  stopSubs()
  activePubkey = null
  myNoteIds = new Set()
  pending = new Map()
  handled = new Set()
  autoCount = 0
  profilesRequested.clear() // a re-login retries profiles that didn't resolve this session
  ThreadIndex.reset()
  Reciprocal.reset()
  updateBadge()
  renderDeckPanel()
}

// ---------- triage actions (shared by the Requests panel AND the thread-view controls) ----------
// Endorse a reply onto your post's thread: add to the Thread Index, host it (best-effort pin),
// drop it from Pending, and remember it as handled so it never re-queues.
export async function approveReply (replyId, parentId, author) {
  if (!replyId || !parentId) return
  markHandled(replyId)
  await ThreadIndex.add(parentId, replyId).catch(() => {})
  ThreadIndex.resolveAndPin({ id: replyId, pubkey: author }).catch(() => {})
  if (pending.delete(replyId)) savePending()
  updateBadge(); renderDeckPanel()
}

// Leave it off your wall (it still lives in the replier's own log) — just stop surfacing it.
export function ignoreReply (replyId) {
  if (!replyId) return
  markHandled(replyId)
  if (pending.delete(replyId)) savePending()
  updateBadge(); renderDeckPanel()
}

// Mute the author (NIP-51) + drop their pending replies; nothing from them re-queues.
export async function blockReply (replyId, author) {
  if (!replyId) return
  markHandled(replyId)
  pending.delete(replyId)
  if (author) for (const [id, it] of pending) if (it.author === author) { pending.delete(id); markHandled(id) }
  savePending(); updateBadge(); renderDeckPanel()
  try { const Lists = await import('../lists.js'); if (author) await Lists.muteUser(author) }
  catch (e) { console.warn('[nosdag] block (mute) failed:', e) }
}

// Reversible de-attachment (design §6.4) — drop a reply from your published Thread Index.
export async function revokeReply (replyId, parentId) {
  if (!replyId || !parentId) return
  await ThreadIndex.remove(parentId, replyId).catch(() => {})
}

export function init () {
  if (started) return
  started = true
  window.addEventListener('nosmero:login', onLogin)
  window.addEventListener('nosmero:logout', onLogout)
  window.NosdagPending = { show, refresh: renderDeckPanel, count: () => pending.size }
  // Exposed for the thread-view curation controls (thread.js) + debugging.
  window.NosdagReq = {
    approve: approveReply,
    ignore: ignoreReply,
    block: blockReply,
    revoke: revokeReply,
    move: (parentId, replyId, dir) => ThreadIndex.move(parentId, replyId, dir)
  }
  if (myPub()) onLogin()
}

// ---------- rendering ----------
function npubShort (hex) {
  try {
    const npub = window.NostrTools.nip19.npubEncode(hex)
    return npub.slice(0, 10) + '…' + npub.slice(-4)
  } catch { return (hex || '').slice(0, 8) + '…' }
}
function relTime (sec) {
  if (!sec) return ''
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec)
  if (d < 60) return d + 's'
  if (d < 3600) return Math.floor(d / 60) + 'm'
  if (d < 86400) return Math.floor(d / 3600) + 'h'
  return Math.floor(d / 86400) + 'd'
}

// Authors restored from a previous session (loadPending) have no kind-0 in the in-memory
// profile cache, so without this the panel shows their npubs forever — only freshly-gated
// events used to trigger a fetch. Request each missing profile once per session and repaint
// when they land; the once-guard stops a render→fetch→render loop for keys with no kind-0.
const profilesRequested = new Set()
function backfillProfiles () {
  const missing = [...new Set([...pending.values()].map((it) => it.author))]
    .filter((pk) => !State.profileCache?.[pk] && !profilesRequested.has(pk))
  if (!missing.length) return
  for (const pk of missing) profilesRequested.add(pk)
  Posts.fetchProfiles?.(missing).then(renderDeckPanel).catch(() => {})
}

function rowHtml (it) {
  const prof = State.profileCache?.[it.author] || {}
  const name = prof.display_name || prof.name || npubShort(it.author)
  const avatar = prof.picture
    ? `<img class="nd-req-pic" src="${escapeHtml(prof.picture)}" alt="" onerror="this.style.visibility='hidden'">`
    : '<span class="nd-req-pic nd-req-pic-ph"></span>'
  const snip = escapeHtml((it.content || '').replace(/\s+/g, ' ').trim()) || '<i>(no text)</i>'
  const isMention = it.type === 'mention'
  const tag = isMention
    ? '<span class="nd-req-tag nd-req-tag-mention">MENTION</span>'
    : '<span class="nd-req-tag">STRANGER</span>'
  const viewTarget = it.parentId || it.id          // a mention opens its own note; a reply opens your note
  // A mention isn't a reply to YOUR note — there's nothing to attach to your thread, so no Approve.
  const approve = isMention ? '' :
    `<button class="nd-req-btn nd-req-approve" data-id="${escapeHtml(it.id)}" data-pid="${escapeHtml(it.parentId)}" data-pk="${escapeHtml(it.author)}" title="Attach this reply to your thread + host it">✓ Approve</button>`
  return `<div class="nd-req-item">
    <div class="nd-req-top">
      ${avatar}
      <div class="nd-req-who">
        <b>${escapeHtml(name)}</b>
        <span class="nd-req-meta nd-mono">${escapeHtml(npubShort(it.author))} · ${relTime(it.created_at)}</span>
      </div>
      ${tag}
    </div>
    <div class="nd-req-snip">${snip}</div>
    <div class="nd-req-act">
      ${approve}
      <button class="nd-req-btn nd-req-ignore" data-id="${escapeHtml(it.id)}" title="${isMention ? 'Dismiss this mention' : 'Pass — leave it off your wall'}">${isMention ? 'Dismiss' : 'Ignore'}</button>
      <button class="nd-req-btn nd-req-block" data-id="${escapeHtml(it.id)}" data-pk="${escapeHtml(it.author)}" title="Mute this author">Block</button>
      <button class="nd-req-view" data-pid="${escapeHtml(viewTarget)}" title="Open the thread">▸ thread</button>
    </div>
  </div>`
}

function panelHtml () {
  const items = [...pending.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
  const n = items.length
  const head = `<h4 class="nd-deck-h">Requests <span class="nd-req-n"${n ? '' : ' data-zero="1"'}>${n}</span></h4>`
  const auto = autoCount
    ? `<div class="nd-req-auto">↳ ${autoCount} repl${autoCount === 1 ? 'y' : 'ies'} from people you follow auto-attach</div>`
    : ''
  if (!n) {
    return head + auto + '<p class="nd-deck-note">No replies or mentions from people outside your follows yet. When a stranger replies to your notes or @-mentions you, it lands here for review.</p>'
  }
  return head + auto +
    '<p class="nd-req-hint">Replies + @-mentions from people you don’t follow. <b>Approve</b> attaches a reply to your thread (and hosts it); <b>Ignore</b>/<b>Dismiss</b> passes; <b>Block</b> mutes the author.</p>' +
    `<div class="nd-req-list">${items.map(rowHtml).join('')}</div>`
}

function deckRoot () {
  return document.querySelector('#rightPanel .nd-deck') || document.querySelector('.nd-deck') || null
}

function renderDeckPanel () {
  reconcileFollows()
  backfillProfiles()
  const deck = deckRoot()
  if (!deck) return
  let sec = deck.querySelector('#ndReqPanel')
  if (!sec) {
    sec = document.createElement('section')
    sec.id = 'ndReqPanel'
    sec.className = 'nd-deck-panel nd-req'
    // sit directly under "Your Node" so a stranger reply is immediately visible
    const first = deck.querySelector('.nd-deck-panel')
    if (first && first.nextSibling) deck.insertBefore(sec, first.nextSibling)
    else deck.appendChild(sec)
  }
  sec.innerHTML = panelHtml()
  sec.querySelectorAll('.nd-req-view').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pid = btn.getAttribute('data-pid')
      if (pid && typeof window.openThreadView === 'function') window.openThreadView(pid)
    })
  })
  sec.querySelectorAll('.nd-req-approve').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.disabled = true
      approveReply(btn.dataset.id, btn.dataset.pid, btn.dataset.pk)
    })
  })
  sec.querySelectorAll('.nd-req-ignore').forEach((btn) => {
    btn.addEventListener('click', () => ignoreReply(btn.dataset.id))
  })
  sec.querySelectorAll('.nd-req-block').forEach((btn) => {
    btn.addEventListener('click', () => blockReply(btn.dataset.id, btn.dataset.pk))
  })
}

function updateBadge () {
  reconcileFollows()
  const b = document.getElementById('ndRequestsCount')
  if (!b) return
  const n = pending.size
  b.textContent = n > 99 ? '99+' : String(n)
  b.style.display = n > 0 ? '' : 'none'
}

// rail "Requests" click → revert the right panel to the deck, then scroll the panel into view
function show () {
  if (!myPub()) {
    // signed out there is no queue and the deck is a sign-in prompt — ask for login
    // instead of doing nothing
    if (typeof window.showLoginModalWithLogin === 'function') window.showLoginModalWithLogin()
    return
  }
  // A contextual view (thread/profile/compose) hides #rightPanelDefaultFeed entirely —
  // close() clears the contextual state and restores it; loadDefaultContent alone repaints
  // an element that stays display:none.
  try { window.RightPanel?.close?.() } catch { /* ignore */ }
  try { window.RightPanel?.loadDefaultContent?.() } catch { /* ignore */ }
  setTimeout(() => {
    renderDeckPanel()
    document.getElementById('ndReqPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, 140)
}

// Called by telemetry-deck.js right after it (re)renders the deck — (re)injects the panel and
// makes sure the background service is running.
export function mountIntoDeck () {
  init()
  renderDeckPanel()
}
