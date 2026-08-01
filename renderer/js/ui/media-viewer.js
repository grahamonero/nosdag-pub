// Media viewer: clicking an image inside a note focuses the image in a full-window
// overlay instead of opening the note's thread. Videos keep their native controls —
// clicks on them just stop falling through to the thread handler.
//
// The interception must run in the CAPTURE phase: feed media lives inside
// .post-content, whose inline onclick opens the thread, and DOMPurify strips any
// inline handler parseContent could put on the media itself (same reason the
// .pdf-card opener captures — see pdf-reader.js).

let viewerEl = null;

function onKey(e) {
    if (e.key === 'Escape') closeMediaViewer();
}

export function closeMediaViewer() {
    viewerEl?.remove();
    viewerEl = null;
    document.removeEventListener('keydown', onKey);
}

export function openMediaViewer(url, alt = '') {
    if (!url) return;
    closeMediaViewer();
    viewerEl = document.createElement('div');
    viewerEl.className = 'nd-media-viewer';
    const img = document.createElement('img');
    img.src = url;
    img.alt = alt || 'Media';
    const close = document.createElement('button');
    close.className = 'nd-media-viewer-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close');
    viewerEl.append(img, close);
    // Backdrop or ✕ closes; the image itself is inert so a stray click doesn't dismiss it.
    viewerEl.addEventListener('click', (e) => { if (e.target !== img) closeMediaViewer(); });
    document.addEventListener('keydown', onKey);
    // Append to <body>, NOT .app-container — the container is a stacking context that
    // traps fixed overlays under the root-level top bar (see the Settings-page gotcha).
    document.body.appendChild(viewerEl);
    close.focus();
}

export function initMediaViewer() {
    if (window._ndMediaViewerInit) return;
    window._ndMediaViewerInit = true;
    document.addEventListener('click', (ev) => {
        const el = ev.target.closest?.('.post-content img, .post-content video');
        if (!el) return;
        if (el.closest('.pdf-card')) return;              // pdf cards have their own opener
        if (el.classList.contains('note-avatar')) return; // embedded-note avatars keep card behavior
        if (el.tagName === 'VIDEO') {
            // Let the native controls work; just don't open the thread underneath them.
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        // ThumbHash placeholders keep the real URL in data-thumbhash-src; mirror-fetch
        // recovered images carry a plain src.
        openMediaViewer(el.dataset.thumbhashSrc || el.currentSrc || el.src, el.alt);
    }, { capture: true });
}
