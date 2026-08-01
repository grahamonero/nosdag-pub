// tor-process — Tor lifecycle for anonymous mode (the Electron-main counterpart of
// kubo-sidecar). Deliberately ELECTRON-FREE: it takes binPath + dataDir as plain config
// so spawn/bootstrap/onion/shutdown can be exercised headlessly. main.mjs injects the
// Electron-specific paths (userData) and the bundled-vs-system `tor` binary.
//
// It spawns a dedicated `tor` with a v3 hidden service forwarding onion -> the local
// Helia ws listener, and a SOCKS port for outbound .onion dials. The Helia node (tor-node)
// rides this: outbound dials go through the SOCKS agent, inbound arrives via the onion.
//
// Same hard guarantee as the Kubo sidecar: Tor must never outlive the app. stop() escalates
// SIGTERM -> SIGKILL and confirms death; killNowSync() is the sync last-ditch for exit handlers.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class TorProcess {
  constructor ({
    binPath = process.env.TOR_BIN || 'tor',
    dataDir,
    socksPort = 9350,
    hiddenServices = [],   // [{ name, dir, virtPort, targetPort }]
    bootstrapTimeoutMs = 180_000,
    onLog = () => {},
    onExit = () => {}          // fired only if tor dies UNEXPECTEDLY after a clean start (H2 kill-switch)
  }) {
    this.binPath = binPath
    this.dataDir = dataDir
    this.socksPort = socksPort
    this.hiddenServices = hiddenServices
    this.bootstrapTimeoutMs = bootstrapTimeoutMs
    this.onLog = onLog
    this.onExit = onExit
    this.proc = null
    this.pid = null            // persists past this.proc so exit handlers can still SIGKILL
    this.stopping = false
    this.ready = false         // true once bootstrapped + onions read; gates the unexpected-exit hook
    this.onions = {}           // name -> <onion>.onion
    this.bootstrap = 0         // last bootstrap %
    this.log = ''
  }

  #writeTorrc () {
    fs.mkdirSync(this.dataDir, { recursive: true })
    for (const hs of this.hiddenServices) fs.mkdirSync(hs.dir, { recursive: true, mode: 0o700 })
    const torrc = [
      // IsolateDestAddr/IsolateDestPort: a separate Tor circuit per destination host:port, so one
      // relay/host can't correlate your traffic across a shared circuit (H1 hardening; complements
      // the Monero relay's own SOCKS-auth-isolated circuit).
      `SocksPort 127.0.0.1:${this.socksPort} IsolateDestAddr IsolateDestPort`,
      `DataDirectory ${this.dataDir}`,
      'Log notice stdout',
      ...this.hiddenServices.flatMap((hs) => [
        `HiddenServiceDir ${hs.dir}`,
        `HiddenServicePort ${hs.virtPort} 127.0.0.1:${hs.targetPort}`
      ])
    ].join('\n') + '\n'
    const torrcPath = path.join(this.dataDir, 'torrc')
    fs.writeFileSync(torrcPath, torrc)
    return torrcPath
  }

  /** spawn tor → wait for 100% bootstrap → read onion hostnames. Resolves once reachable. */
  async start () {
    const torrcPath = this.#writeTorrc()
    const env = { ...process.env }
    // For a downloaded tor (Expert Bundle / Tor Browser), its shared libs sit beside the binary.
    if (this.binPath !== 'tor') {
      const dir = path.dirname(path.resolve(this.binPath))
      env.LD_LIBRARY_PATH = dir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '')
    }
    this.stopping = false
    this.onLog('starting tor')
    this.proc = spawn(this.binPath, ['-f', torrcPath], { stdio: ['ignore', 'pipe', 'pipe'], env })
    this.pid = this.proc.pid

    let spawnErr = null
    this.proc.on('error', (e) => { spawnErr = e })
    // Unexpected death after a clean start = engage the kill-switch (a bootstrap-time failure is
    // handled by start() throwing, so gate on this.ready and skip our own stop()'s exit).
    this.proc.on('exit', (code, signal) => {
      if (this.stopping || !this.ready) return
      this.pid = null; this.proc = null; this.ready = false
      this.onLog(`tor exited unexpectedly (code ${code ?? '—'}, signal ${signal ?? '—'})`)
      try { this.onExit({ code, signal }) } catch { /* handler is best-effort */ }
    })
    const onLine = (d) => {
      const s = d.toString()
      this.log += s
      const m = s.match(/Bootstrapped (\d+)%/)
      if (m) { this.bootstrap = Number(m[1]); this.onLog(`tor bootstrap ${this.bootstrap}%`) }
    }
    this.proc.stdout.on('data', onLine)
    this.proc.stderr.on('data', onLine)

    const deadline = Date.now() + this.bootstrapTimeoutMs
    while (Date.now() < deadline) {
      if (spawnErr) { await this.stop(); throw new Error(`could not start tor (${spawnErr.code}). Install tor or set TOR_BIN. [${spawnErr.message}]`) }
      if (/Bootstrapped 100%/.test(this.log)) break
      if (/\[err\]/.test(this.log)) { await this.stop(); throw new Error('tor errored during bootstrap:\n' + this.log.split('\n').filter((l) => /err/i.test(l)).join('\n')) }
      await sleep(500)
    }
    if (!/Bootstrapped 100%/.test(this.log)) {
      const stuck = (this.log.match(/Bootstrapped \d+%[^\n]*/g) || []).slice(-1)[0] || '(no bootstrap lines)'
      await this.stop()
      throw new Error(`tor did not reach 100% in ${Math.round(this.bootstrapTimeoutMs / 1000)}s — last: ${stuck} (needs Tor-network egress)`)
    }

    for (const hs of this.hiddenServices) {
      const hostFile = path.join(hs.dir, 'hostname')
      for (let i = 0; i < 40 && !fs.existsSync(hostFile); i++) await sleep(250)
      this.onions[hs.name] = fs.readFileSync(hostFile, 'utf8').trim()
    }
    this.ready = true
    this.onLog(`tor ready (socks ${this.socksPort}; onions: ${Object.values(this.onions).join(', ') || 'none'})`)
    return this
  }

  #alive (pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
  }

  /** Stop tor and DO NOT RESOLVE until it is dead. SIGTERM → poll → SIGKILL → confirm. */
  async stop ({ graceMs = 2000 } = {}) {
    this.stopping = true
    const pid = this.pid
    this.proc = null
    if (!this.#alive(pid)) { this.pid = null; return }
    try { process.kill(pid, 'SIGTERM') } catch {}
    const start = Date.now()
    while (Date.now() - start < graceMs) {
      if (!this.#alive(pid)) { this.pid = null; return }
      await sleep(100)
    }
    this.onLog(`tor graceful stop timed out — SIGKILL pid ${pid}`)
    try { process.kill(pid, 'SIGKILL') } catch {}
    for (let i = 0; i < 40; i++) { if (!this.#alive(pid)) { this.pid = null; return }; await sleep(50) }
    this.onLog(`WARNING: tor pid ${pid} survived SIGKILL`)
    this.pid = null
  }

  /** Synchronous last-ditch kill for process exit handlers (can't await). */
  killNowSync () {
    const pid = this.pid
    if (this.#alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    this.pid = null
  }
}
