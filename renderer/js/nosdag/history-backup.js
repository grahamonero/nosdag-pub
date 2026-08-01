// Nosdag — "Download my history": note-history backup/restore in Settings.
//
// Export writes your whole chain (every envelope head → genesis, plus the media those notes
// reference) into a single .car archive — a standard content-addressed format any IPFS tool
// can read, so your history is portable even without Nosdag. Restore is the reverse: pick a
// .car on a fresh install, the blocks land in your local node, the head re-pins, and your
// notes are servable again. Machine migration + disaster recovery in one file.
//
// Trust model: the backup's head event is signature-verified and must be authored by the
// logged-in npub. Because each signed event carries its `prev` CID as a string tag (§13.1),
// the verified head hash-commits the ENTIRE chain — main's scan enforces link === tag at
// every hop, so one signature authenticates the whole file.
//
// Head adoption after restore (never fork):
//   • no local head (fresh install)        → adopt the backup head — unless relays name a
//     NEWER head that descends from it and is still fetchable (Cloud Bridge / hosts), in
//     which case adopt that and treat the backup as a block back-fill.
//   • local head === backup head           → nothing to move.
//   • backup head descends from local head → backup is newer (made on another machine) → adopt.
//   • anything else                        → keep the local head; blocks import all the same.

const H = () => window.nosdag?.history

function ensureStyles () {
  if (document.getElementById('nd-hb-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-hb-styles'
  el.textContent = `
.nd-hb-desc{font-size:12.5px;line-height:1.6;color:var(--nd-dim,#9aa4b4);margin:0 0 14px;max-width:62ch}
.nd-hb-desc b{color:var(--text-primary,#e9eef5);font-weight:600}
.nd-hb-row{display:flex;gap:10px;flex-wrap:wrap}
.nd-hb-btn{padding:11px 16px;border-radius:10px;cursor:pointer;font:600 12.5px/1 var(--nd-mono,ui-monospace,monospace);letter-spacing:.02em;transition:.16s;border:none}
.nd-hb-btn[data-kind=primary]{color:var(--nd-on-accent,#f6ead9);background:linear-gradient(180deg,var(--nd-accent-hi),var(--nd-accent));box-shadow:0 6px 18px color-mix(in srgb, var(--nd-accent) 25%, transparent)}
.nd-hb-btn[data-kind=ghost]{color:var(--text-primary,#e9eef5);background:transparent;border:1px solid var(--nd-line,rgba(255,255,255,.12))}
.nd-hb-btn[data-kind=ghost]:hover{border-color:var(--nd-accent);color:var(--nd-accent)}
.nd-hb-btn:hover{filter:brightness(1.06)}
.nd-hb-btn:disabled{opacity:.55;cursor:progress;filter:none}
.nd-hb-status{margin-top:12px;font:600 11.5px/1.6 var(--nd-mono,ui-monospace,monospace);display:none;word-break:break-word}
.nd-hb-status.show{display:block}
.nd-hb-status[data-tone=busy]{color:var(--nd-rest,#f5a623)}
.nd-hb-status[data-tone=ok]{color:var(--nd-ok,#26d07c)}
.nd-hb-status[data-tone=err]{color:var(--nd-down,#ff5d5d)}
.nd-hb-status[data-tone=note]{color:var(--nd-dim,#9aa4b4)}
.nd-hb-confirm{margin-top:14px;padding:14px 16px;border:1px solid var(--nd-line-2,rgba(255,255,255,.15));border-radius:12px;background:color-mix(in srgb, var(--nd-accent) 5%, transparent);display:none}
.nd-hb-confirm.show{display:block}
.nd-hb-k{font:600 9.5px/1 var(--nd-mono,ui-monospace,monospace);letter-spacing:.14em;text-transform:uppercase;color:var(--nd-accent);margin:0 0 9px}
.nd-hb-stats{font:600 12.5px/1.6 var(--nd-mono,ui-monospace,monospace);color:var(--text-primary,#e9eef5)}
.nd-hb-stats b{color:var(--nd-accent)}
.nd-hb-sub{margin:8px 0 0;font-size:12px;line-height:1.55;color:var(--nd-dim,#9aa4b4)}
.nd-hb-sub.warn{color:var(--nd-rest,#f5a623)}
.nd-hb-confirm .nd-hb-row{margin-top:13px}`
  document.head.appendChild(el)
}

function fmtBytes (n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function setStatus (el, text, tone) {
  if (!el) return
  if (!text) { el.classList.remove('show'); return }
  el.textContent = text
  el.dataset.tone = tone || 'note'
  el.classList.add('show')
}

// Live progress while main packs/imports — mirrors how the Tor card narrates the history sync.
function startPoll (statusEl) {
  let on = true
  ;(async () => {
    while (on) {
      try {
        const s = await H()?.status()
        if (!on) break
        if (s?.state === 'exporting') setStatus(statusEl, `Packing your history… ${s.blocks || 0} blocks`, 'busy')
        else if (s?.state === 'importing') setStatus(statusEl, s.blocks ? `Restoring… ${s.blocks}/${s.total || '?'} blocks` : 'Restoring your notes…', 'busy')
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 400))
    }
  })()
  return () => { on = false }
}

function npubOf (pubkey) {
  try { return window.NostrTools.nip19.npubEncode(pubkey) } catch { return pubkey || '' }
}

// Republish the nosdag:head pointer (kind 30078, d:nosdag:head) so the network agrees with
// the restored head — same event dag-publish announces after every post.
async function announceHead (headCid) {
  try {
    const [State, Utils, Relays] = await Promise.all([
      import('../state.js'), import('../utils.js'), import('../relays.js')
    ])
    const pointer = await Utils.signEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'nosdag:head'], ['head', headCid]],
      content: ''
    })
    const writeRelays = Relays.getWriteRelays()
    if (State.pool && writeRelays?.length) State.pool.publish(writeRelays, pointer)
    return true
  } catch (e) {
    console.warn('[nosdag] head-pointer announce failed (history still restored locally):', e)
    return false
  }
}

