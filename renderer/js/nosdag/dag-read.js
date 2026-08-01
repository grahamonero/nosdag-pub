// Nosdag Phase 2 Step 3 — the READ path.
//
// Reading a Nosdag author's notes from IPFS (not relays):
//   1. resolveHeadCid(pubkey) — fetch their nosdag:head pointer (kind 30078, d:nosdag:head)
//      from relays → the latest head CID
//   2. walkNotes(headCid) — getPost the head, then walk `prev` back through the chain, pulling
//      each note's dag-cbor envelope from IPFS (Bitswap if not local), verifying every signature
//      and the link↔string-tag consistency invariant. Returns the notes newest→oldest.
//
// The events returned are ordinary signed Nostr events — feed/thread renderers can consume them
// exactly like relay-fetched notes; the only difference is provenance (IPFS).

/**
 * Resolve an author's latest head CID from their nosdag:head pointer on relays.
 * @returns {Promise<string|null>}
 */
export async function resolveHeadCid (pubkey, pool, relays) {
  if (!pubkey || !pool || !Array.isArray(relays) || !relays.length) return null
  try {
    const events = await pool.querySync(relays, { kinds: [30078], authors: [pubkey], '#d': ['nosdag:head'] })
    if (!events || !events.length) return null
    events.sort((a, b) => b.created_at - a.created_at) // newest pointer wins (replaceable)
    const head = events[0].tags?.find((t) => t[0] === 'head')?.[1] || null
    // Phase 6 — anonymous (Tor) mode has no DHT, so Bitswap can only pull from peers we've dialed.
    // Resolve the author's nosdag:onion pointer and dial it over Tor here, so every remote DAG read
    // (thread backfill, "their notes from IPFS", …) reaches them. No-op in clearnet; best-effort —
    // a failed dial just means the walk comes up empty rather than blocking head resolution.
    if (head) {
      try { const OD = await import('./onion-discovery.js'); await OD.ensureAuthorDialed(pubkey, pool, relays) }
      catch (e) { console.warn('[nosdag] ensureAuthorDialed failed:', e) }
    }
    return head
  } catch (e) {
    console.warn('[nosdag] resolveHeadCid failed:', e)
    return null
  }
}

/**
 * Walk an author's note chain from a head CID, pulling each envelope from IPFS.
 * @returns {Promise<Array<object>>} signed Nostr events, newest → oldest.
 */
export async function walkNotes (headCid, { limit = 200, verify = true, author = null } = {}) {
  if (!headCid || !window.nosdag?.kubo?.getPost) return []
  const NT = window.NostrTools
  const notes = []
  const seen = new Set()
  let cur = headCid
  let n = 0
  let expectedAuthor = author // bound to the resolved author when the caller knows it; else established at hop 0

  while (cur && n < limit) {
    if (seen.has(cur)) { console.warn('[nosdag] cycle detected at', cur); break }
    seen.add(cur)

    const env = await window.nosdag.kubo.getPost(cur, { timeout: 20000 }) // { v, event, prev, skip } — Bitswap-fetches if remote; bounded so a missing block breaks the walk instead of hanging it
    if (!env || env.error || !env.event) { console.warn('[nosdag] missing/unreadable envelope at', cur, env?.error || ''); break }

    const ev = env.event
    if (verify && NT?.verifyEvent && !NT.verifyEvent(ev)) { console.warn('[nosdag] signature failed at', cur); break }

    // author-continuity invariant (H6): a single author's DAG never crosses authors, so every hop
    // MUST be the same signer the head established (or the caller's expected author). Without it a
    // signed head could prev-link to another user's / fabricated envelopes and have them rendered —
    // and pinned — as this author's history. Only meaningful alongside `verify`.
    if (expectedAuthor == null) expectedAuthor = ev.pubkey
    else if (ev.pubkey !== expectedAuthor) { console.warn('[nosdag] author mismatch at', cur, `(expected ${expectedAuthor?.slice(0, 8)}… got ${ev.pubkey?.slice(0, 8)}…)`); break }

    // consistency invariant: the IPLD link we follow MUST equal the signed string tag
    const prevTag = ev.tags?.find((t) => t[0] === 'prev')?.[1] ?? null
    const prevLink = env.prev ?? null
    if (prevTag !== prevLink) { console.warn('[nosdag] link/tag mismatch at', cur, `(tag=${prevTag} link=${prevLink})`); break }

    ev._nosdagCid = cur // provenance: the envelope CID this note was read from (display only; verifyEvent ignores it)
    notes.push(ev)
    cur = prevLink
    n++
  }

  return notes
}

