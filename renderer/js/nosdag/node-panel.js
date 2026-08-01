// Nosdag — Node status panel (first net-new Nosdag surface).
//
// A "ground-station telemetry" view of the embedded Kubo node. Reuses Nosmero's
// design tokens (--monero-orange, --success/--warning/--danger, dark surfaces) and
// the SF-Mono stack for telemetry values, so it harmonizes with the host app rather
// than introducing a clashing aesthetic. Data arrives over Electron IPC
// (window.nosdag.kubo.status) — the §1.5 kubo-manager surface, marshalled to main.
//
// Self-contained: it injects its own scoped styles (.nd-node) once and self-cancels
// its poll when the page is hidden. The Cloud Bridge block is a seam for §5.2.

const $ = (id) => document.getElementById(id)

let pollTimer = null
let lastPeerId = ''

const TEMPLATE = `
<div class="nd-node">
  <div class="nd-head">
    <button class="nd-back" data-nd-home aria-label="Back to feed">←</button>
    <div class="nd-titles">
      <h1 class="nd-title">Your Node</h1>
      <div class="nd-sub">Embedded IPFS · running on this device</div>
    </div>
    <div class="nd-chip" id="nd-chip" data-s="boot">···</div>
  </div>

  <section class="nd-hero" id="nd-hero" data-s="boot">
    <div class="nd-hero-grid"></div>
    <div class="nd-status">
      <div class="nd-orb" id="nd-orb" data-s="boot"><span class="nd-orb-core"></span></div>
      <div class="nd-status-text">
        <div class="nd-status-label" id="nd-status-label">Connecting…</div>
        <div class="nd-status-desc" id="nd-status-desc">Reaching the local daemon</div>
      </div>
    </div>
    <div class="nd-radar" aria-hidden="true">
      <div class="nd-radar-rings"></div>
      <div class="nd-sweep"></div>
      <div class="nd-peercount"><span id="nd-peers">—</span><small>peers</small></div>
    </div>
  </section>

  <section class="nd-card" style="--d:1">
    <h2 class="nd-h">Identity</h2>
    <dl class="nd-dl">
      <dt>Peer ID</dt>
      <dd class="nd-peerid"><span class="nd-mono" id="nd-peerid">—</span><button class="nd-copy" id="nd-copy" title="Copy Peer ID">⧉</button></dd>
      <dt>Agent</dt><dd class="nd-mono" id="nd-agent">—</dd>
      <dt>Kubo</dt><dd class="nd-mono" id="nd-kubo">—</dd>
      <dt>RPC</dt><dd class="nd-mono" id="nd-rpc">—</dd>
    </dl>
  </section>

  <section class="nd-metrics">
    <div class="nd-tile" style="--d:2"><div class="nd-tile-v nd-mono" id="nd-m-peers">—</div><div class="nd-tile-l">Swarm peers</div></div>
    <div class="nd-tile" style="--d:3"><div class="nd-tile-v nd-mono" id="nd-m-repo">—</div><div class="nd-tile-l">Repo size</div></div>
    <div class="nd-tile nd-clickable" id="nd-notes-tile" style="--d:4" title="Read your notes back from IPFS"><div class="nd-tile-v nd-mono" id="nd-m-pins">—</div><div class="nd-tile-l">Notes in IPFS</div></div>
  </section>

  <section class="nd-card nd-bridge" id="nd-bridge" style="--d:5"><!-- filled by cloud-bridge.js mountBridgeCard --></section>

  <p class="nd-foot" id="nd-privacy-note" style="display:none;color:var(--nd-boot,#f5a623)"></p>
  <p class="nd-foot">Your keys are your identity; your node holds your data — content-addressed and owned on this device.</p>
</div>`

