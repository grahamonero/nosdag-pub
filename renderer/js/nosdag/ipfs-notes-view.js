// Nosdag Phase 2 Step 3 (UI) — "your notes, read from IPFS".
//
// Opened from the deck's "notes in IPFS" stat. Resolves the user's head (local head, falling
// back to their nosdag:head pointer on relays), walks the chain from IPFS via getPost, and
// renders the reconstructed notes — each tagged with its CID + a "from IPFS" badge. This is the
// full write→read loop made visible: notes come back from IPFS, not relays.

import { walkNotes, resolveHeadCid, readAuthorArchive, fetchDeletedIds } from './dag-read.js'
import { getLocalHead, setPostCount } from './dag-publish.js'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const readRelays = () => {
  try { return window.NostrRelays?.getReadRelays?.() || window.NostrRelays?.getWriteRelays?.() || [] } catch { return [] }
}

function renderIpfsNote (ev) {
  const when = ev.created_at ? new Date(ev.created_at * 1000).toLocaleString() : ''
  let content
  try { content = window.NostrUtils?.parseContent ? window.NostrUtils.parseContent(ev.content || '') : esc(ev.content) } catch { content = esc(ev.content) }
  const cid = ev._nosdagCid || ''
  const cidShort = cid ? `${cid.slice(0, 14)}…${cid.slice(-8)}` : ''
  return `<article class="nd-ipfsnote-note">
    <div class="nd-ipfsnote-meta"><span class="nd-ipfsnote-badge">📦 from IPFS</span><span>${esc(when)}</span></div>
    <div class="nd-ipfsnote-content">${content}</div>
    ${cidShort ? `<div class="nd-ipfsnote-cid" data-cid="${esc(cid)}" title="Click to copy CID">⧉ ${esc(cidShort)}</div>` : ''}
  </article>`
}

export async function showIpfsNotes (pubkeyArg) {
  const State = window.NostrState
  const pubkey = pubkeyArg || State?.publicKey
  if (!pubkey) { window.NostrUtils?.showNotification?.('Sign in to read your notes from IPFS', 'info'); return }

  const overlay = document.createElement('div')
  overlay.className = 'nd-ipfsnotes-overlay'
  overlay.innerHTML = `
    <div class="nd-ipfsnotes">
      <div class="nd-ipfsnotes-top">
        <div>
          <div class="nd-ipfsnotes-title">Your notes, read from IPFS</div>
          <div class="nd-ipfsnotes-sub">walked from your head through IPFS — not relays</div>
        </div>
        <button class="nd-ipfsnotes-close" aria-label="Close">✕</button>
      </div>
      <div class="nd-ipfsnotes-body"><div class="nd-ipfsnotes-status">📡 walking your note chain from IPFS…</div></div>
    </div>`

  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => {
    const cidEl = e.target.closest?.('.nd-ipfsnote-cid[data-cid]')
    if (cidEl) {
      navigator.clipboard?.writeText(cidEl.dataset.cid).then(() => {
        const orig = cidEl.textContent
        cidEl.textContent = '✓ copied'
        setTimeout(() => { cidEl.textContent = orig }, 1100)
      }).catch(() => {})
      return
    }
    if (e.target === overlay) close()
  })
  overlay.querySelector('.nd-ipfsnotes-close').addEventListener('click', close)
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) } }
  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)

  const body = overlay.querySelector('.nd-ipfsnotes-body')
  try {
    let head = getLocalHead(pubkey)
    if (!head) head = await resolveHeadCid(pubkey, State?.pool, readRelays())

    const chainNotes = head ? await walkNotes(head, { limit: 200, author: pubkey }) : [] // bind hop-0 to this author (H6)

    // Timeline-archive notes (imported pre-Nosdag history) render too, minus a best-effort
    // kind-5 delete filter.
    let archiveNotes = []
    try {
      const arc = await readAuthorArchive(pubkey, { pool: State?.pool, relays: readRelays(), limit: 200 })
      archiveNotes = arc.notes
      if (archiveNotes.length) {
        const deleted = await fetchDeletedIds(pubkey, archiveNotes.map(n => n.id), State?.pool, readRelays())
        archiveNotes = archiveNotes.filter(n => !deleted.has(n.id))
      }
    } catch { /* chain-only */ }

    if (!head && !archiveNotes.length) { body.innerHTML = '<div class="nd-ipfsnotes-status">No notes in IPFS yet — post a note first.</div>'; return }

    // self-heal: the chain walk stays the source of truth for the CHAIN count
    try { if (chainNotes.length) setPostCount(pubkey, chainNotes.length) } catch { /* ignore */ }

    const byId = new Map()
    for (const n of [...chainNotes, ...archiveNotes]) if (n?.id && !byId.has(n.id)) byId.set(n.id, n)
    let notes = [...byId.values()].sort((a, b) => b.created_at - a.created_at)
    // This modal bypasses the feed pipeline, so apply the mute filter explicitly.
    try { const Lists = await import('../lists.js'); notes = notes.filter((n) => !Lists.isMuted(n)) } catch { /* module optional */ }
    if (!notes.length) { body.innerHTML = '<div class="nd-ipfsnotes-status">Couldn’t read any notes from IPFS.</div>'; return }

    body.innerHTML =
      `<div class="nd-ipfsnotes-count">📦 ${notes.length} note${notes.length === 1 ? '' : 's'} reconstructed from IPFS${head ? ` · head ${esc(head.slice(0, 12))}…` : ''}${archiveNotes.length ? ` · ${archiveNotes.length} archived` : ''}</div>` +
      notes.map(renderIpfsNote).join('')
  } catch (e) {
    body.innerHTML = `<div class="nd-ipfsnotes-status">Error reading from IPFS: ${esc(e.message || e)}</div>`
  }
}
