// Nosdag Phase 3 Slice 3 — durability ("who hosts you") + the no-bridge nudge (design §7 / §3.4).
//
// Answers one question honestly: will your content survive you going offline? What's KNOWABLE
// without a network-wide "I host you" signal:
//   • YOU — this device, but only while Nosdag is open.
//   • your Cloud Bridge — if linked, it's on a public IP 24/7 (the durable floor).
// Followers who altruistically pin you can't be enumerated yet (that needs §5.3's reverse-pin
// signal), so the indicator never invents seeders — it shows you + your bridge, and is explicit
// when the ONLY host is your own device (the at-risk state worth fixing by linking a bridge).

import { getLocalHead } from './dag-publish.js'

const cloud = () => window.nosdag?.cloudBridge

let _bridge = null  // { linked, provider?, reachable? }
let _at = 0
let _provs = null   // distinct DHT providers of your latest note (number | null)
let _provAt = 0

export async function refreshBridge () {
  // Bridges are per-account — logged out there's no "you" whose durability this could describe.
  let pk = null
  try { pk = window.NostrState?.publicKey || null } catch { /* ignore */ }
  if (!cloud()?.status || !pk) { _bridge = { linked: false }; _at = Date.now(); return _bridge }
  try {
    const s = await cloud().status({ pubkey: pk })
    _bridge = (s && s.linked) ? { linked: true, provider: s.provider, reachable: s.reachable } : { linked: false }
  } catch { _bridge = { linked: false } }
  _at = Date.now()
  return _bridge
}

/** Cached bridge state (refreshes if older than maxAgeMs). */
export async function bridge (maxAgeMs = 15000) {
  if (!_bridge || Date.now() - _at > maxAgeMs) await refreshBridge()
  return _bridge
}

/** Last known bridge state without an IPC (null until bridge() has run once). */
export function bridgeSync () { return _bridge }

/** True when nothing but your own (offline-prone) device holds your content. */
export function isAtRisk () { return !_bridge?.linked }

/** The hosts we can honestly name: you + your bridge (if linked). */
export function hosts () {
  const list = [{ label: 'You', sub: 'this device', kind: 'local' }]
  if (_bridge?.linked) list.push({ label: _bridge.provider || 'Cloud Bridge', sub: 'you', kind: 'bridge' })
  return list
}

/**
 * Distinct nodes the DHT reports providing your LATEST note — the trustless redundancy count (§7).
 * Includes your own node + bridge + any follower hosting you; a follower shows up within minutes of
 * pinning (once their node announces to the DHT). Cached; returns null if unknowable.
 */
export async function providerCount (maxAgeMs = 30000) {
  const head = getLocalHead(window.NostrState?.publicKey)
  if (!head || !window.nosdag?.kubo?.providers) return null
  if (_provs != null && Date.now() - _provAt < maxAgeMs) return _provs
  try { const r = await window.nosdag.kubo.providers(head, { timeoutMs: 8000, max: 40 }); _provs = (r && !r.error && typeof r.count === 'number') ? r.count : null }
  catch { _provs = null }
  _provAt = Date.now()
  return _provs
}
