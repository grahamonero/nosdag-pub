// Nosdag Phase 3 Slice 2 — "Hosted Follows" page (design §5.1).
//
// The surface where you choose which of the accounts you follow your node hosts (pins their notes +
// media locally so their content survives them going offline). At first login you pick who; new
// follows then auto-host unless you turn that off here. Bounded by a per-account quota + a global
// disk cap, both shown live. Operator-console aesthetic, consistent with the Node panel.

import * as State from '../state.js'
import * as Relays from '../relays.js'
import * as AP from './altruistic-pin.js'

function fmtBytes (n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}
function shortNpub (pk) {
  try { const n = window.NostrTools.nip19.npubEncode(pk); return n.slice(0, 12) + '…' + n.slice(-4) } catch { return pk.slice(0, 10) + '…' }
}
function profileOf (pk) { return State.profileCache?.[pk] || {} }
function nameOf (pk) { const p = profileOf(pk); return (p.display_name || p.name || '').trim() || shortNpub(pk) }
function pfpOf (pk) { return profileOf(pk).picture || '' }
function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

function ensureStyles () {
  if (document.getElementById('hf-styles')) return
  const el = document.createElement('style')
  el.id = 'hf-styles'
  el.textContent = STYLE
  document.head.appendChild(el)
}

export async function renderHostedFollows (container) {
  ensureStyles()

  if (!window.nosdag?.kubo?.pinRecursive) {
    container.innerHTML = `<div class="hf-wrap"><p class="hf-empty">Hosting runs in the Nosdag desktop app.</p></div>`
    return
  }
  const me = State.publicKey
  if (!me) {
    container.innerHTML = `<div class="hf-wrap">${header()}<p class="hf-empty">Sign in to host the accounts you follow — their notes &amp; media live on your node, so they stay reachable when their machine is off.</p></div>`
    container.querySelector('[data-hf-home]')?.addEventListener('click', () => window.navigateTo?.('home'))
    return
  }

  // You can't host yourself. Drop any stray self-host record (without unpinning your own notes), make
  // sure your own head stays pinned in case a past self-unfollow unpinned it, then exclude yourself.
  if (AP.isHosted(me)) {
    AP.forgetHost(me)
    try { const DP = await import('./dag-publish.js'); const h = DP.getLocalHead(me); if (h) window.nosdag?.kubo?.pinRecursive?.(h) } catch { /* best-effort */ }
  }
  const follows = [...(State.followingUsers || [])].filter((pk) => pk !== me)
  const u = AP.usage()
  const firstRun = u.count === 0 && Object.keys(AP.wantedMap()).length === 0

  container.innerHTML = `
  <div class="hf-wrap">
    ${header()}

    <section class="hf-card">
      <div class="hf-usage">
        <div class="hf-usage-top">
          <span class="hf-usage-val nd-mono" id="hf-usage-val">${fmtBytes(u.totalBytes)} <small>of ${fmtBytes(u.capBytes)}</small></span>
          <span class="hf-usage-cnt nd-mono" id="hf-usage-cnt">${u.count} hosted</span>
        </div>
        <div class="hf-bar"><div class="hf-bar-fill" id="hf-bar-fill" style="width:${Math.min(100, (u.totalBytes / u.capBytes) * 100).toFixed(1)}%"></div></div>
      </div>
      <div class="hf-settings">
        <label class="hf-field">
          <span class="hf-field-label">Total reserved for hosting</span>
          <span class="hf-field-in"><input type="number" id="hf-globalcap" min="1" step="1" value="${Math.round(AP.globalCapMB() / 1024 * 10) / 10}"><i>GB</i></span>
        </label>
        <label class="hf-field">
          <span class="hf-field-label">Default per account</span>
          <span class="hf-field-in"><input type="number" id="hf-percap" min="1" step="10" value="${AP.perAccountMB()}"><i>MB</i></span>
        </label>
      </div>
      <label class="hf-switch hf-auto">
        <input type="checkbox" id="hf-autonew" ${AP.autoNewFollows() ? 'checked' : ''}>
        <span class="hf-slider"></span>
        <span class="hf-auto-label">Host new follows automatically</span>
      </label>
      <button class="hf-btn" id="hf-refresh">Refresh hosted content</button>
      <div class="hf-status nd-mono" id="hf-status" hidden></div>
    </section>

    ${firstRun ? '<p class="hf-intro">Pick which of your follows to host. Their notes &amp; media will be pinned to your node.</p>' : ''}

    <section class="hf-list" id="hf-list">
      ${follows.length ? follows.map(row).join('') : '<p class="hf-empty">You don’t follow anyone yet.</p>'}
    </section>
  </div>`

  container.querySelector('[data-hf-home]')?.addEventListener('click', () => window.navigateTo?.('home'))

  const status = container.querySelector('#hf-status')
  const showStatus = (t) => { if (status) { status.hidden = !t; status.textContent = t || '' } }

  container.querySelector('#hf-autonew')?.addEventListener('change', (e) => AP.setAutoNewFollows(e.currentTarget.checked))

  container.querySelector('#hf-globalcap')?.addEventListener('change', (e) => {
    const gb = parseFloat(e.currentTarget.value)
    if (gb > 0) { AP.setGlobalCapMB(Math.round(gb * 1024)); updateUsage(container) }
  })
  container.querySelector('#hf-percap')?.addEventListener('change', (e) => {
    const mb = parseInt(e.currentTarget.value, 10)
    if (mb > 0) AP.setDefaultPerAccountMB(mb) // applies to future hosts / accounts without an override
  })

  container.querySelector('#hf-refresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Refreshing…'
    try { const r = await AP.refreshHosted(showStatus); showStatus(`Done — ${r.updated} updated of ${r.checked} hosted.`) }
    catch (err) { showStatus('Error: ' + (err?.message || err)) }
    btn.disabled = false; btn.textContent = orig
    follows.forEach(refreshRow.bind(null, container)); updateUsage(container)
  })

  // wire each row's host toggle
  container.querySelectorAll('.hf-row').forEach((rowEl) => {
    const pk = rowEl.dataset.pk
    rowEl.querySelector('.hf-row-toggle input')?.addEventListener('change', async (e) => {
      const input = e.currentTarget
      const on = input.checked
      input.disabled = true
      setRowState(rowEl, on ? 'Pinning…' : 'Unpinning…')
      try {
        if (on) {
          AP.setWant(pk, true) // intent sticks even if this attempt fails — the retry loop takes over
          const res = await AP.hostAccount(pk, (m) => setRowState(rowEl, m))
          if (!res.ok) {
            if (AP.isPermanentRefusal(res.reason)) {
              AP.setWant(pk, false)
              input.checked = false
              setRowState(rowEl, res.error || 'failed', 'err')
            } else {
              input.checked = true
              setRowState(rowEl, waitText(pk), 'wait')
            }
            updateUsage(container)
            input.disabled = false
            return // keep the message — don't refreshRow (it would wipe it)
          }
          refreshRow(container, pk)
        } else {
          await AP.unhostAccount(pk) // also clears the intent
          refreshRow(container, pk)
        }
        updateUsage(container)
      } catch (err) {
        if (on) {
          setRowState(rowEl, waitText(pk) || String(err?.message || err), 'wait')
        } else {
          input.checked = true
          setRowState(rowEl, String(err?.message || err), 'err')
        }
      }
      input.disabled = false
    })

    // per-account cap: store the override; if already hosted, re-apply within the new limit
    rowEl.querySelector('.hf-cap')?.addEventListener('change', async (ev) => {
      const mb = parseInt(ev.currentTarget.value, 10)
      if (!(mb > 0)) return
      AP.setAccountCap(pk, mb)
      if (!AP.isHosted(pk)) return
      await rehost(container, rowEl, pk, [ev.currentTarget])
    })

    // media preference: unchecked = notes only, their media is never pinned
    rowEl.querySelector('.hf-media')?.addEventListener('change', async (ev) => {
      AP.setNotesOnly(pk, !ev.currentTarget.checked)
      if (!AP.isHosted(pk)) return // applies on the next attempt (incl. the retry loop's)
      await rehost(container, rowEl, pk, [ev.currentTarget])
    })
  })

  // live-update rows when the background retry loop pins (or gives up on) an account
  if (onAltpinChanged) window.removeEventListener('nosdag:altpin-changed', onAltpinChanged)
  onAltpinChanged = (e) => {
    if (!container.isConnected) return
    const pk = e.detail?.pk
    if (pk) refreshRow(container, pk)
    updateUsage(container)
  }
  window.addEventListener('nosdag:altpin-changed', onAltpinChanged)

  // fill in names/pfps for follows not yet in the profile cache (best-effort, background)
  hydrateProfiles(container, follows.filter((pk) => !profileOf(pk).name && !profileOf(pk).display_name))
}

