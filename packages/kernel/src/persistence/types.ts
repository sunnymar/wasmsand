/**
 * Types for VFS state persistence (export/import).
 */

import type { PersistenceBackend } from './backend.js';

/** Serialized representation of the VFS + env state. */
export interface SerializedState {
  version: number;
  files: Array<{ path: string; data: string; type: 'file' | 'dir'; permissions?: number; uid?: number; gid?: number }>;
  env?: [string, string][];
  overlay?: {
    baseId: string;
    whiteouts: string[];
  };
}

export interface ExportStateOptions {
  /** Include bytes visible from read-only base layers instead of only upper changes. */
  includeBase?: boolean;
}

/** Configuration for sandbox persistence behaviour. */
export interface PersistenceOptions {
  mode: 'ephemeral' | 'session' | 'persistent';
  namespace?: string;
  autosaveMs?: number;
  /** Explicit backend. Auto-detected if not provided (IndexedDB in browser, filesystem in Node). */
  backend?: PersistenceBackend;
}
