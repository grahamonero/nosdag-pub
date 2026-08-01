// Settings category panes — sub-nav wiring + the pane registry.
//
// The Settings page keeps every section mounted at all times (saveSettings
// reads each field by id with no null guards); switching categories only
// flips the .on class on the .nd-set-pane wrappers. It must never call
// loadSettings() (5s relay fetch + form clobber) and never touch
// #settingsPage's style attribute (a MutationObserver in app.js watches it
// to resync toggles).
//
// Future settings sections: resolve your pane's container with
// getSettingsPane(paneId) and append your .settings-section into it.
// Pane ids: payments · relays · privacy · data · profile · feed

const PANE_IDS = ['payments', 'relays', 'privacy', 'data', 'profile', 'feed']

/** The content container element for one category pane (sections live inside it). */
export function getSettingsPane (paneId) {
  if (!PANE_IDS.includes(paneId)) return null
  return document.querySelector(`#settingsPageContent .nd-set-pane[data-nd-pane="${paneId}"]`)
}

/** Show one category pane (pure display toggle) and rewind the scroller. */
export function switchSettingsPane (paneId) {
  const pane = getSettingsPane(paneId)
  if (!pane) return
  document.querySelectorAll('#settingsPageContent .nd-set-pane').forEach((el) => {
    el.classList.toggle('on', el === pane)
  })
  document.querySelectorAll('#ndSettingsNav .nd-set-tab').forEach((el) => {
    el.classList.toggle('on', el.getAttribute('data-nd-pane-btn') === paneId)
  })
  const scroller = document.getElementById('settingsPageContent')
  if (scroller) scroller.scrollTop = 0
}

let wired = false

/** Bind the sub-nav clicks (idempotent — called on every Settings open). */
export function initSettingsPanes () {
  if (wired) return
  const nav = document.getElementById('ndSettingsNav')
  if (!nav) return
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nd-pane-btn]')
    if (btn) switchSettingsPane(btn.getAttribute('data-nd-pane-btn'))
  })
  wired = true
}

// non-module callers (inline handlers, smokes)
window.getSettingsPane = getSettingsPane
window.switchSettingsPane = switchSettingsPane
