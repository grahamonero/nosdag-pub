// store-reader — offline read access to the posture that is NOT running.
//
// The mixed-posture repair (migrate.mjs exportMissingCar) needs blocks from the other
// posture's store while only the current posture's node is live. Both stores are readable
// at rest:
//   • Helia — a plain FsBlockstore directory; open it read-only-in-spirit and get() blocks.
//   • Kubo  — the flatfs repo, read via the bundled `ipfs` CLI with IPFS_PATH pointed at it
//     (block get / dag export run offline against the repo when no daemon holds it).
// Callers MUST guarantee the corresponding daemon is stopped — true by construction: the
// clearnet posture reads the Helia store, the Tor posture reads the Kubo repo.
//
// Both readers expose the same surface:
//   getBlock(cid)  → Uint8Array           (throws when the store lacks the block)
//   closure(cid)   → async iterable of { cid, bytes } — the root plus every IPLD-reachable
//                    block under it (how chunked UnixFS media travels)
//   close()        → release resources
//
// Electron-free like the rest of lib/ so the migrate smoke drives it under plain Node.

import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { FsBlockstore } from 'blockstore-fs'
import { CarBlockIterator } from '@ipld/car'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import * as pbCodec from '@ipld/dag-pb'
import * as cborCodec from '@ipld/dag-cbor'

// IPLD links of one block, by codec — same walk tor-node.mjs uses for refsRecursive.
function linksOf (cid, bytes) {
  if (cid.code === raw.code) return []
  if (cid.code === pbCodec.code) return pbCodec.decode(bytes).Links.map((l) => l.Hash)
  if (cid.code === cborCodec.code) {
    const out = []
    const scan = (v) => {
      if (v == null) return
      const asCid = CID.asCID(v)
      if (asCid) { out.push(asCid); return }
      if (Array.isArray(v)) { v.forEach(scan); return }
      if (typeof v === 'object') Object.values(v).forEach(scan)
    }
    scan(cborCodec.decode(bytes))
    return out
  }
  return []
}

/** Open the at-rest Helia store (…/helia/blocks). */
export async function openHeliaReader (blocksPath) {
  const bs = new FsBlockstore(blocksPath)
  await bs.open()
  const getBlock = async (cid) => bs.get(CID.asCID(cid) ?? CID.parse(String(cid)))
  return {
    getBlock,
    closure: async function * (rootCid) {
      const queue = [CID.asCID(rootCid) ?? CID.parse(String(rootCid))]
      const seen = new Set()
      while (queue.length) {
        const cid = queue.shift()
        const k = cid.toString()
        if (seen.has(k)) continue
        seen.add(k)
        const bytes = await getBlock(cid)
        yield { cid, bytes }
        for (const l of linksOf(cid, bytes)) queue.push(l)
      }
    },
    close: () => bs.close()
  }
}

/**
 * Open the at-rest Kubo repo via the bundled binary. `scratchDir` stages `dag export` CARs
 * (media closures can be large — never buffered in memory).
 */
export function openKuboReader ({ binPath, ipfsPath, scratchDir }) {
  // A crashed daemon can leave a stale `api` file that would make the CLI dial a dead HTTP
  // API instead of opening the repo. The caller guarantees no daemon is running, so drop it.
  try { fs.unlinkSync(path.join(ipfsPath, 'api')) } catch { /* none — the normal case */ }
  const env = { ...process.env, IPFS_PATH: ipfsPath }

  const getBlock = (cid) => new Promise((resolve, reject) => {
    execFile(binPath, ['block', 'get', String(cid)], { env, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`kubo block get ${cid}: ${String(stderr || err.message).trim().slice(0, 200)}`))
        else resolve(new Uint8Array(stdout))
      })
  })

  return {
    getBlock,
    closure: async function * (rootCid) {
      // One offline `dag export` per root: the CLI walks the closure and streams a CAR,
      // which we iterate back off disk. Fails when the DAG is incomplete in the repo —
      // callers treat that as "this store doesn't have it".
      const carPath = path.join(scratchDir, `nosdag-reader-${process.pid}-${String(rootCid).slice(-8)}.car`)
      try {
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(carPath)
          const proc = spawn(binPath, ['dag', 'export', String(rootCid)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
          let errBuf = ''
          proc.stderr.on('data', (d) => { errBuf += d })
          proc.stdout.pipe(out)
          proc.on('error', reject)
          proc.on('close', (code) => {
            out.end()
            if (code === 0) resolve()
            else reject(new Error(`kubo dag export ${rootCid}: ${errBuf.trim().slice(0, 200) || 'exit ' + code}`))
          })
        })
        const it = await CarBlockIterator.fromIterable(fs.createReadStream(carPath))
        for await (const { cid, bytes } of it) yield { cid, bytes }
      } finally {
        fs.promises.rm(carPath, { force: true }).catch(() => {})
      }
    },
    close: () => {}
  }
}
