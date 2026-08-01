// Nosdag — onion-native relays for anonymous (Tor) mode.
//
// In the Tor posture the relay layer swaps to .onion-native relays: reads (feeds, profiles,
// threads) ride end-to-end inside Tor — no exit node on the path, and the onion address
// itself authenticates the relay. Publishes mirror to the user's normal clearnet write
// relays through Tor exits by default ("Also publish to my clearnet relays"), because a
// note is public broadcast content and the nosdag:head / nosdag:onion pointers must land
// where followers actually look; turning the mirror off = strict onion-only publishing.
//
// Targeted lookups are deliberately NOT overridden (the Nosmero NIP-78 relay that resolves
// XMR tip addresses, author-outbox queries, relay hints, NIP-50 search) — those only exist
// on specific relays and still ride Tor exits, IP-safe either way.
//
// HARD RULE (NIP-65, read verbatim 2026-06-12): the kind 10002 announcement NEVER carries
// onion URLs — it exists so others can find you, and clearnet clients can't dial onions.
// The selection here is local transport config: localStorage only, never published
// (publishing your onion picks would fingerprint you).
//
// The known list = github.com/0xtrr/onion-service-nostr-relays, live-probed over Tor on
// 2026-06-12 (tor-transport/probe-onion-relays.mjs — 3 rounds: open / NIP-01 read / signed
// ephemeral write). Only 6 of 26 were alive; the dead ones stay listed (collapsed) since
// onions resurrect and the in-app check shows it.

import * as State from '../state.js'

const PROBED = '2026-06-12'

