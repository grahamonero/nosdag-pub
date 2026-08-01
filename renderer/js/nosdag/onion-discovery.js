// Nosdag Phase 6 — onion-multiaddr discovery over Nostr relays.
//
// Anonymous (Tor) mode gives each node a persistent v3 onion + a libp2p peer id; together they
// form a dialable multiaddr (/dns4/<onion>/tcp/<wsPort>/ws/p2p/<peerId>). This module makes that
// address DISCOVERABLE the Nostr way — no pasting, the same shape as nosdag:head:
//   • announceOnion()             — publish our multiaddr as a replaceable NIP-78 pointer
//       (kind 30078, d:nosdag:onion). Followers resolve it from relays, exactly like nosdag:head.
//   • ensureAuthorDialed(pubkey)  — before walking an author's DAG, resolve their onion pointer
//       and dial it over Tor (with retries — onion descriptors take a beat to propagate), so
//       Bitswap has a peer to pull from. Wired into resolveHeadCid().
//
// Everything here is a NO-OP in clearnet mode: stock Kubo finds providers via the DHT, so there's
// nothing to announce or dial. The libp2p peer id is regenerated each Tor session, so we
// re-announce on every Tor-mode start — the pointer is replaceable, so the newest one wins.

import * as State from '../state.js'
import * as Relays from '../relays.js'
import * as Utils from '../utils.js'

const ONION_D = 'nosdag:onion'
const DIAL_ATTEMPTS = 4          // onion descriptors take ~10–60s to propagate; the conn forms on a later try
const DIAL_GAP_MS = 8000
const REDIAL_TTL_MS = 60_000     // don't re-resolve+redial the same author more than once a minute
const ANNOUNCE_POLL_MS = 3000    // wait for the tor node to publish its onion before announcing
const ANNOUNCE_TRIES = 40        // ~2 min ceiling (tor bootstrap + onion publish can be slow)
const ANNOUNCE_WATCH_MS = 4000   // reactive announce: re-check node status this often until the pointer lands

function myPub () { return State.publicKey || window.NostrState?.publicKey || null }
function writeRelays () { try { return (Relays.getWriteRelays?.() || []).filter(Boolean) } catch { return [] } }

// Cache the active posture so the read path doesn't IPC on every author it resolves.
let _mode = null
let _modeAt = 0
async function currentMode () {
  const now = Date.now()
  if (_mode && now - _modeAt < 4000) return _mode
  try { const m = await window.nosdag?.mode?.get(); _mode = m?.mode || 'clearnet' } catch { _mode = 'clearnet' }
  _modeAt = now
  return _mode
}
export function invalidateModeCache () { _mode = null }

// Our own dialable onion multiaddr, once the tor node is up (null in clearnet / before ready).
async function myOnionMultiaddr () {
  try { const s = await window.nosdag?.kubo?.status?.(); return (s?.mode === 'tor' && s?.onionMultiaddr) || null } catch { return null }
}

let _announcing = false
let _announcedMa = null   // the onion multiaddr we've confirmed-published this Tor session (re-armed on leaving Tor / logout)
let _watchTimer = null
/**
 * Publish our onion as a nosdag:onion pointer so followers can dial us over Tor. No-op off Tor or
 * when signed out. Polls until the tor node has published its onion (bootstrap is slow), then
 * publishes one replaceable event to our write relays.
 */
export async function announceOnion () {
  if (_announcing) return false
  if (await currentMode() !== 'tor') return false
  const pk = myPub()
  const relays = writeRelays()
  if (!pk || !relays.length) return false
  _announcing = true
  try {
    let ma = null
    for (let i = 0; i < ANNOUNCE_TRIES; i++) {
      if (await currentMode() !== 'tor') return false // switched back to clearnet mid-wait — abort
      ma = await myOnionMultiaddr()
      if (ma) break
      await new Promise((r) => setTimeout(r, ANNOUNCE_POLL_MS))
    }
    if (!ma) { console.warn('[nosdag] onion not ready — skipping announce'); return false }
    const ptr = await Utils.signEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', ONION_D], ['onion', ma]],
      content: ''
    })
    // Require at least one relay to ACK before we treat this onion as announced. In Tor mode the
    // pool reconnects over Tor on entry, so a fire-and-forget publish can silently no-op against a
    // not-yet-dialed relay — and the onion pointer is the ONLY discovery channel in Tor mode, so a
    // silent miss leaves us undiscoverable. Awaiting one ack lets the watch loop retry until it lands.
    await Promise.any(State.pool?.publish(relays, ptr) || [])
    _announcedMa = ma
    console.log('[nosdag] 🧅 announced onion pointer:', ma)
    return true
  } catch (e) {
    console.warn('[nosdag] announceOnion failed:', e)
    return false
  } finally {
    _announcing = false
  }
}

/**
 * Reactive auto-announce. The original wiring fired announceOnion() once on login + once on the Tor
 * toggle and swallowed the result — so a stale mode cache, a login event that landed before this
 * module booted, or relays not yet dialed over Tor would silently bail with no retry (the "auto-fire
 * never actually fires" bug). This loop instead keys off node truth (kubo:status): while in Tor mode
 * it re-checks every few seconds until the onion is up and a relay ACKs the pointer, then stops. It's
 * idempotent per onion — the peerId/onion regenerates each Tor session, so a fresh session re-announces
 * while a settled one self-stops — and re-arms when we leave Tor. No manual NosdagOnion.announce() needed.
 */