let onAltpinChanged = null

function header () {
  return `
  <div class="hf-head">
    <button class="hf-back" data-hf-home aria-label="Back to feed">←</button>
    <div>
      <h1 class="hf-title">Hosted Follows</h1>
      <div class="hf-sub">Pin the accounts you follow to your node, so they stay reachable when offline</div>
    </div>
  </div>`
}

// Re-apply hosting under a changed setting (cap / media preference): drop the current pins, then
// re-host. Intent is re-recorded first so a transient failure leaves the row waiting, not dropped.
async function rehost (container, rowEl, pk, busyEls = []) {
  const tog = rowEl.querySelector('.hf-row-toggle input')
  const els = [tog, ...busyEls].filter(Boolean)
  els.forEach((el) => { el.disabled = true })
  setRowState(rowEl, 'Updating…')
  try {
    await AP.unhostAccount(pk)
    AP.setWant(pk, true)
    const res = await AP.hostAccount(pk, (m) => setRowState(rowEl, m))
    if (!res.ok) {
      if (AP.isPermanentRefusal(res.reason)) {
        AP.setWant(pk, false)
        if (tog) tog.checked = false
        setRowState(rowEl, res.error || 'failed', 'err')
      } else {
        if (tog) tog.checked = true
        setRowState(rowEl, waitText(pk), 'wait')
      }
    } else refreshRow(container, pk)
  } catch (err) { setRowState(rowEl, waitText(pk) || String(err?.message || err), 'wait') }
  els.forEach((el) => { el.disabled = false })
  updateUsage(container)
}

