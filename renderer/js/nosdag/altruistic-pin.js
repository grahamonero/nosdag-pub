// Nosdag Phase 3 Slice 2 — Altruistic pinning (design §5.1).
//
// Your node hosts the accounts you follow: it pins their note DAG (the head CID, recursive → ALL
// their note text) plus their media to YOUR local Kubo node, so their content survives them going
// offline. Self-selected at first login (you pick who); each new follow then auto-hosts unless you
// turn that off. Bounded by a per-account quota and a global disk cap — you only ever spend disk on
// people you chose to follow, and only up to the caps.
//
// State (per logged-in pubkey):
//   nosdag:altpin:hosted:<mypk>  → { <followeePk>: { head, cids:[…], bytes, notes, media, ts } }
// Settings (global):
//   nosdag:altpin:autonew     '1'|'0'  (default on)
//   nosdag:altpin:percapMB    per-account quota (default 250)
//   nosdag:altpin:globalcapMB total cap across all hosted accounts (default 5000 = 5 GB)

import * as State from '../state.js'
import * as Relays from '../relays.js'
import { resolveHeadCid, walkNotes } from './dag-read.js'
import { extractMediaCids } from './cloud-bridge.js'

const MB = 1024 * 1024
// Upper bound on the note chain we'll walk when hosting an account. It caps the envelope fetch (a blind
// recursive pin would let anyone you follow pull an attacker-sized chain onto your disk), and — because
// we refuse a chain that hits this bound — it guarantees the whole history is local before we recursive-
// pin it, so that pin is fetch-free. (Security review 2026-07-03, H-B.)
const HOST_MAX_NOTES = 20000
const kubo = () => window.nosdag?.kubo

function num (k, d) { try { const v = parseInt(localStorage.getItem(k) || '', 10); return Number.isFinite(v) && v > 0 ? v : d } catch { return d } }
export const perAccountMB = () => num('nosdag:altpin:percapMB', 250)
export const globalCapMB = () => num('nosdag:altpin:globalcapMB', 5120) // 5 GB default
export function setDefaultPerAccountMB (mb) { try { localStorage.setItem('nosdag:altpin:percapMB', String(Math.max(1, mb | 0))) } catch { /* private mode */ } }
export function setGlobalCapMB (mb) { try { localStorage.setItem('nosdag:altpin:globalcapMB', String(Math.max(1, mb | 0))) } catch { /* private mode */ } }

// Per-account quota overrides — granular "how much to host" per account; falls back to the default.
const CAPS_KEY = () => `nosdag:altpin:caps:${State.publicKey || 'anon'}`
function loadCaps () { try { return JSON.parse(localStorage.getItem(CAPS_KEY()) || '{}') } catch { return {} } }
function saveCaps (m) { try { localStorage.setItem(CAPS_KEY(), JSON.stringify(m)) } catch { /* private mode */ } }
export function accountCapMB (pk) { const o = loadCaps()[pk]; return (Number.isFinite(o) && o > 0) ? o : perAccountMB() }
export function setAccountCap (pk, mb) { const m = loadCaps(); if (mb && mb > 0) m[pk] = mb | 0; else delete m[pk]; saveCaps(m) }

export function autoNewFollows () { try { return localStorage.getItem('nosdag:altpin:autonew') !== '0' } catch { return true } }
export function setAutoNewFollows (on) { try { localStorage.setItem('nosdag:altpin:autonew', on ? '1' : '0') } catch { /* private mode */ } }

// Per-account "notes only" — host the note chain but skip their media (the bulk of most accounts'
// size). A preference, not state: it survives host on/off and applies to every future attempt,
// including the retry loop's.
const NOTESONLY_KEY = () => `nosdag:altpin:notesonly:${State.publicKey || 'anon'}`
function loadNotesOnly () { try { return JSON.parse(localStorage.getItem(NOTESONLY_KEY()) || '{}') } catch { return {} } }
function saveNotesOnly (m) { try { localStorage.setItem(NOTESONLY_KEY(), JSON.stringify(m)) } catch { /* private mode */ } }
export function notesOnly (pk) { return !!loadNotesOnly()[pk] }
export function setNotesOnly (pk, on) {
  if (!pk) return
  const m = loadNotesOnly()
  if (on) m[pk] = 1; else delete m[pk]
  saveNotesOnly(m)
}