export function ensureAnnounceLoop () {
  if (_watchTimer) return
  const run = async () => {
    if (!_watchTimer) return // stopped while we were scheduled
    try { await tickAnnounce() } catch (e) { console.warn('[nosdag] announce tick failed:', e) }
    if (_watchTimer) _watchTimer = setTimeout(run, ANNOUNCE_WATCH_MS) // reschedule only if still active
  }
  _watchTimer = setTimeout(run, 0) // truthy marker + immediate first check
}
function stopAnnounceLoop () {
  if (_watchTimer) { clearTimeout(_watchTimer); _watchTimer = null }
}
async function tickAnnounce () {
  let s = null
  try { s = await window.nosdag?.kubo?.status?.() } catch { s = null }
  if (!s) return                                                            // transient IPC hiccup — retry next tick
  if (s.mode !== 'tor') { _announcedMa = null; stopAnnounceLoop(); return } // back on clearnet — re-arm for the next Tor session
  if (s.ready && s.torExternal) { stopAnnounceLoop(); return }              // external proxy: outbound-only, no onion will ever come — stand down
  if (!s.ready || !s.onionMultiaddr || !myPub()) return                     // tor still bootstrapping / onion not up / signed out — wait
  if (s.onionMultiaddr === _announcedMa) { stopAnnounceLoop(); return }     // this onion already announced — done
  await announceOnion()                                                     // sets _announcedMa on a confirmed relay ack; a later tick then stops the loop
}

/** Resolve an author's onion multiaddr from their nosdag:onion pointer on relays. */
export async function resolveOnionMultiaddr (pubkey, pool, relays) {
  if (!pubkey || !pool || !Array.isArray(relays) || !relays.length) return null
  try {
    const events = await pool.querySync(relays, { kinds: [30078], authors: [pubkey], '#d': [ONION_D] })
    if (!events || !events.length) return null
    events.sort((a, b) => b.created_at - a.created_at) // newest pointer wins (replaceable)
    return events[0].tags?.find((t) => t[0] === 'onion')?.[1] || null
  } catch (e) {
    console.warn('[nosdag] resolveOnionMultiaddr failed:', e)
    return null
  }
}

const _dialed = new Map() // pubkey -> ts of the last successful/attempted dial (throttle)
/**
 * In Tor mode, resolve an author's onion and dial it so Bitswap can pull their DAG over Tor.
 * No-op in clearnet (the DHT handles provider discovery there). Best-effort: a failed dial just
 * means walkNotes() comes up empty — the honest "couldn't reach them over Tor" outcome.
 * @returns {Promise<boolean>} whether we believe we're connected
 */
export async function ensureAuthorDialed (pubkey, pool, relays) {
  if (!pubkey || pubkey === myPub()) return false // never dial yourself
  if (await currentMode() !== 'tor') return false
  if (!window.nosdag?.kubo?.swarmConnect) return false
  const last = _dialed.get(pubkey) || 0
  if (Date.now() - last < REDIAL_TTL_MS) return true // dialed recently — libp2p keeps the connection
  const ma = await resolveOnionMultiaddr(pubkey, pool, relays)
  if (!ma) { console.warn('[nosdag] no onion pointer published for', (pubkey || '').slice(0, 8)); return false }
  _dialed.set(pubkey, Date.now()) // mark attempted up-front so concurrent reads don't pile on dials
  for (let i = 1; i <= DIAL_ATTEMPTS; i++) {
    try {
      const res = await window.nosdag.kubo.swarmConnect(ma)
      if (!res?.error) { console.log('[nosdag] 🧅 connected to author over Tor:', ma); _dialed.set(pubkey, Date.now()); return true }
      console.warn(`[nosdag] dial over Tor failed (try ${i}/${DIAL_ATTEMPTS}):`, res.error)
    } catch (e) {
      console.warn(`[nosdag] dial over Tor threw (try ${i}/${DIAL_ATTEMPTS}):`, e)
    }
    if (i < DIAL_ATTEMPTS) await new Promise((r) => setTimeout(r, DIAL_GAP_MS))
  }
  _dialed.delete(pubkey) // every attempt failed — let the next read try afresh
  return false
}

/**
 * Test helper (exposed on window.NosdagOnion.fetchAuthor): resolve + dial an author over Tor, then
 * read their notes back from IPFS. Lets you verify the two-node-over-Tor path from devtools without
 * a dedicated UI button: NosdagOnion.fetchAuthor('npub1…' | '<hex pubkey>').
 */
async function fetchAuthor (pubkeyOrNpub) {
  let pk = pubkeyOrNpub
  try { if (typeof pk === 'string' && pk.startsWith('npub')) pk = window.NostrTools.nip19.decode(pk).data } catch { /* leave as-is */ }
  const V = await import('./ipfs-notes-view.js')
  return V.showIpfsNotes(pk) // → resolveHeadCid(pk) → ensureAuthorDialed → walkNotes over Tor
}

// ---------- lifecycle (mirrors pending-queue.js / consumption-tiers.js) ----------
let started = false
function onLogin () { ensureAnnounceLoop() }                 // arm the reactive announce; one tick then self-stops in clearnet
function onLogout () { stopAnnounceLoop(); _announcedMa = null; _dialed.clear(); invalidateModeCache() }

export function init () {
  if (started) return
  started = true
  window.addEventListener('nosmero:login', onLogin)
  window.addEventListener('nosmero:logout', onLogout)
  window.NosdagOnion = { announce: announceOnion, ensureAnnounceLoop, ensureAuthorDialed, resolveOnionMultiaddr, fetchAuthor }
  if (myPub()) onLogin()
}
