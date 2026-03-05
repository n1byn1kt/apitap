#!/usr/bin/env node
// ApiTap Native Messaging Host
// Receives skill files from the Chrome extension and saves to ~/.apitap/skills/

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { signSkillFile } from './skill/signing.js';
import { deriveKey } from './auth/crypto.js';
import { getMachineId } from './auth/manager.js';

const SKILLS_DIR = path.join(os.homedir(), '.apitap', 'skills');
const VERSION = '1.0.0';

// Sign skill JSON using the CLI's HMAC signing infrastructure
async function signSkillJson(skillJson: string): Promise<string> {
  try {
    const skill = JSON.parse(skillJson);
    const machineId = await getMachineId();
    const key = deriveKey(machineId);
    const signed = signSkillFile(skill, key);
    return JSON.stringify(signed);
  } catch {
    return skillJson; // Return unsigned if signing fails
  }
}

export interface NativeRequest {
  action: 'save_skill' | 'save_batch' | 'ping';
  domain?: string;
  skillJson?: string;
  skills?: Array<{ domain: string; skillJson: string }>;
}

export interface NativeResponse {
  success: boolean;
  action?: string;
  path?: string;
  paths?: string[];
  error?: string;
  version?: string;
  skillsDir?: string;
}

// Domain validation — must match src/skill/store.ts conventions
function isValidDomain(domain: string): boolean {
  if (!domain || domain.length === 0 || domain.length > 253) return false;
  if (domain.includes('/') || domain.includes('\\')) return false;
  if (domain.includes('..')) return false;
  if (domain.startsWith('.') || domain.startsWith('-')) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(domain)) return false;
  return true;
}

export async function handleNativeMessage(
  request: NativeRequest,
  skillsDir: string = SKILLS_DIR,
): Promise<NativeResponse> {
  try {
    if (request.action === 'ping') {
      return {
        success: true,
        action: 'pong',
        version: VERSION,
        skillsDir,
      };
    }

    if (request.action === 'save_skill') {
      if (!request.domain || !isValidDomain(request.domain)) {
        return { success: false, error: `Invalid domain: ${request.domain}` };
      }
      if (!request.skillJson) {
        return { success: false, error: 'Missing skillJson' };
      }
      // Validate JSON
      try {
        JSON.parse(request.skillJson);
      } catch {
        return { success: false, error: 'Invalid JSON in skillJson' };
      }

      await fs.mkdir(skillsDir, { recursive: true });
      const filePath = path.join(skillsDir, `${request.domain}.json`);
      // Sign the skill file on receive (CLI is the signing authority)
      const signed = await signSkillJson(request.skillJson);
      await fs.writeFile(filePath, signed, 'utf-8');
      return { success: true, path: filePath };
    }

    if (request.action === 'save_batch') {
      if (!Array.isArray(request.skills) || request.skills.length === 0) {
        return { success: false, error: 'Missing or empty skills array' };
      }

      await fs.mkdir(skillsDir, { recursive: true });
      const paths: string[] = [];

      for (const { domain, skillJson } of request.skills) {
        if (!isValidDomain(domain)) {
          return { success: false, error: `Invalid domain: ${domain}` };
        }
        try {
          JSON.parse(skillJson);
        } catch {
          return { success: false, error: `Invalid JSON for domain ${domain}` };
        }
        const filePath = path.join(skillsDir, `${domain}.json`);
        const signed = await signSkillJson(skillJson);
        await fs.writeFile(filePath, signed, 'utf-8');
        paths.push(filePath);
      }

      return { success: true, paths };
    }

    return { success: false, error: `Unknown action: ${request.action}` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// --- Unix socket server for CLI relay ---

export type MessageHandler = (message: any) => Promise<any>;

let socketServer: net.Server | null = null;

export async function startSocketServer(
  socketPath: string,
  handler: MessageHandler,
): Promise<void> {
  // Clean up stale socket
  try { await fs.unlink(socketPath); } catch { /* doesn't exist — fine */ }

  return new Promise((resolve, reject) => {
    socketServer = net.createServer((conn) => {
      let buffer = '';

      conn.on('data', (chunk) => {
        buffer += chunk.toString();
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) return;

        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        let request: any;
        try {
          request = JSON.parse(line);
        } catch {
          conn.end(JSON.stringify({ success: false, error: 'Invalid JSON' }) + '\n');
          return;
        }

        handler(request).then(
          (response) => conn.end(JSON.stringify(response) + '\n'),
          (err) => conn.end(JSON.stringify({ success: false, error: String(err) }) + '\n'),
        );
      });

      conn.on('error', () => { /* client disconnect — ignore */ });
    });

    socketServer.on('error', reject);
    socketServer.listen(socketPath, () => resolve());
  });
}

export async function stopSocketServer(): Promise<void> {
  if (!socketServer) return;
  return new Promise((resolve) => {
    socketServer!.close(() => resolve());
    socketServer = null;
  });
}

// --- stdio framing (only runs when executed directly, not when imported for tests) ---

function readMessage(): Promise<NativeRequest | null> {
  return new Promise((resolve) => {
    const headerBuf = Buffer.alloc(4);
    let headerRead = 0;

    function onData(chunk: Buffer) {
      let offset = 0;

      // Read header
      if (headerRead < 4) {
        const needed = 4 - headerRead;
        const toCopy = Math.min(needed, chunk.length);
        chunk.copy(headerBuf, headerRead, 0, toCopy);
        headerRead += toCopy;
        offset = toCopy;

        if (headerRead < 4) return; // need more data for header
      }

      const messageLength = headerBuf.readUInt32LE(0);
      if (messageLength > 1024 * 1024) {
        process.stderr.write(`Message too large: ${messageLength}\n`);
        resolve(null);
        return;
      }

      // Accumulate message body
      const bodyBuf = Buffer.alloc(messageLength);
      let bodyRead = 0;

      if (offset < chunk.length) {
        const remaining = chunk.subarray(offset);
        const toCopy = Math.min(remaining.length, messageLength);
        remaining.copy(bodyBuf, 0, 0, toCopy);
        bodyRead = toCopy;
      }

      if (bodyRead >= messageLength) {
        process.stdin.removeListener('data', onData);
        try {
          resolve(JSON.parse(bodyBuf.toString('utf-8')));
        } catch {
          resolve(null);
        }
        return;
      }

      // Need more data
      function onMoreData(moreChunk: Buffer) {
        const toCopy = Math.min(moreChunk.length, messageLength - bodyRead);
        moreChunk.copy(bodyBuf, bodyRead, 0, toCopy);
        bodyRead += toCopy;

        if (bodyRead >= messageLength) {
          process.stdin.removeListener('data', onMoreData);
          process.stdin.removeListener('data', onData);
          try {
            resolve(JSON.parse(bodyBuf.toString('utf-8')));
          } catch {
            resolve(null);
          }
        }
      }
      process.stdin.on('data', onMoreData);
    }

    process.stdin.on('data', onData);
    process.stdin.on('end', () => resolve(null));
  });
}

function sendMessage(message: NativeResponse) {
  const json = Buffer.from(JSON.stringify(message), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

// Main loop — only runs when executed as a script
const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('native-host.ts') || process.argv[1].endsWith('native-host.js'));

if (isMainModule) {
  (async () => {
    while (true) {
      const request = await readMessage();
      if (!request) break;
      const response = await handleNativeMessage(request);
      sendMessage(response);
    }
  })();
}