/** Convenience: resolve an author's head from relays, then walk their notes from IPFS. */
export async function readAuthorNotes (pubkey, pool, relays, opts) {
  const head = await resolveHeadCid(pubkey, pool, relays)
  if (!head) return { head: null, notes: [] }
  const notes = await walkNotes(head, { ...(opts || {}), author: pubkey }) // bind hop-0 to the resolved author (H6)
  return { head, notes }
}

// ---- Timeline-archive READ side --------------------------------------------------------
// Archived notes (pre-Nosdag imports) are standalone envelopes {v, event, links:{}} under a
// dag-cbor manifest — no prev chain to walk, so no link↔tag invariant. The manifest itself
// is UNSIGNED; its authority is the signed nosdag:archive pointer that names its CID, so a
// reader must verify every event's signature AND bind it to the manifest's author.

/**
 * Resolve an author's latest archive-manifest CID from their nosdag:archive pointer.
 * Mirrors resolveHeadCid (incl. the Tor onion dial — required for any remote Bitswap).
 * @returns {Promise<string|null>}
 */
export async function resolveArchiveCid (pubkey, pool, relays) {
  if (!pubkey || !pool || !Array.isArray(relays) || !relays.length) return null
  try {
    const events = await pool.querySync(relays, { kinds: [30078], authors: [pubkey], '#d': ['nosdag:archive'] })
    if (!events || !events.length) return null
    events.sort((a, b) => b.created_at - a.created_at) // newest pointer wins (replaceable)
    const cid = events[0].tags?.find((t) => t[0] === 'archive')?.[1] || null
    if (cid) {
      try { const OD = await import('./onion-discovery.js'); await OD.ensureAuthorDialed(pubkey, pool, relays) }
      catch (e) { console.warn('[nosdag] ensureAuthorDialed failed:', e) }
    }
    return cid
  } catch (e) {
    console.warn('[nosdag] resolveArchiveCid failed:', e)
    return null
  }
}

const archiveReadCache = new Map() // `${manifestCid}:${limit}` -> result (render reuse within a session)

/**
 * Read an author's timeline archive: manifest → per-note envelopes, each signature-verified
 * and bound to the manifest's author. Media URLs in the manifest's url→CID map are swapped
 * to the local gateway AFTER verification — a swapped event's content no longer hashes to
 * its id, so results are render-only: never re-verify or re-publish them.
 * The manifest carries no timestamps and its order is only roughly ascending, so `limit`
 * caps from the TAIL (newest-ish heuristic) and results are sorted by created_at after fetch.
 * @returns {Promise<{manifestCid: string|null, notes: object[], count: number, skipped: number}>}
 *          notes newest → oldest.
 */
