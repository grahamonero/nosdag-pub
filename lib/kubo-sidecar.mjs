// kubo-sidecar — the genuinely-new Electron-main lifecycle code (build scope §4.1).
//
// Deliberately ELECTRON-FREE: it takes binPath + ipfsPath as plain config, so the
// spawn/init/supervise/shutdown logic can be exercised headlessly (smoke-sidecar.mjs)
// without a display. main.mjs injects the Electron-specific values
// (kubo.path() with the asar-unpack rewrite, app.getPath('userData')).
//
// It manages the daemon; the RPC *surface* on top of it is lib/kubo-manager.mjs
// (the §1.5 interface, graduated verbatim from the harness).

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export class KuboSidecar {
  constructor ({
    binPath,
    ipfsPath,
    apiPort = 5201,        // Nosdag-specific ports → never collide with a user's own IPFS Desktop (5001/8080/4001)
    gatewayPort = 8201,
    swarmPort = 4201,
    maxRestarts = 3,
    onLog = () => {}
  }) {
    this.binPath = binPath
    this.ipfsPath = ipfsPath
    this.apiPort = apiPort
    this.gatewayPort = gatewayPort
    this.swarmPort = swarmPort
    this.maxRestarts = maxRestarts
    this.onLog = onLog
    this.proc = null
    this.pid = null            // persists past this.proc so exit handlers can still SIGKILL
    this.stopping = false
    this.restarts = 0
  }

  #ipfs (args) {
    return execFileSync(this.binPath, args, {
      env: { ...process.env, IPFS_PATH: this.ipfsPath },
      stdio: 'pipe'
    }).toString()
  }

  /** Init the repo once, then pin our config (ports, no API CORS — main drives RPC, §4.2). */
  init () {
    if (!fs.existsSync(path.join(this.ipfsPath, 'config'))) {
      fs.mkdirSync(this.ipfsPath, { recursive: true })
      this.onLog(`initializing repo at ${this.ipfsPath}`)
      this.#ipfs(['init']) // plain init: NO server profile (its AddrFilters would block local dials)
    }
    const cfgFile = path.join(this.ipfsPath, 'config')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    cfg.Addresses.API = `/ip4/127.0.0.1/tcp/${this.apiPort}`
    cfg.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${this.gatewayPort}`
    cfg.Addresses.Swarm = [`/ip4/0.0.0.0/tcp/${this.swarmPort}`, `/ip6/::/tcp/${this.swarmPort}`]
    // Connectivity per build scope §4.4 (clearnet default). Routing stays "auto" so it's a real node.
    cfg.Swarm = cfg.Swarm || {}
    cfg.Swarm.EnableHolePunching = true
    cfg.Swarm.RelayClient = { ...(cfg.Swarm.RelayClient || {}), Enabled: true }
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  }

  /** init → spawn → wait until the RPC answers. Resolves once the daemon is healthy. */
  async start () {
    this.init()
    this.#spawn()
    await this.waitReady()
    this.onLog(`daemon ready on 127.0.0.1:${this.apiPort}`)
    return this
  }

  #spawn () {
    this.onLog('starting daemon')
    // --enable-gc: periodic garbage collection reclaims UNPINNED blocks once the repo passes its GC
    // watermark. Without it, blocks fetched-but-not-pinned (browsing others' notes, and the bounded walk
    // altruistic-pin does for accounts it then declines to host) accumulate forever — the disk-fill half
    // of the pin-bomb finding. Safe: everything we intend to keep is pinned (your own head is recursive-
    // pinned on publish, media on add, hosted accounts on host), and pinned blocks are never collected.
    // (Security review 2026-07-03, H-B.)
    this.proc = spawn(this.binPath, ['daemon', '--migrate=true', '--enable-gc'], {
      env: { ...process.env, IPFS_PATH: this.ipfsPath },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.pid = this.proc.pid
    this.proc.stdout.on('data', (d) => this.onLog(`[kubo] ${d.toString().trim()}`))
    this.proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.onLog(`[kubo:err] ${s}`) })
    this.proc.on('exit', (code, sig) => {
      this.proc = null
      if (this.stopping) return
      this.onLog(`daemon exited unexpectedly (code=${code} sig=${sig})`)
      if (this.restarts < this.maxRestarts) {
        this.restarts++
        this.onLog(`supervising: restart ${this.restarts}/${this.maxRestarts}`)
        this.#spawn()
      } else {
        this.onLog(`gave up after ${this.maxRestarts} restarts`)
      }
    })
  }

  async waitReady (tries = 120, delayMs = 500) {
    const { create } = await import('kubo-rpc-client')
    const client = create({ url: `http://127.0.0.1:${this.apiPort}` })
    for (let i = 0; i < tries; i++) {
      try { await client.id(); return } catch { await new Promise((r) => setTimeout(r, delayMs)) }
    }
    throw new Error(`kubo daemon did not become ready on :${this.apiPort}`)
  }

  /** Is `pid` still a live process? signal 0 is an existence probe (EPERM = exists, not ours). */
  #alive (pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
  }

  /**
   * Stop the daemon and DO NOT RESOLVE until it is actually dead. Graceful SIGTERM first (lets
   * kubo flush its repo), polling for a clean exit, then escalate to SIGKILL and confirm. This is
   * the hard guarantee that closing the app takes the node offline — no orphaned seeder.
   */
  async stop ({ graceMs = 2500 } = {}) {
    this.stopping = true
    const pid = this.pid
    this.proc = null
    if (!this.#alive(pid)) { this.pid = null; return }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    try { process.kill(pid, 'SIGTERM') } catch {}
    const start = Date.now()
    while (Date.now() - start < graceMs) {
      if (!this.#alive(pid)) { this.pid = null; return } // exited gracefully
      await sleep(100)
    }
    this.onLog(`graceful stop timed out (${graceMs}ms) — SIGKILL pid ${pid}`)
    try { process.kill(pid, 'SIGKILL') } catch {}
    for (let i = 0; i < 40; i++) { // confirm death (up to ~2s)
      if (!this.#alive(pid)) { this.pid = null; return }
      await sleep(50)
    }
    this.onLog(`WARNING: pid ${pid} survived SIGKILL`)
    this.pid = null
  }

  /**
   * Synchronous last-ditch kill for process exit handlers (process.on('exit') can't await).
   * Guarantees the daemon can't orphan even if the async stop() never ran to completion.
   */
  killNowSync () {
    const pid = this.pid
    if (this.#alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    this.pid = null
  }
}
