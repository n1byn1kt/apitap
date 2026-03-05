import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_SOCKET = path.join(os.homedir(), '.apitap', 'bridge.sock');

export interface BridgeCaptureResult {
  success: boolean;
  skillFiles?: any[];
  error?: string;
}

/**
 * Fast check: does the bridge socket exist?
 * Returns false if the file doesn't exist (costs ~0.1ms).
 * Returns true if the file exists (doesn't verify it's connectable).
 */
export async function bridgeAvailable(socketPath: string = DEFAULT_SOCKET): Promise<boolean> {
  try {
    await fs.access(socketPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a capture_request to the extension via the native host bridge.
 * Returns skill files on success, or a structured error.
 */
export async function requestBridgeCapture(
  domain: string,
  socketPath: string = DEFAULT_SOCKET,
  options: { timeout?: number } = {},
): Promise<BridgeCaptureResult> {
  const timeout = options.timeout ?? 120_000; // 2 minutes (capture can take time)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.destroy();
      resolve({ success: false, error: 'timeout' });
    }, timeout);

    const client = net.createConnection(socketPath, () => {
      const message = JSON.stringify({ action: 'capture_request', domain }) + '\n';
      client.write(message);
    });

    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });

    client.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ success: false, error: 'invalid response from bridge' });
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `bridge connection failed: ${err.message}` });
    });
  });
}