export async function readAuthorArchive (pubkey, { pool = null, relays = [], limit = 1000 } = {}) {
  const empty = { manifestCid: null, notes: [], count: 0, skipped: 0 }
  if (!pubkey || !window.nosdag?.archive?.get || !window.nosdag?.kubo?.getPost) return empty
  let manifestCid = null
  try { manifestCid = localStorage.getItem('nosdag:archive:' + pubkey) } catch { /* private mode */ }
  if (!manifestCid && pool) manifestCid = await resolveArchiveCid(pubkey, pool, relays)
  if (!manifestCid) return empty

  // Keyed by author too: the author-binding refusal below must never be short-circuited
  // by a cache entry another pubkey's read created for the same manifest.
  const cacheKey = `${pubkey.toLowerCase()}:${manifestCid}:${limit}`
  if (archiveReadCache.has(cacheKey)) return archiveReadCache.get(cacheKey)

  const man = await window.nosdag.archive.get({ cid: manifestCid })
  if (!man || man.error) { console.warn('[nosdag] archive manifest unreadable:', man?.error || 'no result'); return empty }
  if ((man.pubkey || '').toLowerCase() !== pubkey.toLowerCase()) {
    console.warn('[nosdag] archive manifest author mismatch — refusing')
    return empty
  }

  const NT = window.NostrTools
  const gw = window.nosdag?.kubo?.gateway || ''
  const mediaEntries = Object.entries(man.media || {})
  const all = man.notes || []
  const cids = limit > 0 && all.length > limit ? all.slice(-limit) : all
  if (all.length > cids.length) console.warn(`[nosdag] archive read capped at ${cids.length} of ${all.length} notes`)

  const notes = []
  let skipped = 0
  const WINDOW = 15 // parallel getPosts per batch — never serial over thousands, never unbounded
  for (let i = 0; i < cids.length; i += WINDOW) {
    const results = await Promise.all(cids.slice(i, i + WINDOW).map(async (cid) => {
      try {
        const env = await window.nosdag.kubo.getPost(cid, { timeout: 20000 })
        if (!env || env.error || !env.event) return null
        const ev = env.event
        if (NT?.verifyEvent && !NT.verifyEvent(ev)) return null
        if ((ev.pubkey || '').toLowerCase() !== pubkey.toLowerCase()) return null // author binding (H6 analogue)
        // Swap archived media links to the local gateway so the bytes come from this node
        // (mirror-fetch then owns degradation). A URL absent from the map keeps its
        // original HTTP form by design (dropped/unhealable media).
        if (gw && mediaEntries.length && typeof ev.content === 'string') {
          for (const [url, mcid] of mediaEntries) {
            if (ev.content.includes(url)) ev.content = ev.content.split(url).join(gw + mcid)
          }
        }
        ev._nosdagCid = cid // provenance (display only)
        return ev
      } catch { return null }
    }))
    for (const ev of results) { if (ev) notes.push(ev); else skipped++ }
  }
  notes.sort((a, b) => b.created_at - a.created_at)
  const result = { manifestCid, notes, count: man.count || notes.length, skipped }
  archiveReadCache.set(cacheKey, result)
  return result
}

// Best-effort NIP-09 delete filter: one batched query for the author's kind-5s referencing
// the given ids. Cached per author+posture for the session (silent Tor relays would
// otherwise poison a later clearnet pass). Silent relays → empty set — best-effort by
// design; the archive itself is unchanged and a re-import refreshes the snapshot.
const deletedCache = new Map() // `${pubkey}:${posture}` -> Set<id>
export async function fetchDeletedIds (pubkey, ids, pool, relays) {
  let posture = 'clearnet'
  try { posture = localStorage.getItem('nosdag:posture') === 'tor' ? 'tor' : 'clearnet' } catch { /* private mode */ }
  const cacheKey = `${pubkey}:${posture}`
  if (deletedCache.has(cacheKey)) return deletedCache.get(cacheKey)
  const out = new Set()
  if (!pool || !Array.isArray(relays) || !relays.length || !ids?.length) return out
  const timeoutMs = posture === 'tor' ? 12000 : 5000
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const events = await Promise.race([
        pool.querySync(relays, { kinds: [5], authors: [pubkey], '#e': chunk }),
        new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs))
      ])
      for (const ev of events || []) {
        for (const t of ev.tags || []) if (t[0] === 'e' && t[1]) out.add(t[1])
      }
    }
    deletedCache.set(cacheKey, out)
  } catch (e) {
    console.warn('[nosdag] delete-filter query failed:', e?.message || e)
  }
  return out
}