// alive = passed the dated probe; write = accepts writes without payment/whitelist.
export const KNOWN_ONION_RELAYS = [
  { name: 'nostr.oxtr.dev', url: 'ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion', write: true, fee: null, alive: PROBED, note: 'fastest at probe; strfry' },
  { name: 'bitcoiner.social', url: 'ws://bitcoinr6de5lkvx4tpwdmzrdfdpla5sya2afwpcabjup2xpi5dulbad.onion', write: true, fee: null, alive: PROBED, note: 'monitored uptime, nightly backups' },
  { name: 'nostr.girino.org', url: 'ws://gnostr2jnapk72mnagq3cuykfon73temzp77hcbncn4silgt77boruid.onion', write: true, fee: null, alive: PROBED, note: 'khatru' },
  { name: 'nerostrator', url: 'ws://nerostrrgb5fhj6dnzhjbgmnkpy2berdlczh6tuh2jsqrjok3j4zoxid.onion', write: false, fee: 'XMR to write', alive: PROBED, note: 'free read; one XMR payment unlocks write' },
  { name: 'noderunners', url: 'ws://35vr3xigzjv2xyzfyif6o2gksmkioppy4rmwag7d4bqmwuccs2u4jaid.onion', write: false, fee: 'whitelist', alive: PROBED, note: 'reads fine; writes whitelist-only' },
  { name: 'nostrbtc.com', url: 'ws://7imqzy3ui3gpn4fdsvefaqjrs4zqvytm33h5jmcmzbfc2hmm4qhy2iad.onion', write: false, fee: 'paid (LN)', alive: PROBED, note: 'LN-paid; kind-1 write unverified' },
  // down at the dated probe (HostUnreachable — descriptor gone). Kept: onions resurrect.
  { name: 'relay.snort.social', url: 'ws://skzzn6cimfdv5e2phjc4yr5v7ikbxtn5f7dkwn5c7v47tduzlbosqmqd.onion', write: true, fee: null, alive: null },
  { name: 'nostr.thesamecat.io', url: 'ws://2jsnlhfnelig5acq6iacydmzdbdmg7xwunm4xl6qwbvzacw4lwrjmlyd.onion', write: true, fee: null, alive: null },
  { name: 'nostr.land', url: 'ws://nostrland2gdw7g3y77ctftovvil76vquipymo7tsctlxpiwknevzfid.onion', write: false, fee: 'paid (LN)', alive: null },
  { name: 'relay.westernbtc.com', url: 'ws://westbtcebhgi4ilxxziefho6bqu5lqwa5ncfjefnfebbhx2cwqx5knyd.onion', write: false, fee: 'paid (LN)', alive: null },
  { name: 'freelay.sovbit.host', url: 'ws://sovbitm2enxfr5ot6qscwy5ermdffbqscy66wirkbsigvcshumyzbbqd.onion', write: true, fee: null, alive: null },
  { name: 'nostr.sovbit.host', url: 'ws://sovbitgz5uqyh7jwcsudq4sspxlj4kbnurvd3xarkkx2use3k6rlibqd.onion', write: false, fee: 'paid', alive: null },
  { name: 'nostr.wine', url: 'ws://nostrwinemdptvqukjttinajfeedhf46hfd5bz2aj2q5uwp7zros3nad.onion', write: false, fee: 'paid', alive: null },
  { name: 'inbox.nostr.wine', url: 'ws://wineinboxkayswlofkugkjwhoyi744qvlzdxlmdvwe7cei2xxy4gc6ad.onion', write: false, fee: 'paid', alive: null },
  { name: 'filter.nostr.wine', url: 'ws://winefiltermhqixxzmnzxhrmaufpnfq3rmjcl6ei45iy4aidrngpsyid.onion', write: false, fee: 'paid', alive: null },
  { name: 'pzfw4… (unnamed)', url: 'ws://pzfw4uteha62iwkzm3lycabk4pbtcr67cg5ymp5i3xwrpt3t24m6tzad.onion:81', write: true, fee: null, alive: null },
  { name: 'nostr.fractalized.net', url: 'ws://xvgox2zzo7cfxcjrd2llrkthvjs5t7efoalu34s6lmkqhvzvrms6ipyd.onion', write: true, fee: null, alive: null },
  { name: 'nfrelay.app', url: 'ws://nfrelay6saohkmipikquvrn6d64dzxivhmcdcj4d5i7wxis47xwsriyd.onion', write: true, fee: null, alive: null },
  { name: 'relay.nostr.net', url: 'ws://nostrnetl6yd5whkldj3vqsxyyaq3tkuspy23a3qgx7cdepb4564qgqd.onion', write: true, fee: null, alive: null },
  { name: 'wot.girino.org', url: 'ws://girwot2koy3kvj6fk7oseoqazp5vwbeawocb3m27jcqtah65f2fkl3yd.onion', write: false, fee: 'WoT', alive: null },
  { name: 'haven.girino.org', url: 'ws://ghaven2hi3qn2riitw7ymaztdpztrvmm337e2pgkacfh3rnscaoxjoad.onion/outbox', write: false, fee: 'haven', alive: null },
  { name: 'relay.nostpy.lol', url: 'ws://pemgkkqjqjde7y2emc2hpxocexugbixp42o4zymznil6zfegx5nfp4id.onion', write: true, fee: 'WoT', alive: null },
  { name: 'poster.place', url: 'ws://dmw5wbawyovz7fcahvguwkw4sknsqsalffwctioeoqkvvy7ygjbcuoad.onion', write: true, fee: null, alive: null },
  { name: 'azzamo premium', url: 'ws://q6a7m5qkyonzb5fk5yv4jyu3ar44hqedn7wjopg737lit2ckkhx2nyid.onion', write: false, fee: 'paid (LN)', alive: null },
  { name: 'azzamo inbox', url: 'ws://gp5kiwqfw7t2fwb3rfts2aekoph4x7pj5pv65re2y6hzaujsxewanbqd.onion', write: false, fee: 'freemium', alive: null },
  { name: 'noderunners (legacy entry)', url: 'ws://nostr2jjjvkmgmzemqvyhjnflrwambfsdwxitkrvgqzobxn2llkfojid.onion', write: false, fee: null, alive: null, hidden: true }
].filter((r) => !r.hidden)

// 3 read+write + 2 read-only (XMR-unlockable / clean reader) — 2026-06-12 probe ranking.
export const DEFAULT_SELECTION = KNOWN_ONION_RELAYS.slice(0, 5).map((r) => r.url)

// ---------------- posture + persistence ----------------

// The relays.js getters are SYNC, so the posture is a pushed flag, not an await:
// tor-mode.js pushes it on every switch, and module init below syncs it from main at boot
// (localStorage carries the last-known posture across the await gap). Outside the shell
// (web/dev) it stays 'clearnet' → every override returns null → zero behavior change.
let posture = 'clearnet'
try { posture = localStorage.getItem('nosdag:posture') === 'tor' ? 'tor' : 'clearnet' } catch { /* private mode */ }

export function getPosture () { return posture }
export function setPosture (mode) {
  posture = mode === 'tor' ? 'tor' : 'clearnet'
  try { localStorage.setItem('nosdag:posture', posture) } catch { /* private mode */ }
  // keep the header relay pill truthful the moment the posture changes
  try { window.updateRelayIndicator?.(State.relays?.length ?? 0) } catch { /* header not mounted */ }
}
export async function syncPosture () {
  try { const m = await window.nosdag?.mode?.get?.(); if (m?.mode) setPosture(m.mode) } catch { /* not in shell */ }
  return posture
}
if (typeof window !== 'undefined' && window.nosdag?.mode) syncPosture() // boot sync (fire-and-forget)