function row (pk) {
  const rec = AP.hostedRecord(pk)
  const hosted = !!rec
  const waiting = !hosted && AP.wantHost(pk)
  return `
  <div class="hf-row" data-pk="${esc(pk)}">
    <div class="hf-av">${pfpOf(pk) ? `<img src="${esc(pfpOf(pk))}" loading="lazy" alt="">` : ''}</div>
    <div class="hf-id">
      <div class="hf-name" data-hf-name>${esc(nameOf(pk))}</div>
      <div class="hf-meta nd-mono ${waiting ? 'hf-meta-wait' : ''}" data-hf-meta>${hosted ? metaText(rec) : (waiting ? esc(waitText(pk)) : shortNpub(pk))}</div>
    </div>
    <label class="hf-media-opt" title="Pin their media too — unchecked hosts notes only">
      <input type="checkbox" class="hf-media" ${AP.notesOnly(pk) ? '' : 'checked'}>
      <span>media</span>
    </label>
    <div class="hf-capwrap" data-hf-capwrap ${hosted ? '' : 'hidden'}>
      <input type="number" class="hf-cap" min="1" step="10" value="${AP.accountCapMB(pk)}" title="Max to host for this account">
      <i>MB</i>
    </div>
    <label class="hf-switch hf-row-toggle">
      <input type="checkbox" ${hosted || waiting ? 'checked' : ''}>
      <span class="hf-slider"></span>
    </label>
  </div>`
}

function metaText (rec) {
  if (!rec) return ''
  if (rec.notesOnly) return `${rec.notes || 0} notes · notes only · ${fmtBytes(rec.bytes || 0)}`
  return `${rec.notes || 0} notes · ${rec.media || 0} media · ${fmtBytes(rec.bytes || 0)}`
}

function waitText (pk) {
  const w = AP.wantRecord(pk)
  const why = w?.lastReason === 'no-content'
    ? 'nothing in IPFS yet'
    : 'can’t reach them right now'
  return `Waiting to pin — ${why} · keeps trying while the app runs`
}

function setRowState (rowEl, msg, tone = '') {
  const meta = rowEl.querySelector('[data-hf-meta]')
  if (!meta) return
  meta.textContent = msg || ''
  meta.classList.toggle('hf-meta-err', tone === 'err')
  meta.classList.toggle('hf-meta-wait', tone === 'wait')
}

function refreshRow (container, pk) {
  const rowEl = container.querySelector(`.hf-row[data-pk="${CSS.escape(pk)}"]`)
  if (!rowEl) return
  const rec = AP.hostedRecord(pk)
  const waiting = !rec && AP.wantHost(pk)
  const meta = rowEl.querySelector('[data-hf-meta]')
  if (meta) {
    meta.classList.remove('hf-meta-err')
    meta.classList.toggle('hf-meta-wait', waiting)
    meta.textContent = rec ? metaText(rec) : (waiting ? waitText(pk) : shortNpub(pk))
  }
  const input = rowEl.querySelector('.hf-row-toggle input')
  if (input) input.checked = !!rec || waiting
  const cap = rowEl.querySelector('[data-hf-capwrap]')
  if (cap) { cap.hidden = !rec; const ci = cap.querySelector('.hf-cap'); if (ci) ci.value = AP.accountCapMB(pk) }
  const media = rowEl.querySelector('.hf-media')
  if (media) media.checked = !AP.notesOnly(pk)
}

