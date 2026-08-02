// media-transcode — phone-video compatibility + metadata hygiene for note attachments.
//
// Phone cameras record ISO-BMFF containers (.mov on iPhone, .mp4 on Android) that carry two
// problems for a note attachment:
//   1. METADATA: GPS coordinates (`©xyz` / Apple's location atoms in `udta`/`meta`), creation
//      timestamps and device make/model — a location leak that Tor mode can't hide, because
//      it rides inside the published file itself. The renderer's canvas path strips images
//      only; video must be stripped here.
//   2. CODEC: HEVC/H.265 (the iPhone/Android "high efficiency" default) doesn't decode in
//      most viewers' browsers — a published HEVC note is a dead player for them. Only a
//      re-encode to H.264 fixes that, which needs ffmpeg.
//
// So: every ISO-BMFF video gets metadata stripped (pure JS — no dependency), and HEVC-family
// codecs additionally require ffmpeg for the H.264 transcode (which strips by construction
// via -map_metadata -1). Electron-free like the rest of lib/ so the smoke drives it headless.

import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'

// Codecs mainstream browsers decode (Chromium/Firefox baseline). Everything else that shows
// up in a video track — hvc1/hev1 (HEVC), dvh1/dvhe (Dolby Vision), ap4h/apch/… (ProRes),
// mp4v/s263 (legacy) — needs the H.264 transcode to be watchable by other people.
const WEB_SAFE_VIDEO = new Set(['avc1', 'avc3', 'vp09', 'av01'])

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])

// Iterate ISO-BMFF boxes in [start, end). Yields { type, start, size, payload }.
// Handles 64-bit largesize (size==1) and to-end (size==0); stops at anything malformed.
function * boxes (bytes, start, end) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = start
  while (o + 8 <= end) {
    let size = dv.getUint32(o)
    const type = fourcc(bytes, o + 4)
    let hdr = 8
    if (size === 1) {
      if (o + 16 > end) return
      size = Number(dv.getBigUint64(o + 8))
      hdr = 16
    } else if (size === 0) {
      size = end - o
    }
    if (size < hdr || o + size > end) return
    yield { type, start: o, size, payload: o + hdr }
    o += size
  }
}

/**
 * Identify the container and the video-track sample-entry codecs.
 * @returns {{ container: 'iso-bmff'|'webm'|'ogg'|null, videoCodecs: Set<string> }}
 */
export function sniffVideo (bytes) {
  const out = { container: null, videoCodecs: new Set() }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    out.container = 'webm' // EBML magic (webm/mkv)
    return out
  }
  if (bytes.length >= 4 && fourcc(bytes, 0) === 'OggS') {
    out.container = 'ogg'
    return out
  }
  for (const box of boxes(bytes, 0, bytes.length)) {
    if (box.type === 'ftyp') out.container = 'iso-bmff'
    if (box.type !== 'moov') continue
    out.container = 'iso-bmff'
    for (const trak of boxes(bytes, box.payload, box.start + box.size)) {
      if (trak.type !== 'trak') continue
      for (const mdia of boxes(bytes, trak.payload, trak.start + trak.size)) {
        if (mdia.type !== 'mdia') continue
        // handler type tells video tracks from audio/metadata tracks — stsd entries in an
        // audio track (mp4a…) must not trip the codec check
        let handler = null
        const stsdEntries = []
        for (const inner of boxes(bytes, mdia.payload, mdia.start + mdia.size)) {
          if (inner.type === 'hdlr' && inner.payload + 12 <= inner.start + inner.size) {
            handler = fourcc(bytes, inner.payload + 8)
          }
          if (inner.type !== 'minf') continue
          for (const stbl of boxes(bytes, inner.payload, inner.start + inner.size)) {
            if (stbl.type !== 'stbl') continue
            for (const stsd of boxes(bytes, stbl.payload, stbl.start + stbl.size)) {
              if (stsd.type !== 'stsd') continue
              // stsd payload: version/flags (4) + entry_count (4), then sample entries (boxes)
              for (const entry of boxes(bytes, stsd.payload + 8, stsd.start + stsd.size)) {
                stsdEntries.push(entry.type)
              }
            }
          }
        }
        if (handler === 'vide') for (const t of stsdEntries) out.videoCodecs.add(t)
      }
    }
  }
  return out
}

/** true when any video track's codec won't decode in mainstream viewers */
export function needsTranscode (videoCodecs) {
  for (const c of videoCodecs) if (!WEB_SAFE_VIDEO.has(c)) return true
  return false
}

