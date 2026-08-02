// Nosdag Phase 2 — media → IPFS.
//
// In the Nosdag shell, attached images/video go into the user's OWN local Kubo node (not a
// third-party HTTP host), and the note references them by a portable, signed `ipfs://<CID>`.
// On read, ipfs:// is rewritten to the local gateway so the existing image/video renderer shows
// it — Bitswap-backed, so it works on another machine that walked the note from IPFS.
//
//   write:  attach file → addFileToIpfs() → bytes to local Kubo → `ipfs://<CID>#media.jpg`
//   sign:   addImetaTags() derives NIP-92 imeta tags from the content (design §13.1)
//   render: rewriteIpfsMedia() swaps ipfs:// → http://127.0.0.1:8201/ipfs/ before parseContent

const GATEWAY = () => (window.nosdag?.kubo?.gateway || 'http://127.0.0.1:8201/ipfs/')

/** true when running inside the Nosdag Electron shell (a local Kubo node is reachable). */
export function inNosdagShell () {
  return !!window.nosdag?.kubo?.addMedia
}

// mime ↔ the fake extension the feed's image/video regex keys off (the #media.<ext> fragment).
const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogg',
  // QuickTime is ISO-BMFF like MP4 — deliberately labeled mp4 so the feed's video-URL
  // regex renders it and Chromium's demuxer (which plays H.264 .mov) picks it up.
  'video/quicktime': 'mp4'
}
const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg'
}

function extForFile (file) {
  const ext = MIME_TO_EXT[(file.type || '').toLowerCase()]
  if (ext) return ext
  // no/unknown MIME: fall back to the filename so a .mov still gets the video label
  if ((file.type || '').startsWith('video/') || /\.(mov|mp4|webm|ogg)$/i.test(file.name || '')) return 'mp4'
  return 'jpg' // sensible default
}

// Shared tail of both add routes: shape the IPC result into a note reference or a clear error.
function finishAdd (res, ext) {
  if (!res || res.error || !res.cid) {
    const detail = res?.error || 'addMedia returned no CID'
    // IPFS-or-fail (no centralized HTTP fallback): surface a clear, actionable message instead.
    if (/not ready/i.test(detail)) {
      const e = new Error('Your IPFS node is still starting — wait a moment and try again.')
      e.nodeStarting = true
      throw e
    }
    throw new Error('Could not add media to your IPFS node: ' + detail)
  }
  return `ipfs://${res.cid}#media.${ext}`
}

/**
 * Add a File/Blob to the local IPFS node and return a portable note reference.
 * @returns {Promise<string>} e.g. `ipfs://bafy…#media.jpg`
 * @throws if the bridge is missing or the add fails — the caller blocks the post (no HTTP fallback).
 */
export async function addFileToIpfs (file) {
  if (!inNosdagShell()) throw new Error('not in Nosdag shell')

  // Video runs through main before the add: GPS/device/timestamp metadata stripped (the
  // renderer's canvas path covers images only), and phone-camera HEVC transcoded to H.264 so
  // other people's players can actually decode it. An undecodable codec with no ffmpeg on
  // the machine throws — the caller blocks the note, same as the IPFS-or-fail rule.
  const isVideo = /^video\//i.test(file.type || '') || /\.(mov|mp4|m4v|webm|ogg|3gp)$/i.test(file.name || '')

  // A picked video streams by its OS path: only the path crosses IPC, prep + add run
  // file→file in main, so video size has no practical limit. Pasted/blob-backed files
  // have no path and fall through to the buffered route below.
  const kubo = window.nosdag.kubo
  if (isVideo && kubo.pathForFile && kubo.prepareMediaFile && kubo.addMediaFromPath) {
    const fsPath = kubo.pathForFile(file)
    if (fsPath) {
      let ext = extForFile(file)
      if (file.size > 100 * 1024 * 1024) window.NostrUtils?.showNotification?.('Preparing video — a large or HEVC file can take a while', 'info')
      const prep = await kubo.prepareMediaFile({ path: fsPath, name: file.name || '', type: file.type || '' })
      if (prep?.error) throw new Error(prep.error)
      if (prep?.ext) ext = prep.ext
      if (prep?.converted) window.NostrUtils?.showNotification?.('Video converted to H.264 for compatibility', 'info')
      return finishAdd(await kubo.addMediaFromPath({ path: prep.path }), ext)
    }
  }

  // Buffered route — images (canvas strip needs the bytes here) and pathless video.
  // strip EXIF/GPS the same way the HTTP path does (reuse the lifted Nosmero util).
  let toAdd = file
  try { if (window.NostrUtils?.stripImageMetadata) toAdd = await window.NostrUtils.stripImageMetadata(file) } catch { /* fail-open */ }

  let bytes = new Uint8Array(await toAdd.arrayBuffer())
  let ext = extForFile(toAdd)

  if (isVideo && kubo.prepareMedia) {
    const prep = await kubo.prepareMedia({ bytes, name: file.name || '', type: toAdd.type || '' })
    if (prep?.error) throw new Error(prep.error)
    if (prep?.bytes) bytes = prep.bytes instanceof Uint8Array ? prep.bytes : new Uint8Array(prep.bytes)
    if (prep?.ext) ext = prep.ext
    if (prep?.converted) window.NostrUtils?.showNotification?.('Video converted to H.264 for compatibility', 'info')
  }

  return finishAdd(await kubo.addMedia(bytes), ext)
}

/**
 * Rewrite `ipfs://<CID>[#frag]` references to the local gateway URL so the existing
 * image/video regex in parseContent renders them. No-op outside the shell / when absent.
 */
export function rewriteIpfsMedia (content) {
  if (typeof content !== 'string' || content.indexOf('ipfs://') === -1) return content
  return content.replace(/ipfs:\/\//gi, GATEWAY())
}

/**
 * Derive NIP-92 `imeta` tags from any `ipfs://<CID>#media.<ext>` refs in the content and push
 * them onto eventTemplate.tags (design §13.1). Mirrors Utils.addMentionTags — call right before
 * signing. Dedupes against imeta tags already present.
 */
export function addImetaTags (eventTemplate) {
  if (!eventTemplate || typeof eventTemplate.content !== 'string') return eventTemplate
  if (!Array.isArray(eventTemplate.tags)) eventTemplate.tags = []

  const have = new Set(
    eventTemplate.tags
      .filter((t) => t[0] === 'imeta')
      .map((t) => (t.find((v) => typeof v === 'string' && v.startsWith('url ')) || '').slice(4))
  )

  const re = /ipfs:\/\/([A-Za-z0-9]+)(?:#[^\s<]*?\.([a-z0-9]+))?/gi
  let m
  while ((m = re.exec(eventTemplate.content)) !== null) {
    const cid = m[1]
    const url = `ipfs://${cid}`
    if (have.has(url)) continue
    have.add(url)
    const mime = EXT_TO_MIME[(m[2] || '').toLowerCase()] || 'application/octet-stream'
    eventTemplate.tags.push(['imeta', `url ${url}`, `m ${mime}`])
  }
  return eventTemplate
}