const HOSTED_KEY = () => `nosdag:altpin:hosted:${State.publicKey || 'anon'}`
function loadHosted () { try { return JSON.parse(localStorage.getItem(HOSTED_KEY()) || '{}') } catch { return {} } }
function saveHosted (m) { try { localStorage.setItem(HOSTED_KEY(), JSON.stringify(m)) } catch { /* private mode */ } }

// Hosting INTENT, kept separate from the achieved-state records above: turning a follow's hosting
// on stays wanted until the user turns it off, even while the account is unreachable — an offline
// peer must not silently cancel the choice. The retry loop below works the wanted-but-not-hosted
// set for as long as the app runs.  { <followeePk>: { ts, backoff?, nextTry?, lastReason?, lastError? } }
const WANT_KEY = () => `nosdag:altpin:want:${State.publicKey || 'anon'}`
function loadWant () { try { return JSON.parse(localStorage.getItem(WANT_KEY()) || '{}') } catch { return {} } }
function saveWant (m) { try { localStorage.setItem(WANT_KEY(), JSON.stringify(m)) } catch { /* private mode */ } }
export function wantHost (pk) { return !!loadWant()[pk] }
export function wantedMap () { return loadWant() }
export function wantRecord (pk) { return loadWant()[pk] || null }
export function setWant (pk, on) {
  if (!pk) return
  const m = loadWant()
  if (on) { if (!m[pk]) m[pk] = { ts: Math.floor(Date.now() / 1000) } } else { delete m[pk] }
  saveWant(m)
}

/** Refusals waiting can't cure — the toggle should turn back off. Everything else (offline peer,
 *  silent relays, node still booting, a failed measure) is transient: intent sticks and retries. */
export function isPermanentRefusal (reason) {
  return reason === 'self' || reason === 'cap' || reason === 'too-big'
}

export function isHosted (pk) { return !!loadHosted()[pk] }
export function hostedMap () { return loadHosted() }
export function hostedRecord (pk) { return loadHosted()[pk] || null }
export function usage () {
  const m = loadHosted()
  let total = 0
  for (const k in m) total += (m[k]?.bytes || 0)
  return { totalBytes: total, count: Object.keys(m).length, capBytes: globalCapMB() * MB, perAccountBytes: perAccountMB() * MB }
}

async function sizeOf (cid) {
  try { const r = await kubo()?.dagSize?.(cid); return (r && !r.error && r.bytes) ? r.bytes : 0 } catch { return 0 }
}

/**
 * Host one account: pin its head (recursive → all note text) + media newest-first within the
 * per-account quota and the remaining global cap. onProgress(msg) is optional.
 * @returns {Promise<{ok:boolean, head?, notes?, media?, bytes?, error?}>}
 */
let hostBusy = false // single-flight: manual toggles, refreshHosted and the retry loop must not stack attempts

export async function hostAccount (pk, onProgress = () => {}) {
  if (hostBusy) return { ok: false, reason: 'busy', error: 'Busy with another hosting attempt — retrying shortly' }
  hostBusy = true
  try {
    return await hostAccountInner(pk, onProgress)
  } finally {
    hostBusy = false
  }
}

