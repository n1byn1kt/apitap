import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOST_NAME = 'com.apitap.native';

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

export function generateHostManifest(hostPath: string, extensionId: string): HostManifest {
  return {
    name: HOST_NAME,
    description: 'ApiTap native messaging host — saves captured skill files to ~/.apitap/skills/',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export function getBrowserPaths(platform: string = process.platform): string[] {
  const home = os.homedir();

  if (platform === 'linux') {
    return [
      path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
      path.join(home, '.config', 'chromium', 'NativeMessagingHosts'),
      path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
    ];
  }

  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      path.join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
      path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'),
    ];
  }

  return [];
}

export async function installNativeHost(
  hostPath: string,
  extensionId: string,
  browserDirs?: string[],
): Promise<{ installed: string[]; errors: string[] }> {
  const dirs = browserDirs ?? getBrowserPaths();
  const manifest = generateHostManifest(hostPath, extensionId);
  const manifestJson = JSON.stringify(manifest, null, 2);

  const installed: string[] = [];
  const errors: string[] = [];

  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const manifestPath = path.join(dir, `${HOST_NAME}.json`);
      await fs.writeFile(manifestPath, manifestJson, 'utf-8');
      installed.push(manifestPath);
    } catch (err) {
      errors.push(`${dir}: ${err}`);
    }
  }

  return { installed, errors };
}
