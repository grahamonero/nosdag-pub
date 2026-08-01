// Nosdag Phase 3 — Cloud Bridge (design §5.2 / build §4.3).
//
// Link a pinning service so your notes + media stay reachable 24/7 when this machine is offline — a
// durability floor independent of follower altruism. Two mechanisms sit behind one bridge, chosen by
// the provider:
//   • PSA  — the standard IPFS Pinning Service API (Pinata, most providers). Kubo's built-in
//            remote-pinning does the work; the token lives in Kubo's config.
//   • RPC  — a Kubo-RPC endpoint (Filebase: rpc.filebase.io). Filebase only authenticates its
//            per-bucket token on this API, which Kubo's remote-pinning can't target — so main pins to
//            it directly and keeps the token in a userData file.
// The user never picks the mechanism: choosing a provider selects it. The card explains which one is
// in use so "Filebase vs another service" is transparent.
//
// Bridges are PER-ACCOUNT: every op passes the active pubkey and main resolves that account's own
// entry in the bridge map — so a second account on this machine never pins into (or is correlated
// with) another account's provider bucket. A bridge linked before per-account existed surfaces as
// `legacy` on an unlinked status; the card offers an explicit claim-or-remove.
//
// Responsibilities:
//   • publish hook  — pinNote(signedEvent, headCid, prevCid): called from dag-publish after the local
//                     pin; mirrors the note to the linked bridge. Best-effort, never blocks the post.
//   • Node-panel UI — mountBridgeCard(section): link form (provider, endpoint, token), live counts,
//                     unlink. Styled with the --nd-* tokens that cascade from .nd-node.

const bridge = () => window.nosdag?.cloudBridge

// Provider presets. `kind` picks the mechanism; `endpoint` prefills (editable); `explain` states how
// that provider is pinned to; `hint` says exactly where the token comes from.
export const PRESETS = [
  {
    id: 'filebase', label: 'Filebase', kind: 'rpc', endpoint: 'https://rpc.filebase.io',
    explain: 'Filebase pins through its IPFS RPC API (rpc.filebase.io) — Nosdag talks to it directly. Pinning by CID needs a paid Filebase plan (the free tier is upload-only).',
    hint: 'Token = your IPFS bucket’s “Secret Access Token” (Filebase → Access Keys → IPFS RPC API endpoint → pick your bucket). The bucket must be an IPFS bucket.'
  },
  {
    id: 'pinata', label: 'Pinata', kind: 'psa', endpoint: 'https://api.pinata.cloud/psa',
    explain: 'Pinata uses the standard IPFS Pinning Service API.',
    hint: 'Token = a JWT scoped to the Pinning Service API (Pinata dashboard → API Keys).'
  },
  {
    id: 'custom', label: 'Custom (Pinning Service API)', kind: 'psa', endpoint: '',
    explain: 'For any service that implements the standard IPFS Pinning Service API.',
    hint: 'Enter the service’s Pinning Service API endpoint and a bearer token.'
  }
]

const MECHANISM = { rpc: 'IPFS RPC API', psa: 'Pinning Service API' }

// The active account's pubkey — bridges are per-account, so every IPC carries it.
const activePk = () => { try { return window.NostrState?.publicKey || null } catch { return null } }

// in-renderer cache of the last status (shared singleton with dag-publish's import), keyed by the
// account it was fetched for so an account switch can't reuse the previous account's bridge state.
let active = null      // { linked, kind, provider, endpoint, counts, reachable } | null
let activeFor = null   // pubkey `active` belongs to
let hydrated = false

export function getActive () { return active }

export async function refreshStatus () {
  const pk = activePk()
  if (!bridge() || !pk) { active = { linked: false }; activeFor = pk; hydrated = true; return active }
  try { const s = await bridge().status({ pubkey: pk }); active = (s && !s.error) ? s : { linked: false, error: s?.error } }
  catch { active = { linked: false } }
  activeFor = pk
  hydrated = true
  return active
}

// ---- media CID extraction from a signed event ----
// By publish time interop-publish has rewritten ipfs://<CID> → https://dweb.link/ipfs/<CID>, and the
// imeta `url` carries the same — so match BOTH forms across content + tags. CIDv1 (bafy/bafk…) and
// CIDv0 (Qm…) are each ≥40 chars of [A-Za-z0-9]; main validates each.
export function extractMediaCids (signedEvent) {
  if (!signedEvent) return []
  const hay = JSON.stringify({ content: signedEvent.content || '', tags: signedEvent.tags || [] })
  const re = /(?:ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]{40,})/g
  const out = new Set()
  let m
  while ((m = re.exec(hay)) !== null) out.add(m[1])
  return [...out]
}

