// Nosdag — anonymous (Tor) mode control. Mounts a card in the Node panel that toggles the
// node's posture between clearnet (the bundled Kubo node) and anonymous (a Helia node whose
// only transport dials peer .onion addresses over Tor).
//
// All-or-nothing: switching fully restarts the node backend in main — the two transports never
// run at once. The switch is slow the first time (Tor has to bootstrap), so we kick off the
// mode.set() and poll status in parallel to show live bootstrap progress.
//
// Honest disclosure (design §4 / §10.4): anonymous mode now routes the renderer's WHOLE network —
// Nostr relays, search, the backend API, media and DNS — plus the node's peer-to-peer (IPFS) layer
// over Tor, so nothing sees your real IP. What it does NOT do is hide your identity: you're still
// posting as your npub. The card states both plainly rather than implying full anonymity.

const api = () => window.nosdag?.mode
const statusApi = () => window.nosdag?.kubo
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

function ensureStyles () {
  if (document.getElementById('nd-tor-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-tor-styles'
  el.textContent = `
.nd-tor-head{display:flex;align-items:center;justify-content:space-between;gap:14px}
.nd-tor-badge{flex:none;font:600 10.5px/1 var(--nd-mono);letter-spacing:.07em;text-transform:uppercase;padding:6px 11px;border-radius:999px;border:1px solid var(--nd-line);color:var(--text-muted,#606060);display:inline-flex;align-items:center;gap:7px}
.nd-tor-badge .dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 9px currentColor}
.nd-tor-badge[data-on=tor]{color:#a07bff;border-color:color-mix(in srgb,#a07bff 50%,transparent)}
.nd-tor-badge[data-on=clearnet]{color:#9aa4b4}
.nd-tor-badge[data-on=switching]{color:#f5a623;border-color:color-mix(in srgb,#f5a623 45%,transparent)}
.nd-tor-badge[data-on=down]{color:#ff5d5d;border-color:color-mix(in srgb,#ff5d5d 50%,transparent)}
.nd-tor-desc{margin:12px 0 0;font-size:12.5px;line-height:1.6;color:var(--text-secondary,#a0a0a0);max-width:56ch}
.nd-tor-onion{margin:14px 0 0;padding:11px 13px;border:1px solid var(--nd-line);border-radius:11px;background:rgba(160,123,255,.06);display:flex;align-items:center;gap:9px}
.nd-tor-onion .k{font:600 9.5px/1 var(--nd-mono);letter-spacing:.14em;text-transform:uppercase;color:#a07bff;flex:none}
.nd-tor-onion .v{font:600 11.5px/1.4 var(--nd-mono);color:var(--text-primary,#fff);word-break:break-all}
.nd-tor-onion button{margin-left:auto;flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--nd-line);background:transparent;color:var(--text-secondary,#a0a0a0);cursor:pointer;font-size:12px}
.nd-tor-onion button:hover{border-color:#a07bff;color:#a07bff}
.nd-tor-facts{margin:14px 0 0;padding:0;list-style:none;display:grid;gap:8px}
.nd-tor-facts li{display:flex;gap:9px;font-size:12px;line-height:1.5;color:var(--text-secondary,#a0a0a0)}
.nd-tor-facts li::before{content:'';flex:none;width:6px;height:6px;border-radius:50%;margin-top:6px;background:var(--text-muted,#606060)}
.nd-tor-facts li.warn::before{background:var(--nd-rest,#f5a623)}
.nd-tor-facts li b{color:var(--text-primary,#e9eef5);font-weight:600}
.nd-tor-btn{margin-top:18px;width:100%;padding:12px;border-radius:10px;border:none;cursor:pointer;font:600 13px/1 var(--nd-mono);letter-spacing:.02em;transition:.16s}
.nd-tor-btn[data-act=tor]{color:var(--nd-on-accent);background:var(--nd-accent);box-shadow:none}
.nd-tor-btn[data-act=clearnet]{color:var(--text-primary,#fff);background:transparent;border:1px solid var(--nd-line)}
.nd-tor-btn[data-act=clearnet]:hover{border-color:var(--text-secondary,#a0a0a0)}
.nd-tor-btn:hover{filter:brightness(1.06)}
.nd-tor-btn:disabled{opacity:.6;cursor:progress;filter:none}
.nd-tor-prog{margin-top:13px;font:600 11.5px/1.5 var(--nd-mono);color:var(--nd-rest,#f5a623);display:none}
.nd-tor-prog.show{display:block}
.nd-tor-err{margin-top:11px;font-size:12px;color:var(--nd-down,#ff7a7a);display:none}
.nd-tor-err.show{display:block}
.nd-tor-desc .mono,.nd-tor-proxy-cur .mono{font:600 12px/1.4 var(--nd-mono);color:var(--text-primary,#fff)}
.nd-tor-proxy-cur{margin:13px 0 0;font-size:12px;color:var(--text-secondary,#a0a0a0)}
.nd-tor-proxy-row{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
.nd-tor-proxy-row input{flex:1 1 180px;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--nd-line);background:transparent;color:var(--text-primary,#fff);font:600 12px/1.2 var(--nd-mono)}
.nd-tor-proxy-row input::placeholder{color:var(--text-muted,#606060);font-weight:400}
.nd-tor-proxy-row input:focus{outline:none;border-color:var(--nd-accent)}
.nd-tor-proxy-row button{flex:none;padding:10px 14px;border-radius:10px;cursor:pointer;font:600 12px/1 var(--nd-mono);letter-spacing:.02em;transition:.16s}
.nd-tor-proxy-row button[data-act=save]{border:none;color:var(--nd-on-accent);background:var(--nd-accent)}
.nd-tor-proxy-row button[data-act=clear]{background:transparent;border:1px solid var(--nd-line);color:var(--text-primary,#fff)}
.nd-tor-proxy-row button:hover{filter:brightness(1.06)}
.nd-tor-proxy-row button:disabled{opacity:.6;cursor:progress;filter:none}`
  document.head.appendChild(el)
}

const FACTS_CLEARNET = [
  ['Hides your IP, not your identity.', 'Everything rides Tor — but you still post as your npub.', true],
  ['Some lookups still touch clearnet relays.', 'Search, profile, and payment-address lookups query clearnet relays over Tor — those relays see the query (e.g. who you’re about to pay), but not your IP.', true],
  ['Restarts your node.', 'Your note history syncs over automatically.', false],
  ['Slower, especially at first.', 'Tor circuits take 10–60s to warm up.', true],
  ['Cloud Bridge & Hosted Follows pause.', 'They need clearnet; they resume when you switch back.', true]
]

function copyBtn (text) {
  return (e) => {
    navigator.clipboard?.writeText(text).then(() => {
      const b = e.currentTarget; const o = b.textContent; b.textContent = '✓'; setTimeout(() => { b.textContent = o }, 1200)
    }).catch(() => {})
  }
}

function render (card, st, hostedCount = 0) {
  const onTor = st.mode === 'tor'
  const switching = !!st.switching
  // The node never started (most often: tor bootstrap timed out on a first run). Egress is
  // fail-closed behind the dead proxy, so nothing leaks — surface the cause and offer Retry:
  // mode.set('tor') with the node down performs a real stop→start, and tor resumes from the
  // consensus progress it already saved, so a retry usually completes.
  if (onTor && st.startError && !switching) {
    card.innerHTML = `
    <div class="nd-tor-head">
      <h2 class="nd-h" style="margin:0">Anonymous mode</h2>
      <span class="nd-tor-badge" data-on="down"><span class="dot"></span>Not connected</span>
    </div>
    <p class="nd-tor-desc">${esc(st.startError.message)}</p>
    <button class="nd-tor-btn" data-act="tor">Retry Tor</button>
    <button class="nd-tor-btn" data-act="clearnet">Switch to clearnet</button>
    <div class="nd-tor-prog" id="nd-tor-prog"></div>
    <div class="nd-tor-err" id="nd-tor-err"></div>`
    card.querySelector('[data-act=tor]')?.addEventListener('click', () => doSwitch(card, 'tor', { retry: true }))
    card.querySelector('[data-act=clearnet]')?.addEventListener('click', () => doSwitch(card, 'clearnet'))
    return
  }
  // Kill-switch latched (tor died, egress blackholed): show a disconnected state, not "Tor". The
  // "Switch to clearnet" button is a valid in-app recovery — it tears down the dead node and drops
  // the blackhole — so it stays functional; restarting the app reconnects over Tor.
  if (st.torDown) {
    card.innerHTML = `
    <div class="nd-tor-head">
      <h2 class="nd-h" style="margin:0">Anonymous mode</h2>
      <span class="nd-tor-badge" data-on="down"><span class="dot"></span>Disconnected</span>
    </div>
    <p class="nd-tor-desc">Tor stopped unexpectedly, so all network access is blocked to protect your IP. Restart Nosdag to reconnect over Tor, or switch to clearnet now.</p>
    <button class="nd-tor-btn" data-act="clearnet">Switch to clearnet</button>
    <div class="nd-tor-prog" id="nd-tor-prog"></div>
    <div class="nd-tor-err" id="nd-tor-err"></div>`
    card.querySelector('.nd-tor-btn')?.addEventListener('click', () => doSwitch(card, 'clearnet'))
    return
  }
  const onionRow = (onTor && st.onion)
    ? `<div class="nd-tor-onion"><span class="k">onion</span><span class="v" id="nd-tor-onion-v">${st.onion}</span><button id="nd-tor-onion-copy" title="Copy onion address">⧉</button></div>`
    : ''
  const facts = FACTS_CLEARNET.map(([h, d, warn]) => {
    // Make the Hosted-Follows pause concrete: say how many accounts lose this host.
    if (hostedCount > 0 && h.startsWith('Cloud Bridge')) {
      d += ` You currently host <b>${hostedCount} account${hostedCount === 1 ? '' : 's'}</b> — they lose this host until you switch back.`
    }
    return `<li class="${warn ? 'warn' : ''}"><span><b>${h}</b> ${d}</span></li>`
  }).join('')
  // External-proxy posture has no onion service — say the outbound-only consequence up front.
  const extFact = (onTor && st.torExternal)
    ? '<li class="warn"><span><b>Outbound only.</b> While the external proxy is in use, other users can’t fetch your notes and media from this node over Tor.</span></li>'
    : ''
  card.innerHTML = `
    <div class="nd-tor-head">
      <h2 class="nd-h" style="margin:0">Anonymous mode</h2>
      <span class="nd-tor-badge" data-on="${switching ? 'switching' : st.mode}"><span class="dot"></span>${switching ? 'Switching…' : onTor ? 'Tor' : 'Clearnet'}</span>
    </div>
    <p class="nd-tor-desc">${onTor
      ? (st.torExternal
        ? `All traffic runs over Tor via your external proxy at <span class="mono">${esc(st.torProxyAddr || '')}</span>. Nothing sees your IP — but with no onion service this node is outbound-only.`
        : 'All traffic runs over Tor. Nothing sees your IP; peers reach you through your onion service.')
      : 'Route all traffic over Tor so nothing sees your IP.'}</p>
    ${onionRow}
    <ul class="nd-tor-facts">${extFact}${facts}</ul>
    <button class="nd-tor-btn" data-act="${onTor ? 'clearnet' : 'tor'}">${onTor ? 'Switch to clearnet' : 'Switch to anonymous mode'}</button>
    <div class="nd-tor-prog" id="nd-tor-prog"></div>
    <div class="nd-tor-err" id="nd-tor-err"></div>`

  card.querySelector('#nd-tor-onion-copy')?.addEventListener('click', copyBtn(st.onion))
  card.querySelector('.nd-tor-btn')?.addEventListener('click', () => doSwitch(card, onTor ? 'clearnet' : 'tor'))
}

async function doSwitch (card, target, extra) {
  const btn = card.querySelector(`.nd-tor-btn[data-act=${target}]`) || card.querySelector('.nd-tor-btn')
  const prog = card.querySelector('#nd-tor-prog')
  const err = card.querySelector('#nd-tor-err')
  if (!btn) return
  card.querySelectorAll('.nd-tor-btn').forEach((b) => { b.disabled = true })
  btn.disabled = true
  err.classList.remove('show')
  prog.classList.add('show')
  prog.textContent = target === 'tor' ? 'Starting Tor… this can take a minute' : 'Switching to clearnet…'

  // Shared blockstore: hand main the chain head + pubkey so the notes + media you authored
  // migrate into the destination store during the switch (nothing to pass when logged out or
  // nothing published — main just skips the sync).
  let migrateOpts
  try {
    const pk = window.NostrState?.publicKey
    const headCid = pk ? localStorage.getItem('nosdag:head:' + pk) : null
    const archiveCid = pk ? localStorage.getItem('nosdag:archive:' + pk) : null // timeline archive crosses too
    if (pk && (headCid || archiveCid)) migrateOpts = { headCid, pubkey: pk, archiveCid }
  } catch { /* private mode */ }

  // Poll status in parallel so the user sees live Tor bootstrap + history-sync progress while
  // mode.set() runs.
  let polling = true
  const poll = async () => {
    while (polling) {
      try {
        const s = await statusApi()?.status?.()
        const mig = s?.migration
        if (mig?.state === 'exporting') {
          prog.textContent = `Packing your history… ${mig.blocks || 0} blocks`
        } else if (mig?.state === 'importing') {
          prog.textContent = `Syncing your history… ${mig.blocks || 0}/${mig.total || '?'} blocks`
        } else if (target === 'tor' && s && !s.ready && s.torBootstrap != null) {
          prog.textContent = `Starting Tor… bootstrapping ${s.torBootstrap}%`
        } else if (target === 'tor' && s?.ready && s.mode === 'tor') {
          prog.textContent = s.onion ? `Onion published · ${s.onion.slice(0, 16)}…` : 'Anonymous node online'
        }
      } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 1500))
    }
  }
  poll()

  let res
  const setOpts = extra?.retry ? { ...(migrateOpts || {}), retry: true } : migrateOpts
  try { res = await api()?.set?.(target, setOpts) } catch (e) { res = { error: String(e?.message || e) } }
  polling = false

  // A successful switch (incl. recovering to clearnet after a kill-switch) clears the down state in
  // main — drop the stale blocking banner so it doesn't linger over a working session.
  if (res?.ok) document.getElementById('nd-tor-down-banner')?.remove()

  // Push the settled posture to the onion-relays module so the relay getters swap in
  // lock-step with the node backend (its getters are sync — the flag must be pushed).
  import('./onion-relays.js')
    .then((OR) => OR.setPosture(res?.ok ? target : (res?.mode || 'clearnet')))
    .catch(() => { /* module optional */ })

  if (res?.error) {
    err.textContent = res.error + (res.mode ? ` (now in ${res.mode} mode)` : '')
    err.classList.add('show')
    prog.classList.remove('show')
  } else if (target === 'tor') {
    // Just landed in Tor mode — arm the reactive announce loop so our onion pointer publishes as soon
    // as the node + relays are ready (and retries until a relay ACKs), without a manual announce() call.
    import('./onion-discovery.js').then(OD => (OD.ensureAnnounceLoop || OD.announceOnion)?.()).catch(() => {})
  }
  // Re-read the settled state and re-render (button flips, onion appears/clears).
  await mountTorCard(card)
  // The onion-relays card next door is posture-aware too (copy + Check button) — refresh it.
  import('./onion-relays.js')
    .then((OR) => OR.mountOnionRelaysCard(document.getElementById('nd-onion-relays')))
    .catch(() => { /* card not mounted */ })
  // And the proxy card, so an "applies when you next enter anonymous mode" notice settles.
  mountTorProxyCard(document.getElementById('nd-tor-proxy')).catch(() => { /* card not mounted */ })

  // Settle the history-sync outcome on the fresh render (mountTorCard wipes prog/err).
  const mig = res?.ok ? res.migration : null
  if (mig?.state === 'failed') {
    const e2 = card.querySelector('#nd-tor-err')
    if (e2) {
      e2.textContent = `History sync failed: ${mig.error}. Older notes may not be servable in this mode — switching modes again retries the sync.`
      e2.classList.add('show')
    }
  } else if (mig?.state === 'done' && mig.notes > 0) {
    const p2 = card.querySelector('#nd-tor-prog')
    if (p2) {
      p2.textContent = `History synced — ${mig.notes} note${mig.notes === 1 ? '' : 's'}${mig.media ? ` + ${mig.media} media` : ''} now served ${target === 'tor' ? 'over Tor' : 'on clearnet'}`
      p2.classList.add('show')
    }
  }
}