const STYLE = `
.nd-node{
  --nd-mono:'SF Mono','Cascadia Code',Monaco,'JetBrains Mono',ui-monospace,monospace;
  --nd-online:var(--success,#10B981); --nd-boot:var(--warning,#F59E0B); --nd-down:var(--danger,#EF4444);
  --nd-accent:var(--monero-orange,var(--nd-accent));
  --nd-line:var(--border-color,rgba(255,255,255,.08));
  --nd-card:var(--card-bg,rgba(255,255,255,.03));
  max-width:840px;margin:0 auto;padding:30px 22px 64px;color:var(--text-primary,#fff);
}
.nd-node *{box-sizing:border-box}
@keyframes nd-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.nd-node{animation:nd-rise .45s ease both}
.nd-card,.nd-tile{animation:nd-rise .5s ease both;animation-delay:calc(var(--d,0)*70ms)}

/* header */
.nd-head{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.nd-back{flex:none;width:38px;height:38px;border-radius:10px;border:1px solid var(--nd-line);background:transparent;color:var(--text-secondary,#a0a0a0);font-size:17px;cursor:pointer;transition:.18s}
.nd-back:hover{border-color:var(--nd-accent);color:var(--text-primary,#fff);transform:translateX(-2px)}
.nd-titles{flex:1;min-width:0}
.nd-title{margin:0;font-size:21px;font-weight:650;letter-spacing:-.01em}
.nd-sub{margin-top:2px;font-size:12.5px;color:var(--text-muted,#606060)}
.nd-chip{flex:none;font:600 11px/1 var(--nd-mono);letter-spacing:.06em;padding:6px 11px;border-radius:999px;border:1px solid var(--nd-line);text-transform:uppercase}
.nd-chip[data-s=online]{color:var(--nd-online);border-color:color-mix(in srgb,var(--nd-online) 45%,transparent)}
.nd-chip[data-s=boot]{color:var(--nd-boot);border-color:color-mix(in srgb,var(--nd-boot) 40%,transparent)}
.nd-chip[data-s=down]{color:var(--nd-down);border-color:color-mix(in srgb,var(--nd-down) 40%,transparent)}

/* hero */
.nd-hero{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:20px;
  padding:26px 28px;border:1px solid var(--nd-line);border-radius:18px;
  background:radial-gradient(120% 140% at 18% 0%,color-mix(in srgb, var(--nd-accent) 8%, transparent),transparent 55%),var(--nd-card);margin-bottom:18px}
.nd-hero[data-s=down]{background:radial-gradient(120% 140% at 18% 0%,rgba(239,68,68,.07),transparent 55%),var(--nd-card)}
.nd-hero-grid{position:absolute;inset:0;pointer-events:none;opacity:.5;
  background-image:linear-gradient(var(--nd-line) 1px,transparent 1px),linear-gradient(90deg,var(--nd-line) 1px,transparent 1px);
  background-size:30px 30px;mask-image:radial-gradient(140% 120% at 80% 50%,#000,transparent 75%)}
.nd-status{position:relative;display:flex;align-items:center;gap:18px;z-index:1}
.nd-orb{flex:none;width:52px;height:52px;border-radius:50%;display:grid;place-items:center;color:var(--nd-boot)}
.nd-orb[data-s=online]{color:var(--nd-online)} .nd-orb[data-s=down]{color:var(--nd-down)}
.nd-orb-core{width:13px;height:13px;border-radius:50%;background:currentColor;box-shadow:0 0 14px currentColor}
.nd-orb::before,.nd-orb::after{content:'';position:absolute;width:52px;height:52px;border-radius:50%;border:1.5px solid currentColor;opacity:.55;animation:nd-pulse 2.6s ease-out infinite}
.nd-orb::after{animation-delay:1.3s}
.nd-orb[data-s=down]::before,.nd-orb[data-s=down]::after{animation-play-state:paused;opacity:.25}
@keyframes nd-pulse{0%{transform:scale(.45);opacity:.6}100%{transform:scale(1.3);opacity:0}}
.nd-status-label{font-size:19px;font-weight:650;letter-spacing:-.01em}
.nd-status-desc{margin-top:3px;font-size:12.5px;color:var(--text-secondary,#a0a0a0);max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nd-radar{position:relative;flex:none;width:118px;height:118px;z-index:1}
.nd-radar-rings,.nd-radar-rings::before,.nd-radar-rings::after{position:absolute;border-radius:50%;border:1px solid var(--nd-line)}
.nd-radar-rings{inset:0}.nd-radar-rings::before{content:'';inset:20px}.nd-radar-rings::after{content:'';inset:42px}
.nd-sweep{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,transparent 0deg,color-mix(in srgb,var(--nd-accent) 30%,transparent) 42deg,transparent 64deg);animation:nd-spin 4.2s linear infinite}
.nd-hero[data-s=boot] .nd-sweep{opacity:.5}.nd-hero[data-s=down] .nd-sweep{opacity:.18;animation-play-state:paused}
@keyframes nd-spin{to{transform:rotate(360deg)}}
.nd-peercount{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.nd-peercount span{font:700 30px/1 var(--nd-mono);color:var(--nd-accent);transition:color .3s}
.nd-hero[data-s=down] .nd-peercount span,.nd-hero[data-s=boot] .nd-peercount span{color:var(--text-muted,#606060)}
.nd-peercount small{margin-top:4px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-muted,#606060)}

/* cards */
.nd-card{border:1px solid var(--nd-line);border-radius:16px;background:var(--nd-card);padding:18px 20px;margin-bottom:16px}
.nd-h{margin:0 0 14px;font:600 11px/1 var(--nd-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted,#606060)}
.nd-dl{display:grid;grid-template-columns:104px 1fr;gap:11px 16px;margin:0}
.nd-dl dt{font-size:12.5px;color:var(--text-secondary,#a0a0a0);align-self:center}
.nd-dl dd{margin:0;font-size:13px;color:var(--text-primary,#fff);min-width:0}
.nd-mono{font-family:var(--nd-mono);word-break:break-all}
.nd-peerid{display:flex;align-items:center;gap:8px}
.nd-peerid .nd-mono{font-size:12.5px;color:var(--nd-accent);overflow:hidden;text-overflow:ellipsis}
.nd-copy{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--nd-line);background:transparent;color:var(--text-secondary,#a0a0a0);cursor:pointer;font-size:12px;transition:.16s}
.nd-copy:hover{border-color:var(--nd-accent);color:var(--nd-accent)}

/* metrics */
.nd-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}
.nd-tile{border:1px solid var(--nd-line);border-radius:14px;background:var(--nd-card);padding:18px 16px;transition:.18s}
.nd-tile:hover{border-color:var(--border-hover,rgba(255,255,255,.15));transform:translateY(-2px)}
.nd-tile.nd-clickable{cursor:pointer}
.nd-tile.nd-clickable:hover{border-color:var(--nd-accent);box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--nd-accent) 25%, transparent)}
.nd-tile-v{font-size:26px;font-weight:700;color:var(--text-primary,#fff);line-height:1}
.nd-tile-l{margin-top:8px;font-size:11px;letter-spacing:.04em;color:var(--text-muted,#606060);text-transform:uppercase}

/* cloud bridge */
.nd-bridge-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.nd-bridge-desc{margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--text-secondary,#a0a0a0);max-width:52ch}
.nd-badge{flex:none;font:600 10.5px/1 var(--nd-mono);letter-spacing:.06em;text-transform:uppercase;padding:6px 10px;border-radius:999px;color:var(--text-muted,#606060);border:1px solid var(--nd-line)}
.nd-bridge-btn{margin-top:16px;width:100%;padding:11px;border-radius:10px;border:1px dashed var(--border-hover,rgba(255,255,255,.15));background:transparent;color:var(--text-muted,#606060);font-size:13px;font-weight:600;cursor:not-allowed;letter-spacing:.01em}

.nd-foot{margin:22px 4px 0;font-size:12px;line-height:1.6;color:var(--text-muted,#606060);text-align:center}
`

