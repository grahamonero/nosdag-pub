// Nosdag — right-panel telemetry deck (the panel's default/idle content).
//
// Renders "Your Node" (live, from the existing window.nosdag.kubo.status IPC — no
// Phase 2 needed) + "Hosting you" (placeholder until the provider/seeder layer is wired).
// Hooked from RightPanel.loadDefaultContent, so it shows whenever the panel is idle and
// is replaced by thread/profile/compose views automatically (then returns on close()).

const $ = (id) => document.getElementById(id)
let pollTimer = null

const TEMPLATE = `
<div class="nd-deck">
  <section class="nd-deck-panel">
    <h4 class="nd-deck-h">Your Node</h4>
    <div class="nd-deck-node">
      <div class="nd-deck-orb" id="ndd-orb" data-s="boot"><i></i></div>
      <div class="nd-deck-id">
        <b id="ndd-state">Connecting…</b>
        <span class="nd-mono" id="ndd-peerid">reaching daemon…</span>
      </div>
    </div>
    <div class="nd-deck-stats">
      <div class="nd-deck-stat peers"><div class="v" id="ndd-peers">—</div><div class="k">peers</div></div>
      <div class="nd-deck-stat"><div class="v" id="ndd-repo">—</div><div class="k">repo</div></div>
      <div class="nd-deck-stat nd-clickable" id="ndd-notes-tile" title="Read your notes back from IPFS"><div class="v" id="ndd-pins">—</div><div class="k">notes in IPFS</div></div>
      <div class="nd-deck-stat"><div class="v" id="ndd-kubo">—</div><div class="k">kubo</div></div>
    </div>
  </section>
  <section class="nd-deck-panel">
    <h4 class="nd-deck-h">Durability</h4>
    <div id="ndd-hosting"><p class="nd-deck-note">Checking…</p></div>
  </section>
</div>`

