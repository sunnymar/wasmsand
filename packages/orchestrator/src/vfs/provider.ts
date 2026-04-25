/**
 * Interface for virtual filesystem providers.
 *
 * Providers handle synthetic mount points like /dev and /proc,
 * intercepting VFS operations before they reach the inode tree.
 */

export interface VirtualProvider {
  /**
   * Filesystem type label, surfaced through /proc/mounts and df.
   * Real Linux filesystems use short lowercase identifiers
   * (proc, devtmpfs, tmpfs, ext4, ...); we follow that convention.
   * Optional for back-compat with older user-mount providers; the VFS
   * substitutes a sensible default ('virtfs') when absent.
   */
  readonly fsType?: string;

  /** Read the contents of a file at the given subpath (relative to mount point). */
  readFile(subpath: string): Uint8Array;

  /** Write data to a file at the given subpath. */
  writeFile(subpath: string, data: Uint8Array): void;

  /** Check whether a file or directory exists at the given subpath. */
  exists(subpath: string): boolean;

  /** Return type and size information for the given subpath. */
  stat(subpath: string): { type: 'file' | 'dir'; size: number };

  /** List entries in a directory at the given subpath. */
  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }>;
}

/**
 * One entry in the mount table — the structured form behind /proc/mounts.
 * The fields match fstab(5) columns in the same order.
 */
export interface MountEntry {
  /** Source / "device" (typically the fs type name for synthetic mounts). */
  fsname: string;
  /** Mount point path (e.g. '/proc'). */
  mountPath: string;
  /** Filesystem type ('proc', 'devtmpfs', 'codepodfs', ...). */
  fsType: string;
  /** Mount options string (comma-joined, fstab-style). */
  options: string;
}
