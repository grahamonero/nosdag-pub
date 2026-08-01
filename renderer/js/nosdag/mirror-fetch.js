// Nosdag Phase 2 — mirror-fetch + "media resting" tombstone (design §3.2–3.4, §7).
//
// Swarm media renders from the LOCAL gateway (ipfs://<CID> → http://127.0.0.1:8201/ipfs/<CID>,
// rewritten in utils.parseContent). The local Kubo gateway pulls the block over Bitswap if a
// provider is reachable. This module is the DEGRADATION layer for when that direct pull fails:
//
//   1. mirror-fetch — if the local gateway errors or stalls past a timeout, retry the SAME CID
//      over HTTPS from public IPFS gateways (Tier-1 mirrors, §3.2). First that loads wins.
//      (A bad mirror can stall but can't forge — the CID is the hash, §3.3.)
//   2. tombstone — if every source fails, replace the media with a "resting" placeholder +
//      "Notify me when online", which polls in the background and swaps the media back in when
//      a provider appears (§7).
//
// A global, debounced observer adopts any <img>/<video> whose src points at the local gateway,
// so feed / thread / profile / the read-from-IPFS modal are all covered with one install.

const DEFAULTS = {
  publicGateways: ['https://dweb.link/ipfs/', 'https://ipfs.io/ipfs/', 'https://4everland.io/ipfs/'],
  localTimeout: 9000,    // ms to give the local gateway (direct Bitswap) before trying mirrors
  mirrorTimeout: 5000,   // ms per public gateway
  locatingDelay: 500,    // ms before showing the "Locating media…" box (skips a flash on fast loads)
  retryInterval: 20000,  // ms between background retries after "Notify me when online"
  retryMax: 45           // give up watching after ~15 min
}
// Tests (and power users) can override before media renders.
const cfg = (k) => (window.__nosdagMirror && window.__nosdagMirror[k] != null) ? window.__nosdagMirror[k] : DEFAULTS[k]

const localGw = () => window.nosdag?.kubo?.gateway || 'http://127.0.0.1:8201/ipfs/'
const gatewaysFor = () => [localGw(), ...cfg('publicGateways')]

/** pull { cid, frag } out of a `.../ipfs/<CID>[#frag]` URL */
function parseIpfsUrl (url) {
  const m = String(url || '').match(/\/ipfs\/([A-Za-z0-9]+)(#[^?\s]*)?/)
  return m ? { cid: m[1], frag: m[2] || '' } : null
}

const isImg = (el) => el.tagName === 'IMG'
const loaded = (el) => isImg(el) ? (el.complete && el.naturalWidth > 0) : (el.readyState >= 2)
const errored = (el) => isImg(el) && el.complete && el.naturalWidth === 0 && !!el.getAttribute('src')

function setSrc (el, url) {
  el.setAttribute('src', url)
  if (!isImg(el)) { try { el.load() } catch { /* video */ } }
}

/** A "Locating media…" box shown while we wait, so the spot is never blank. */
function makeLocating (cid) {
  const ph = document.createElement('div')
  ph.className = 'nd-locating'
  ph.dataset.cid = cid
  ph.innerHTML = '<span class="nd-locating-dot"></span><span class="nd-locating-text nd-mono">Locating media…</span>'
  return ph
}

/** Load all urls in PARALLEL; resolve the first that loads, else null (all errored or timed out). */
function raceImages (urls, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let pending = urls.length
    const finish = (val) => { if (!settled) { settled = true; resolve(val) } }
    const to = setTimeout(() => finish(null), timeoutMs)
    urls.forEach((url) => {
      const img = new Image()
      img.onload = () => { clearTimeout(to); finish(url) }
      img.onerror = () => { if (--pending === 0) { clearTimeout(to); finish(null) } }
      img.src = url
    })
  })
}

/**
 * Drive one media element: local gateway → (parallel) public-gateway race → tombstone, with a
 * visible "locating" state the whole time (an unloaded <img> is zero-height/invisible, which is
 * why a failing image used to leave no indication at all).
 */
