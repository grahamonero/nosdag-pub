// Nosdag Phase 5 · Slice 5 — smart-publish (design §2.5 / §3.5).
//
// Every Nosdag note is published so that ANY Nostr client can render it. Media lives on the
// author's IPFS node as ipfs://<CID>; right before signing we rewrite that ref — in BOTH the
// kind:1 body and the NIP-92 imeta `url` — to a public IPFS-gateway HTTPS URL. Vanilla clients
// (Damus / Amethyst / Primal / snort) then render the text + media natively. The gateway URL
// still embeds the CID, so content-addressing / sovereignty survive and the signature covers it.
// Nosdag's OWN renderer re-points that URL at the user's local node (utils.parseContent) so Nosdag
// keeps serving the CID P2P. The DAG envelope + nosdag:head pointer + local pin are UNCHANGED.
//
// No toggle, no per-account mode (user decision 2026-06-07, option C): smart-publish is always on —
// reach everywhere + content-addressed + Nosdag-local P2P, nothing for the user to misconfigure.
// Pure renderer-side, no new on-wire format; applied at EVERY signing path (notes + replies).

// Baked permanently into published events (user decision 2026-06-07): a neutral public gateway —
// no Nosmero coupling, resolves any CID over the DHT from whoever is seeding (the author). The
// matching host is also recognised on render in utils.parseContent (keep the two in sync).
const GATEWAY = 'https://dweb.link/ipfs/'

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogg'
}

// ---------- the rewrite ----------
// ipfs://<CID>#media.jpg  →  https://dweb.link/ipfs/<CID>?filename=media.jpg
// The ?filename=…<ext> tail keeps a real extension on the URL so extension-sniffing clients (older
// Damus) still detect the image; NIP-92-aware clients use the imeta `m` mime. It's also a genuine
// IPFS-gateway parameter (Content-Disposition), so it never changes what the gateway serves.
function gatewayFromIpfs (ref, mimeExt) {
  const m = String(ref).match(/^ipfs:\/\/([A-Za-z0-9]+)(?:#[^\s<]*?\.([A-Za-z0-9]+))?/i)
  if (!m) return ref
  const cid = m[1]
  const ext = (m[2] || mimeExt || '').toLowerCase()
  return `${GATEWAY}${cid}${ext ? `?filename=media.${ext}` : ''}`
}

/**
 * Rewrite an event template for interop publishing: every ipfs://<CID> ref in the body and the
 * NIP-92 imeta `url` becomes its public-gateway HTTPS URL. Always applied (no mode); a no-op when
 * the note carries no ipfs:// ref. Call right after Media.addImetaTags(), before sign — mutates +
 * returns the template.
 */
export function applyInterop (eventTemplate) {
  if (!eventTemplate) return eventTemplate

  // 1. body: rewrite every ipfs://<CID>[#frag] occurrence to its gateway URL
  if (typeof eventTemplate.content === 'string' && eventTemplate.content.indexOf('ipfs://') !== -1) {
    eventTemplate.content = eventTemplate.content.replace(
      /ipfs:\/\/[A-Za-z0-9]+(?:#[^\s<]*)?/gi,
      (ref) => gatewayFromIpfs(ref)
    )
  }

  // 2. imeta tags: rewrite the `url ipfs://…` element so NIP-92 carries the gateway URL (matching
  //    the body — clients key the metadata to the body URL). The url addImetaTags built has no
  //    #frag, so recover the extension from the sibling `m <mime>`.
  if (Array.isArray(eventTemplate.tags)) {
    for (const tag of eventTemplate.tags) {
      if (tag[0] !== 'imeta') continue
      const mEl = tag.find((v) => typeof v === 'string' && v.startsWith('m '))
      const mimeExt = mEl ? MIME_EXT[mEl.slice(2).trim().toLowerCase()] : ''
      for (let i = 1; i < tag.length; i++) {
        if (typeof tag[i] === 'string' && tag[i].startsWith('url ipfs://')) {
          tag[i] = 'url ' + gatewayFromIpfs(tag[i].slice(4), mimeExt)
        }
      }
    }
  }
  return eventTemplate
}