// ---- Anonymous Mode page (left rail) — the switch card + the onion relay picker ----
// Own styles: the .nd-card glass definition lives in node-panel's injected sheet, which may
// not have loaded yet, so the page carries its own scoped equivalents.
function ensurePageStyles () {
  if (document.getElementById('nd-anon-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-anon-styles'
  el.textContent = `
.nd-anon{max-width:680px;margin:0 auto;padding:22px 18px 60px;
  --nd-mono:'SF Mono','Cascadia Code',Monaco,'JetBrains Mono',ui-monospace,monospace;
  --nd-line:var(--border-color,rgba(255,255,255,.08))}
.nd-anon-top{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.nd-anon-back{flex:none;width:36px;height:36px;border-radius:10px;border:1px solid var(--nd-line);background:transparent;color:var(--text-primary,#e9eef5);cursor:pointer;font-size:16px}
.nd-anon-back:hover{border-color:var(--nd-accent);color:var(--nd-accent)}
.nd-anon-top h1{margin:0;font-size:20px;font-weight:750;color:var(--text-primary,#e9eef5)}
.nd-anon-top p{margin:3px 0 0;font-size:12.5px;color:var(--text-muted,#9aa4b4)}
.nd-anon .nd-card{border:1px solid var(--nd-line);border-radius:16px;background:var(--card-bg,rgba(255,255,255,.03));padding:18px 20px;margin-bottom:16px}
.nd-anon .nd-h{font-size:15px;font-weight:700;color:var(--text-primary,#e9eef5)}`
  document.head.appendChild(el)
}

/** Full-page Anonymous Mode view: posture switch + onion relay picker, one calm read. */
export async function renderAnonModePage (container) {
  ensurePageStyles()
  container.innerHTML = `
    <div class="nd-anon">
      <header class="nd-anon-top">
        <button class="nd-anon-back" data-back title="Back">←</button>
        <div>
          <h1>Anonymous mode</h1>
          <p>Run Nosdag over Tor — or direct over clearnet. You also choose this at every launch.</p>
        </div>
      </header>
      <section class="nd-card" id="nd-tor"></section>
      <section class="nd-card" id="nd-tor-proxy"></section>
      <section class="nd-card" id="nd-onion-relays"></section>
    </div>`
  container.querySelector('[data-back]')?.addEventListener('click', () => window.navigateTo?.('home'))
  await mountTorCard(container.querySelector('#nd-tor'))
  await mountTorProxyCard(container.querySelector('#nd-tor-proxy'))
  try {
    const OR = await import('./onion-relays.js')
    await OR.mountOnionRelaysCard(container.querySelector('#nd-onion-relays'))
  } catch (e) { console.warn('[nosdag] onion-relays card failed:', e) }
}

export async function mountTorCard (card) {
  if (!card) return
  if (!api()) { // not running in the shell (web/dev) — hide the card
    card.style.display = 'none'
    return
  }
  card.style.display = ''
  card.classList.add('nd-card')
  ensureStyles()
  let st = { mode: 'clearnet' }
  try {
    const m = await api().get()
    st.mode = m?.mode || 'clearnet'
    st.switching = m?.switching
    if (st.mode === 'tor') {
      const s = await statusApi()?.status?.()
      st.onion = s?.onion; st.torDown = s?.torDown
      st.torExternal = s?.torExternal; st.torProxyAddr = s?.torProxyAddr
      // Node never came up (e.g. tor bootstrap timeout): status carries the startNode error.
      if (s && !s.ready && s.nodeStartError) st.startError = s.nodeStartError
    }
  } catch { /* default clearnet */ }
  // How many followed accounts this node hosts (clearnet only — that's the posture about to
  // pause them). Logged out / none hosted → 0 → the generic fact text stands.
  let hostedCount = 0
  if (st.mode !== 'tor') {
    try { const AP = await import('./altruistic-pin.js'); hostedCount = Object.keys(AP.hostedMap() || {}).length } catch { /* module optional */ }
  }
  render(card, st, hostedCount)
}

// ---- External Tor proxy card (Anonymous Mode page) ----
// Anonymous mode normally spawns the bundled Tor daemon. This card points it at an already-running
// SOCKS proxy instead (Tor router, Whonix-style gateway, system tor). Outbound-only: with an
// external proxy main starts no onion service, so the node reads the Tor network but nothing can
// fetch from it over Tor. The card renders in BOTH postures — it's a setting, and it must stay
// reachable when Tor itself failed to start (the #nd-tor error branch wipes only its own card).
export async function mountTorProxyCard (card) {
  if (!card) return
  if (!api()) { // not running in the shell (web/dev) — hide the card
    card.style.display = 'none'
    return
  }
  card.style.display = ''
  card.classList.add('nd-card')
  ensureStyles()
  let current = null
  try { current = (await api().get())?.torProxy || null } catch { /* default bundled */ }
  renderProxyCard(card, current)
}

function renderProxyCard (card, current, notice) {
  card.innerHTML = `
    <div class="nd-tor-head">
      <h2 class="nd-h" style="margin:0">Tor proxy</h2>
    </div>
    <p class="nd-tor-desc">Anonymous mode normally starts its own Tor. Point it at a SOCKS proxy that’s already running instead — a Tor router, a Whonix-style gateway, or your system tor.</p>
    <p class="nd-tor-proxy-cur">${current ? `Using <span class="mono">${esc(current)}</span>` : 'Built-in Tor (default)'}</p>
    <div class="nd-tor-proxy-row">
      <input id="nd-tor-proxy-in" type="text" spellcheck="false" autocomplete="off" placeholder="host:port — e.g. 192.168.1.1:9050" value="${esc(current || '')}">
      <button data-act="save">Save</button>
      <button data-act="clear">Clear</button>
    </div>
    <ul class="nd-tor-facts">
      <li class="warn"><span><b>Outbound only:</b> with an external proxy there is no onion service — other users can’t fetch your notes and media from your node over Tor, and your onion address isn’t published.</span></li>
      <li class="warn"><span><b>Circuit isolation depends on your proxy:</b> Tor separates this app’s Monero traffic from relay traffic only if the proxy honors SOCKS-auth isolation (Tor’s default). A router configured otherwise may put them on shared circuits.</span></li>
    </ul>
    <div class="nd-tor-prog${notice ? ' show' : ''}" id="nd-tor-proxy-note">${notice ? esc(notice) : ''}</div>
    <div class="nd-tor-err" id="nd-tor-proxy-err"></div>`
  const input = card.querySelector('#nd-tor-proxy-in')
  card.querySelector('[data-act=save]')?.addEventListener('click', () => applyProxy(card, input.value.trim() || null))
  card.querySelector('[data-act=clear]')?.addEventListener('click', () => applyProxy(card, null))
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyProxy(card, input.value.trim() || null) })
}

async function applyProxy (card, value) {
  const err = card.querySelector('#nd-tor-proxy-err')
  const note = card.querySelector('#nd-tor-proxy-note')
  err?.classList.remove('show'); note?.classList.remove('show')
  card.querySelectorAll('.nd-tor-proxy-row button').forEach((b) => { b.disabled = true })
  let res
  try { res = await api()?.torProxy?.(value) } catch (e) { res = { error: String(e?.message || e) } }
  if (!res || res.error) {
    card.querySelectorAll('.nd-tor-proxy-row button').forEach((b) => { b.disabled = false })
    if (err) {
      err.textContent = res?.error || 'Setting failed — shell bridge unavailable.'
      err.classList.add('show')
    }
    return
  }
  renderProxyCard(card, res.torProxy, res.needsSwitch
    ? 'Applies when you next enter anonymous mode — switch to clearnet and back.'
    : (res.torProxy ? 'Saved — used the next time anonymous mode starts.' : 'Cleared — built-in Tor.'))
}