async function doExport (root) {
  const status = root.querySelector('#nd-hb-status')
  const btns = root.querySelectorAll('.nd-hb-btn')
  const pk = window.NostrState?.publicKey
  if (!pk) return setStatus(status, 'Sign in first.', 'err')

  const DP = await import('./dag-publish.js')
  let headCid = DP.getLocalHead(pk)
  if (!headCid) {
    // local pointer lost but relays may still name our head (blocks may be local or fetchable)
    try {
      const [DR, State, Relays] = await Promise.all([
        import('./dag-read.js'), import('../state.js'), import('../relays.js')
      ])
      headCid = await DR.resolveHeadCid(pk, State.pool, Relays.getReadRelays())
    } catch { /* offline */ }
  }
  if (!headCid) return setStatus(status, 'No notes in your history yet — publish a note first.', 'note')

  const suggestedName = `nosdag-history-${npubOf(pk).slice(5, 13)}-${new Date().toISOString().slice(0, 10)}.car`
  btns.forEach((b) => { b.disabled = true })
  setStatus(status, 'Choose where to save…', 'busy')
  const stop = startPoll(status)
  let res
  try { res = await H().export({ headCid, suggestedName }) } catch (e) { res = { error: String(e?.message || e) } }
  stop()
  btns.forEach((b) => { b.disabled = false })

  if (res?.cancelled) return setStatus(status, '', null)
  if (!res?.ok) return setStatus(status, 'Export failed: ' + (res?.error || 'unknown error'), 'err')
  const skipped = res.skippedMedia
    ? ` · ${res.skippedMedia} referenced media file${res.skippedMedia === 1 ? '' : 's'} not on this node, not included`
    : ''
  setStatus(status, `✓ ${res.notes} note${res.notes === 1 ? '' : 's'} + ${res.media} media · ${fmtBytes(res.bytes)} → ${res.path}${skipped}`, 'ok')
}

async function doRestore (root) {
  const status = root.querySelector('#nd-hb-status')
  const confirm = root.querySelector('#nd-hb-confirm')
  const pk = window.NostrState?.publicKey
  confirm.classList.remove('show')
  if (!pk) return setStatus(status, 'Sign in first.', 'err')

  setStatus(status, 'Pick a backup file…', 'busy')
  let ins
  try { ins = await H().inspect({}) } catch (e) { ins = { error: String(e?.message || e) } }
  if (ins?.cancelled) return setStatus(status, '', null)
  if (ins?.error) return setStatus(status, 'Could not read that file: ' + ins.error, 'err')

  // Whose history is this? The head signature authenticates the whole chain (§13.1).
  if (ins.pubkey !== pk) {
    return setStatus(status, `That backup belongs to a different account (${npubOf(ins.pubkey).slice(0, 16)}…) — sign in with that account to restore it.`, 'err')
  }
  if (!window.NostrTools?.verifyEvent || !window.NostrTools.verifyEvent(ins.event)) {
    return setStatus(status, 'The backup failed signature verification — the file may be corrupted.', 'err')
  }
  if (ins.missingPrev && !ins.priorAvailable) {
    return setStatus(status, 'This file holds only part of a history and the older notes aren\'t on this node — restore a full backup instead.', 'err')
  }

  setStatus(status, '', null)
  const newest = ins.newestAt ? new Date(ins.newestAt * 1000).toLocaleDateString() : '?'
  const oldest = ins.oldestAt ? new Date(ins.oldestAt * 1000).toLocaleDateString() : '?'
  const subs = []
  if (ins.missingMedia) subs.push(`<p class="nd-hb-sub warn">${ins.missingMedia} media file${ins.missingMedia === 1 ? '' : 's'} referenced by these notes ${ins.missingMedia === 1 ? 'isn\'t' : 'aren\'t'} inside this backup (they weren't on the node when it was made).</p>`)
  if (ins.missingPrev) subs.push('<p class="nd-hb-sub warn">Partial backup — the older notes it chains into are already on this node.</p>')
  confirm.innerHTML = `
    <p class="nd-hb-k">Restore preview</p>
    <div class="nd-hb-stats"><b>${ins.notes}</b> note${ins.notes === 1 ? '' : 's'} + <b>${ins.media}</b> media · ${fmtBytes(ins.bytes)}<br>newest ${newest} · oldest ${oldest}</div>
    ${subs.join('')}
    <p class="nd-hb-sub">Imports into your local node and re-pins your history. Nothing is deleted — if this node already holds a newer history, that one is kept.</p>
    <div class="nd-hb-row">
      <button class="nd-hb-btn" data-kind="primary" id="nd-hb-go">Restore into this node</button>
      <button class="nd-hb-btn" data-kind="ghost" id="nd-hb-cancel">Cancel</button>
    </div>`
  confirm.classList.add('show')
  confirm.querySelector('#nd-hb-cancel').addEventListener('click', () => confirm.classList.remove('show'))
  confirm.querySelector('#nd-hb-go').addEventListener('click', () => performRestore(root, ins, pk))
}