function ensureStyles () {
  if (document.getElementById('nd-node-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-node-styles'
  el.textContent = STYLE
  document.head.appendChild(el)
}

function fmtBytes (n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`
}

function applyStatus (s) {
  const onTor = s?.mode === 'tor'
  let state, label, desc
  if (s?.ready) { state = 'online'; label = onTor ? 'Online · Tor' : 'Online'; desc = onTor ? 'Connected over Tor — peers can\'t see your IP' : 'Connected to peers' }
  else if (s?.error) { state = 'down'; label = 'Unreachable'; desc = s.error }
  else if (onTor || (s && s.torBootstrap != null)) { state = 'boot'; label = 'Starting Tor…'; desc = s?.torBootstrap != null ? `Bootstrapping ${s.torBootstrap}%` : 'Bringing up the Tor node' }
  else { state = 'boot'; label = 'Starting…'; desc = 'Bringing up the local daemon' }

  const setS = (id, v) => { const e = $(id); if (e) e.dataset.s = state }
  setS('nd-orb'); setS('nd-hero'); setS('nd-chip')
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v }
  set('nd-chip', state === 'online' ? '● live' : state === 'boot' ? '● booting' : '● offline')
  set('nd-status-label', label)
  set('nd-status-desc', desc)
  set('nd-peers', s?.ready ? s.peers : '—')
  set('nd-m-peers', s?.ready ? s.peers : '—')
  set('nd-m-repo', s?.repoSizeBytes != null ? fmtBytes(s.repoSizeBytes) : '—')
  // "Notes in IPFS" = this user's note count (matches the right-panel deck), NOT the raw
  // recursive-pin count. Read from dag-publish's localStorage counter via the logged-in pubkey.
  let noteCount = '—'
  try { const pk = window.NostrState?.publicKey; if (pk) noteCount = parseInt(localStorage.getItem('nosdag:posts:' + pk) || '0', 10) } catch { /* ignore */ }
  set('nd-m-pins', noteCount)
  set('nd-peerid', s?.peerId || '—')
  set('nd-agent', onTor ? 'helia · libp2p/ws' : (s?.agentVersion || '—'))
  set('nd-kubo', onTor ? 'Helia · Tor' : (s?.version ? `v${s.version}` : '—'))
  set('nd-rpc', onTor ? (s?.onion ? `${s.onion.slice(0, 18)}…onion` : 'onion service') : (s?.apiPort ? `127.0.0.1:${s.apiPort}` : '—'))
  // M6: be honest that clearnet IPFS exposes your IP ↔ the content you host/fetch (DHT providers +
  // Bitswap want-lists). Inherent to clearnet; anonymous mode hides it. Shown only in clearnet.
  const priv = $('nd-privacy-note')
  if (priv) {
    priv.style.display = onTor ? 'none' : ''
    if (!onTor) priv.textContent = '⚠ In clearnet, peers on the IPFS network can link your IP to the notes and media your node hosts and fetches. Anonymous mode routes everything over Tor to hide this.'
  }
}

async function tick () {
  let s = null
  try { s = await window.nosdag?.kubo?.status?.() }
  catch (e) { s = { ready: false, error: String(e?.message || e) } }
  if (s?.peerId) lastPeerId = s.peerId
  applyStatus(s || { ready: false, error: 'IPC bridge unavailable' })
}

export async function renderNodePanel (container) {
  ensureStyles()
  container.innerHTML = TEMPLATE

  container.querySelector('[data-nd-home]')?.addEventListener('click', () => window.navigateTo?.('home'))
  container.querySelector('#nd-notes-tile')?.addEventListener('click', async () => {
    try { const V = await import('./ipfs-notes-view.js'); await V.showIpfsNotes() }
    catch (e) { console.warn('[nosdag] ipfs-notes view failed:', e) }
  })

  const copyBtn = container.querySelector('#nd-copy')
  copyBtn?.addEventListener('click', async () => {
    if (!lastPeerId) return
    try {
      await navigator.clipboard.writeText(lastPeerId)
      copyBtn.textContent = '✓'
      setTimeout(() => { copyBtn.textContent = '⧉' }, 1200)
    } catch { /* clipboard may be unavailable */ }
  })

  // Tor/clearnet posture + onion relays moved to their own page (Anonymous Mode, left rail).

  // Cloud Bridge card — self-contained; manages its own link/linked state.
  import('./cloud-bridge.js')
    .then((CB) => CB.mountBridgeCard(container.querySelector('#nd-bridge')))
    .catch((e) => console.warn('[nosdag] cloud-bridge card failed:', e))

  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  await tick()
  pollTimer = setInterval(() => {
    const pg = document.getElementById('nodePage')
    if (!pg || pg.style.display === 'none' || !pg.isConnected) { clearInterval(pollTimer); pollTimer = null; return }
    tick()
  }, 2500)
}
