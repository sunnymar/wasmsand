/**
 * /proc virtual provider.
 *
 * Provides synthetic proc files:
 * - /proc/uptime    — seconds since VFS creation
 * - /proc/version   — sandbox version string
 * - /proc/cpuinfo   — processor entries
 * - /proc/meminfo   — synthetic memory info
 * - /proc/loadavg   — load averages + running/total + last_pid
 * - /proc/diskstats — VFS storage statistics (JSON)
 * - /proc/mounts    — fstab-style mount table; df/mount/getmntent
 *                    parse this to enumerate filesystems.
 */

import { VfsError } from './inode.js';
import type { VirtualProvider } from './provider.js';

const PROC_FILES = new Set([
  'uptime', 'version', 'cpuinfo', 'meminfo', 'loadavg', 'diskstats', 'mounts',
]);

const VERSION_STRING = 'codepod 1.0.0 (WASI sandbox)\n';

export interface StorageStats {
  totalBytes: number;
  limitBytes: number | undefined;
  fileCount: number;
  fileCountLimit: number | undefined;
}

import type { MountEntry } from './provider.js';

export class ProcProvider implements VirtualProvider {
  readonly fsType = 'proc';

  private readonly createdAt: number;
  private readonly getStorageStats?: () => StorageStats;
  private readonly getMountList?: () => MountEntry[];

  constructor(
    getStorageStats?: () => StorageStats,
    getMountList?: () => MountEntry[],
  ) {
    this.createdAt = Date.now();
    this.getStorageStats = getStorageStats;
    this.getMountList = getMountList;
  }

  readFile(subpath: string): Uint8Array {
    const content = this.generateContent(subpath);
    return new TextEncoder().encode(content);
  }

  writeFile(subpath: string, _data: Uint8Array): void {
    if (subpath === '') {
      throw new VfsError('EISDIR', 'is a directory: /proc');
    }
    if (PROC_FILES.has(subpath)) {
      throw new VfsError('EROFS', `read-only file system: /proc/${subpath}`);
    }
    throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
  }

  exists(subpath: string): boolean {
    if (subpath === '') return true; // /proc itself
    return PROC_FILES.has(subpath);
  }

  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    if (subpath === '') {
      return { type: 'dir', size: PROC_FILES.size };
    }
    if (PROC_FILES.has(subpath)) {
      const content = this.generateContent(subpath);
      return { type: 'file', size: new TextEncoder().encode(content).byteLength };
    }
    throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
  }

  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    if (subpath !== '') {
      throw new VfsError('ENOTDIR', `not a directory: /proc/${subpath}`);
    }
    return Array.from(PROC_FILES).map(name => ({ name, type: 'file' as const }));
  }

  private generateContent(subpath: string): string {
    switch (subpath) {
      case 'uptime': {
        const seconds = (Date.now() - this.createdAt) / 1000;
        return `${seconds.toFixed(2)} ${seconds.toFixed(2)}\n`;
      }
      case 'version':
        return VERSION_STRING;
      case 'cpuinfo': {
        const cpuCount = this.getCpuCount();
        const entries: string[] = [];
        for (let i = 0; i < cpuCount; i++) {
          entries.push(
            `processor\t: ${i}\n` +
            `model name\t: WASI Virtual CPU\n` +
            `cpu MHz\t\t: 0.000\n` +
            ''
          );
        }
        return entries.join('\n');
      }
      case 'meminfo':
        return (
          'MemTotal:       2097152 kB\n' +
          'MemFree:        1048576 kB\n' +
          'MemAvailable:   1572864 kB\n' +
          'Buffers:          65536 kB\n' +
          'Cached:          524288 kB\n'
        );
      case 'loadavg': {
        // Format: "<1m> <5m> <15m> <runnable>/<total> <last_pid>"
        // We don't sample load yet — emit zeros for the averages and a
        // best-effort process count of 1 (the shell).  Real values land
        // with the per-PID /proc work + a kernel-side sampling loop.
        return '0.00 0.00 0.00 1/1 1\n';
      }
      case 'mounts': {
        // fstab(5) columns: fsname mountpoint fstype options dump pass.
        // Source the mount list from the VFS itself (it owns the
        // provider registry) so user-added mounts via vfs.mount() are
        // visible alongside the built-in /proc and /dev — this is what
        // df, mount(8), and getmntent expect.
        const entries = this.getMountList ? this.getMountList() : [];
        const lines = entries.map(e =>
          `${e.fsname} ${e.mountPath} ${e.fsType} ${e.options} 0 0`
        );
        return lines.length ? lines.join('\n') + '\n' : '';
      }
      case 'diskstats': {
        const stats = this.getStorageStats
          ? this.getStorageStats()
          : { totalBytes: 0, limitBytes: undefined, fileCount: 0, fileCountLimit: undefined };
        return JSON.stringify({
          totalBytes: stats.totalBytes,
          limitBytes: stats.limitBytes ?? 0,
          fileCount: stats.fileCount,
          fileCountLimit: stats.fileCountLimit ?? 0,
        }) + '\n';
      }
      default:
        throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
    }
  }

  private getCpuCount(): number {
    // Use navigator.hardwareConcurrency if available (browser), else 1
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
      return navigator.hardwareConcurrency;
    }
    return 1;
  }
}