async function performRestore (root, ins, pk) {
  const status = root.querySelector('#nd-hb-status')
  const confirm = root.querySelector('#nd-hb-confirm')
  const btns = root.querySelectorAll('.nd-hb-btn')
  btns.forEach((b) => { b.disabled = true })
  setStatus(status, 'Restoring your notes…', 'busy')
  const stop = startPoll(status)
  let res
  try { res = await H().restore() } catch (e) { res = { error: String(e?.message || e) } }
  stop()
  btns.forEach((b) => { b.disabled = false })
  confirm.classList.remove('show')
  if (!res?.ok) return setStatus(status, 'Restore failed: ' + (res?.error || 'unknown error'), 'err')

  // Head adoption — the no-fork rule (see module header).
  const DP = await import('./dag-publish.js')
  const cur = DP.getLocalHead(pk)
  const target = ins.headCid
  let tail = 'your history is now served from this node.'
  if (!cur) {
    let adopt = target
    let fromRelay = false
    try {
      // Disaster-recovery nuance: relays may name a NEWER head (notes made after this backup).
      // If that chain descends from the backup head AND is still fetchable (Cloud Bridge /
      // hosts), adopt it — the backup just back-filled the older blocks. Unreachable → those
      // newer notes are lost; the backup head is the best truth we can serve.
      const [DR, State, Relays] = await Promise.all([
        import('./dag-read.js'), import('../state.js'), import('../relays.js')
      ])
      const relayHead = await DR.resolveHeadCid(pk, State.pool, Relays.getReadRelays())
      if (relayHead && relayHead !== target) {
        const d = await H().contains({ headCid: relayHead, targetCid: target })
        if (d?.contains) { adopt = relayHead; fromRelay = true }
      }
    } catch { /* offline → backup head */ }
    DP.setLocalHead(pk, adopt)
    if (fromRelay) {
      tail = 'picked up your newer head from relays — the backup back-filled the rest.'
    } else {
      if (!ins.missingPrev) DP.setPostCount(pk, ins.notes)
      announceHead(adopt)
    }
  } else if (cur !== target) {
    const d = await H().contains({ headCid: target, targetCid: cur })
    if (d?.contains) {
      // backup made on a machine that had posted past this node's head — adopt the newer chain
      DP.setLocalHead(pk, target)
      if (!ins.missingPrev) DP.setPostCount(pk, ins.notes)
      announceHead(target)
    } else {
      const r = await H().contains({ headCid: cur, targetCid: target })
      tail = r?.contains
        ? 'this node already holds a newer history — kept it; the backup\'s blocks were imported all the same.'
        : 'this backup is from a different chain than the history on this node — kept the current one; the backup\'s blocks were imported all the same.'
    }
  }
  setStatus(status, `✓ Restored ${ins.notes} note${ins.notes === 1 ? '' : 's'} + ${ins.media} media — ${tail}`, 'ok')
}

/** Mount into the Settings section (hidden outside the Nosdag shell, e.g. web/dev). */
// This predates the pane registry and keeps its static placeholder; new settings sections should resolve their container via getSettingsPane() in js/nosdag/settings-sections.js.
export async function mountBackupSection () {
  const section = document.getElementById('ndHistoryBackupSection')
  if (!section) return
  if (!H()) { section.style.display = 'none'; return }
  section.style.display = ''
  ensureStyles()
  const host = section.querySelector('#ndHistoryBackup')
  host.innerHTML = `
    <p class="nd-hb-desc">Your notes + media live in your local node as one content-addressed history. Export packs <b>all of it into a single .car archive</b> — restore that file on any Nosdag install (with this account's nsec) to move machines or recover from a dead disk. The format is standard IPFS: even without Nosdag, <code>ipfs dag import</code> can serve it.</p>
    <div class="nd-hb-row">
      <button class="nd-hb-btn" data-kind="primary" id="nd-hb-export">⬇ Export my note history</button>
      <button class="nd-hb-btn" data-kind="ghost" id="nd-hb-restore">⬆ Restore from backup…</button>
    </div>
    <div class="nd-hb-status" id="nd-hb-status"></div>
    <div class="nd-hb-confirm" id="nd-hb-confirm"></div>`
  host.querySelector('#nd-hb-export').addEventListener('click', () => doExport(host))
  host.querySelector('#nd-hb-restore').addEventListener('click', () => doRestore(host))
}
