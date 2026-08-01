// Nosdag Phase 2 Step 4 — tag feed cards with their IPFS state.
//
// Walks the logged-in user's note chain once (cached by head CID) to build an
// event-id → envelope-CID map, then adds a small "◍ IPFS" chip to that user's own
// `.post` cards in any rendered container (feed / profile / thread). Hover shows the CID.
//
// (Other authors' notes will get "seeded ×N / ⧗ resting" here too, once there are other
// Nosdag users with published heads — same matching, different data source.)

import { walkNotes } from './dag-read.js'
import { getLocalHead } from './dag-publish.js'
import * as Durability from './durability.js'

let cache = { head: null, map: null }

function ensureDurChipStyles () {
  if (document.getElementById('nd-durchip-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-durchip-styles'
  el.textContent = `.nd-dur-chip{font:600 10px/1 'SF Mono',ui-monospace,monospace;padding:2px 6px;border-radius:6px;margin-left:6px;vertical-align:middle;cursor:default}
.nd-dur-chip.ok{color:#26d07c;border:1px solid color-mix(in srgb,#26d07c 35%,transparent)}
.nd-dur-chip.risk{color:#f5a623;border:1px solid color-mix(in srgb,#f5a623 40%,transparent)}`
  document.head.appendChild(el)
}

// Test/dev helper (until a profile button exists): read ANY author's notes from IPFS.
//   window.nosdagReadFromIpfs('<npub or hex pubkey>')
// Resolves that author's nosdag:head from relays, walks their chain, opens the read-from-IPFS
// modal — Bitswap-fetching their blocks. This is how machine A reads machine B's notes.
if (typeof window !== 'undefined' && !window.nosdagReadFromIpfs) {
  window.nosdagReadFromIpfs = async (id) => {
    let pk = id
    try { if (typeof id === 'string' && id.startsWith('npub')) pk = window.NostrTools.nip19.decode(id).data } catch { /* use as-is */ }
    const V = await import('./ipfs-notes-view.js')
    return V.showIpfsNotes(pk)
  }
}

async function buildIdToCidMap (pubkey) {
  const head = getLocalHead(pubkey)
  let arcCid = null
  try { arcCid = localStorage.getItem('nosdag:archive:' + pubkey) } catch { /* private mode */ }
  if (!head && !arcCid) return new Map()
  const key = `${head || ''}|${arcCid || ''}`
  if (cache.head === key && cache.map) return cache.map // rebuilt only when head or archive advances
  const map = new Map()
  if (head) {
    const notes = await walkNotes(head, { limit: 500, verify: false })
    for (const ev of notes) if (ev.id && ev._nosdagCid) map.set(ev.id, ev._nosdagCid)
  }
  // Archived (imported) notes carry the same chip — the manifest ships the id↔CID pairing
  // for free, no envelope fetches needed.
  if (arcCid && window.nosdag?.archive?.get) {
    try {
      const man = await window.nosdag.archive.get({ cid: arcCid })
      if (man && !man.error && Array.isArray(man.ids)) {
        man.ids.forEach((id, i) => { const c = man.notes?.[i]; if (id && c && !map.has(id)) map.set(id, c) })
      }
    } catch { /* archive notes just go chip-less */ }
  }
  cache = { head: key, map }
  return map
}

/**
 * Tag the logged-in user's own notes in `container` that are in their IPFS DAG.
 * @param {string|Element} containerId  element id or the element itself
 * @param {string} [pubkeyArg]          override (defaults to the logged-in pubkey)
 */
export async function markIpfsNotes (containerId, pubkeyArg) {
  if (!window.nosdag?.kubo?.getPost) return
  const container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId
  if (!container) return

  // Any note posted via Nosdag carries client=nosdag → it's in its author's IPFS DAG. Badge those
  // regardless of author or follow status. For the logged-in user we also have exact CIDs locally.
  const posts = container.querySelectorAll('.post[data-post-id]:not([data-nd-ipfs])')
  if (!posts.length) return

  const myPubkey = pubkeyArg || window.NostrState?.publicKey
  let myMap = null
  if (myPubkey) { try { myMap = await buildIdToCidMap(myPubkey) } catch { /* ignore */ } }

  // Slice 3 — load the bridge state once so each own-note can show its durability (cached, cheap).
  ensureDurChipStyles()
  try { await Durability.bridge() } catch { /* ignore */ }

  posts.forEach((p) => {
    const id = p.dataset.postId
    if (!id) return
    const author = p.dataset.pubkey
    const mineCid = (myMap && author === myPubkey) ? myMap.get(id) : null
    const isNosdag = p.dataset.client === 'nosdag'
    if (!mineCid && !isNosdag) return
    p.dataset.ndIpfs = '1'

    // Attach to the post's OWN header, never a nested .parent-post (the quoted/replied-to note).
    let slot = null
    for (const el of p.querySelectorAll('.post-header .post-info')) { if (!el.closest('.parent-post')) { slot = el; break } }
    if (!slot) { for (const el of p.querySelectorAll('.post-header')) { if (!el.closest('.parent-post')) { slot = el; break } } }
    if (!slot) slot = p
    if (slot.querySelector('.nd-ipfs-chip')) return

    const chip = document.createElement('span')
    chip.className = 'nd-ipfs-chip'
    chip.textContent = '◍ IPFS'
    if (mineCid) {
      chip.title = `Click to copy CID · ${mineCid}`
      chip.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault()
        navigator.clipboard?.writeText(mineCid).then(() => {
          chip.textContent = '✓ copied'; setTimeout(() => { chip.textContent = '◍ IPFS' }, 1100)
        }).catch(() => {})
      })
    } else {
      chip.title = 'In IPFS (Nosdag) · click to read this author from IPFS'
      chip.addEventListener('click', async (e) => {
        e.stopPropagation(); e.preventDefault()
        try { const V = await import('./ipfs-notes-view.js'); await V.showIpfsNotes(author) } catch { /* ignore */ }
      })
    }
    slot.appendChild(chip)

    // Slice 3 — durability chip on your OWN notes: backed up beyond this device, or at-risk.
    if (mineCid) {
      const atRisk = Durability.isAtRisk()
      const dchip = document.createElement('span')
      dchip.className = 'nd-dur-chip ' + (atRisk ? 'risk' : 'ok')
      dchip.textContent = atRisk ? '⚠ only here' : '⛁ backed up'
      dchip.title = atRisk
        ? 'Only this device holds this note — link a Cloud Bridge (Node panel) so it stays online when you close Nosdag'
        : 'Hosted by You + your Cloud Bridge'
      slot.appendChild(dchip)
    }
  })
}
