// media-gateway — the Tor-posture local media gateway. The renderer fetches ipfs media at
// 127.0.0.1:8201/ipfs/<cid> (the same URL shape Kubo's gateway serves in clearnet posture);
// Kubo is stopped in Tor mode, so this serves from the Helia node instead.
//
// Streams with byte-range support: chunks go to the socket as the exporter yields them, so
// media of any size serves in bounded memory (the old implementation reassembled the whole
// file per request, which capped attachment size at whatever fit in RAM). Range/206 also
// gives <video> seeking. Electron-free so the smoke drives it against a mock node.

import http from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const SIZE_TIMEOUT = 60_000 // root-block fetch (may be a remote Bitswap pull over Tor)
const STALL_TIMEOUT = 60_000 // per-chunk: a dead Tor fetch aborts instead of hanging the socket

export function sniffMime (b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length > 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return 'application/octet-stream'
}

// Single-range parse: null = no/unparseable header (serve 200 full — a server MAY ignore
// Range), 'unsatisfiable' = syntactically valid but outside the file (416), else {start,end}.
function parseRange (header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  if (!m[1]) {
    const n = Number(m[2]) // suffix form: the last N bytes
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

// First ≤16 bytes of the file — enough for sniffMime, one hot block once anything was served.
async function firstBytes (node, cid, signal) {
  const parts = []
  let n = 0
  for await (const chunk of node.catStream(cid, { offset: 0, length: 16, signal })) {
    parts.push(Buffer.from(chunk)); n += chunk.length
    if (n >= 16) break
  }
  return Buffer.concat(parts)
}

/**
 * @param {object} node  the tor-node surface — needs catStream(cid, {offset,length,signal})
 *                       and mediaSize(cid, {signal})
 * @param {number} port  loopback port to listen on (the app's gateway port, 8201)
 */
export function startMediaGateway (node, port) {
  const server = http.createServer(async (req, res) => {
    const m = (req.url || '').match(/^\/ipfs\/([^/?#]+)/)
    if (!m) { res.writeHead(404); res.end('not found'); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    const cid = m[1]

    let size
    try {
      size = await node.mediaSize(cid, { signal: AbortSignal.timeout(SIZE_TIMEOUT) })
    } catch { res.writeHead(502); res.end('media unavailable'); return }

    const range = parseRange(req.headers.range, size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1

    const ctrl = new AbortController()
    res.on('close', () => ctrl.abort())

    let mime = 'application/octet-stream'
    if (size > 0) {
      try { mime = sniffMime(await firstBytes(node, cid, ctrl.signal)) } catch { /* best-effort */ }
    }

    const headers = {
      'content-type': mime,
      'accept-ranges': 'bytes',
      'content-length': size === 0 ? 0 : end - start + 1,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=31536000, immutable'
    }
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === 'HEAD' || size === 0) { res.end(); return }

    let stall = setTimeout(() => ctrl.abort(), STALL_TIMEOUT)
    const guarded = (async function * () {
      try {
        for await (const chunk of node.catStream(cid, { offset: start, length: end - start + 1, signal: ctrl.signal })) {
          clearTimeout(stall)
          stall = setTimeout(() => ctrl.abort(), STALL_TIMEOUT)
          yield chunk
        }
      } finally { clearTimeout(stall) }
    })()
    try {
      await pipeline(Readable.from(guarded), res)
    } catch {
      res.destroy() // headers are already gone — a mid-stream failure can only cut the socket
    }
  })
  server.on('error', (e) => console.error('[media-gw]', e?.message || e))
  server.listen(port, '127.0.0.1')
  return server
}