/**
 * Publish hook — mirror a freshly-stored note to the linked bridge. Fire-and-forget; never throws.
 * No-op when no bridge is linked.
 */
export async function pinNote (signedEvent, headCid, prevCid) {
  try {
    const pk = signedEvent?.pubkey
    if (!bridge() || !headCid || !pk) return
    if (!hydrated || activeFor !== pk) await refreshStatus()
    if (!active?.linked) return
    const mediaCids = extractMediaCids(signedEvent)
    const res = await bridge().pinNote({ pubkey: pk, headCid, mediaCids, prevHeadCid: prevCid || null })
    if (res?.error) { console.warn('[nosdag] cloud-bridge pin failed:', res.error); return }
    console.log(`[nosdag] ☁ mirrored to ${active.provider} (${active.kind}): head=${headCid} +${mediaCids.length} media`, res)
  } catch (e) { console.warn('[nosdag] cloud-bridge pinNote error:', e) }
}

// ---------------------------------------------------------------------------
// Node-panel UI
// ---------------------------------------------------------------------------

function esc (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function ensureBridgeStyles () {
  if (document.getElementById('nd-bridge-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-bridge-styles'
  el.textContent = STYLE
  document.head.appendChild(el)
}

function headerRow (badge) {
  return `
  <div class="nd-bridge-row">
    <div>
      <h2 class="nd-h">Cloud Bridge</h2>
      <p class="nd-bridge-desc">Link a pinning service so your notes &amp; media stay reachable 24/7 when this machine is offline. Same CIDs everywhere — no lock-in.</p>
    </div>
    ${badge}
  </div>`
}

// A bridge linked before per-account bridges existed: claim it for the active account or remove it.
function legacyBanner (l) {
  return `
  <div class="nd-bf-legacy" id="nd-bridge-legacy">
    <p class="nd-bf-legacy-t">This node has a bridge from before per-account linking: <b>${esc(l.provider)}</b> <span class="nd-mono">${esc(l.endpoint)}</span></p>
    <p class="nd-bf-legacy-s">If it's yours, claim it for this account and pinning continues unchanged. Other accounts stay unlinked either way.</p>
    <div class="nd-bridge-actions">
      <button class="nd-bridge-mini" id="nd-bridge-claim" type="button">Claim for this account</button>
      <button class="nd-bridge-mini nd-bridge-unlink" id="nd-bridge-discard" type="button">Remove it</button>
    </div>
  </div>`
}

function notLinkedShell (note, legacy) {
  const opts = PRESETS.map((p, i) => `<option value="${p.id}"${i === 0 ? ' selected' : ''}>${esc(p.label)}</option>`).join('')
  const p0 = PRESETS[0]
  return `
  ${headerRow('<span class="nd-badge" id="nd-bridge-badge">Not linked</span>')}
  ${legacy ? legacyBanner(legacy) : ''}
  <form class="nd-bridge-form" id="nd-bridge-form" autocomplete="off">
    <label class="nd-bf-label" for="nd-bf-provider">Provider</label>
    <select class="nd-bf-input" id="nd-bf-provider">${opts}</select>
    <p class="nd-bf-explain" id="nd-bf-explain">${esc(p0.explain)}</p>

    <label class="nd-bf-label" for="nd-bf-endpoint">Endpoint</label>
    <input class="nd-bf-input nd-mono" id="nd-bf-endpoint" type="url" spellcheck="false" value="${esc(p0.endpoint)}" placeholder="https://…">

    <label class="nd-bf-label" for="nd-bf-token">Access token</label>
    <input class="nd-bf-input nd-mono" id="nd-bf-token" type="password" spellcheck="false" placeholder="paste service token">

    <p class="nd-bf-hint" id="nd-bf-hint">${esc(p0.hint)}</p>
    <p class="nd-bf-err" id="nd-bf-err" hidden></p>
    <button class="nd-bf-submit" id="nd-bf-submit" type="submit">Link pinning service</button>
    <p class="nd-bf-note">Nosdag pins your notes by CID — most services charge for pin-by-CID, so check your provider’s plan. The token is stored locally and never published to Nostr. Bridges are per-account: this link applies to the account you’re logged in as.</p>
  </form>
  ${note ? `<p class="nd-bf-err" style="margin-top:10px">${esc(note)}</p>` : ''}`
}

function statsBlock (s) {
  if (s.kind === 'rpc') {
    const n = s.counts ? (s.counts.pinned ?? '—') : '—'
    return `<div class="nd-bstats nd-bstats-one"><div class="nd-bstat"><div class="nd-bstat-v nd-mono ok">${n}</div><div class="nd-bstat-l">pinned</div></div></div>`
  }
  const c = s.counts || null
  const stat = (k, cls) => `<div class="nd-bstat"><div class="nd-bstat-v nd-mono ${cls}">${c ? (c[k] ?? 0) : '—'}</div><div class="nd-bstat-l">${k}</div></div>`
  return `<div class="nd-bstats">${stat('pinned', 'ok')}${stat('pinning', 'warn')}${stat('queued', 'warn')}${stat('failed', 'bad')}</div>`
}

function linkedShell (s) {
  return `
  ${headerRow('<span class="nd-badge nd-badge-on" id="nd-bridge-badge">● Linked</span>')}
  <div class="nd-bridge-linked">
    <dl class="nd-dl">
      <dt>Provider</dt><dd>${esc(s.provider)} <span class="nd-bridge-mech">via ${esc(MECHANISM[s.kind] || s.kind)}</span></dd>
      <dt>Endpoint</dt><dd class="nd-mono nd-bridge-ep">${esc(s.endpoint)}</dd>
    </dl>
    ${statsBlock(s)}
    ${s.reachable === false
      ? '<p class="nd-bf-warn">⚠ This service isn’t responding — your notes are NOT being mirrored. Re-check the token (Unlink and re-link).</p>'
      : ''}
    <button class="nd-bridge-mini" id="nd-bridge-mirror" type="button" style="width:100%;margin-top:14px">Mirror my latest note now</button>
    <button class="nd-bridge-mini" id="nd-bridge-pinall" type="button" style="width:100%;margin-top:8px">Pin all my notes</button>
    <pre class="nd-bridge-mresult" id="nd-bridge-mresult" hidden></pre>
    <div class="nd-bridge-actions">
      <button class="nd-bridge-mini" id="nd-bridge-refresh" type="button">Refresh</button>
      <button class="nd-bridge-mini nd-bridge-unlink" id="nd-bridge-unlink" type="button">Unlink</button>
    </div>
  </div>`
}

function bindLinkForm (section, rerender) {
  const form = section.querySelector('#nd-bridge-form')
  if (!form) return
  const provider = section.querySelector('#nd-bf-provider')
  const endpoint = section.querySelector('#nd-bf-endpoint')
  const explain = section.querySelector('#nd-bf-explain')
  const hint = section.querySelector('#nd-bf-hint')
  const token = section.querySelector('#nd-bf-token')
  const err = section.querySelector('#nd-bf-err')
  const submit = section.querySelector('#nd-bf-submit')

  const presetFor = () => PRESETS.find((p) => p.id === provider.value) || PRESETS[0]
  const showErr = (msg) => { if (err) { err.textContent = msg; err.hidden = !msg } }

  // Choosing a provider prefills its endpoint + copy, but the endpoint stays editable (providers
  // change theirs; presets can be wrong).
  provider?.addEventListener('change', () => {
    const p = presetFor()
    endpoint.value = p.endpoint
    if (explain) explain.textContent = p.explain
    if (hint) hint.textContent = p.hint
    endpoint.focus()
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    showErr('')
    const p = presetFor()
    const kind = p.kind
    const ep = (endpoint.value || '').trim()
    const key = (token.value || '').trim()
    if (!ep) return showErr('Enter the service endpoint.')
    try { new URL(ep) } catch { return showErr('That endpoint is not a valid URL.') }
    if (!key) return showErr('Paste your access token.')
    if (!bridge()) return showErr('The Cloud Bridge needs the Nosdag desktop shell.')

    submit.disabled = true
    submit.textContent = 'Testing…'
    try {
      // Probe with the real token before saving, so a wrong token/endpoint gives a precise message.
      const test = await bridge().test({ kind, endpoint: ep, key })
      if (test?.error) throw new Error('Couldn’t reach the service: ' + test.error)
      if (!test.ok) {
        if (test.status === 401 || test.status === 403) {
          throw new Error(`The service rejected this token (HTTP ${test.status}). ` + (kind === 'rpc'
            ? 'Use your Filebase IPFS bucket’s Secret Access Token (the bucket must be an IPFS bucket).'
            : 'Check it’s a pinning-scoped token for this endpoint.'))
        }
        throw new Error(`The service returned HTTP ${test.status}${test.statusText ? ' ' + test.statusText : ''}. Check the endpoint.`)
      }
      submit.textContent = 'Linking…'
      const res = await bridge().link({ kind, endpoint: ep, key })
      if (!res || res.error) throw new Error(res?.error || 'could not link the service')
      await rerender()
    } catch (e2) {
      submit.disabled = false
      submit.textContent = 'Link pinning service'
      showErr(String(e2?.message || e2))
    }
  })
}

function bindLinked (section, rerender) {
  section.querySelector('#nd-bridge-refresh')?.addEventListener('click', () => rerender())

  // Diagnostic: mirror the latest note on demand and surface the service's actual response, so a
  // failed pin is legible (HTTP status + body) instead of failing silently in the publish hook.
  section.querySelector('#nd-bridge-mirror')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const out = section.querySelector('#nd-bridge-mresult')
    const show = (t) => { if (out) { out.hidden = false; out.textContent = t } }
    let headCid = null
    const pk = activePk()
    try { if (pk) headCid = localStorage.getItem('nosdag:head:' + pk) } catch { /* ignore */ }
    if (!headCid) return show('No note found in your IPFS DAG yet — publish a note first, then try again.')

    btn.disabled = true
    const orig = btn.textContent
    btn.textContent = 'Mirroring…'
    show('Pinning ' + headCid + ' …\n(this can take up to a minute while the service fetches it)')
    try {
      const res = await bridge().pinNote({ pubkey: pk, headCid, mediaCids: [] })
      if (res?.error) show('Error: ' + res.error)
      else {
        const lines = (res.results || []).map((r) =>
          `${r.ok ? '✓ pinned' : '✗ failed'}  ${String(r.cid).slice(0, 14)}…  ${r.status ? 'HTTP ' + r.status : ''}${r.error ? r.error : ''}${r.body ? '\n   ' + r.body : ''}`)
        show(lines.join('\n') || JSON.stringify(res))
      }
    } catch (err) { show('Error: ' + (err?.message || err)) }
    btn.disabled = false
    btn.textContent = orig
  })

  // Back-fill: pin the user's ENTIRE note history. The head pin is recursive (covers all note text);
  // media isn't IPLD-linked, so walk the DAG and pin every past media CID too.
  section.querySelector('#nd-bridge-pinall')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const mirrorBtn = section.querySelector('#nd-bridge-mirror')
    const out = section.querySelector('#nd-bridge-mresult')
    const show = (t) => { if (out) { out.hidden = false; out.textContent = t } }
    let headCid = null
    const pk = activePk()
    try { if (pk) headCid = localStorage.getItem('nosdag:head:' + pk) } catch { /* ignore */ }
    if (!headCid) return show('No notes found in your IPFS DAG yet.')

    btn.disabled = true; if (mirrorBtn) mirrorBtn.disabled = true
    const orig = btn.textContent
    btn.textContent = 'Pinning…'
    show('Reading your note history…')
    try {
      const DR = await import('./dag-read.js')
      const notes = await DR.walkNotes(headCid, { limit: 5000 })
      const media = new Set()
      for (const ev of notes) extractMediaCids(ev).forEach((c) => media.add(c))
      const cids = [headCid, ...media] // head pin is recursive → all note text; + each media CID
      show(`Found ${notes.length} notes, ${media.size} media. Pinning ${cids.length} items…`)

      const CHUNK = 4
      let done = 0, okN = 0
      const fails = []
      for (let i = 0; i < cids.length; i += CHUNK) {
        const res = await bridge().pinMany({ pubkey: pk, cids: cids.slice(i, i + CHUNK) })
        if (res?.error) fails.push({ cid: '(batch)', error: res.error })
        for (const r of (res?.results || [])) { done++; if (r.ok) okN++; else fails.push(r) }
        show(`Pinning ${done}/${cids.length}…  ✓${okN}${fails.length ? '  ✗' + fails.length : ''}`)
      }
      let summary = `Done. ✓ ${okN} of ${cids.length} pinned  (${notes.length} notes, ${media.size} media).`
      if (fails.length) {
        summary += '\n\n' + fails.slice(0, 6).map((f) =>
          `✗ ${String(f.cid).slice(0, 14)}…  ${f.status ? 'HTTP ' + f.status : ''}${f.error || ''}${f.body ? ' ' + f.body : ''}`).join('\n')
        if (fails.length > 6) summary += `\n…and ${fails.length - 6} more`
      }
      show(summary)
    } catch (err) { show('Error: ' + (err?.message || err)) }
    btn.disabled = false; if (mirrorBtn) mirrorBtn.disabled = false
    btn.textContent = orig
  })
  section.querySelector('#nd-bridge-unlink')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    btn.textContent = 'Unlinking…'
    try {
      const res = await bridge().unlink({ pubkey: activePk() })
      if (res?.error) throw new Error(res.error)
    } catch (err) { console.warn('[nosdag] unlink failed:', err) }
    await rerender()
  })
}

