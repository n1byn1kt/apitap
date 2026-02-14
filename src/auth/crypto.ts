// src/auth/crypto.ts
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = 'apitap-v0.2-key-derivation';

export interface EncryptedData {
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

/**
 * Derive a 256-bit key from a machine identifier using PBKDF2.
 * Uses a fixed application salt — the entropy comes from the machine ID
 * being stretched through 100K iterations.
 */
export function deriveKey(machineId: string): Buffer {
  return pbkdf2Sync(machineId, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Each call generates a random IV for semantic security.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedData {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return {
    salt: PBKDF2_SALT,
    iv: iv.toString('hex'),
    ciphertext,
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * Throws if key is wrong or data was tampered with.
 */
export function decrypt(data: EncryptedData, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(data.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));

  let plaintext = decipher.update(data.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

/**
 * Create an HMAC-SHA256 signature.
 * Returns a prefixed string: "hmac-sha256:<hex>"
 */
export function hmacSign(data: string, key: Buffer): string {
  const hmac = createHmac('sha256', key);
  hmac.update(data);
  return `hmac-sha256:${hmac.digest('hex')}`;
}

/**
 * Verify an HMAC-SHA256 signature using timing-safe comparison.
 */
export function hmacVerify(data: string, signature: string, key: Buffer): boolean {
  if (!signature.startsWith('hmac-sha256:')) return false;

  const expected = hmacSign(data, key);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}
