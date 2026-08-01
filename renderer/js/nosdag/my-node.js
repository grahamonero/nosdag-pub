// My Node — one page composing the node panel, media library, and hosted follows.
// Composition only: each tab pane hands its container to the EXISTING renderer
// (node-panel.js / media-library.js / hosted-follows.js); their standalone page
// headers are hidden by nosdag-theme.css when mounted inside .nd-mn.
//
// Tab semantics: the node pane re-renders on every activation — its status poll
// self-cancels when #nodePage hides, and a fresh render restarts it. Media and
// hosted render once per page visit (each renderMyNode call re-arms them), so a
// tab flip inside one visit doesn't repeat the media DAG scan.

const paneMap = (c) => ({
  node: c.querySelector('[data-mn-pane="node"]'),
  media: c.querySelector('[data-mn-pane="media"]'),
  hosted: c.querySelector('[data-mn-pane="hosted"]')
})

let rendered = { media: false, hosted: false }

export async function renderMyNode (container, tab = 'node') {
  if (!container.querySelector('.nd-mn')) {
    container.innerHTML = `
    <div class="nd-mn">
      <div class="nd-mn-head">
        <button class="nd-back" data-nd-home aria-label="Back to feed">←</button>
        <h1 class="nd-mn-title">My Node</h1>
      </div>
      <nav class="nd-mn-tabs">
        <button class="nd-mn-tab" data-mn-tab="node">Node</button>
        <button class="nd-mn-tab" data-mn-tab="media">Media</button>
        <button class="nd-mn-tab" data-mn-tab="hosted">Hosted Follows</button>
      </nav>
      <div class="nd-mn-pane" data-mn-pane="node"></div>
      <div class="nd-mn-pane" data-mn-pane="media" style="display:none"></div>
      <div class="nd-mn-pane" data-mn-pane="hosted" style="display:none"></div>
    </div>`
    container.querySelector('[data-nd-home]').addEventListener('click', () => window.navigateTo?.('home'))
    container.querySelectorAll('.nd-mn-tab').forEach((b) =>
      b.addEventListener('click', () => activate(container, b.dataset.mnTab)))
  }
  rendered = { media: false, hosted: false }
  await activate(container, tab)
}

async function activate (container, tab) {
  const panes = paneMap(container)
  if (!panes[tab]) tab = 'node'
  container.querySelectorAll('.nd-mn-tab').forEach((b) =>
    b.classList.toggle('on', b.dataset.mnTab === tab))
  for (const [k, el] of Object.entries(panes)) el.style.display = k === tab ? '' : 'none'

  try {
    if (tab === 'node') {
      const NP = await import('./node-panel.js')
      await NP.renderNodePanel(panes.node)
    } else if (tab === 'media' && !rendered.media) {
      rendered.media = true
      if (!window.NostrState?.publicKey) {
        panes.media.innerHTML = '<div class="nd-mn-gate">Sign in to see the media your notes reference and where each file is pinned.</div>'
      } else {
        const ML = await import('./media-library.js')
        await ML.renderMediaLibrary(panes.media)
      }
    } else if (tab === 'hosted' && !rendered.hosted) {
      rendered.hosted = true
      const HF = await import('./hosted-follows.js')
      await HF.renderHostedFollows(panes.hosted)
    }
  } catch (e) {
    console.error('[MyNode] tab failed to render:', tab, e)
    panes[tab].innerHTML = `<div class="nd-mn-gate">This section failed to load: ${e.message || e}</div>`
  }
}