/**
 * Strip metadata from an ISO-BMFF file IN PLACE on a copy: every `udta`, `meta` and `uuid`
 * box (top-level and inside moov/trak/mdia/minf/stbl — where GPS, device tags and XMP live)
 * is renamed to `free` AND its payload zeroed — sizes never change, so chunk offsets
 * (stco/co64) stay valid and the file plays exactly as before. Creation/modification
 * timestamps in mvhd/tkhd/mdhd are zeroed too. Renaming without zeroing would keep the GPS
 * bytes in the file; zeroing is what actually removes them.
 */
const STRIP_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
const STRIP_BLANK = new Set(['udta', 'meta', 'uuid'])
const STRIP_TIMED = new Set(['mvhd', 'tkhd', 'mdhd'])

// The recursive patch walk both strip variants share — mutates `out` in place.
function patchBoxesInPlace (out, start, end) {
  const blank = (box) => {
    out[box.start + 4] = 0x66; out[box.start + 5] = 0x72; out[box.start + 6] = 0x65; out[box.start + 7] = 0x65 // 'free'
    out.fill(0, box.payload, box.start + box.size)
  }
  for (const box of boxes(out, start, end)) {
    if (STRIP_BLANK.has(box.type)) { blank(box); continue }
    if (STRIP_TIMED.has(box.type) && box.payload + 4 <= box.start + box.size) {
      const version = out[box.payload]
      const width = version === 1 ? 8 : 4
      const t0 = box.payload + 4 // creation_time, then modification_time
      if (t0 + 2 * width <= box.start + box.size) out.fill(0, t0, t0 + 2 * width)
    }
    if (STRIP_CONTAINERS.has(box.type)) patchBoxesInPlace(out, box.payload, box.start + box.size)
  }
}

export function stripIsoBmffMetadata (bytes) {
  const out = bytes.slice()
  patchBoxesInPlace(out, 0, out.length)
  return out
}

// Everything metadata-bearing lives in moov (the index) or small top-level udta/meta/uuid
// boxes — moov stays small even for multi-GB files, so the file-based paths buffer it and
// nothing else. A "moov" bigger than this is malformed; skip rather than balloon memory.
const MOOV_MAX_BYTES = 256 * 1024 * 1024

// Read one box header at `offset` from an open FileHandle — the fd twin of boxes(),
// same yielded shape. Returns null at EOF or on anything malformed.
async function readBoxHeaderAt (fh, offset, fileSize) {
  if (offset + 8 > fileSize) return null
  const hdr = Buffer.alloc(16)
  const { bytesRead } = await fh.read(hdr, 0, Math.min(16, fileSize - offset), offset)
  if (bytesRead < 8) return null
  let size = hdr.readUInt32BE(0)
  const type = fourcc(hdr, 4)
  let hdrLen = 8
  if (size === 1) {
    if (bytesRead < 16) return null
    size = Number(hdr.readBigUInt64BE(8))
    hdrLen = 16
  } else if (size === 0) {
    size = fileSize - offset
  }
  if (size < hdrLen || offset + size > fileSize) return null
  return { type, start: offset, size, payload: offset + hdrLen }
}

/**
 * File-based sniffVideo: walks top-level boxes via fd reads — mdat (the bulk) is seeked
 * over, never read — and analyses the buffered moov with the same in-memory walk.
 * Same result shape as sniffVideo.
 */
export async function sniffVideoFile (filePath) {
  const out = { container: null, videoCodecs: new Set() }
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const { size: fileSize } = await fh.stat()
    const magic = Buffer.alloc(4)
    const { bytesRead } = await fh.read(magic, 0, 4, 0)
    if (bytesRead >= 4) {
      if (magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3) { out.container = 'webm'; return out }
      if (fourcc(magic, 0) === 'OggS') { out.container = 'ogg'; return out }
    }
    let o = 0
    for (let box; (box = await readBoxHeaderAt(fh, o, fileSize)); o = box.start + box.size) {
      if (box.type === 'ftyp') out.container = 'iso-bmff'
      if (box.type === 'moov' && box.size <= MOOV_MAX_BYTES) {
        const moov = Buffer.alloc(box.size)
        await fh.read(moov, 0, box.size, box.start)
        // the buffer's single top-level box IS moov — sniffVideo's walk takes it from here
        const sub = sniffVideo(new Uint8Array(moov.buffer, moov.byteOffset, moov.length))
        if (sub.container) out.container = sub.container
        for (const c of sub.videoCodecs) out.videoCodecs.add(c)
      }
    }
    return out
  } finally { await fh.close() }
}