function ensureDurStyles () {
  if (document.getElementById('nd-dur-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-dur-styles'
  el.textContent = `
.nd-host-row{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:650;color:#e9eef5;margin-bottom:9px}
.nd-host-dot{width:9px;height:9px;border-radius:50%;flex:none;box-shadow:0 0 8px currentColor}
.nd-host-dot.ok{color:#26d07c;background:#26d07c} .nd-host-dot.warn{color:#f5a623;background:#f5a623}
.nd-host-list{font-size:12px;color:#9aa4b4;margin-bottom:9px;line-height:1.8}
.nd-host-chip{display:inline-block;font:600 10.5px/1 'SF Mono',ui-monospace,monospace;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.1);margin:0 4px 4px 0;color:#cdd4de;vertical-align:middle}
.nd-host-chip.nd-host-bridge{color:#26d07c;border-color:color-mix(in srgb,#26d07c 45%,transparent)}
.nd-dur-btn{margin-top:10px;width:100%;padding:9px;border-radius:9px;border:none;cursor:pointer;font:600 12px/1 'SF Mono',ui-monospace,monospace;color:#0a0e14;background:linear-gradient(180deg,var(--nd-accent-hi),var(--nd-accent));box-shadow:0 4px 14px color-mix(in srgb, var(--nd-accent) 28%, transparent)}
.nd-dur-btn:hover{filter:brightness(1.06)}
.nd-host-net{display:flex;align-items:center;gap:7px;margin-top:11px;font-size:12px;color:#9aa4b4}
.nd-host-net b{color:#e9eef5}`
  document.head.appendChild(el)
}

// Slice 3 — the live "who hosts you" readout + no-bridge nudge.
async function renderHosting () {
  const el = $('ndd-hosting'); if (!el) return
  ensureDurStyles()
  let D
  try { D = await import('./durability.js') } catch { return }
  const b = await D.bridge()
  const chips = D.hosts().map(h => `<span class="nd-host-chip nd-host-${h.kind}">${h.label}${h.sub ? ` · ${h.sub}` : ''}</span>`).join('')

  if (b?.linked && b.reachable !== false) {
    el.innerHTML =
      `<div class="nd-host-row"><span class="nd-host-dot ok"></span>Backed up</div>
       <div class="nd-host-list">Hosted by ${chips}</div>
       <p class="nd-deck-note">Your notes stay reachable when you're away — your bridge keeps a copy on a public IP.</p>`
  } else if (b?.linked) {
    el.innerHTML =
      `<div class="nd-host-row"><span class="nd-host-dot warn"></span>Bridge not responding</div>
       <div class="nd-host-list">Hosted by ${chips}</div>
       <p class="nd-deck-note">Your Cloud Bridge is linked but didn't respond — re-check the token in Node → Cloud Bridge.</p>
       <button class="nd-dur-btn" data-nd-bridge>Open Cloud Bridge</button>`
  } else {
    el.innerHTML =
      `<div class="nd-host-row"><span class="nd-host-dot warn"></span>Only this device</div>
       <div class="nd-host-list">Hosted by ${chips}</div>
       <p class="nd-deck-note">Your notes go offline when you close Nosdag — nothing else holds them. Link a Cloud Bridge so they stay reachable 24/7.</p>
       <button class="nd-dur-btn" data-nd-bridge>Link a Cloud Bridge</button>`
  }
  el.querySelector('[data-nd-bridge]')?.addEventListener('click', () => window.navigateTo?.('node'))

  // Trustless redundancy (DHT) — fills in after a brief lookup. Counts your node + bridge + any
  // follower hosting you; a follower appears within minutes of pinning.
  D.providerCount().then((n) => {
    if (n == null || !el.isConnected) return
    const ln = document.createElement('div')
    ln.className = 'nd-host-net'
    ln.innerHTML = `<span class="nd-host-dot ${n >= 2 ? 'ok' : 'warn'}"></span>Held by <b>${n}</b> node${n === 1 ? '' : 's'} on the network`
    ln.title = 'Distinct nodes the DHT reports providing your latest note — your node, your bridge, and any followers hosting you.'
    el.appendChild(ln)
  }).catch(() => {})
}

function fmtBytes (n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`
}

function applyStatus (s) {
  const onTor = s?.mode === 'tor'
  let state, label
  if (s?.ready) { state = 'online'; label = onTor ? 'Online · Tor' : 'Online' }
  else if (s?.error) { state = 'down'; label = 'Unreachable' }
  else { state = 'boot'; label = (onTor || s?.torBootstrap != null) ? 'Starting Tor…' : 'Starting…' }
  const orb = $('ndd-orb'); if (orb) orb.dataset.s = state
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v }
  set('ndd-state', label)
  set('ndd-peerid', s?.peerId ? `${s.peerId.slice(0, 10)}…${s.peerId.slice(-5)}` : (s?.error ? 'no daemon' : 'reaching daemon…'))
  set('ndd-peers', s?.ready ? s.peers : '—')
  set('ndd-repo', s?.repoSizeBytes != null ? fmtBytes(s.repoSizeBytes) : '—')
  // "posts" = notes this user has written into IPFS (per-note, from dag-publish). The raw
  // recursive-pin count is a node-internals number and not shown here (see Node panel).
  let posts = '—'
  try { const pk = window.NostrState?.publicKey; if (pk) posts = parseInt(localStorage.getItem('nosdag:posts:' + pk) || '0', 10) } catch { /* ignore */ }
  set('ndd-pins', posts)
  set('ndd-kubo', onTor ? 'Tor' : (s?.version ? `v${s.version}` : '—'))
  // also feed the header net-chip if present
  const chip = $('ndNetChip')
  if (chip) chip.textContent = s?.ready ? `${onTor ? 'tor' : 'swarm'} · ${s.peers} peers` : (s?.error ? 'node offline' : (s?.torBootstrap != null ? `tor ${s.torBootstrap}%` : 'node booting…'))
  if (chip) chip.dataset.s = state
}

async function tick () {
  let s = null
  try { s = await window.nosdag?.kubo?.status?.() }
  catch (e) { s = { ready: false, error: String(e?.message || e) } }
  applyStatus(s || { ready: false, error: 'IPC bridge unavailable' })
}

const SIGNIN_TEMPLATE = `
<div class="nd-deck">
  <section class="nd-deck-panel nd-deck-signin">
    <div class="nd-deck-orb" data-s="off"><i></i></div>
    <h4 class="nd-deck-h">Your Node</h4>
    <p class="nd-deck-note">Sign in to activate your node. Your posts, the content you pin for people you follow, and your presence on the network all live under your key — not a server's.</p>
    <button class="nd-deck-signin-btn" data-nd-signin>Sign in</button>
  </section>
</div>`

export async function renderTelemetryDeck (container) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }

  // Model A: the embedded node is per-device, but "Your Node" telemetry only means something
  // once you're signed in. Anonymous users get a sign-in prompt, not the device node's internals.
  const isLoggedIn = !!window.NostrState?.publicKey
  const chip = document.getElementById('ndNetChip')
  // Phase 5 · Slice 1 — always define window.NosdagPending, signed in or not, so the rail
  // "Requests" item is never a silent no-op. init() is idempotent and defers the actual
  // subscription until login; the panel itself is only injected on the signed-in render below.
  import('./pending-queue.js').then(PQ => PQ.init()).catch(() => {})
  if (!isLoggedIn) {
    container.innerHTML = SIGNIN_TEMPLATE
    container.querySelector('[data-nd-signin]')?.addEventListener('click', () => {
      if (typeof window.showLoginModalWithLogin === 'function') window.showLoginModalWithLogin()
    })
    if (chip) chip.style.display = 'none'
    return
  }
  if (chip) chip.style.display = ''

  container.innerHTML = TEMPLATE
  // clicking the "notes in IPFS" stat reads your notes back from IPFS (Step 3)
  container.querySelector('#ndd-notes-tile')?.addEventListener('click', async () => {
    try { const V = await import('./ipfs-notes-view.js'); await V.showIpfsNotes() }
    catch (e) { console.warn('[nosdag] ipfs-notes view failed:', e) }
  })
  // Phase 5 · Slice 1 — inject the "Requests" panel (stranger replies) + start its background
  // subscription. Idempotent; the panel re-injects on every deck re-render.
  import('./pending-queue.js').then(PQ => PQ.mountIntoDeck()).catch(() => {})
  // Phase 5 · Slice 4 — start the thread-follow background service (idempotent; self-wires login/logout).
  import('./consumption-tiers.js').then(CT => CT.init()).catch(() => {})
  // Phase 6 — onion discovery: announce our onion pointer in Tor mode + dial followees over Tor
  // on read (idempotent; self-wires login/logout; no-op in clearnet).
  import('./onion-discovery.js').then(OD => OD.init()).catch(() => {})
  await tick()
  renderHosting().catch(() => {}) // Slice 3 — durability ("who hosts you") + no-bridge nudge
  pollTimer = setInterval(() => {
    // Keep polling while the deck is in the DOM. Stop ONLY if it was detached or replaced —
    // NOT on visibility. offsetParent-based visibility checks are unreliable (null during the
    // right-panel init and in various layout contexts) and were killing the poll before the
    // daemon finished booting, leaving the deck stuck on "reaching daemon…". Polling a hidden
    // deck (e.g. while a thread/profile view is open) is one cheap IPC call every 2.5s.
    if (!container.isConnected || !document.getElementById('ndd-orb')) {
      clearInterval(pollTimer); pollTimer = null; return
    }
    tick()
  }, 2500)
}