function updateUsage (container) {
  const u = AP.usage()
  const val = container.querySelector('#hf-usage-val')
  const cnt = container.querySelector('#hf-usage-cnt')
  const fill = container.querySelector('#hf-bar-fill')
  if (val) val.innerHTML = `${fmtBytes(u.totalBytes)} <small>of ${fmtBytes(u.capBytes)}</small>`
  if (cnt) cnt.textContent = `${u.count} hosted`
  if (fill) fill.style.width = `${Math.min(100, (u.totalBytes / u.capBytes) * 100).toFixed(1)}%`
}

// Pull kind-0 for follows missing from the profile cache, then fill in their name/pfp cells.
async function hydrateProfiles (container, pks) {
  if (!pks.length || !State.pool) return
  const relays = Relays.getReadRelays?.() || []
  if (!relays.length) return
  try {
    for (let i = 0; i < pks.length; i += 100) {
      const chunk = pks.slice(i, i + 100)
      const evs = await State.pool.querySync(relays, { kinds: [0], authors: chunk })
      for (const ev of (evs || [])) {
        try {
          const meta = JSON.parse(ev.content || '{}')
          State.profileCache[ev.pubkey] = { ...(State.profileCache[ev.pubkey] || {}), ...meta }
          const rowEl = container.querySelector(`.hf-row[data-pk="${CSS.escape(ev.pubkey)}"]`)
          if (rowEl) {
            const nameEl = rowEl.querySelector('[data-hf-name]'); if (nameEl) nameEl.textContent = nameOf(ev.pubkey)
            const av = rowEl.querySelector('.hf-av'); const pic = pfpOf(ev.pubkey)
            if (av && pic && !av.querySelector('img')) { const im = document.createElement('img'); im.loading = 'lazy'; im.src = pic; av.appendChild(im) }
          }
        } catch { /* bad metadata */ }
      }
    }
  } catch (e) { console.warn('[nosdag] hosted-follows profile hydrate:', e) }
}