/**
 * File-based stripIsoBmffMetadata: copy src → dst, then patch dst IN PLACE — sound because
 * the strip never changes sizes. Top-level udta/meta/uuid are renamed+zeroed with chunked
 * writes; moov is buffered, patched by the shared walk, and written back. mdat is never read,
 * so memory stays bounded regardless of file size.
 */
export async function stripIsoBmffMetadataFile (srcPath, dstPath) {
  await fs.promises.copyFile(srcPath, dstPath)
  const fh = await fs.promises.open(dstPath, 'r+')
  try {
    const { size: fileSize } = await fh.stat()
    let o = 0
    for (let box; (box = await readBoxHeaderAt(fh, o, fileSize)); o = box.start + box.size) {
      if (STRIP_BLANK.has(box.type)) {
        await fh.write(Buffer.from('free', 'ascii'), 0, 4, box.start + 4)
        const zeros = Buffer.alloc(Math.min(1 << 20, box.start + box.size - box.payload))
        for (let p = box.payload; p < box.start + box.size; p += zeros.length) {
          await fh.write(zeros, 0, Math.min(zeros.length, box.start + box.size - p), p)
        }
      } else if (box.type === 'moov' && box.size <= MOOV_MAX_BYTES) {
        const moov = Buffer.alloc(box.size)
        await fh.read(moov, 0, box.size, box.start)
        const view = new Uint8Array(moov.buffer, moov.byteOffset, moov.length)
        patchBoxesInPlace(view, 0, view.length)
        await fh.write(moov, 0, moov.length, box.start)
      }
    }
  } finally { await fh.close() }
}

/** Locate an ffmpeg binary: $FFMPEG_BIN, else PATH, else the mac package-manager dirs
 * (GUI-launched mac apps get launchd's minimal PATH, which lacks /opt/homebrew/bin). */
export function resolveFfmpeg (env = process.env) {
  const macDirs = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg']
    : []
  const candidates = [env.FFMPEG_BIN, 'ffmpeg', ...macDirs].filter(Boolean)
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' })
      return bin
    } catch { /* not this one */ }
  }
  return null
}

/** ffmpeg wall-clock allowance scaled to input size — a long 4K transcode is legitimately
 * slow; a hung ffmpeg still dies. ~10 min floor + 2 s per MiB (≈ 2¾ h for a 4.8 GB file). */
export function transcodeTimeoutMs (sizeBytes) {
  return 10 * 60_000 + Math.ceil((sizeBytes || 0) / (1 << 20)) * 2000
}

/**
 * ffmpeg with full metadata stripping (-map_metadata -1, no chapters, bitexact so no encoder
 * tag is written), file → file — ffmpeg streams from disk, so file size never touches memory.
 *   reencode: true  → H.264/AAC in mp4 (+faststart) — the HEVC/ProRes/legacy cure
 *   reencode: false → stream copy in the given container format — a strip-only remux
 * Caller owns both paths (including outPath cleanup on failure).
 */
export async function ffmpegStripFile ({ ffmpegBin, inPath, outPath, reencode, format = 'mp4', timeoutMs = 10 * 60_000 }) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inPath,
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact',
    ...(reencode
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']
      : ['-c', 'copy']),
    '-f', format === 'mov' ? 'mp4' : format, // mov input re-containers to mp4 (same family)
    outPath
  ]
  await new Promise((resolve, reject) => {
    execFile(ffmpegBin, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${String(stderr || err.message).trim().slice(0, 300)}`))
      else resolve()
    })
  })
}

/** The buffered variant (images-scale inputs; the smoke drives it): temp files in tmpDir,
 * always removed. Multi-GB attachments take the file→file path above instead. */
export async function ffmpegStrip ({ ffmpegBin, bytes, tmpDir, reencode, format = 'mp4', timeoutMs = 10 * 60_000 }) {
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const inPath = path.join(tmpDir, `nosdag-media-in-${stamp}`)
  const outPath = path.join(tmpDir, `nosdag-media-out-${stamp}.${format}`)
  try {
    await fs.promises.writeFile(inPath, bytes)
    await ffmpegStripFile({ ffmpegBin, inPath, outPath, reencode, format, timeoutMs })
    return new Uint8Array(await fs.promises.readFile(outPath))
  } finally {
    fs.promises.rm(inPath, { force: true }).catch(() => {})
    fs.promises.rm(outPath, { force: true }).catch(() => {})
  }
}