function manage (el) {
  if (el.dataset.ndMirror) return
  const parsed = parseIpfsUrl(el.getAttribute('src'))
  if (!parsed) return
  el.dataset.ndMirror = '1'
  const { cid, frag } = parsed

  if (loaded(el)) return // already showing — nothing to do

  // Show a "Locating media…" box if it hasn't loaded promptly (hide the still-loading element
  // behind it so there's a single visible slot that becomes the image OR the tombstone).
  let ph = null
  let resolved = false
  const showTimer = setTimeout(() => {
    if (resolved) return
    ph = makeLocating(cid)
    try { el.insertAdjacentElement('beforebegin', ph); el.style.display = 'none' } catch { ph = null }
  }, cfg('locatingDelay'))

  const finishOk = () => {                         // a source served it → reveal the element
    if (resolved) return
    resolved = true; clearTimeout(showTimer)
    if (ph) { ph.remove(); ph = null }
    el.style.display = ''
  }
  const finishTomb = () => {                       // every source failed → resting placeholder
    if (resolved) return
    resolved = true; clearTimeout(showTimer)
    const ts = buildTombstone(cid, frag)
    if (ph) { ph.replaceWith(ts) } else { try { el.insertAdjacentElement('beforebegin', ts) } catch { /* gone */ } }
    try { el.remove() } catch { /* gone */ }
  }

  // Phase 2 — local gateway failed: race ALL public gateways at once; first to load wins.
  const tryMirrors = async () => {
    const urls = cfg('publicGateways').map((gw) => gw + cid + frag)
    const winner = urls.length ? await raceImages(urls, cfg('mirrorTimeout')) : null
    if (resolved) return
    if (!winner) { finishTomb(); return }
    el.addEventListener('load', finishOk, { once: true })
    el.addEventListener('loadeddata', finishOk, { once: true })
    el.addEventListener('error', finishTomb, { once: true }) // unlikely — the probe just loaded it
    setSrc(el, winner)                             // bytes already cached by the winning probe → instant
  }

  // Phase 1 — the local gateway (element's current src), with a watchdog.
  let localTimer
  const detachLocal = () => {
    clearTimeout(localTimer)
    el.removeEventListener('load', onLocalLoad)
    el.removeEventListener('loadeddata', onLocalLoad)
    el.removeEventListener('error', onLocalError)
  }
  const onLocalLoad = () => { detachLocal(); finishOk() }
  const onLocalError = () => { detachLocal(); tryMirrors() }

  if (errored(el)) { tryMirrors(); return } // local already failed before we attached
  el.addEventListener('load', onLocalLoad, { once: true })
  el.addEventListener('loadeddata', onLocalLoad, { once: true })
  el.addEventListener('error', onLocalError, { once: true })
  localTimer = setTimeout(() => { detachLocal(); tryMirrors() }, cfg('localTimeout'))
}

/** Build the §7 "resting" placeholder element (with its Notify-me retry wired). */
function buildTombstone (cid, frag) {
  const ts = document.createElement('div')
  ts.className = 'nd-tombstone'
  ts.dataset.cid = cid
  if (frag) ts.dataset.frag = frag
  ts.innerHTML =
    '<div class="nd-tombstone-glyph">☾</div>' +
    '<div class="nd-tombstone-text">This media is resting.' +
    '<span class="nd-tombstone-sub">The poster and their providers are offline.</span></div>' +
    '<button type="button" class="nd-tombstone-retry">Notify me when online</button>' +
    `<div class="nd-tombstone-cid nd-mono">${cid.slice(0, 12)}…${cid.slice(-6)}</div>`
  ts.querySelector('.nd-tombstone-retry').addEventListener('click', (e) => {
    e.preventDefault()
    startWatching(ts, cid, frag)
  })
  return ts
}

/** Replace a media element with the resting placeholder (used by the headless smoke). */
function installTombstone (el, cid, frag) {
  const ts = buildTombstone(cid, frag)
  try { el.replaceWith(ts) } catch { /* gone */ }
  return ts
}

/** Probe every gateway (local + public) for the CID in parallel; first to load wins, else null. */
function probe (cid, frag) {
  return raceImages(gatewaysFor().map((gw) => gw + cid + frag), cfg('mirrorTimeout'))
}

/** Background watch after the user clicks "Notify me when online". */
function startWatching (ts, cid, frag) {
  const btn = ts.querySelector('.nd-tombstone-retry')
  if (ts.dataset.watching) return
  ts.dataset.watching = '1'
  btn.disabled = true
  let attempts = 0
  const tick = async () => {
    if (!ts.isConnected) return // navigated away — stop
    attempts++
    btn.textContent = '◌ Watching for the poster…'
    const url = await probe(cid, frag)
    if (url) { swapInMedia(ts, url); return }
    if (attempts >= cfg('retryMax')) { btn.disabled = false; btn.textContent = 'Try again'; delete ts.dataset.watching; return }
    setTimeout(tick, cfg('retryInterval'))
  }
  tick()
}

/** A provider appeared — replace the tombstone with the recovered image. */
function swapInMedia (ts, url) {
  const img = document.createElement('img')
  img.className = 'nd-recovered-media'
  img.alt = ''
  img.src = url
  img.dataset.ndMirror = '1' // already resolved to a working source
  try { ts.replaceWith(img) } catch { /* gone */ }
  try { window.NostrUtils?.showNotification?.('Resting media is back online', 'success') } catch { /* ignore */ }
}

// ---- global, debounced adoption of local-gateway media ---------------------
let scheduled = false
function scan () {
  scheduled = false
  const base = localGw()
  const sel = `img[src^="${base}"]:not([data-nd-mirror]), video[src^="${base}"]:not([data-nd-mirror])`
  let nodes
  try { nodes = document.querySelectorAll(sel) } catch { return }
  nodes.forEach(manage)
}
function schedule () { if (!scheduled) { scheduled = true; setTimeout(scan, 150) } }

export function initMirrorFetch () {
  if (typeof window === 'undefined' || window.__nosdagMirrorInit) return
  window.__nosdagMirrorInit = true
  schedule() // adopt anything already on screen
  try {
    // childList catches inserted media; attributeFilter:['src'] catches a deferred src swap
    // (e.g. a future blurhash placeholder resolving to the gateway URL). Loop-safe: managed
    // elements carry data-nd-mirror and are skipped by scan().
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src']
    })
  } catch { /* no DOM */ }
}

// expose for the headless smoke + manual triggering
if (typeof window !== 'undefined') {
  window.nosdagMirror = { initMirrorFetch, scan, probe, manage, installTombstone, startWatching }
}

// self-install on import (idempotent)
initMirrorFetch()
