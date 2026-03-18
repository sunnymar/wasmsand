/**
 * Minimal interface for shell command execution.
 *
 * ShellInstance (Rust WASM executor) implements this interface,
 * providing shell parsing and execution via WebAssembly.
 */

import type { RunResult } from './shell-types.js';
import type { HistoryEntry } from './history.js';

export interface StreamCallbacks {
  onStdout?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
}

export interface ShellLike {
  run(command: string): Promise<RunResult>;

  /** Set or clear streaming callbacks on pid 0 stdout/stderr buffer targets. */
  setOutputCallbacks?(callbacks: StreamCallbacks | null): void;

  // Environment
  getEnv(name: string): string | undefined;
  setEnv(name: string, value: string): void;
  getEnvMap(): Map<string, string>;
  setEnvMap(env: Map<string, string>): void;

  // History
  getHistory(): HistoryEntry[];
  clearHistory(): void;

  // Lifecycle
  cancel(reason: string): void;
  setDeadlineNow(): void;
  resetCancel(deadlineMs: number): void;

  destroy?(): void;
}
