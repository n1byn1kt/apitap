// src/auth/manager.ts
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { encrypt, decrypt, deriveKey, type EncryptedData } from './crypto.js';
import type { StoredAuth, StoredToken, StoredSession } from '../types.js';

const AUTH_FILENAME = 'auth.enc';

/**
 * Manages encrypted auth credential storage.
 * All credentials stored in a single encrypted file keyed by domain.
 */
export class AuthManager {
  private key: Buffer;
  private authPath: string;

  constructor(baseDir: string, machineId: string, saltFile?: string) {
    this.key = deriveKey(machineId, saltFile);
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

  /** Store refreshable tokens for a domain (merges with existing auth). */
  async storeTokens(domain: string, tokens: Record<string, StoredToken>): Promise<void> {
    const all = await this.loadAll();
    const existing = all[domain] || { type: 'custom' as const, header: '', value: '' };
    all[domain] = { ...existing, tokens };
    await this.saveAll(all);
  }

  /** Retrieve refreshable tokens for a domain. */
  async retrieveTokens(domain: string): Promise<Record<string, StoredToken> | null> {
    const all = await this.loadAll();
    return all[domain]?.tokens ?? null;
  }

  /** Store browser session (cookies) for a domain (merges with existing auth). */
  async storeSession(domain: string, session: StoredSession): Promise<void> {
    const all = await this.loadAll();
    const existing = all[domain] || { type: 'custom' as const, header: '', value: '' };
    all[domain] = { ...existing, session };
    await this.saveAll(all);
  }

  /** Retrieve browser session for a domain. */
  async retrieveSession(domain: string): Promise<StoredSession | null> {
    const all = await this.loadAll();
    return all[domain]?.session ?? null;
  }

  /**
   * Retrieve session with subdomain fallback.
   * Tries exact match first, then walks up parent domains.
   * e.g., dashboard.twitch.tv → twitch.tv
   */
  async retrieveSessionWithFallback(domain: string): Promise<StoredSession | null> {
    // Try exact match first
    const exact = await this.retrieveSession(domain);
    if (exact) return exact;

    // Try parent domains
    for (const parent of getParentDomains(domain)) {
      const session = await this.retrieveSession(parent);
      if (session) return session;
    }

    return null;
  }

  /** Store OAuth credentials for a domain (merges with existing auth). */
  async storeOAuthCredentials(domain: string, creds: { refreshToken?: string; clientSecret?: string }): Promise<void> {
    const all = await this.loadAll();
    const existing = all[domain] || { type: 'custom' as const, header: '', value: '' };
    if (creds.refreshToken !== undefined) existing.refreshToken = creds.refreshToken;
    if (creds.clientSecret !== undefined) existing.clientSecret = creds.clientSecret;
    all[domain] = existing;
    await this.saveAll(all);
  }

  /** Retrieve OAuth credentials for a domain. */
  async retrieveOAuthCredentials(domain: string): Promise<{ refreshToken?: string; clientSecret?: string } | null> {
    const all = await this.loadAll();
    const auth = all[domain];
    if (!auth) return null;
    if (!auth.refreshToken && !auth.clientSecret) return null;
    return { refreshToken: auth.refreshToken, clientSecret: auth.clientSecret };
  }

  /** List all domains with stored auth. */
  async listDomains(): Promise<string[]> {
    const all = await this.loadAll();
    return Object.keys(all);
  }

  /** Clear all auth for a domain. */
  async clear(domain: string): Promise<void> {
    const all = await this.loadAll();
    delete all[domain];
    await this.saveAll(all);
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
 * Get parent domains for subdomain fallback.
 * dashboard.twitch.tv → ["twitch.tv"]
 * a.b.example.com → ["b.example.com", "example.com"]
 * twitch.tv → [] (already base, 2 labels)
 */
export function getParentDomains(domain: string): string[] {
  const parts = domain.split('.');
  const parents: string[] = [];

  // Stop at 2 labels (e.g., "example.com" is the minimum)
  for (let i = 1; i < parts.length - 1; i++) {
    parents.push(parts.slice(i).join('.'));
  }

  return parents;
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
