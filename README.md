# Nosdag

A peer-to-peer desktop social network. Your identity is a Nostr keypair; relays carry only
kilobyte-sized pointers and signaling. Everything else — your notes, media, and history —
lives on an **IPFS node embedded in the app**, owned and served from your own machine.

- **Notes as a signed chain** — each note links to your previous one; one pin of the latest
  head replicates your whole history. Anyone can verify it against your key.
- **Monero tips built in** — an embedded XMR wallet; tip any note or profile directly.
  No middlemen, no custodians.
- **Anonymous mode** — run the whole app over Tor: a Helia/libp2p node dialing other
  users' onion services, onion relays for signaling, and a fail-closed kill-switch.
- **Own your availability** — link a remote pinning service (Cloud Bridge), host the
  accounts you follow, or export your entire history as a single `.car` file.

## Requirements

- **Node.js 22.12+** (`nvm use` picks it up from `.nvmrc`)
- `npm install` needs network access — it downloads the Electron runtime and the bundled
  Kubo (IPFS) binary
- Optional: **ffmpeg** on PATH — required to attach phone video (HEVC is transcoded to
  H.264 so every viewer can play it)
- Optional: **tor** — required for anonymous mode. If it isn't on PATH, launch with
  `TOR_BIN=/path/to/tor`. Already run Tor yourself (a tor router, Whonix-style gateway,
  or system tor)? Point anonymous mode at it from the Anonymous Mode page — outbound-only:
  without an onion service your notes can't be served over Tor while it's in use

## Run

```bash
npm install
npm start
```

On first launch you choose a network posture: **clearnet** (bundled Kubo node) or
**anonymous** (everything over Tor). Anonymous mode is experimental — read the
disclosures on the Anonymous Mode page before relying on it.

## Back up your key

Your Nostr private key (nsec) **is** your account. There is no recovery service.
Settings → Your data → Private Key lets you export it — do that before anything else,
and store it offline.

## Ports

The embedded node uses API `5201`, gateway `8201`, swarm `4201` — chosen so it never
conflicts with a standalone IPFS Desktop installation.

## License

MIT — see [LICENSE](LICENSE).
