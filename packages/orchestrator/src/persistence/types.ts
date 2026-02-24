/**
 * Types for VFS state persistence (export/import).
 */

/** Serialized representation of the VFS + env state. */
export interface SerializedState {
  version: number;
  files: Array<{ path: string; data: string; type: 'file' | 'dir' }>;
  env?: [string, string][];
}

/** Configuration for sandbox persistence behaviour. */
export interface PersistenceOptions {
  mode: 'ephemeral' | 'session' | 'persistent';
  namespace?: string;
  autosaveMs?: number;
}
