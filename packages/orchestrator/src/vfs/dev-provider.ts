/**
 * /dev virtual provider.
 *
 * Provides synthetic device files:
 * - /dev/null  — returns empty on read, discards writes silently
 * - /dev/zero  — returns zero-filled bytes on read, read-only
 * - /dev/random, /dev/urandom — returns cryptographically random bytes
 */

import { VfsError } from './inode.js';
import type { VirtualProvider } from './provider.js';

/** Default read size for devices that generate data (zero, random, urandom). */
const DEFAULT_READ_SIZE = 4096;

const DEVICES = new Set(['null', 'zero', 'random', 'urandom']);

export class DevProvider implements VirtualProvider {
  readonly fsType = 'devtmpfs';

  readFile(subpath: string): Uint8Array {
    switch (subpath) {
      case 'null':
        return new Uint8Array(0);
      case 'zero': {
        return new Uint8Array(DEFAULT_READ_SIZE);
      }
      case 'random':
      case 'urandom': {
        const buf = new Uint8Array(DEFAULT_READ_SIZE);
        crypto.getRandomValues(buf);
        return buf;
      }
      default:
        throw new VfsError('ENOENT', `no such file or directory: /dev/${subpath}`);
    }
  }

  writeFile(subpath: string, _data: Uint8Array): void {
    switch (subpath) {
      case 'null':
        // Silently discard
        return;
      case 'zero':
      case 'random':
      case 'urandom':
        throw new VfsError('EROFS', `read-only device: /dev/${subpath}`);
      default:
        throw new VfsError('ENOENT', `no such file or directory: /dev/${subpath}`);
    }
  }

  exists(subpath: string): boolean {
    if (subpath === '') return true; // /dev itself
    return DEVICES.has(subpath);
  }

  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    if (subpath === '') {
      return { type: 'dir', size: DEVICES.size };
    }
    if (DEVICES.has(subpath)) {
      return { type: 'file', size: 0 };
    }
    throw new VfsError('ENOENT', `no such file or directory: /dev/${subpath}`);
  }

  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    if (subpath !== '') {
      throw new VfsError('ENOTDIR', `not a directory: /dev/${subpath}`);
    }
    return Array.from(DEVICES).map(name => ({ name, type: 'file' as const }));
  }
}
