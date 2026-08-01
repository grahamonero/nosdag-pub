/**
 * Auth Client — LOCAL-ONLY username/password accounts.
 *
 * Nosdag keeps username/password accounts entirely on-device: the nsec is
 * encrypted under the password with NIP-49 (memory-hard scrypt) and stored in
 * localStorage; login decrypts it locally. There is NO server — no nosmero
 * dependency, no key blob ever leaves the machine. A new device has no local
 * account, so you import your nsec (or create a fresh account) there.
 *
 * SECURITY:
 * - The plaintext nsec is never persisted; only the NIP-49 ncryptsec is stored.
 * - Wrong password = NIP-49 decrypt fails (the decrypt IS the check) — no
 *   separate password hash is kept, so there's nothing extra to brute-force.
 */

import * as nip49 from './nip49.js';

// ---- Local account store: { [usernameLower]: { npub, ncryptsec } } ----
const ACCOUNTS_KEY = 'nosdag:accounts';
const SESSION_KEY = 'nosmero-auth-session';

function normUser(u) { return String(u || '').toLowerCase().trim(); }

function loadAccounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || {}; } catch { return {}; }
}
function getAccount(username) { return loadAccounts()[normUser(username)] || null; }
function putAccount(username, npub, ncryptsec) {
  const all = loadAccounts();
  all[normUser(username)] = { npub, ncryptsec };
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(all));
}

// ---- Derive an npub from a pasted nsec (local; nostr-tools from the bundle, no CDN) ----
async function npubFromNsec(nsec) {
  const { decode, npubEncode } = window.NostrTools.nip19;
  const { getPublicKey } = window.NostrTools;
  const decoded = decode(String(nsec).trim());
  if (decoded.type !== 'nsec') throw new Error('Pasted key is not an nsec');
  return npubEncode(getPublicKey(decoded.data));
}

// ---- Client-side encrypted backup (download an ncryptsec file) ----
async function createClientSideBackup(nsec, password, npub) {
  const ncryptsec = await nip49.encrypt(nsec, password);
  const backup = {
    version: 1,
    npub,
    ncryptsec,
    timestamp: new Date().toISOString(),
    note: 'Nosdag encrypted key backup - Keep this file safe!'
  };
  return JSON.stringify(backup, null, 2);
}
function downloadBackup(backupData, filename = 'nosdag-backup.json') {
  const blob = new Blob([backupData], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Create a local account from a freshly generated key. Seamless: no network —
 * encrypt under the password, write the record, done.
 * @returns {Promise<{success, username, npub}>}
 */
export async function signup({ nsec, npub, password, username, createBackup = false }) {
  if (!nsec || !npub || !password) throw new Error('nsec, npub, and password are required');
  if (!username) throw new Error('Username is required');
  const v = nip49.validatePassword(password);
  if (!v.valid) throw new Error(v.error);
  if (getAccount(username)) throw new Error('That username already exists on this device');

  const ncryptsec = await nip49.encrypt(nsec, password);
  putAccount(username, npub, ncryptsec);

  if (createBackup) {
    downloadBackup(await createClientSideBackup(nsec, password, npub), `nosdag-backup-${normUser(username)}.json`);
  }
  return { success: true, username: normUser(username), npub };
}

/**
 * Create a local account anchored to an EXISTING nsec the user controls
 * (the "bring your own key" path, and the way an existing account re-establishes
 * itself on a device after the move to local-only).
 * @returns {Promise<{nsec, npub, username, ncryptsec}>}
 */
export async function signupWithNsec({ nsec, username, password }) {
  if (!nsec || !username || !password) throw new Error('nsec, username, and password are required');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new Error('Username must be 3-20 characters (letters, numbers, underscore)');
  }
  const v = nip49.validatePassword(password);
  if (!v.valid) throw new Error(v.error);
  if (getAccount(username)) throw new Error('That username already exists on this device');

  const npub = await npubFromNsec(nsec);
  const ncryptsec = await nip49.encrypt(String(nsec).trim(), password);
  putAccount(username, npub, ncryptsec);
  return { nsec: String(nsec).trim(), npub, username: normUser(username), ncryptsec };
}

/**
 * Log in by decrypting the local account blob with the password.
 * @returns {Promise<{nsec, npub, username, ncryptsec}>}
 */
export async function login(identifier, password) {
  if (!identifier || !password) throw new Error('Username and password required');
  const acct = getAccount(identifier);
  if (!acct) throw new Error('No account on this device for that username — import your nsec or create an account');
  let nsec;
  try {
    nsec = await nip49.decrypt(acct.ncryptsec, password);
  } catch {
    throw new Error('Incorrect password');
  }
  if (!nsec) throw new Error('Incorrect password');
  return { nsec, npub: acct.npub, username: normUser(identifier), ncryptsec: acct.ncryptsec };
}

/**
 * "Forgot password": re-import the nsec and set a new password — re-encrypts the
 * local blob. Overwrites the existing record (the recovery/overwrite path).
 * @returns {Promise<{nsec, npub, username, ncryptsec}>}
 */
export async function resetPasswordWithNsec({ username, nsec, newPassword }) {
  if (!username || !nsec || !newPassword) throw new Error('username, nsec, and newPassword are required');
  const v = nip49.validatePassword(newPassword);
  if (!v.valid) throw new Error(v.error);

  const npub = await npubFromNsec(nsec);
  const ncryptsec = await nip49.encrypt(String(nsec).trim(), newPassword);
  putAccount(username, npub, ncryptsec);
  return { nsec: String(nsec).trim(), npub, username: normUser(username), ncryptsec };
}

/**
 * Username availability — local only (is it free on THIS device?).
 */
export async function checkAvailability(field, value) {
  if (field === 'username') return !getAccount(value);
  return true; // email isn't used in the local-only model
}

// ==================== Session metadata (local, no secrets) ====================

export function saveSession({ npub, email, username, email_verified }) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    npub,
    email: email || null,
    username: username || null,
    email_verified: !!email_verified,
    login_method: 'email_password',
    timestamp: Date.now()
  }));
}

export function getSession() {
  try { const d = localStorage.getItem(SESSION_KEY); return d ? JSON.parse(d) : null; } catch { return null; }
}

export function clearSession() { localStorage.removeItem(SESSION_KEY); }

export function isEmailPasswordLogin() { return getSession()?.login_method === 'email_password'; }

export { createClientSideBackup, downloadBackup };
