// Nosdag — Media library: every media file your notes reference, with sizes and where each
// one is pinned (this node / your Cloud Bridge), per-item pin toggles, and an on-demand
// "held by N nodes" network count.
//
// Enumeration walks your own chain from the local head — envelopes are local, so the walk is
// fast — and extracts media CIDs from each signed event (same regex the bridge mirroring
// uses). Followers hosting you can't be enumerated (no reverse-pin signal yet, §5.3), so the
// columns only name what's verifiable: your node and your bridge; the DHT count covers the
// rest on demand.
//
// Unpinning locally frees space at the node's next GC; unpinning from the bridge stops the
// 24/7 copy. Either cell re-pins with a click too (local re-pin Bitswap-fetches if needed).

import { getLocalHead } from './dag-publish.js'
import { extractMediaCids } from './cloud-bridge.js'

const kubo = () => window.nosdag?.kubo
const cloud = () => window.nosdag?.cloudBridge

/** Walk the chain and collect distinct media CIDs, newest note first. */
export async function collectMedia (pk, { limit = 10000 } = {}) {
  const head = pk ? getLocalHead(pk) : null
  if (!head || !kubo()?.getPost) return []
  const seen = new Set()
  const have = new Set()
  const items = []
  let cur = head
  let hops = 0
  let repaired = false
  while (cur && hops < limit) {
    if (seen.has(cur)) break
    seen.add(cur)
    // Bounded read: an envelope this store lacks must fail fast, not send Kubo on an endless
    // Bitswap hunt with the page stuck on "scanning". On the first gap, ask main for a DEEP
    // mixed-posture repair (whole-chain walk, other posture's store as the source) and retry
    // this hop once — a gap below the watermark means an old pre-repair migration never ran.
    const env = await kubo().getPost(cur, { timeout: 15000 })
    if (!env || env.error || !env.event) {
      if (!repaired && window.nosdag?.migrate?.catchUp) {
        repaired = true
        console.warn('[nosdag] media scan: gap at', cur, '— running a deep repair')
        try {
          const r = await window.nosdag.migrate.catchUp({ pubkey: pk, headCid: head, deep: true })
          if (r && !r.error && !r.busy) { seen.delete(cur); continue } // retry the same hop once
        } catch { /* fall through to the honest stop */ }
      }
      console.warn('[nosdag] media scan stopped at', cur, env?.error || '')
      break
    }
    for (const cid of extractMediaCids(env.event)) {
      if (!have.has(cid)) {
        have.add(cid)
        items.push({ cid, noteAt: env.event.created_at || null })
      }
    }
    cur = env.prev
    hops++
  }
  return items
}

