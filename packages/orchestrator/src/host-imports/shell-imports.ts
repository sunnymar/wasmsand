/**
 * Host import implementations for the shell WASM module.
 *
 * createShellImports() returns a record of functions that form the `codepod`
 * import namespace. Each function reads arguments from WASM linear memory,
 * performs the operation via VFS / ProcessManager, and writes results back.
 *
 * Note: host_spawn is stubbed for now. The real async-to-sync bridging
 * (using SAB + Atomics) will be wired up in Task 5 (ShellInstance).
 *
 * Note: host_read_command / host_write_result are placeholders. ShellInstance
 * (Task 5) will provide the real implementations.
 */

import type { VfsLike } from '../vfs/vfs-like.js';
import type { ProcessManager } from '../process/manager.js';
import { readString, readBytes, writeJson, writeString, writeBytes } from './common.js';

// Error codes matching Rust's rc_to_error convention
const ERR_NOT_FOUND = -1;
const _ERR_PERMISSION_DENIED = -2;
const ERR_IO = -3;

export interface ShellImportsOptions {
  vfs: VfsLike;
  mgr: ProcessManager;
  memory: WebAssembly.Memory;
  /** Called when the shell requests a cancellation check. */
  checkCancel?: () => number; // 0 = ok, 1 = timeout, 2 = cancelled
}

export function createShellImports(opts: ShellImportsOptions): Record<string, WebAssembly.ImportValue> {
  const { vfs, mgr, memory } = opts;

  return {
    // ── Process lifecycle ──

    host_spawn(
      cmdPtr: number, cmdLen: number,
      argsPtr: number, argsLen: number,
      _envPtr: number, _envLen: number,
      _stdinPtr: number, _stdinLen: number,
      _cwdPtr: number, _cwdLen: number,
      outPtr: number, outCap: number,
    ): number {
      const cmd = readString(memory, cmdPtr, cmdLen);
      const argsJson = readString(memory, argsPtr, argsLen);

      let args: string[];
      try {
        const parsed: unknown = JSON.parse(argsJson);
        if (Array.isArray(parsed)) {
          args = parsed as string[];
        } else if (parsed !== null && typeof parsed === 'object') {
          const req = parsed as Record<string, unknown>;
          args = (req.args as string[] | undefined) ?? [];
        } else {
          args = [];
        }
      } catch {
        args = [];
      }

      // mgr.spawn() is async. In the full implementation this will use
      // SAB + Atomics to block the WASM thread until the host resolves.
      // For v1 testing, return a placeholder result.
      try {
        void args; // will be used once async bridging is wired
        const result = {
          exit_code: 0,
          stdout: '',
          stderr: `${cmd}: spawn not yet wired\n`,
          execution_time_ms: 0,
        };
        return writeJson(memory, outPtr, outCap, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const result = {
          exit_code: 127,
          stdout: '',
          stderr: `${cmd}: ${msg}\n`,
          execution_time_ms: 0,
        };
        return writeJson(memory, outPtr, outCap, result);
      }
    },

    host_has_tool(namePtr: number, nameLen: number): number {
      const name = readString(memory, namePtr, nameLen);
      return mgr.hasTool(name) ? 1 : 0;
    },

    host_check_cancel(): number {
      return opts.checkCancel?.() ?? 0;
    },

    host_time_ms(): bigint {
      return BigInt(Date.now());
    },

    // ── Filesystem ──

    host_stat(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        const s = vfs.stat(path);
        const info = {
          type: s.type,
          size: s.size,
          mode: s.permissions,
        };
        return writeJson(memory, outPtr, outCap, info);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_read_file(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        const data = vfs.readFile(path);
        return writeBytes(memory, outPtr, outCap, data);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_write_file(
      pathPtr: number, pathLen: number,
      dataPtr: number, dataLen: number,
      mode: number,
    ): number {
      const path = readString(memory, pathPtr, pathLen);
      const data = readBytes(memory, dataPtr, dataLen);
      try {
        if (mode === 1) {
          // Append mode
          try {
            const existing = vfs.readFile(path);
            const combined = new Uint8Array(existing.length + data.length);
            combined.set(existing);
            combined.set(data, existing.length);
            vfs.writeFile(path, combined);
          } catch {
            // File doesn't exist yet — create it
            vfs.writeFile(path, data);
          }
        } else {
          // Truncate mode (mode 0)
          vfs.writeFile(path, data);
        }
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_readdir(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        const entries = vfs.readdir(path).map(e => e.name);
        return writeJson(memory, outPtr, outCap, entries);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_mkdir(pathPtr: number, pathLen: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        vfs.mkdir(path);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_remove(pathPtr: number, pathLen: number, recursive: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        if (recursive) {
          vfs.rmdir(path);
        } else {
          try {
            vfs.unlink(path);
          } catch {
            vfs.rmdir(path);
          }
        }
        return 0;
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_chmod(pathPtr: number, pathLen: number, mode: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        vfs.chmod(path, mode);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_glob(
      _patternPtr: number, _patternLen: number,
      _cwdPtr: number, _cwdLen: number,
      outPtr: number, outCap: number,
    ): number {
      // Glob is complex -- stub for now, will implement in Phase 2
      return writeJson(memory, outPtr, outCap, []);
    },

    host_rename(fromPtr: number, fromLen: number, toPtr: number, toLen: number): number {
      const from = readString(memory, fromPtr, fromLen);
      const to = readString(memory, toPtr, toLen);
      try {
        vfs.rename(from, to);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_symlink(targetPtr: number, targetLen: number, linkPtr: number, linkLen: number): number {
      const target = readString(memory, targetPtr, targetLen);
      const link = readString(memory, linkPtr, linkLen);
      try {
        vfs.symlink(target, link);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_readlink(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        const target = vfs.readlink(path);
        return writeString(memory, outPtr, outCap, target);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    // ── Shell session ──
    // These are placeholders -- ShellInstance (Task 5) will provide the
    // real implementations that wire into the command loop.

    host_read_command(outPtr: number, outCap: number): number {
      void outPtr;
      void outCap;
      // Placeholder -- ShellInstance will override this
      return 0;
    },

    host_write_result(resultPtr: number, resultLen: number): void {
      void resultPtr;
      void resultLen;
      // Placeholder -- ShellInstance will override this
    },
  };
}