// Claim-or-remove for a pre-per-account bridge. Claiming a PSA legacy also purges its token from
// Kubo's config, which restarts the node — say so while it runs. Remove arms on first click.
function bindLegacy (section, rerender) {
  const claim = section.querySelector('#nd-bridge-claim')
  const discard = section.querySelector('#nd-bridge-discard')
  claim?.addEventListener('click', async () => {
    claim.disabled = true; if (discard) discard.disabled = true
    claim.textContent = 'Claiming… (the node may restart)'
    try {
      const res = await bridge().claimLegacy({ pubkey: activePk() })
      if (res?.error) throw new Error(res.error)
    } catch (err) { console.warn('[nosdag] legacy claim failed:', err) }
    await rerender()
  })
  discard?.addEventListener('click', async () => {
    if (discard.dataset.armed !== '1') { discard.dataset.armed = '1'; discard.textContent = 'Really remove?'; return }
    discard.disabled = true; if (claim) claim.disabled = true
    discard.textContent = 'Removing…'
    try {
      const res = await bridge().discardLegacy()
      if (res?.error) throw new Error(res.error)
    } catch (err) { console.warn('[nosdag] legacy remove failed:', err) }
    await rerender()
  })
}

/**
 * Fill the Node-panel "Cloud Bridge" section with the live link form / linked state.
 * @param {HTMLElement} section  the <section class="nd-card nd-bridge"> element to populate
 */