function fmtBytes (n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function ensureStyles () {
  if (document.getElementById('nd-ml-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-ml-styles'
  el.textContent = `
.nd-ml{max-width:760px;margin:0 auto;padding:22px 18px 60px;
  --nd-mono:'SF Mono','Cascadia Code',Monaco,'JetBrains Mono',ui-monospace,monospace;
  --nd-line:var(--border-color,rgba(255,255,255,.08))}
.nd-ml-top{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.nd-ml-back{flex:none;width:36px;height:36px;border-radius:10px;border:1px solid var(--nd-line);background:transparent;color:var(--text-primary,#e9eef5);cursor:pointer;font-size:16px}
.nd-ml-back:hover{border-color:var(--nd-accent);color:var(--nd-accent)}
.nd-ml-top h1{margin:0;font-size:20px;font-weight:750;color:var(--text-primary,#e9eef5)}
.nd-ml-top p{margin:3px 0 0;font-size:12.5px;color:var(--text-muted,#9aa4b4)}
.nd-ml-sum{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 16px}
.nd-ml-chip{font:600 10.5px/1 var(--nd-mono);letter-spacing:.07em;text-transform:uppercase;padding:6px 11px;border-radius:999px;border:1px solid var(--nd-line);color:var(--text-muted,#9aa4b4)}
.nd-ml-chip b{color:var(--nd-accent)}
.nd-ml-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--nd-line);border-radius:12px;margin-bottom:8px}
.nd-ml-thumb{flex:none;width:44px;height:44px;border-radius:9px;object-fit:cover;background:rgba(255,255,255,.04);border:1px solid var(--nd-line)}
.nd-ml-thumb.miss{display:flex;align-items:center;justify-content:center;color:var(--text-muted,#5d6878);font-size:17px}
.nd-ml-meta{min-width:0;flex:1}
.nd-ml-cid{font:600 11px/1.4 var(--nd-mono);color:var(--text-primary,#e9eef5);cursor:pointer;word-break:break-all}
.nd-ml-cid:hover{color:var(--nd-accent)}
.nd-ml-sub{font:500 10.5px/1.5 var(--nd-mono);color:var(--text-muted,#5d6878)}
.nd-ml-pill{flex:none;cursor:pointer;font:600 9.5px/1 var(--nd-mono);letter-spacing:.08em;text-transform:uppercase;padding:6px 10px;border-radius:999px;border:1px solid var(--nd-line);color:var(--text-muted,#5d6878);transition:.14s;min-width:72px;text-align:center}
.nd-ml-pill[data-s=on]{color:#26d07c;border-color:rgba(38,208,124,.45)}
.nd-ml-pill[data-s=off]:hover{color:var(--nd-accent);border-color:color-mix(in srgb, var(--nd-accent) 50%, transparent)}
.nd-ml-pill[data-s=on]:hover{color:#ff5d5d;border-color:rgba(255,93,93,.5)}
.nd-ml-pill[data-s=arm]{color:#ff5d5d;border-color:rgba(255,93,93,.6)}
.nd-ml-pill[data-s=busy]{color:#f5a623;border-color:rgba(245,166,35,.5);cursor:progress}
.nd-ml-pill[data-s=na]{opacity:.4;cursor:default}
.nd-ml-net{flex:none;cursor:pointer;font:600 10px/1 var(--nd-mono);padding:6px 9px;border-radius:8px;border:1px solid var(--nd-line);background:transparent;color:var(--text-muted,#5d6878)}
.nd-ml-net:hover{color:var(--nd-accent);border-color:color-mix(in srgb, var(--nd-accent) 50%, transparent)}
.nd-ml-empty{padding:40px 0;text-align:center;color:var(--text-muted,#9aa4b4);font-size:13px}
.nd-ml-note{margin-top:14px;font-size:11.5px;line-height:1.55;color:var(--text-muted,#5d6878)}`
  document.head.appendChild(el)
}

// pill helper: pinned-state cell with two-click unpin (first click arms, second confirms)
function wirePill (pill, { isOn, doPin, doUnpin, onChange }) {
  let armTimer = null
  const setState = (s, label) => { pill.dataset.s = s; pill.textContent = label }
  const labelFor = (on) => on ? '⛁ pinned' : 'not pinned'
  setState(isOn() ? 'on' : 'off', labelFor(isOn()))
  pill.addEventListener('click', async () => {
    const s = pill.dataset.s
    if (s === 'busy' || s === 'na') return
    if (s === 'on') { setState('arm', 'unpin?'); armTimer = setTimeout(() => setState('on', labelFor(true)), 3000); return }
    clearTimeout(armTimer)
    const unpinning = s === 'arm'
    setState('busy', unpinning ? 'unpinning…' : 'pinning…')
    try {
      const r = unpinning ? await doUnpin() : await doPin()
      if (r && r.error) throw new Error(r.error)
      onChange(!unpinning)
      setState(unpinning ? 'off' : 'on', labelFor(!unpinning))
    } catch (e) {
      console.warn('[nosdag] media pin toggle failed:', e)
      setState(isOn() ? 'on' : 'off', labelFor(isOn()))
    }
  })
}

export async function renderMediaLibrary (container) {
  ensureStyles()
  const pk = window.NostrState?.publicKey
  container.innerHTML = `
    <div class="nd-ml">
      <header class="nd-ml-top">
        <button class="nd-ml-back" data-back title="Back">←</button>
        <div>
          <h1>Media library</h1>
          <p>Every media file your notes reference — and who's pinning it.</p>
        </div>
      </header>
      <div class="nd-ml-sum" id="nd-ml-sum"><span class="nd-ml-chip">scanning your notes…</span></div>
      <div id="nd-ml-list"></div>
      <p class="nd-ml-note">Unpinning here frees local space at the node's next garbage collection; unpinning from the bridge stops its 24/7 copy. ⌗ asks the IPFS network how many nodes currently hold a copy — Nosdag can count them, but can't yet name which followers they are.</p>
    </div>`
  container.querySelector('[data-back]')?.addEventListener('click', () => window.navigateTo?.('home'))

  const sum = container.querySelector('#nd-ml-sum')
  const list = container.querySelector('#nd-ml-list')

  const items = await collectMedia(pk)
  if (!items.length) {
    sum.innerHTML = '<span class="nd-ml-chip">0 files</span>'
    list.innerHTML = '<div class="nd-ml-empty">No media in your notes yet — attach an image when you post and it lands here.</div>'
    return
  }

  // one bridge round trip for the whole list; everything else fills per row
  const bridgePinned = new Set()
  let bridgeState = 'none' // none | linked | tor | error
  try {
    const bs = await cloud()?.pinStatus?.({ pubkey: pk, cids: items.map((i) => i.cid) })
    if (bs?.kind) { bridgeState = 'linked'; (bs.pinned || []).forEach((c) => bridgePinned.add(c)) }
    else if (bs?.skipped === 'tor') bridgeState = 'tor'
    else if (bs?.error) bridgeState = 'error'
  } catch { bridgeState = 'error' }

  let totalBytes = 0
  let sized = 0
  const renderSum = () => {
    const bits = [`<span class="nd-ml-chip"><b>${items.length}</b> file${items.length === 1 ? '' : 's'}</span>`,
      `<span class="nd-ml-chip"><b>${fmtBytes(totalBytes)}</b>${sized < items.length ? ' so far' : ''}</span>`]
    if (bridgeState === 'linked') bits.push(`<span class="nd-ml-chip"><b>${bridgePinned.size}</b> on bridge</span>`)
    if (bridgeState === 'none') bits.push('<span class="nd-ml-chip">no bridge linked</span>')
    if (bridgeState === 'tor') bits.push('<span class="nd-ml-chip">bridge paused (tor)</span>')
    if (bridgeState === 'error') bits.push('<span class="nd-ml-chip">bridge unreachable</span>')
    sum.innerHTML = bits.join('')
  }
  renderSum()

  const gw = kubo()?.gateway || 'http://127.0.0.1:8201/ipfs/'
  for (const it of items) {
    const row = document.createElement('div')
    row.className = 'nd-ml-row'
    const when = it.noteAt ? new Date(it.noteAt * 1000).toLocaleDateString() : ''
    row.innerHTML = `
      <img class="nd-ml-thumb" src="${gw}${it.cid}" loading="lazy" alt="">
      <div class="nd-ml-meta">
        <div class="nd-ml-cid" title="Copy CID">${it.cid.slice(0, 22)}…${it.cid.slice(-6)}</div>
        <div class="nd-ml-sub"><span data-size>sizing…</span>${when ? ` · note from ${when}` : ''}</div>
      </div>
      <span class="nd-ml-pill" data-cell="local" data-s="busy" title="Pinned on this node?">…</span>
      <span class="nd-ml-pill" data-cell="bridge" title="Pinned on your Cloud Bridge?">…</span>
      <button class="nd-ml-net" title="How many nodes hold this file (DHT)?">⌗ net</button>`
    list.appendChild(row)

    const img = row.querySelector('.nd-ml-thumb')
    img.addEventListener('error', () => { const d = document.createElement('div'); d.className = 'nd-ml-thumb miss'; d.textContent = '▣'; img.replaceWith(d) })
    row.querySelector('.nd-ml-cid').addEventListener('click', (e) => {
      navigator.clipboard?.writeText(it.cid).then(() => { const t = e.target; const o = t.textContent; t.textContent = '✓ copied'; setTimeout(() => { t.textContent = o }, 1100) }).catch(() => {})
    })

    // size (cumulative — covers chunked files)
    kubo()?.dagSize?.(it.cid).then((r) => {
      const elx = row.querySelector('[data-size]')
      if (r && !r.error && elx) { elx.textContent = fmtBytes(r.bytes); totalBytes += r.bytes || 0; sized++; renderSum() }
      else if (elx) { elx.textContent = 'size unknown'; sized++; renderSum() }
    }).catch(() => {})

    // local pin cell
    const localPill = row.querySelector('[data-cell="local"]')
    kubo()?.isPinned?.(it.cid).then((r) => {
      let on = r && !r.error ? r.pinned : null
      if (on == null) { localPill.dataset.s = 'na'; localPill.textContent = 'n/a'; return }
      wirePill(localPill, {
        isOn: () => on,
        doPin: () => kubo().pinRecursive(it.cid, 30000),
        doUnpin: () => kubo().unpinRecursive(it.cid),
        onChange: (v) => { on = v }
      })
    }).catch(() => { localPill.dataset.s = 'na'; localPill.textContent = 'n/a' })

    // bridge pin cell
    const bridgePill = row.querySelector('[data-cell="bridge"]')
    if (bridgeState !== 'linked') {
      bridgePill.dataset.s = 'na'
      bridgePill.textContent = bridgeState === 'tor' ? 'tor' : 'no bridge'
    } else {
      let on = bridgePinned.has(it.cid)
      wirePill(bridgePill, {
        isOn: () => on,
        doPin: async () => {
          const r = await cloud().pinMany({ pubkey: pk, cids: [it.cid] })
          const item = r?.results?.[0]
          return (r?.error || (item && item.ok === false)) ? { error: r?.error || item?.error || item?.body || 'bridge refused' } : { ok: true }
        },
        doUnpin: () => cloud().unpin({ pubkey: pk, cid: it.cid }),
        onChange: (v) => { on = v; v ? bridgePinned.add(it.cid) : bridgePinned.delete(it.cid); renderSum() }
      })
    }

    // on-demand DHT count
    const netBtn = row.querySelector('.nd-ml-net')
    netBtn.addEventListener('click', async () => {
      netBtn.textContent = '⌗ …'
      try {
        const r = await kubo().providers(it.cid, { timeoutMs: 8000, max: 20 })
        netBtn.textContent = (r && !r.error && typeof r.count === 'number') ? `⌗ ${r.count} node${r.count === 1 ? '' : 's'}` : '⌗ ?'
      } catch { netBtn.textContent = '⌗ ?' }
    })
  }
}
