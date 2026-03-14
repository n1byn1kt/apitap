// extension/src/crypto.ts
// AES-256-GCM encryption for auth tokens in chrome.storage.session.
// Key is generated once per browser session and stored in chrome.storage.session
// (never persisted to disk). Tokens are encrypted at rest in session storage
// as defense-in-depth against memory dumps or co-resident extensions.

const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV for GCM

let cachedKey: CryptoKey | null = null;

/**
 * Get or create the per-session encryption key.
 * Stored in chrome.storage.session (cleared on browser close).
 * The key itself is stored as a JWK — this is acceptable because the threat
 * model is encrypting token values, not hiding the key from same-session access.
 */
async function getSessionKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const result = await chrome.storage.session.get(['_encKey']);
  if (result._encKey) {
    cachedKey = await crypto.subtle.importKey(
      'jwk',
      result._encKey,
      { name: ALGO, length: KEY_LENGTH },
      true,
      ['encrypt', 'decrypt'],
    );
    return cachedKey;
  }

  // Generate a new key for this session
  const key = await crypto.subtle.generateKey(
    { name: ALGO, length: KEY_LENGTH },
    true, // extractable so we can store as JWK
    ['encrypt', 'decrypt'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', key);
  await chrome.storage.session.set({ _encKey: jwk });
  cachedKey = key;
  return key;
}

/**
 * Encrypt a plaintext string. Returns base64-encoded IV + ciphertext.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getSessionKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    encoded,
  );
  // Concatenate IV + ciphertext, then base64-encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded IV + ciphertext string.
 */
export async function decrypt(encoded: string): Promise<string> {
  const key = await getSessionKey();
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}
