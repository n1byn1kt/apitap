// src/auth/manager.ts
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { encrypt, decrypt, deriveKey, type EncryptedData } from './crypto.js';
import type { StoredAuth } from '../types.js';

const AUTH_FILENAME = 'auth.enc';

/**
 * Manages encrypted auth credential storage.
 * All credentials stored in a single encrypted file keyed by domain.
 */
export class AuthManager {
  private key: Buffer;
  private authPath: string;

  constructor(baseDir: string, machineId: string) {
    this.key = deriveKey(machineId);
    this.authPath = join(baseDir, AUTH_FILENAME);
  }

  /** Store auth credentials for a domain (overwrites existing). */
  async store(domain: string, auth: StoredAuth): Promise<void> {
    const allAuth = await this.loadAll();
    allAuth[domain] = auth;
    await this.saveAll(allAuth);
  }

  /** Retrieve auth credentials for a domain. Returns null if not found or decryption fails. */
  async retrieve(domain: string): Promise<StoredAuth | null> {
    const allAuth = await this.loadAll();
    return allAuth[domain] ?? null;
  }

  /** Check if auth exists for a domain without loading the value. */
  async has(domain: string): Promise<boolean> {
    const allAuth = await this.loadAll();
    return domain in allAuth;
  }

  private async loadAll(): Promise<Record<string, StoredAuth>> {
    try {
      const content = await readFile(this.authPath, 'utf-8');
      const encrypted: EncryptedData = JSON.parse(content);
      const plaintext = decrypt(encrypted, this.key);
      return JSON.parse(plaintext);
    } catch {
      return {};
    }
  }

  private async saveAll(data: Record<string, StoredAuth>): Promise<void> {
    const dir = join(this.authPath, '..');
    await mkdir(dir, { recursive: true });

    const plaintext = JSON.stringify(data);
    const encrypted = encrypt(plaintext, this.key);

    await writeFile(this.authPath, JSON.stringify(encrypted, null, 2) + '\n', { mode: 0o600 });
    // Ensure permissions even if file existed with different perms
    await chmod(this.authPath, 0o600);
  }
}

/**
 * Get the machine ID for key derivation.
 * Linux: /etc/machine-id
 * Fallback: hostname + homedir (less secure but portable)
 */
export async function getMachineId(): Promise<string> {
  try {
    const id = await readFile('/etc/machine-id', 'utf-8');
    return id.trim();
  } catch {
    // Fallback for non-Linux systems
    const { hostname } = await import('node:os');
    const { homedir } = await import('node:os');
    return `${hostname()}-${homedir()}`;
  }
}
