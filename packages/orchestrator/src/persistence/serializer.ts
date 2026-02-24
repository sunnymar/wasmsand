/**
 * VFS state serializer.
 *
 * Binary format:
 *   [4 bytes: magic "WSND" = 0x57, 0x53, 0x4E, 0x44]
 *   [4 bytes: version = 1, little-endian uint32]
 *   [rest:    JSON UTF-8 encoded SerializedState]
 *
 * Files are base64-encoded; directories use an empty data string.
 * Virtual provider paths (/dev, /proc) are excluded from export.
 */

import type { VfsLike } from '../vfs/vfs-like.js';
import type { SerializedState } from './types.js';

/** Magic bytes identifying a serialized state blob. */
const MAGIC = new Uint8Array([0x57, 0x53, 0x4e, 0x44]); // "WSND"

/** Current format version. */
const FORMAT_VERSION = 1;

/** Header size: 4 bytes magic + 4 bytes version. */
const HEADER_SIZE = 8;

/** Paths whose subtrees are virtual providers and must not be serialized. */
const EXCLUDED_PREFIXES = ['/dev', '/proc'];

/**
 * Export the full VFS state (files + directories) and optional env vars
 * into a self-describing binary blob.
 */
export function exportState(vfs: VfsLike, env?: Map<string, string>): Uint8Array {
  const files: SerializedState['files'] = [];
  walkTree(vfs, '/', files);

  const state: SerializedState = {
    version: FORMAT_VERSION,
    files,
  };

  if (env && env.size > 0) {
    state.env = Array.from(env);
  }

  const json = JSON.stringify(state);
  const jsonBytes = new TextEncoder().encode(json);

  const blob = new Uint8Array(HEADER_SIZE + jsonBytes.byteLength);

  // Write magic
  blob.set(MAGIC, 0);

  // Write version (little-endian uint32)
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  view.setUint32(4, FORMAT_VERSION, true);

  // Write JSON payload
  blob.set(jsonBytes, HEADER_SIZE);

  return blob;
}

/**
 * Import a previously exported state blob into a VFS.
 *
 * Directories are created first (via mkdirp), then files are written.
 * All mutations go through `vfs.withWriteAccess()` to bypass read-only
 * path restrictions.
 *
 * Returns the restored environment map if one was stored in the blob.
 */
export function importState(vfs: VfsLike, blob: Uint8Array): { env?: Map<string, string> } {
  if (blob.byteLength < HEADER_SIZE) {
    throw new Error('Invalid state blob: too short');
  }

  // Validate magic
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) {
      throw new Error('Invalid state blob: bad magic bytes');
    }
  }

  // Validate version
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const version = view.getUint32(4, true);
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported state version: ${version}`);
  }

  // Parse JSON payload
  const jsonBytes = blob.subarray(HEADER_SIZE);
  const json = new TextDecoder().decode(jsonBytes);
  const state: SerializedState = JSON.parse(json);

  // Restore filesystem: directories first, then files
  vfs.withWriteAccess(() => {
    for (const entry of state.files) {
      if (entry.type === 'dir') {
        vfs.mkdirp(entry.path);
      }
    }
    for (const entry of state.files) {
      if (entry.type === 'file') {
        const content = Buffer.from(entry.data, 'base64');
        vfs.writeFile(entry.path, new Uint8Array(content));
      }
    }
  });

  // Restore env
  if (state.env) {
    return { env: new Map(state.env) };
  }

  return {};
}

/**
 * Recursively walk the VFS tree starting at `dirPath`, collecting
 * file and directory entries. Skips excluded virtual provider paths.
 */
function walkTree(
  vfs: VfsLike,
  dirPath: string,
  out: SerializedState['files'],
): void {
  const entries = vfs.readdir(dirPath);

  for (const entry of entries) {
    const childPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;

    // Skip virtual provider subtrees
    if (EXCLUDED_PREFIXES.some(prefix => childPath === prefix || childPath.startsWith(prefix + '/'))) {
      continue;
    }

    if (entry.type === 'dir') {
      out.push({ path: childPath, data: '', type: 'dir' });
      walkTree(vfs, childPath, out);
    } else if (entry.type === 'file') {
      const content = vfs.readFile(childPath);
      const b64 = Buffer.from(content).toString('base64');
      out.push({ path: childPath, data: b64, type: 'file' });
    }
    // Skip symlinks — not part of the persistence spec
  }
}
