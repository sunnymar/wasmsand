/**
 * Python socket/ssl module shims for the sandbox.
 *
 * These shims are written to the VFS at /usr/lib/python/ by Sandbox.create()
 * when networking is enabled. They shadow RustPython's frozen modules via
 * PYTHONPATH and sitecustomize.py injection.
 *
 * Source files live in ./python-shims/ as static .py files.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'python-shims');

/** Read a Python shim file from the python-shims directory. */
function readShim(filename: string): string {
  return readFileSync(join(SHIM_DIR, filename), 'utf-8');
}

/**
 * Get the socket shim source for the given network mode.
 * - `restricted`: HTTP-level interception via _codepod.fetch()
 * - `full`: real socket proxy via _codepod.socket_*() (when available)
 */
export function getSocketShimSource(mode: 'restricted' | 'full' = 'restricted'): string {
  const filename = mode === 'full' ? 'socket_native.py' : 'socket_fetch.py';
  return readShim(filename);
}

/** Get the ssl shim source (works in both modes). */
export function getSslShimSource(): string {
  return readShim('ssl.py');
}

/** Get the sitecustomize.py source that injects shims at startup. */
export function getSiteCustomizeSource(): string {
  return readShim('sitecustomize.py');
}

// Backward-compatible exports — read once at module load
export const SOCKET_SHIM_SOURCE = readShim('socket_fetch.py');
export const SSL_SHIM_SOURCE = readShim('ssl.py');
export const SITE_CUSTOMIZE_SOURCE = readShim('sitecustomize.py');
