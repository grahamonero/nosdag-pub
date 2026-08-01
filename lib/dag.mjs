// dag — writer + reader/walk over the Nosdag DAG, expressed purely through the
// kubo-manager interface (§1.5). No direct Kubo calls here → ports unchanged to
// Electron main (renderer asks main over IPC; the logic is identical).

import { verifyEvent } from 'nostr-tools/pure'
import { CID } from 'multiformats/cid'
import { buildPost } from './envelope.mjs'

/**
 * WRITER: build a signed post + its envelope, store it on `node`, return its CID.
 * The returned CID is what the NEXT post's prevCid references and what the
 * head pointer (§13.2) advertises.
 */
export async function writePost (node, { sk, content, createdAt, prevCid = null, skipCids = [] }) {
  const { envelope, event } = buildPost({ sk, content, createdAt, prevCid, skipCids })
  const cid = await node.putEnvelope(envelope)
  return { cid, event }
}

const linkStr = (v) => {
  if (v == null) return null
  const c = CID.asCID(v)
  return c ? c.toString() : String(v)
}

/**
 * READER (2nd node): from the head CID alone, walk `prev` to the first post.
 * Each getEnvelope() may Bitswap-fetch from a connected peer if not local.
 * Enforces the consistency invariant: the IPLD link we follow MUST equal the
 * signed string tag, and every event signature MUST verify — else abort.
 *
 * @returns {Promise<string[]>} post contents, newest → oldest
 */
export async function walkHistory (node, headCid) {
  const contentsNewestFirst = []
  let cur = headCid
  let author = null // the head establishes the author; every hop must match (H6)

  while (cur) {
    const env = await node.getEnvelope(cur)                        // ← live Bitswap fetch if remote

    if (!verifyEvent(env.event)) {
      throw new Error(`signature failed at ${cur} — aborting walk`)
    }

    // author-continuity invariant (H6): a single author's DAG never crosses authors. A spliced
    // foreign envelope would otherwise pass per-hop sig + link==tag and be read as this history.
    if (author == null) author = env.event.pubkey
    else if (env.event.pubkey !== author) {
      throw new Error(`author mismatch at ${cur} (expected ${author} got ${env.event.pubkey}) — aborting walk`)
    }

    const prevTag = env.event.tags.find((t) => t[0] === 'prev')?.[1] ?? null
    const prevLink = linkStr(env.links?.prev)
    if (prevTag !== prevLink) {
      throw new Error(`link/tag mismatch at ${cur} (tag=${prevTag} link=${prevLink}) — aborting walk`)
    }

    contentsNewestFirst.push(env.event.content)
    cur = env.links?.prev ?? null
  }

  return contentsNewestFirst
}
