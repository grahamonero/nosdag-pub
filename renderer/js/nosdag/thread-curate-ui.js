// Nosdag Phase 5 · Slice 2 — shared thread-curation UI.
//
// Used by BOTH thread renderers — the full-page view (js/ui/thread.js) and the right-panel view
// (js/right-panel.js) — so the author's curation controls + their click handling stay identical.
// Pure HTML-string builders + one delegated click handler; the actual mutations live behind
// window.NosdagReq (wired in pending-queue.js).

import { escapeHtml } from '../utils.js'

// Owner-only controls under an ENDORSED reply: reorder (↑/↓) + reversible revoke (§6.4).
export function ownerControls (parentId, replyId, indent) {
  const a = (act, label, cls = '') =>
    `<button class="nd-tc-btn ${cls}" data-nd-act="${act}" data-pid="${escapeHtml(parentId)}" data-id="${escapeHtml(replyId)}">${label}</button>`
  return `<div class="nd-tc nd-tc-owner" style="margin-left:${indent}px">${a('up', '↑', 'nd-tc-mini')}${a('down', '↓', 'nd-tc-mini')}${a('revoke', '⊘ revoke', 'nd-tc-revoke')}</div>`
}

// Owner-only triage bar under an UNENDORSED (stranger) reply.
export function triageBar (parentId, replyId, author, indent) {
  const d = `data-pid="${escapeHtml(parentId)}" data-id="${escapeHtml(replyId)}" data-pk="${escapeHtml(author || '')}"`
  return `<div class="nd-tc nd-tc-triage" style="margin-left:${indent}px">
    <button class="nd-tc-btn nd-tc-approve" data-nd-act="approve" ${d}>✓ Approve</button>
    <button class="nd-tc-btn" data-nd-act="ignore" ${d}>Ignore</button>
    <button class="nd-tc-btn nd-tc-block" data-nd-act="block" ${d}>Block</button>
  </div>`
}

// Open/close the "unendorsed replies (N)" disclosure wrapping replies the node's author hasn't
// endorsed. The author triages them here; everyone else sees them de-emphasized — visible, but
// below the endorsed replies and marked as outside the author's curation.
export function unendorsedOpen (count, indent, forOwner = true) {
  const noun = count === 1 ? 'reply' : 'replies'
  const label = forOwner
    ? `⌁ ${count} unendorsed ${noun}`
    : `⌁ ${count} ${noun} not endorsed by the author`
  return `<div class="nd-unend${forOwner ? '' : ' nd-unend-viewer'}" style="margin-left:${indent}px"><div class="nd-unend-h nd-mono">${label}</div>`
}
export function unendorsedClose () { return '</div>' }

// Idempotent delegated click wiring on a rendered thread container. `refresh()` re-renders the
// thread after a mutation so the new curation state shows. Assigning .onclick replaces any prior
// handler from an earlier render of the same container (no listener stacking).
export function wireCurationClicks (container, refresh) {
  if (!container) return
  container.onclick = async (e) => {
    const btn = e.target.closest('[data-nd-act]')
    if (!btn || !container.contains(btn)) return
    e.preventDefault(); e.stopPropagation()
    const R = window.NosdagReq
    if (!R) return
    const { ndAct: act, id, pid, pk } = btn.dataset
    btn.disabled = true
    try {
      if (act === 'approve') await R.approve(id, pid, pk)
      else if (act === 'ignore') R.ignore(id)
      else if (act === 'block') await R.block(id, pk)
      else if (act === 'revoke') await R.revoke(id, pid)
      else if (act === 'up') await R.move(pid, id, -1)
      else if (act === 'down') await R.move(pid, id, 1)
    } catch (err) { console.warn('[nosdag] thread curation action failed:', err) }
    try { if (typeof refresh === 'function') refresh() } catch { /* ignore */ }
  }
}