const STYLE = `
.hf-wrap{--nd-mono:'SF Mono','Cascadia Code',Monaco,ui-monospace,monospace;--nd-accent:var(--monero-orange,var(--nd-accent));
  --nd-line:var(--border-color,rgba(255,255,255,.08));--nd-card:var(--card-bg,rgba(255,255,255,.03));--nd-seeded:#26d07c;
  max-width:760px;margin:0 auto;padding:30px 22px 64px;color:var(--text-primary,#fff)}
.hf-wrap *{box-sizing:border-box}
@keyframes hf-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.hf-wrap{animation:hf-rise .4s ease both}
.hf-head{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.hf-back{flex:none;width:38px;height:38px;border-radius:10px;border:1px solid var(--nd-line);background:transparent;color:var(--text-secondary,#9aa4b4);font-size:17px;cursor:pointer;transition:.18s}
.hf-back:hover{border-color:var(--nd-accent);color:#fff;transform:translateX(-2px)}
.hf-title{margin:0;font-size:21px;font-weight:650;letter-spacing:-.01em}
.hf-sub{margin-top:2px;font-size:12.5px;color:var(--text-muted,#5d6878)}
.hf-card{border:1px solid var(--nd-line);border-radius:16px;background:var(--nd-card);padding:18px 20px;margin-bottom:16px}
.hf-usage-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.hf-usage-val{font-size:18px;font-weight:700;color:var(--text-primary,#fff)}.hf-usage-val small{font-size:12px;color:var(--text-muted,#5d6878);font-weight:400}
.hf-usage-cnt{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--nd-accent)}
.hf-bar{height:7px;border-radius:4px;background:rgba(0,0,0,.3);margin:10px 0 7px;overflow:hidden}
.hf-bar-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--nd-accent-hi),var(--nd-accent));transition:width .4s ease;min-width:2px}
.hf-usage-sub{font-size:11.5px;color:var(--text-muted,#5d6878)}
.hf-settings{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
.hf-field{display:flex;flex-direction:column;gap:6px}
.hf-field-label{font:600 9.5px/1.3 var(--nd-mono);letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted,#5d6878)}
.hf-field-in{display:flex;align-items:center;gap:7px;border:1px solid var(--nd-line);border-radius:9px;background:rgba(0,0,0,.22);padding:0 11px;transition:.16s}
.hf-field-in:focus-within{border-color:var(--nd-accent)}
.hf-field-in input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--text-primary,#fff);font:600 14px/1 var(--nd-mono);padding:9px 0}
.hf-field-in i{font:600 10px/1 var(--nd-mono);font-style:normal;letter-spacing:.06em;color:var(--text-muted,#5d6878)}
.hf-capwrap{flex:none;display:flex;align-items:center;gap:4px;border:1px solid var(--nd-line);border-radius:8px;background:rgba(0,0,0,.22);padding:0 8px;transition:.16s}
.hf-capwrap[hidden]{display:none}
.hf-capwrap:focus-within{border-color:var(--nd-accent)}
.hf-cap{width:50px;background:transparent;border:none;outline:none;color:var(--text-secondary,#9aa4b4);font:600 12px/1 var(--nd-mono);padding:7px 0;text-align:right}
.hf-capwrap i{font:600 9px/1 var(--nd-mono);font-style:normal;color:var(--text-muted,#5d6878)}
.hf-wrap input[type=number]{-moz-appearance:textfield}
.hf-wrap input[type=number]::-webkit-inner-spin-button,.hf-wrap input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.hf-auto{display:flex;align-items:center;gap:11px;margin:18px 0 0;cursor:pointer}
.hf-auto-label{font-size:13.5px;color:var(--text-primary,#e9eef5)}
.hf-btn{margin-top:16px;padding:9px 14px;border-radius:9px;border:1px solid var(--nd-line);background:transparent;color:var(--text-secondary,#9aa4b4);font:600 12px/1 var(--nd-mono);letter-spacing:.03em;cursor:pointer;transition:.16s}
.hf-btn:hover:not(:disabled){border-color:var(--nd-accent);color:#fff}
.hf-btn:disabled{opacity:.6;cursor:default}
.hf-status{margin-top:12px;font-size:12px;color:var(--text-secondary,#9aa4b4)}
.hf-intro{margin:0 2px 14px;font-size:13px;line-height:1.55;color:var(--text-secondary,#9aa4b4);padding:12px 14px;border-left:2px solid var(--nd-accent);background:color-mix(in srgb, var(--nd-accent) 5%, transparent);border-radius:8px}
.hf-list{display:flex;flex-direction:column;gap:8px}
.hf-row{display:flex;align-items:center;gap:13px;padding:11px 14px;border:1px solid var(--nd-line);border-radius:13px;background:var(--nd-card);transition:.16s}
.hf-row:hover{border-color:rgba(255,255,255,.14)}
.hf-av{flex:none;width:40px;height:40px;border-radius:50%;overflow:hidden;background:rgba(255,255,255,.06);display:grid;place-items:center}
.hf-av img{width:100%;height:100%;object-fit:cover}
.hf-id{flex:1;min-width:0}
.hf-name{font-size:14px;font-weight:600;color:var(--text-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hf-meta{margin-top:3px;font-size:11px;color:var(--text-muted,#5d6878);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hf-meta-err{color:#ff5d5d!important}
.hf-meta-wait{color:var(--nd-rest,#c9973f)!important}
.hf-media-opt{flex:none;display:flex;align-items:center;gap:5px;border:1px solid var(--nd-line);border-radius:8px;padding:6px 9px;cursor:pointer;transition:.16s;color:var(--text-muted,#5d6878)}
.hf-media-opt:hover{border-color:var(--nd-accent)}
.hf-media-opt:has(input:checked){color:var(--text-secondary,#9aa4b4)}
.hf-media-opt input{margin:0;width:12px;height:12px;cursor:pointer;accent-color:var(--nd-accent)}
.hf-media-opt input:disabled{cursor:default}
.hf-media-opt span{font:600 9.5px/1 var(--nd-mono);letter-spacing:.07em;text-transform:uppercase}
.hf-empty{color:var(--text-muted,#5d6878);font-size:13.5px;text-align:center;padding:30px 10px;line-height:1.6}
/* switch */
.hf-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer}
.hf-switch input{position:absolute;opacity:0;width:0;height:0}
.hf-slider{flex:none;width:42px;height:24px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid var(--nd-line);transition:.2s;position:relative}
.hf-slider::before{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#cdd4de;transition:.2s}
.hf-switch input:checked + .hf-slider{background:linear-gradient(180deg,var(--nd-accent-hi),var(--nd-accent));border-color:transparent}
.hf-switch input:checked + .hf-slider::before{transform:translateX(18px);background:#fff}
.hf-switch input:disabled + .hf-slider{opacity:.55}
.hf-row-toggle{flex:none}
`