const skey = () => `nosdag:onion-relays:${State.publicKey || 'anon'}`
const mkey = () => `nosdag:onion-mirror:${State.publicKey || 'anon'}`

function readState () {
  try {
    const j = JSON.parse(localStorage.getItem(skey()) || 'null')
    if (j && Array.isArray(j.selected)) return { selected: j.selected, custom: Array.isArray(j.custom) ? j.custom : [] }
  } catch { /* fall through */ }
  return { selected: [...DEFAULT_SELECTION], custom: [] }
}
function writeState (st) {
  try { localStorage.setItem(skey(), JSON.stringify(st)) } catch { /* private mode */ }
}

export function mirrorEnabled () {
  try { return localStorage.getItem(mkey()) !== '0' } catch { return true } // default ON
}
export function setMirror (on) {
  try { localStorage.setItem(mkey(), on ? '1' : '0') } catch { /* private mode */ }
}

/** every relay the picker knows: the known list + the user's custom additions */
export function allRelays () {
  const st = readState()
  const customs = st.custom.map((c) => ({ name: c.name || c.url.replace(/^wss?:\/\//, '').slice(0, 24) + '…', url: c.url, write: true, fee: null, alive: null, custom: true }))
  return [...KNOWN_ONION_RELAYS, ...customs]
}
export function selectedUrls () {
  const known = new Set(allRelays().map((r) => r.url))
  const sel = readState().selected.filter((u) => known.has(u))
  return sel.length ? sel : [...DEFAULT_SELECTION]
}
export function setSelected (urls) {
  const st = readState()
  st.selected = [...new Set(urls)]
  writeState(st)
}
export function addCustomRelay (url) {
  const u = String(url || '').trim().replace(/\/+$/, '')
  if (!/^wss?:\/\/[a-z2-7]{56}\.onion(:\d+)?(\/[\w-]*)?$/.test(u)) return { error: 'expected ws://<56-char v3 onion>.onion' }
  const st = readState()
  if (allRelays().some((r) => r.url === u)) return { error: 'already in the list' }
  st.custom.push({ url: u })
  if (!st.selected.includes(u)) st.selected.push(u)
  writeState(st)
  return { ok: true }
}
export function restoreDefaults () {
  const st = readState()
  st.selected = [...DEFAULT_SELECTION]
  writeState(st)
}

// ---------------- the relays.js overrides ----------------

const writeCapable = () => {
  const sel = new Set(selectedUrls())
  return allRelays().filter((r) => sel.has(r.url) && r.write).map((r) => r.url)
}

/** Tor posture: feeds/profiles/threads read ONLY from the onion selection. null = no override. */
export function readOverride () {
  if (posture !== 'tor') return null
  return selectedUrls()
}

/** Tor posture: publish to onion write relays, plus the clearnet write set when the mirror is on. */
export function writeOverride (clearnetWrites = []) {
  if (posture !== 'tor') return null
  const writes = writeCapable()
  const base = writes.length ? writes : selectedUrls() // nothing write-capable selected → best effort
  return mirrorEnabled() ? [...new Set([...base, ...clearnetWrites])] : base
}

/** Tor posture: the general-purpose pool (read+write union; clearnet kept when mirroring). */
export function generalOverride (clearnetActive = []) {
  if (posture !== 'tor') return null
  return mirrorEnabled() ? [...new Set([...selectedUrls(), ...clearnetActive])] : selectedUrls()
}

/** Strict onion-only: recipient-inbox targets (other people's clearnet relays) are dropped. */
export function filterInbox (urls = []) {
  if (posture !== 'tor' || mirrorEnabled()) return urls
  return urls.filter((u) => /\.onion(:|\/|$)/.test(u))
}

// ---------------- live check (renderer — rides the session-wide Tor proxy) ----------------

/** Open + NIP-01 REQ + close. Only meaningful in Tor posture (onions don't resolve outside it). */
export function checkRelay (url, { openTimeout = 30000, readTimeout = 12000 } = {}) {
  return new Promise((resolve) => {
    let ws = null
    let settled = false
    let t2 = null
    const t0 = Date.now()
    const done = (res) => {
      if (settled) return
      settled = true
      clearTimeout(t1); clearTimeout(t2)
      try { ws?.close() } catch { /* gone */ }
      resolve(res)
    }
    const t1 = setTimeout(() => done({ ok: false, error: 'connect timeout' }), openTimeout)
    try { ws = new WebSocket(url) } catch (e) { return done({ ok: false, error: String(e?.message || e) }) }
    ws.onopen = () => {
      const openMs = Date.now() - t0
      clearTimeout(t1)
      const tr = Date.now()
      t2 = setTimeout(() => done({ ok: false, openMs, error: 'no response' }), readTimeout)
      try { ws.send(JSON.stringify(['REQ', 'ndcheck', { kinds: [1], limit: 1 }])) } catch { return done({ ok: false, openMs, error: 'send failed' }) }
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data)
          if ((d[0] === 'EVENT' || d[0] === 'EOSE') && d[1] === 'ndcheck') done({ ok: true, openMs, readMs: Date.now() - tr })
        } catch { /* not json */ }
      }
    }
    ws.onerror = () => done({ ok: false, error: 'connection failed' })
    ws.onclose = () => done({ ok: false, error: 'closed' })
  })
}

// ---------------- the card (Node panel, under the Anonymous-mode card) ----------------

function ensureStyles () {
  if (document.getElementById('nd-or-styles')) return
  const el = document.createElement('style')
  el.id = 'nd-or-styles'
  el.textContent = `
.nd-or-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.nd-or-badge{flex:none;font:600 10.5px/1 var(--nd-mono,ui-monospace,monospace);letter-spacing:.07em;text-transform:uppercase;padding:6px 11px;border-radius:999px;border:1px solid var(--nd-line,rgba(255,255,255,.12));color:var(--nd-accent)}
.nd-or-desc{margin:12px 0 0;font-size:12.5px;line-height:1.6;color:var(--text-secondary,#9aa4b4);max-width:58ch}
.nd-or-mirror{display:flex;gap:10px;align-items:flex-start;margin:14px 0 0;padding:11px 13px;border:1px solid var(--nd-line,rgba(255,255,255,.12));border-radius:11px;background:color-mix(in srgb, var(--nd-accent) 5%, transparent);cursor:pointer}
.nd-or-mirror input{margin-top:2px;accent-color:var(--nd-accent)}
.nd-or-mirror span{font-size:12px;line-height:1.55;color:var(--text-secondary,#9aa4b4)}
.nd-or-mirror b{color:var(--text-primary,#e9eef5);font-weight:600}
.nd-or-list{margin:14px 0 0;display:grid;gap:6px}
.nd-or-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--nd-line,rgba(255,255,255,.08));border-radius:10px;cursor:pointer;transition:.15s}
.nd-or-row:hover{border-color:color-mix(in srgb, var(--nd-accent) 45%, transparent)}
.nd-or-row input{accent-color:var(--nd-accent);flex:none}
.nd-or-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#5d6878}
.nd-or-dot[data-s=ok]{background:#26d07c;box-shadow:0 0 8px rgba(38,208,124,.7)}
.nd-or-dot[data-s=down]{background:#ff5d5d;box-shadow:0 0 8px rgba(255,93,93,.6)}
.nd-or-dot[data-s=checking]{background:#f5a623;box-shadow:0 0 8px rgba(245,166,35,.7)}
.nd-or-meta{min-width:0;flex:1}
.nd-or-name{font-size:12.5px;font-weight:600;color:var(--text-primary,#e9eef5);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.nd-or-chip{font:600 9px/1 var(--nd-mono,ui-monospace,monospace);letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:999px;border:1px solid var(--nd-line,rgba(255,255,255,.14));color:var(--text-muted,#9aa4b4)}
.nd-or-chip[data-k=write]{color:var(--nd-accent);border-color:color-mix(in srgb, var(--nd-accent) 50%, transparent)}
.nd-or-chip[data-k=fee]{color:#f5a623;border-color:rgba(245,166,35,.4)}
.nd-or-url{font:500 10.5px/1.4 var(--nd-mono,ui-monospace,monospace);color:var(--text-muted,#5d6878);word-break:break-all;display:block;margin-top:2px}
.nd-or-ms{flex:none;font:600 10.5px/1 var(--nd-mono,ui-monospace,monospace);color:var(--text-muted,#5d6878)}
.nd-or-expand{margin-top:10px;width:100%;padding:9px;border-radius:10px;border:1px dashed var(--nd-line,rgba(255,255,255,.14));background:transparent;color:var(--text-muted,#9aa4b4);cursor:pointer;font:600 11.5px/1 var(--nd-mono,ui-monospace,monospace)}
.nd-or-expand:hover{color:var(--nd-accent);border-color:color-mix(in srgb, var(--nd-accent) 45%, transparent)}
.nd-or-actions{display:flex;gap:10px;margin-top:13px;flex-wrap:wrap}
.nd-or-btn{padding:10px 14px;border-radius:10px;cursor:pointer;font:600 12px/1 var(--nd-mono,ui-monospace,monospace);border:none;transition:.15s}
.nd-or-btn[data-kind=primary]{color:#0a0e14;background:linear-gradient(180deg,var(--nd-accent-hi),var(--nd-accent))}
.nd-or-btn[data-kind=ghost]{color:var(--text-primary,#e9eef5);background:transparent;border:1px solid var(--nd-line,rgba(255,255,255,.12))}
.nd-or-btn[data-kind=ghost]:hover{border-color:var(--nd-accent);color:var(--nd-accent)}
.nd-or-btn:disabled{opacity:.5;cursor:not-allowed}
.nd-or-add{display:flex;gap:8px;margin-top:12px}
.nd-or-add input{flex:1;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--nd-line,rgba(255,255,255,.12));background:rgba(0,0,0,.25);color:var(--text-primary,#e9eef5);font:500 11.5px/1 var(--nd-mono,ui-monospace,monospace)}
.nd-or-add input:focus{outline:none;border-color:var(--nd-accent)}
.nd-or-status{margin-top:11px;font:600 11.5px/1.6 var(--nd-mono,ui-monospace,monospace);display:none}
.nd-or-status.show{display:block}
.nd-or-status[data-tone=ok]{color:#26d07c}
.nd-or-status[data-tone=err]{color:#ff5d5d}
.nd-or-status[data-tone=note]{color:var(--text-muted,#9aa4b4)}
.nd-or-warn{margin-top:11px;font-size:12px;color:#f5a623;display:none}
.nd-or-warn.show{display:block}`
  document.head.appendChild(el)
}

const lastCheck = new Map() // url → { ok, openMs } (session-scoped)

function rowHtml (r, selected) {
  const chips = []
  chips.push(r.write
    ? '<span class="nd-or-chip" data-k="write">write</span>'
    : '<span class="nd-or-chip">read-only</span>')
  if (r.fee) chips.push(`<span class="nd-or-chip" data-k="fee">${r.fee}</span>`)
  if (!r.alive && !r.custom) chips.push(`<span class="nd-or-chip">down ${PROBED}</span>`)
  if (r.custom) chips.push('<span class="nd-or-chip">custom</span>')
  const c = lastCheck.get(r.url)
  const dot = c ? (c.ok ? 'ok' : 'down') : 'unknown'
  const ms = c?.ok && c.openMs != null ? `${c.openMs}ms` : ''
  return `
    <label class="nd-or-row" data-url="${r.url}">
      <input type="checkbox" ${selected ? 'checked' : ''}>
      <span class="nd-or-dot" data-s="${dot}"></span>
      <span class="nd-or-meta">
        <span class="nd-or-name">${r.name} ${chips.join(' ')}</span>
        <span class="nd-or-url">${r.url.replace(/^wss?:\/\//, '').slice(0, 38)}…</span>
      </span>
      <span class="nd-or-ms">${ms}</span>
    </label>`
}

function render (card, { expanded = false } = {}) {
  const onTor = posture === 'tor'
  const sel = new Set(selectedUrls())
  const all = allRelays()
  const main = all.filter((r) => r.alive || r.custom || sel.has(r.url))
  const dead = all.filter((r) => !main.includes(r))
  const writes = writeCapable().length

  card.innerHTML = `
    <div class="nd-or-head">
      <h2 class="nd-h" style="margin:0">Onion relays</h2>
      <span class="nd-or-badge">${sel.size} selected · ${writes} write</span>
    </div>
    <p class="nd-or-desc">${onTor
      ? 'Active — your feeds read from these onion relays, end-to-end inside Tor.'
      : 'In anonymous mode, feeds read from these onion relays instead of your normal ones. Configure anytime.'}</p>
    <label class="nd-or-mirror">
      <input type="checkbox" id="nd-or-mirror" ${mirrorEnabled() ? 'checked' : ''}>
      <span><b>Also publish to my clearnet relays (via Tor).</b> Followers on normal relays keep seeing your notes; your IP stays hidden. Off = onion-only publishing, far smaller reach.</span>
    </label>
    <div class="nd-or-list" id="nd-or-list">${main.map((r) => rowHtml(r, sel.has(r.url))).join('')}</div>
    ${dead.length ? `<button class="nd-or-expand" id="nd-or-expand">${expanded ? 'Hide' : 'Show'} ${dead.length} offline relays (down at the ${PROBED} probe)</button>` : ''}
    ${expanded ? `<div class="nd-or-list" id="nd-or-list-dead">${dead.map((r) => rowHtml(r, sel.has(r.url))).join('')}</div>` : ''}
    <div class="nd-or-actions">
      <button class="nd-or-btn" data-kind="primary" id="nd-or-check" ${onTor ? '' : 'disabled title="Onion addresses only resolve inside Tor — switch to anonymous mode to check"'}>Check selected</button>
      <button class="nd-or-btn" data-kind="ghost" id="nd-or-defaults">Restore defaults</button>
    </div>
    <div class="nd-or-add">
      <input id="nd-or-add-input" placeholder="ws://yourrelayonionaddress.onion" spellcheck="false">
      <button class="nd-or-btn" data-kind="ghost" id="nd-or-add-btn">Add</button>
    </div>
    <div class="nd-or-warn" id="nd-or-warn"></div>
    <div class="nd-or-status" id="nd-or-status"></div>`

  const warn = card.querySelector('#nd-or-warn')
  const refreshWarn = () => {
    const w = writeCapable().length
    const n = selectedUrls().length
    let msg = ''
    if (!n) msg = 'Nothing selected — anonymous mode would fall back to the defaults.'
    else if (!w) msg = 'No write-capable relay selected — your notes can only publish via the clearnet mirror.'
    warn.textContent = msg
    warn.classList.toggle('show', !!msg)
  }
  refreshWarn()

  const onToggle = (row) => {
    const url = row.dataset.url
    const cur = new Set(selectedUrls())
    if (row.querySelector('input').checked) cur.add(url)
    else cur.delete(url)
    setSelected([...cur])
    card.querySelector('.nd-or-badge').textContent = `${cur.size} selected · ${writeCapable().length} write`
    refreshWarn()
  }
  card.querySelectorAll('.nd-or-row').forEach((row) => {
    row.querySelector('input').addEventListener('change', () => onToggle(row))
  })

  card.querySelector('#nd-or-mirror').addEventListener('change', (e) => setMirror(e.target.checked))
  card.querySelector('#nd-or-expand')?.addEventListener('click', () => render(card, { expanded: !expanded }))
  card.querySelector('#nd-or-defaults').addEventListener('click', () => { restoreDefaults(); render(card, { expanded }) })

  card.querySelector('#nd-or-add-btn').addEventListener('click', () => {
    const input = card.querySelector('#nd-or-add-input')
    const res = addCustomRelay(input.value)
    const status = card.querySelector('#nd-or-status')
    if (res.error) { status.textContent = res.error; status.dataset.tone = 'err'; status.classList.add('show'); return }
    render(card, { expanded })
  })

  card.querySelector('#nd-or-check')?.addEventListener('click', async () => {
    const status = card.querySelector('#nd-or-status')
    status.textContent = 'Checking over Tor… (cold onion circuits can take ~30s)'
    status.dataset.tone = 'note'
    status.classList.add('show')
    const urls = selectedUrls()
    card.querySelectorAll('.nd-or-row').forEach((row) => {
      if (urls.includes(row.dataset.url)) row.querySelector('.nd-or-dot').dataset.s = 'checking'
    })
    const results = await Promise.all(urls.map(async (u) => {
      const r = await checkRelay(u)
      lastCheck.set(u, r)
      const row = card.querySelector(`.nd-or-row[data-url="${u}"]`)
      if (row) {
        row.querySelector('.nd-or-dot').dataset.s = r.ok ? 'ok' : 'down'
        row.querySelector('.nd-or-ms').textContent = r.ok ? `${r.openMs}ms` : ''
      }
      return r
    }))
    const up = results.filter((r) => r.ok).length
    status.textContent = `${up}/${urls.length} reachable`
    status.dataset.tone = up ? 'ok' : 'err'
  })
}

export async function mountOnionRelaysCard (card) {
  if (!card) return
  if (!window.nosdag?.mode) { card.style.display = 'none'; return } // not in the shell
  card.style.display = ''
  card.classList.add('nd-card')
  ensureStyles()
  await syncPosture()
  render(card)
}