async function hostAccountInner (pk, onProgress = () => {}) {
  if (!kubo()?.pinRecursive) return { ok: false, reason: 'node-unavailable', error: 'node unavailable' }
  if (!pk) return { ok: false, error: 'no pubkey' }
  // You can't host yourself — your notes already live on your node, and your bridge is what keeps
  // them online when you're away. (Also: a self-host record's CIDs are your own pins, so unhosting
  // it would drop your real content.)
  if (pk === State.publicKey) return { ok: false, reason: 'self', error: "You can't host yourself" }

  onProgress('Resolving…')
  // Only accounts that PUBLISH via Nosdag have a nosdag:head DAG to pin. A regular Nostr account
  // keeps its notes only on relays — nothing in IPFS — so there's nothing to host.
  const head = await resolveHeadCid(pk, State.pool, Relays.getReadRelays?.() || [])
  if (!head) return { ok: false, reason: 'no-content', error: 'No Nosdag content to host' }

  const u = usage()
  let globalRemaining = u.capBytes - u.totalBytes + (loadHosted()[pk]?.bytes || 0) // re-hosting frees its own prior bytes
  if (globalRemaining <= 0) return { ok: false, reason: 'cap', error: 'Hosting cap reached — unhost someone or raise the cap' }

  const pinned = []
  let acctBytes = 0
  const perCap = accountCapMB(pk) * MB

  // 1) Walk the chain FIRST — verified + author-bound (H6/H7), so we never pin unverified or foreign
  //    bytes, and so the history is fetched envelope-by-envelope (bounded by HOST_MAX_NOTES) instead of
  //    letting a blind recursive pin pull an attacker-sized chain. A chain that hits the bound is refused,
  //    which also guarantees the recursive pin in step 3 is fetch-free (whole chain already local).
  onProgress('Reading notes…')
  let notes = []
  try { notes = await walkNotes(head, { limit: HOST_MAX_NOTES, author: pk }) } catch { /* treated as unreachable below */ }
  if (!notes.length) return { ok: false, reason: 'unreachable', error: 'Couldn’t reach their notes — they may be offline with no provider' }
  if (notes.length >= HOST_MAX_NOTES) return { ok: false, reason: 'too-big', error: 'Their note history is too long to host' }

  // 2) Measure now that the whole chain is local — accurate, no fetch. A size we CAN'T determine is a
  //    failure, not zero: otherwise an oversized DAG whose dagSize errors would slip under the cap (H8).
  const headSize = await sizeOf(head)
  if (!(headSize > 0)) return { ok: false, reason: 'size-unknown', error: 'Couldn’t measure their note history — try again' }
  if (headSize > perCap || headSize > globalRemaining) {
    return { ok: false, reason: 'too-big', error: 'Their note history exceeds your per-account hosting quota — raise it to host them' }
  }

  // 3) Pin the head recursively — every envelope is already local from the verified walk, so this is
  //    fetch-free; one pin covers the whole chain (design §5.2), keeping unhost a single unpinRecursive.
  onProgress('Pinning notes…')
  const hr = await kubo().pinRecursive(head, 45000)
  if (hr?.error) return { ok: false, reason: 'unreachable', error: 'Couldn’t pin their notes right now' }
  pinned.push(head); acctBytes += headSize; globalRemaining -= headSize

  // 4) media, newest-first, until this account's quota or the global cap is hit — unless the user
  //    opted this account down to notes only
  const skipMedia = notesOnly(pk)
  const media = []
  if (!skipMedia) {
    const seen = new Set()
    for (const ev of notes) for (const c of extractMediaCids(ev)) if (!seen.has(c)) { seen.add(c); media.push(c) }
  }

  let mediaPinned = 0
  let consecFail = 0
  for (const c of media) {
    if (acctBytes >= perCap || globalRemaining <= 0) break
    // Pin first (bounded), THEN measure — sizing a not-yet-local CID would itself fetch and could hang.
    const pr = await kubo().pinRecursive(c, 30000)
    if (pr?.error) { if (++consecFail >= 3) break; continue } // a few unreachable in a row → give up on this account's media
    consecFail = 0
    const sz = await sizeOf(c)
    // Size unknown, or this item would breach the quota → don't host it. Unpin what we just pinned so it
    // isn't parked on disk uncounted (GC then reclaims it); size-unknown is a fetch failure, a real
    // over-cap item stops the loop (media is newest-first). Closes the size-unknown-counts-as-zero hole.
    if (!(sz > 0) || acctBytes + sz > perCap || globalRemaining - sz < 0) {
      try { await kubo().unpinRecursive(c) } catch { /* best-effort */ }
      if (!(sz > 0)) { if (++consecFail >= 3) break; continue }
      break
    }
    pinned.push(c); acctBytes += sz; globalRemaining -= sz; mediaPinned++
    onProgress(`Pinning media ${mediaPinned}/${media.length}…`)
  }

  const m = loadHosted()
  m[pk] = { head, cids: pinned, bytes: acctBytes, notes: notes.length, media: mediaPinned, notesOnly: skipMedia || undefined, ts: Math.floor(Date.now() / 1000) }
  saveHosted(m)
  return { ok: true, head, notes: notes.length, media: mediaPinned, bytes: acctBytes }
}

/** Stop hosting an account: unpin everything we pinned for them, drop the record + the intent. */
export async function unhostAccount (pk) {
  setWant(pk, false)
  const m = loadHosted()
  const rec = m[pk]
  if (!rec) return { ok: true }
  for (const c of (rec.cids || [])) { try { await kubo()?.unpinRecursive?.(c) } catch { /* best-effort */ } }
  delete m[pk]; saveHosted(m)
  return { ok: true }
}

/** Auto-host on new follow (opt-out via autoNewFollows); unhost on unfollow. Called from toggleFollow.
 *  Intent is recorded BEFORE the attempt, so following someone whose node is offline still hosts
 *  them when they next come online (the retry loop picks it up). */
