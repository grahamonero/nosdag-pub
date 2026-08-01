// Nosdag — Timeline import (Settings → "Import timeline to IPFS").
//
// Nosdag only stores notes written AFTER install into IPFS (the §13.1 prev-linked chain).
// This imports the user's PRE-Nosdag timeline: fetch every kind-1 note they authored from
// their relays, verify each signature, store each as a standalone envelope
// ({ v, event, links: {} }), mirror the HTTP media those notes reference into the local
// node, and commit everything under ONE dag-cbor archive manifest whose IPLD links make a
// single recursive pin cover it all.
//
// Old notes can never join the chain: their tags are signed, so a prev tag can't be added,
// and the reader invariant (every IPLD link mirrors a signed tag) forbids link-only
// chaining. The archive is the honest shape — individually sig-verified envelopes plus a
// manifest that names them. Announced as NIP-78 app data (kind 30078, d:"nosdag:archive",
// ['archive', <manifestCid>]) — the same pattern as nosdag:head.
//
// Re-runs are incremental: the previous manifest's event ids carry forward, and only notes
// relays return that aren't already archived (and aren't chain notes — those carry the
// signed prev tag) are added. Media mirroring is best-effort per URL; a dead host skips
// that file, never the import.

import * as State from '../state.js'
import * as Relays from '../relays.js'
import * as Utils from '../utils.js'

const ARCHIVE_KEY = (pk) => `nosdag:archive:${pk}`
const PAGE = 500
const MAX_PAGES = 40                      // 20k notes — a backstop, not a target
const PAGE_TIMEOUT = 15000
const MEDIA_MAX_BYTES = 50 * 1024 * 1024  // matches the composer's attachment cap

const shell = () => window.nosdag?.archive

export function getLocalArchive (pk) {
  try { return localStorage.getItem(ARCHIVE_KEY(pk)) } catch { return null }
}