export async function mountBridgeCard (section) {
  if (!section) return
  ensureBridgeStyles()

  const render = async () => {
    if (!bridge()) {
      section.innerHTML = headerRow('<span class="nd-badge">Shell only</span>') +
        '<p class="nd-bf-hint" style="margin-top:12px">The Cloud Bridge runs in the Nosdag desktop app.</p>'
      return
    }
    section.innerHTML = headerRow('<span class="nd-badge">…</span>') +
      '<p class="nd-bf-hint" style="margin-top:12px">Checking bridge…</p>'

    const s = await refreshStatus()
    if (!activePk()) {
      section.innerHTML = headerRow('<span class="nd-badge">Log in</span>') +
        '<p class="nd-bf-hint" style="margin-top:12px">Log in to link a pinning service — each account links its own bridge.</p>'
    } else if (s?.error) {
      section.innerHTML = notLinkedShell(s.error, null)
      bindLinkForm(section, render)
    } else if (s?.linked) {
      section.innerHTML = linkedShell(s)
      bindLinked(section, render)
    } else {
      section.innerHTML = notLinkedShell(null, s?.legacy || null)
      bindLinkForm(section, render)
      if (s?.legacy) bindLegacy(section, render)
    }
  }

  await render()
}

const STYLE = `
/* Cloud Bridge card — operator console; reuses the .nd-node token scope from node-panel. */
.nd-bridge-form{display:flex;flex-direction:column;gap:7px;margin-top:14px}
.nd-bf-label{font:600 10px/1 var(--nd-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted,#5d6878);margin-top:6px}
.nd-bf-input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--nd-line,rgba(255,255,255,.08));
  background:rgba(0,0,0,.22);color:var(--text-primary,#e9eef5);font-size:13px;outline:none;transition:.16s}
.nd-bf-input:focus{border-color:var(--nd-accent,var(--nd-accent));box-shadow:0 0 0 3px color-mix(in srgb, var(--nd-accent) 12%, transparent)}
select.nd-bf-input{appearance:none;cursor:pointer}
.nd-bf-explain{margin:6px 0 2px;font-size:12px;line-height:1.5;color:var(--text-secondary,#9aa4b4);
  padding:9px 11px;border:1px solid var(--nd-line,rgba(255,255,255,.08));border-left:2px solid var(--nd-accent,var(--nd-accent));border-radius:8px;background:color-mix(in srgb, var(--nd-accent) 5%, transparent)}
.nd-bf-hint{margin:4px 0 0;font-size:11.5px;line-height:1.5;color:var(--text-secondary,#9aa4b4)}
.nd-bf-note{margin:2px 0 0;font-size:11px;color:var(--text-muted,#5d6878)}
.nd-bf-err{margin:2px 0 0;font-size:12px;color:var(--nd-down,#ff5d5d)}
.nd-bf-warn{margin:10px 0 0;font-size:12px;line-height:1.5;color:#f5a623}
.nd-bf-legacy{margin-top:14px;padding:12px 14px;border:1px solid rgba(245,166,35,.35);border-left:2px solid #f5a623;border-radius:9px;background:rgba(245,166,35,.06)}
.nd-bf-legacy-t{margin:0;font-size:12.5px;line-height:1.5;color:var(--text-primary,#e9eef5);word-break:break-all}
.nd-bf-legacy-s{margin:6px 0 0;font-size:11.5px;line-height:1.5;color:var(--text-secondary,#9aa4b4)}
.nd-bf-submit{margin-top:12px;width:100%;padding:11px;border-radius:10px;border:none;cursor:pointer;
  font:600 12.5px/1 var(--nd-mono);letter-spacing:.04em;color:#0a0e14;
  background:linear-gradient(180deg,var(--nd-accent-hi),var(--nd-accent,var(--nd-accent)));box-shadow:0 4px 16px color-mix(in srgb, var(--nd-accent) 28%, transparent);transition:.16s}
.nd-bf-submit:hover:not(:disabled){filter:brightness(1.06);transform:translateY(-1px)}
.nd-bf-submit:disabled{opacity:.6;cursor:default;box-shadow:none}

.nd-badge-on{color:var(--nd-seeded,#26d07c)!important;border-color:color-mix(in srgb,var(--nd-seeded,#26d07c) 45%,transparent)!important}

.nd-bridge-linked{margin-top:12px}
.nd-bridge-mech{font:600 10px/1 var(--nd-mono);letter-spacing:.04em;color:var(--text-muted,#5d6878);text-transform:uppercase}
.nd-bridge-ep{font-size:11.5px;color:var(--nd-accent,var(--nd-accent))}
.nd-bstats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0 4px}
.nd-bstats-one{grid-template-columns:1fr}
.nd-bstat{border:1px solid var(--nd-line,rgba(255,255,255,.08));border-radius:11px;background:rgba(0,0,0,.16);padding:13px 8px;text-align:center}
.nd-bstat-v{font-size:21px;font-weight:700;line-height:1;color:var(--text-primary,#e9eef5)}
.nd-bstat-v.ok{color:var(--nd-seeded,#26d07c)} .nd-bstat-v.warn{color:#f5a623} .nd-bstat-v.bad{color:var(--nd-down,#ff5d5d)}
.nd-bstat-l{margin-top:7px;font:600 9px/1 var(--nd-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted,#5d6878)}
.nd-bridge-mresult{margin:10px 0 0;padding:11px 12px;border:1px solid var(--nd-line,rgba(255,255,255,.08));border-radius:9px;
  background:rgba(0,0,0,.28);color:var(--text-secondary,#9aa4b4);font:11.5px/1.5 var(--nd-mono);white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto}
.nd-bridge-actions{display:flex;gap:10px;margin-top:14px}
.nd-bridge-mini{flex:1;padding:9px;border-radius:9px;border:1px solid var(--nd-line,rgba(255,255,255,.08));background:transparent;
  color:var(--text-secondary,#9aa4b4);font:600 11.5px/1 var(--nd-mono);letter-spacing:.03em;cursor:pointer;transition:.16s}
.nd-bridge-mini:hover{border-color:var(--nd-accent,var(--nd-accent));color:var(--text-primary,#e9eef5)}
.nd-bridge-unlink:hover{border-color:var(--nd-down,#ff5d5d);color:var(--nd-down,#ff5d5d)}
.nd-bridge-mini:disabled{opacity:.6;cursor:default}
`