export async function onFollowChange (pk, nowFollowing) {
  try {
    if (!pk || pk === State.publicKey) return // never host/unhost yourself (unhost would unpin your own notes)
    if (nowFollowing) {
      if (autoNewFollows() && !isHosted(pk)) {
        setWant(pk, true)
        const res = await hostAccount(pk)
        if (!res.ok && isPermanentRefusal(res.reason)) setWant(pk, false)
      }
    } else {
      setWant(pk, false)
      if (isHosted(pk)) await unhostAccount(pk)
    }
  } catch (e) { console.warn('[nosdag] altpin onFollowChange:', e) }
}

/** Drop a host record WITHOUT unpinning — used to forget a stray self-host. Its CIDs are your OWN
 *  notes (pinned by publishing), so unpinning them would drop your real content. */
export function forgetHost (pk) {
  setWant(pk, false)
  const m = loadHosted()
  if (!m[pk]) return false
  delete m[pk]; saveHosted(m); return true
}

// ---------- background retry: keep working the wanted-but-unhosted set while the app runs ----------
// One attempt per tick, gated on the hostBusy single-flight (an attempt can take minutes on a slow
// walk, and overlapping attempts would race the quota accounting). Per-account exponential backoff
// so a permanently-absent peer costs one cheap relay query every few minutes, not a hammer.
const RETRY_TICK_MS = 30 * 1000
const RETRY_BASE_MS = 45 * 1000     // first failure → retry in ~90 s (base doubles before use)
const RETRY_MAX_MS = 15 * 60 * 1000
let retryTimer = null

function announce (pk, hosted) {
  try { window.dispatchEvent(new CustomEvent('nosdag:altpin-changed', { detail: { pk, hosted } })) } catch { /* no DOM */ }
}

async function retryTick () {
  try {
    if (!State.publicKey || hostBusy || !kubo()?.pinRecursive) return
    const hosted = loadHosted()
    const now = Date.now()
    const wanted = loadWant()
    const pk = Object.keys(wanted).find((k) =>
      !hosted[k] && k !== State.publicKey && (!wanted[k].nextTry || now >= wanted[k].nextTry))
    if (!pk) return
    const res = await hostAccount(pk)
    const m = loadWant()
    if (!m[pk]) return // toggled off mid-attempt
    if (res.ok) {
      delete m[pk].backoff; delete m[pk].nextTry; delete m[pk].lastReason; delete m[pk].lastError
      saveWant(m)
      announce(pk, true)
      try {
        const p = State.profileCache?.[pk] || {}
        const who = (p.display_name || p.name || '').trim() || (pk.slice(0, 8) + '…')
        const T = await import('../ui/toasts.js')
        T.showToast(`Now hosting ${who} — their notes are pinned to your node`, 'success')
      } catch { /* toast is best-effort */ }
    } else if (isPermanentRefusal(res.reason)) {
      delete m[pk]; saveWant(m) // waiting can't cure it — drop the intent so the toggle shows off
      announce(pk, false)
    } else {
      const backoff = Math.min(RETRY_MAX_MS, (m[pk].backoff || RETRY_BASE_MS) * 2)
      m[pk].backoff = backoff
      m[pk].nextTry = now + backoff + Math.floor(Math.random() * 15000)
      m[pk].lastReason = res.reason || 'error'
      m[pk].lastError = res.error || ''
      saveWant(m)
      announce(pk, false)
    }
  } catch (e) { console.warn('[nosdag] altpin retry:', e) }
}

/** Start the app-lifetime retry loop (idempotent; ticks no-op while logged out). */
export function initRetry () {
  if (retryTimer) return
  retryTimer = setInterval(retryTick, RETRY_TICK_MS)
  setTimeout(retryTick, 8000) // first pass shortly after boot, once the node is up
}

/** Re-pin hosted accounts whose head has advanced (new notes/media). onProgress(msg) optional. */
export async function refreshHosted (onProgress = () => {}) {
  const m = loadHosted()
  const pks = Object.keys(m)
  let i = 0, updated = 0
  for (const pk of pks) {
    i++
    onProgress(`Checking ${i}/${pks.length}…`)
    try {
      const head = await resolveHeadCid(pk, State.pool, Relays.getReadRelays?.() || [])
      if (head && head !== m[pk].head) { await hostAccount(pk, onProgress); updated++ }
    } catch { /* skip */ }
  }
  return { ok: true, checked: pks.length, updated }
}