// HTTP image/video URLs in a note body — the media worth mirroring. ipfs:// and gateway
// /ipfs/ refs are already content-addressed (and belong to chain notes anyway).
export function extractHttpMediaUrls (content) {
  if (typeof content !== 'string') return []
  const re = /https?:\/\/[^\s<>"']+\.(?:jpg|jpeg|png|gif|webp|mp4|webm|ogg)(?:\?[^\s<>"']*)?/gi
  const out = new Set()
  let m
  while ((m = re.exec(content)) !== null) {
    if (!/\/ipfs\//i.test(m[0])) out.add(m[0])
  }
  return [...out]
}

// Every kind-1 the user authored, paginated with an `until` cursor until relays run dry.
async function fetchAllAuthored (pk, onProgress) {
  const relays = [...new Set([...Relays.getReadRelays(), ...Relays.getWriteRelays()])]
  const byId = new Map()
  let until = Math.floor(Date.now() / 1000) + 600
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await new Promise((resolve) => {
      const got = []
      let done = false
      const finish = () => { if (!done) { done = true; try { sub.close() } catch { /* closed */ } resolve(got) } }
      const sub = State.pool.subscribeMany(relays, [{ kinds: [1], authors: [pk], limit: PAGE, until }], {
        onevent: (ev) => got.push(ev),
        oneose: finish
      })
      setTimeout(finish, PAGE_TIMEOUT)
    })
    let fresh = 0
    for (const ev of events) {
      if (ev.pubkey !== pk || ev.kind !== 1) continue
      if (!byId.has(ev.id)) { byId.set(ev.id, ev); fresh++ }
      if (ev.created_at < until) until = ev.created_at
    }
    onProgress?.(byId.size)
    if (!fresh) break
  }
  return [...byId.values()]
}

/**
 * Heal pass: media mirrored before chunked adds landed in the Tor store as ONE raw block —
 * oversized ones (>2MiB) can't cross postures (Kubo refuses the block) and no peer can
 * fetch them over Bitswap, which strands the whole archive in this store. Re-fetch those
 * URLs (addMedia now chunks) and swap the map entry in place; a URL that no longer
 * resolves is dropped from the map so the archive closure becomes transferable again — the
 * note text keeps the original URL either way. checkMedia only reads the local store, so
 * this is a no-op in the posture that doesn't hold the archive.
 */
async function healOversizedMedia (media, onStatus) {
  const out = { healed: 0, dropped: 0 }
  const check = shell()?.checkMedia
  if (!check) return out
  const cids = [...new Set(Object.values(media))]
  if (!cids.length) return out
  const res = await check({ cids })
  const info = res?.blocks || {}
  const bad = new Set(cids.filter((c) => info[c]?.oversized === true))
  if (!bad.size) return out
  const targets = Object.entries(media).filter(([, c]) => bad.has(c))
  let n = 0
  for (const [url] of targets) {
    n++
    onStatus(`Re-mirroring oversized media… ${n}/${targets.length}`)
    try {
      const res2 = await fetch(url)
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`)
      const buf = new Uint8Array(await res2.arrayBuffer())
      if (!buf.length || buf.length > MEDIA_MAX_BYTES) throw new Error('empty or oversized')
      const add = await window.nosdag.kubo.addMedia(buf)
      if (add?.error) throw new Error(add.error)
      media[url] = add.cid
      out.healed++
    } catch (e) {
      delete media[url]
      out.dropped++
      console.warn('[nosdag] could not re-mirror oversized media — dropped from the archive:', url, String(e?.message || e))
    }
  }
  return out
}

/**
 * Store a batch of (already-fetched) signed events as archive envelopes + manifest.
 * Separated from the relay fetch so the smoke can drive it with crafted events and so
 * media mirroring can be skipped headless. Returns the import summary.
 */
export async function importEvents (pk, events, { mirrorMedia = true, onStatus = () => {} } = {}) {
  if (!shell()) throw new Error('the timeline import runs in the Nosdag desktop app')
  const NT = window.NostrTools

  // chain notes already live in IPFS — they carry the signed prev tag
  const nonChain = events.filter((ev) => !(ev.tags || []).some((t) => t?.[0] === 'prev'))
  const skippedChain = events.length - nonChain.length

  // Mirror a manifest to the account's Cloud Bridge, if linked — ONE recursive remote pin
  // covers every archived note + media file (real IPLD links). Best-effort either way.
  const mirrorToBridge = async (cid) => {
    try {
      const r = await window.nosdag?.cloudBridge?.pinMany?.({ pubkey: pk, cids: [cid] })
      if (r?.kind) console.log(`[nosdag] ☁ archive mirrored to the ${r.kind} bridge: ${cid}`)
    } catch { /* bridge optional */ }
  }

  // prior archive → incremental re-run. The read is bounded in main; if the manifest isn't
  // in THIS posture's store (and the catch-up couldn't bring it over), rebuild fresh —
  // envelopes are content-addressed, so re-imported notes land on their identical CIDs.
  const prevManifestCid = getLocalArchive(pk)
  let prevIds = []
  let prevNotes = []
  let prevMedia = {}
  if (prevManifestCid) {
    const prev = await shell().get({ cid: prevManifestCid })
    if (prev && !prev.error && prev.pubkey === pk) {
      prevIds = prev.ids || []
      prevNotes = prev.notes || []
      prevMedia = prev.media || {}
    } else if (prev?.error) {
      console.warn('[nosdag] previous archive unreadable here — rebuilding fresh:', prev.error)
    }
  }
  const have = new Set(prevIds)

  const fresh = []
  let badSig = 0
  for (const ev of nonChain) {
    if (have.has(ev.id)) continue
    try {
      if (!NT?.verifyEvent || !NT.verifyEvent(ev)) { badSig++; continue }
    } catch { badSig++; continue }
    fresh.push(ev)
  }

  // heal BEFORE the up-to-date early-out — a heal with nothing new to import must still
  // commit a manifest whose closure can cross postures
  const media = { ...prevMedia }
  let heal = { healed: 0, dropped: 0 }
  if (mirrorMedia && window.nosdag?.kubo?.addMedia) heal = await healOversizedMedia(media, onStatus)
  const mediaHealed = heal.healed + heal.dropped > 0

  if (!fresh.length && !mediaHealed) {
    if (prevManifestCid && have.size) await mirrorToBridge(prevManifestCid) // bridge coverage even when nothing new
    return { manifestCid: prevManifestCid, imported: 0, alreadyArchived: have.size, skippedChain, badSig, media: 0, mediaSkipped: 0, upToDate: true }
  }

  // oldest first, so the manifest reads in timeline order
  fresh.sort((a, b) => a.created_at - b.created_at)

  const ids = [...prevIds]
  const notes = [...prevNotes]
  let stored = 0
  for (const ev of fresh) {
    const r = await shell().putNote({ event: ev })
    if (r?.error) throw new Error(`could not store note ${ev.id.slice(0, 8)}…: ${r.error}`)
    ids.push(ev.id)
    notes.push(r.cid)
    stored++
    if (stored % 25 === 0) onStatus(`Storing notes in IPFS… ${stored}/${fresh.length}`)
  }

  // best-effort media mirror: fetch each referenced HTTP file once, add to the local node
  let mediaAdded = 0
  let mediaSkipped = 0
  if (mirrorMedia && window.nosdag?.kubo?.addMedia) {
    const urls = new Set()
    for (const ev of fresh) extractHttpMediaUrls(ev.content).forEach((u) => urls.add(u))
    let seen = 0
    for (const url of urls) {
      seen++
      if (media[url]) continue
      onStatus(`Mirroring media… ${seen}/${urls.size}`)
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = new Uint8Array(await res.arrayBuffer())
        if (!buf.length || buf.length > MEDIA_MAX_BYTES) throw new Error('empty or oversized')
        const add = await window.nosdag.kubo.addMedia(buf)
        if (add?.error) throw new Error(add.error)
        media[url] = add.cid
        mediaAdded++
      } catch (e) {
        mediaSkipped++
        console.warn('[nosdag] timeline-import media skipped:', url, String(e?.message || e))
      }
    }
  }

  onStatus('Committing the archive manifest…')
  const commit = await shell().commit({ pubkey: pk, ids, notes, media, prevManifestCid })
  if (commit?.error) throw new Error('could not commit the archive: ' + commit.error)
  try { localStorage.setItem(ARCHIVE_KEY(pk), commit.cid) } catch { /* ephemeral */ }

  await mirrorToBridge(commit.cid)

  return { manifestCid: commit.cid, imported: stored, alreadyArchived: have.size, skippedChain, badSig, media: mediaAdded, mediaSkipped, mediaHealed: heal.healed, mediaDropped: heal.dropped, total: notes.length }
}

/** The full flow: relay fetch → importEvents → announce the nosdag:archive pointer. */
export async function runImport (onStatus = () => {}) {
  const pk = State.publicKey
  if (!pk) throw new Error('Log in first — the import archives YOUR notes.')

  onStatus('Fetching your notes from relays…')
  const all = await fetchAllAuthored(pk, (n) => onStatus(`Fetching your notes from relays… ${n} found`))
  if (!all.length) return { imported: 0, alreadyArchived: 0, skippedChain: 0, badSig: 0, media: 0, mediaSkipped: 0, empty: true }

  const summary = await importEvents(pk, all, { onStatus })

  // announce the archive pointer (same NIP-78 pattern as nosdag:head); best-effort
  if (summary.manifestCid && !summary.upToDate) {
    try {
      const pointer = await Utils.signEvent({
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', 'nosdag:archive'], ['archive', summary.manifestCid]],
        content: ''
      })
      const writeRelays = Relays.getWriteRelays()
      if (State.pool && writeRelays.length) State.pool.publish(writeRelays, pointer)
    } catch (e) {
      console.warn('[nosdag] archive-pointer publish failed (archive still stored locally):', e)
    }
  }
  return summary
}

// ---------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------

function ensureStyles () {
  if (document.getElementById('nd-ti-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-ti-styles'
  el.textContent = `
.nd-ti-desc{font-size:12.5px;line-height:1.6;color:var(--nd-dim,#9aa4b4);margin:0 0 14px;max-width:62ch}
.nd-ti-desc b{color:var(--text-primary,#e9eef5);font-weight:600}
.nd-ti-btn{padding:11px 16px;border-radius:10px;cursor:pointer;font:600 12.5px/1 var(--nd-mono,ui-monospace,monospace);letter-spacing:.02em;transition:.16s;border:none;color:var(--nd-on-accent,#f6ead9);background:linear-gradient(180deg,var(--nd-accent-hi),var(--nd-accent));box-shadow:0 6px 18px color-mix(in srgb, var(--nd-accent) 25%, transparent)}
.nd-ti-btn:hover:not(:disabled){filter:brightness(1.06)}
.nd-ti-btn:disabled{opacity:.6;cursor:default;box-shadow:none}
.nd-ti-status{margin-top:12px;font:12px/1.6 var(--nd-mono,ui-monospace,monospace);color:var(--nd-dim,#9aa4b4);white-space:pre-wrap;word-break:break-all}`
  document.head.appendChild(el)
}

// This predates the pane registry and keeps its static placeholder; new settings sections should resolve their container via getSettingsPane() in js/nosdag/settings-sections.js.
export function mountImportSection () {
  const section = document.getElementById('ndTimelineImportSection')
  if (!section) return
  if (!shell()) { section.style.display = 'none'; return }
  section.style.display = ''
  ensureStyles()
  const host = section.querySelector('#ndTimelineImport')
  const archived = State.publicKey ? getLocalArchive(State.publicKey) : null
  host.innerHTML = `
    <p class="nd-ti-desc">Notes you wrote <b>before Nosdag</b> live only on relays and third-party media hosts. Import fetches your whole timeline from your relays, stores every note in <b>your local IPFS node</b> (signature-checked), mirrors the images and video they reference, and pins it all under one archive — served peer-to-peer while your node is online, and mirrored to your Cloud Bridge if one is linked. Notes already in your Nosdag chain are skipped; running it again only adds what's new. (The .car history backup covers your Nosdag chain only — not yet this archive.)</p>
    <button class="nd-ti-btn" id="nd-ti-run">${archived ? '⟳ Update timeline archive' : '⬇ Import my timeline to IPFS'}</button>
    <div class="nd-ti-status" id="nd-ti-status">${archived ? 'Archive: ' + archived : ''}</div>`

  const btn = host.querySelector('#nd-ti-run')
  const status = host.querySelector('#nd-ti-status')
  btn.addEventListener('click', async () => {
    btn.disabled = true
    const orig = btn.textContent
    btn.textContent = 'Importing…'
    try {
      const s = await runImport((t) => { status.textContent = t })
      if (s.empty) status.textContent = 'Relays returned no notes for this account.'
      else if (s.upToDate) status.textContent = `Already up to date — ${s.alreadyArchived} notes archived.` + (s.skippedChain ? ` (${s.skippedChain} chain notes skipped)` : '')
      else {
        status.textContent = `Done. ${s.imported} notes${s.media ? ` + ${s.media} media files` : ''} now in IPFS (${s.total} archived total` +
          `${s.skippedChain ? `, ${s.skippedChain} already in your chain` : ''}${s.mediaSkipped ? `, ${s.mediaSkipped} media unreachable` : ''}` +
          `${s.mediaHealed ? `, ${s.mediaHealed} oversized media re-mirrored` : ''}${s.mediaDropped ? `, ${s.mediaDropped} oversized media dropped (source gone)` : ''}` +
          `${s.badSig ? `, ${s.badSig} failed signature check` : ''}).` +
          `\nArchive: ${s.manifestCid}`
      }
    } catch (e) {
      status.textContent = 'Import failed: ' + String(e?.message || e)
    }
    btn.disabled = false
    btn.textContent = State.publicKey && getLocalArchive(State.publicKey) ? '⟳ Update timeline archive' : orig
  })
}
