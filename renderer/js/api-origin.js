// NIP-98 URL helpers for requests to the Nosmero backend.
//
// On the plain web app these are no-ops — both resolve against the page origin.
// The Nosdag Electron shell is the reason they exist: it serves this (reused
// Nosmero) frontend from app://bundle and proxies /api/* to the real backend
// (main.mjs → https://nosmero.com). That splits one URL into two that a signed
// request normally treats as identical:
//
//   • the URL we SEND the request to — must stay on the local origin so /api/*
//     hits the in-shell proxy (which forwards it server-to-server, no CORS).
//   • the URL the backend RECONSTRUCTS to check the NIP-98 `u` tag — it rebuilds
//     it from its OWN Host header (req.protocol + req.get('host') +
//     req.originalUrl), i.e. https://nosmero.com/..., never app://bundle/...
//
// So: sign the second, fetch the first. If you sign app://bundle/... the server
// rejects every authenticated call with `url_mismatch` (this was the open
// Phase-4 follow-up blocking verified tips, paywall, and IPFS uploads in the
// shell). The proxy can't rewrite the `u` tag itself — it's inside the signed
// event — so the fix has to be here, client-side, at sign time.

// Origin the backend reconstructs request URLs from. Must equal what main.mjs's
// /api/* proxy forwards to (NOSMERO_API_ORIGIN) and what nginx passes as Host.
const BACKEND_ORIGIN = 'https://nosmero.com';

// True only inside the Nosdag Electron shell — window.nosdag is injected by the
// preload bridge and is absent on the web app.
function inShell() {
    return typeof window !== 'undefined' && !!window.nosdag;
}

// URL to put in the NIP-98 `u` tag. Must match the server's reconstruction
// exactly or verification fails url_mismatch. Absolute http(s) paths (external
// hosts that aren't proxied) are signed as-is.
export function signedUrl(path) {
    if (/^https?:\/\//.test(path)) return path;
    return new URL(path, inShell() ? BACKEND_ORIGIN : window.location.origin).toString();
}

// URL to actually fetch. Always the local origin so the shell's app:// proxy
// forwards /api/* (on the web this is the same origin the request targets).
export function requestUrl(path) {
    if (/^https?:\/\//.test(path)) return path;
    return new URL(path, window.location.origin).toString();
}
