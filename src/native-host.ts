#!/usr/bin/env node
// ApiTap Native Messaging Host
// Receives skill files from the Chrome extension and saves to ~/.apitap/skills/

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { signSkillFile } from './skill/signing.js';
import { deriveSigningKey } from './auth/crypto.js';
import { getMachineId, AuthManager } from './auth/manager.js';

const SKILLS_DIR = path.join(os.homedir(), '.apitap', 'skills');
const VERSION = '1.0.0';

// Sign skill JSON using the CLI's HMAC signing infrastructure
async function signSkillJson(skillJson: string): Promise<string> {
  try {
    const skill = JSON.parse(skillJson);
    const machineId = await getMachineId();
    const key = deriveSigningKey(machineId);
    const signed = signSkillFile(skill, key);
    return JSON.stringify(signed);
  } catch {
    return skillJson; // Return unsigned if signing fails
  }
}

export interface NativeRequest {
  action: 'save_skill' | 'save_batch' | 'ping' | 'capture_request' | 'save_index' | 'save_auth';
  domain?: string;
  skillJson?: string;
  skills?: Array<{ domain: string; skillJson: string }>;
  indexJson?: string;
  // v1.5.1: multi-header auth
  headers?: Array<{ header: string; value: string }>;
  // Legacy single-header (backwards compat)
  authHeader?: string;
  authValue?: string;
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

    if (request.action === 'save_index') {
      if (!request.indexJson) {
        return { success: false, error: 'Missing indexJson' };
      }
      if (request.indexJson.length > 5 * 1024 * 1024) {
        return { success: false, error: 'Index too large (max 5MB)' };
      }
      try {
        JSON.parse(request.indexJson);
      } catch {
        return { success: false, error: 'Invalid JSON in indexJson' };
      }

      // index.json lives in ~/.apitap/ (parent of skills dir)
      const apitapDir = path.dirname(skillsDir);
      await fs.mkdir(apitapDir, { recursive: true });
      const indexPath = path.join(apitapDir, 'index.json');

      // Atomic write: temp file + rename
      const tmpPath = indexPath + '.tmp.' + process.pid;
      await fs.writeFile(tmpPath, request.indexJson, { mode: 0o600 });
      await fs.rename(tmpPath, indexPath);

      return { success: true, path: indexPath };
    }

    if (request.action === 'save_auth') {
      if (!request.domain || !isValidDomain(request.domain)) {
        return { success: false, error: `Invalid domain: ${request.domain}` };
      }

      // Normalize: support both multi-header (v1.5.1) and legacy single-header
      const authHeaders: Array<{ header: string; value: string }> = request.headers
        ?? (request.authHeader && request.authValue
          ? [{ header: request.authHeader, value: request.authValue }]
          : []);

      if (authHeaders.length === 0) {
        return { success: false, error: 'Missing auth headers' };
      }

      // Primary header determines the auth type
      const primary = authHeaders[0];
      const headerLower = primary.header.toLowerCase();
      const type = headerLower === 'authorization'
        ? (primary.value.startsWith('Bearer ') ? 'bearer' : 'api-key')
        : headerLower === 'x-api-key' ? 'api-key'
        : headerLower === 'cookie' ? 'cookie'
        : 'custom';

      const machineId = await getMachineId();
      const apitapDir = path.dirname(skillsDir);
      const authManager = new AuthManager(apitapDir, machineId);
      await authManager.store(request.domain, {
        type: type as 'bearer' | 'api-key' | 'cookie' | 'custom',
        header: primary.header,
        value: primary.value,
        ...(authHeaders.length > 1 ? { headers: authHeaders } : {}),
      });
      return { success: true };
    }

    return { success: false, error: `Unknown action: ${request.action}` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// --- Relay handler ---

// Actions handled locally by the native host (filesystem operations)
const LOCAL_ACTIONS = new Set(['save_skill', 'save_batch', 'ping', 'save_index', 'save_auth']);

// Actions relayed to the extension (browser operations)
const EXTENSION_ACTIONS = new Set(['capture_request']);

export function createRelayHandler(
  sendToExtension: (msg: any) => Promise<any>,
  skillsDir: string = SKILLS_DIR,
): MessageHandler {
  return async (message: any) => {
    if (LOCAL_ACTIONS.has(message.action)) {
      return handleNativeMessage(message, skillsDir);
    }

    if (EXTENSION_ACTIONS.has(message.action)) {
      try {
        return await sendToExtension(message);
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    return { success: false, error: `Unknown action: ${message.action}` };
  };
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

        // Guard against unbounded buffer growth (max 10MB)
        if (buffer.length > 10 * 1024 * 1024) {
          conn.destroy();
          return;
        }

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
    socketServer.listen(socketPath, () => {
      // Restrict socket permissions to owner only
      fs.chmod(socketPath, 0o600).catch(() => {});
      resolve();
    });
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
      if (messageLength > 10 * 1024 * 1024) {
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
  const bridgeDir = path.join(os.homedir(), '.apitap');
  const socketPath = path.join(bridgeDir, 'bridge.sock');

  // Pending CLI requests waiting for extension responses
  const pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let requestCounter = 0;

  // Send a message to the extension via stdout and wait for response
  function sendToExtension(message: any): Promise<any> {
    return new Promise((resolve) => {
      const id = String(++requestCounter);
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        resolve({ success: false, error: 'approval_timeout' });
      }, 60_000);

      pendingRequests.set(id, { resolve, timer });

      // Tag message with ID so we can match the response
      sendMessage({ ...message, _relayId: id } as any);
    });
  }

  const handler = createRelayHandler(sendToExtension);

  (async () => {
    // Ensure bridge directory exists
    await fs.mkdir(bridgeDir, { recursive: true });

    // Start socket server for CLI connections
    await startSocketServer(socketPath, handler);

    // Read messages from extension via stdin
    while (true) {
      const message = await readMessage();
      if (!message) break;

      // Check if this is a response to a relayed request
      const relayId = (message as any)._relayId;
      if (relayId && pendingRequests.has(relayId)) {
        const pending = pendingRequests.get(relayId)!;
        clearTimeout(pending.timer);
        pendingRequests.delete(relayId);
        const { _relayId, ...response } = message as any;
        pending.resolve(response);
        continue;
      }

      // Otherwise, handle as a direct extension message (save_skill, etc.)
      const response = await handleNativeMessage(message);
      // Echo _portMsgId so extension can match response to request
      if ((message as any)._portMsgId) {
        (response as any)._portMsgId = (message as any)._portMsgId;
      }
      sendMessage(response);
    }

    // Extension disconnected — clean up
    await stopSocketServer();
    try { await fs.unlink(socketPath); } catch { /* already gone */ }
  })();
}
