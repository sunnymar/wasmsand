/**
 * Host import implementations for the shell WASM module.
 *
 * createShellImports() returns a record of functions that form the `codepod`
 * import namespace. Each function reads arguments from WASM linear memory,
 * performs the operation via VFS / ProcessManager, and writes results back.
 *
 * Note: host_spawn supports a syncSpawn callback for synchronous testing.
 * The real async-to-sync bridging (using SAB + Atomics) will be wired up later.
 */

import type { VfsLike } from '../vfs/vfs-like.js';
import type { ProcessManager } from '../process/manager.js';
import type { NetworkBridgeLike } from '../network/bridge.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import { readString, readBytes, writeJson, writeString, writeBytes } from './common.js';

// Error codes matching Rust's rc_to_error convention
const ERR_NOT_FOUND = -1;
const _ERR_PERMISSION_DENIED = -2;
const ERR_IO = -3;

// ── Glob helpers ──

/**
 * Convert a glob pattern to a RegExp.
 * Supports: * (any non-/ chars), ? (single non-/ char), [abc], [!abc]/[^abc],
 * and ** (matches any path segments including /).
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches everything including /
        re += '.*';
        i += 2;
        // Skip a trailing / after ** (e.g. **/ matches zero or more dirs)
        if (pattern[i] === '/') i++;
      } else {
        // * matches anything except /
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      // Character class — find the closing ]
      let j = i + 1;
      // Handle negation
      if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) j++;
      // Handle ] as first char in class
      if (j < pattern.length && pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j++;
      if (j >= pattern.length) {
        // No closing ] — treat [ as literal
        re += '\\[';
        i++;
      } else {
        let cls = pattern.slice(i + 1, j);
        // Convert [!...] to [^...]
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = j + 1;
      }
    } else if ('.+^${}()|\\'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Extract the base directory from a glob pattern.
 * This is everything up to (but not including) the path component
 * that contains the first glob metacharacter (*, ?, [).
 */
function globBaseDir(pattern: string): string {
  const parts = pattern.split('/');
  const base: string[] = [];
  for (const part of parts) {
    if (/[*?[\]]/.test(part)) break;
    base.push(part);
  }
  const dir = base.join('/');
  if (dir === '') return pattern.startsWith('/') ? '/' : '.';
  return dir;
}

/**
 * Recursively collect all file and directory paths under a given directory.
 */
function walkVfs(vfs: VfsLike, dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = vfs.readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = dir === '/' ? '/' + entry.name : dir + '/' + entry.name;
    results.push(fullPath);
    if (entry.type === 'dir') {
      results.push(...walkVfs(vfs, fullPath));
    }
  }
  return results;
}

/**
 * Perform glob matching against the VFS.
 * Returns an array of matching absolute paths, sorted.
 */
function globMatch(vfs: VfsLike, pattern: string): string[] {
  // Normalize: ensure pattern is absolute
  const absPattern = pattern.startsWith('/') ? pattern : '/' + pattern;

  const baseDir = globBaseDir(absPattern);
  const regex = globToRegExp(absPattern);

  // Walk from the base directory
  const allPaths = walkVfs(vfs, baseDir);
  const matches = allPaths.filter(p => regex.test(p));
  matches.sort();
  return matches;
}

export interface ShellImportsOptions {
  vfs: VfsLike;
  mgr: ProcessManager;
  memory: WebAssembly.Memory;
  /** Called when the shell requests a cancellation check. */
  checkCancel?: () => number; // 0 = ok, 1 = timeout, 2 = cancelled
  /** Synchronous spawn handler. If provided, host_spawn calls this instead of mgr.spawn(). */
  syncSpawn?: (cmd: string, args: string[], env: Record<string, string>, stdin: Uint8Array, cwd: string) => { exit_code: number; stdout: string; stderr: string };
  /** Network bridge for synchronous HTTP fetch from WASM. */
  networkBridge?: NetworkBridgeLike;
  /** Extension registry for command extensions. */
  extensionRegistry?: ExtensionRegistry;
  /** Tool allowlist for security policy. If set, only listed tools/extensions are allowed. */
  toolAllowlist?: string[];
}

export function createShellImports(opts: ShellImportsOptions): Record<string, WebAssembly.ImportValue> {
  const { vfs, mgr, memory } = opts;

  return {
    // ── Process lifecycle ──

    // Rust signature: host_spawn(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32
    // The request is a JSON-encoded SpawnRequest with fields: program, args, env, cwd, stdin
    host_spawn(
      reqPtr: number, reqLen: number,
      outPtr: number, outCap: number,
    ): number {
      const reqJson = readString(memory, reqPtr, reqLen);

      let req: { program?: string; args?: string[]; env?: [string, string][]; cwd?: string; stdin?: string };
      try { req = JSON.parse(reqJson); } catch { req = {}; }

      const cmd = req.program ?? '';
      const args = req.args?.map(String) ?? [];
      const env: Record<string, string> = {};
      if (req.env) for (const [k, v] of req.env) env[k] = v;
      const cwd = req.cwd ?? '/';
      const stdinStr = req.stdin ?? '';
      const stdin = new TextEncoder().encode(stdinStr);

      if (opts.syncSpawn) {
        try {
          const result = opts.syncSpawn(cmd, args, env, stdin, cwd);
          return writeJson(memory, outPtr, outCap, result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return writeJson(memory, outPtr, outCap, {
            exit_code: 127,
            stdout: '',
            stderr: `${cmd}: ${msg}\n`,
          });
        }
      }

      // Fallback: return error (async spawn not wired yet)
      return writeJson(memory, outPtr, outCap, {
        exit_code: 127,
        stdout: '',
        stderr: `${cmd}: async spawn not available\n`,
      });
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
          exists: true,
          is_file: s.type === 'file',
          is_dir: s.type === 'dir',
          is_symlink: s.type === 'symlink',
          size: s.size,
          mode: s.permissions,
          mtime_ms: s.mtime ? s.mtime.getTime() : 0,
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
      patternPtr: number, patternLen: number,
      outPtr: number, outCap: number,
    ): number {
      const pattern = readString(memory, patternPtr, patternLen);
      try {
        const matches = globMatch(vfs, pattern);
        return writeJson(memory, outPtr, outCap, matches);
      } catch {
        return writeJson(memory, outPtr, outCap, []);
      }
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

    // ── Network / Extensions ──

    // host_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Synchronous HTTP fetch via NetworkBridge (SAB+Atomics).
    host_fetch(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      const reqJson = readString(memory, reqPtr, reqLen);

      if (!opts.networkBridge) {
        return writeJson(memory, outPtr, outCap, {
          ok: false, status: 0, headers: [], body: '',
          error: 'network access not configured',
        });
      }

      try {
        const req = JSON.parse(reqJson) as {
          url?: string;
          method?: string;
          headers?: [string, string][];
          body?: string | null;
        };
        const url = req.url ?? '';
        const method = req.method ?? 'GET';
        const hdrs: Record<string, string> = {};
        if (req.headers) {
          for (const [k, v] of req.headers) hdrs[k] = v;
        }
        const body = req.body ?? undefined;

        const result = opts.networkBridge.fetchSync(url, method, hdrs, body);

        // Convert headers object to array of tuples for Rust FetchResult
        const headerPairs: [string, string][] = Object.entries(result.headers ?? {});

        return writeJson(memory, outPtr, outCap, {
          ok: !result.error && result.status >= 200 && result.status < 400,
          status: result.status,
          headers: headerPairs,
          body: result.body ?? '',
          error: result.error ?? null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, {
          ok: false, status: 0, headers: [], body: '', error: msg,
        });
      }
    },

    // host_is_extension(name_ptr, name_len) -> i32
    // Synchronous check — Map.has() lookup + tool allowlist check.
    host_is_extension(namePtr: number, nameLen: number): number {
      const name = readString(memory, namePtr, nameLen);
      if (!opts.extensionRegistry?.has(name)) return 0;
      // If tool allowlist is set, only allow extensions in the list
      if (opts.toolAllowlist && !opts.toolAllowlist.includes(name)) return 0;
      return 1;
    },

    // host_extension_invoke(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Returns a Promise — JSPI suspends WASM, awaits the extension handler,
    // then resumes WASM with the result.
    async host_extension_invoke(
      reqPtr: number, reqLen: number,
      outPtr: number, outCap: number,
    ): Promise<number> {
      const reqJson = readString(memory, reqPtr, reqLen);

      if (!opts.extensionRegistry) {
        return writeJson(memory, outPtr, outCap, {
          exit_code: 1, stdout: '', stderr: 'extensions not available\n',
        });
      }

      try {
        const req = JSON.parse(reqJson) as {
          name?: string;
          args?: string[];
          stdin?: string;
          env?: [string, string][];
          cwd?: string;
        };

        const name = req.name ?? '';
        const args = req.args ?? [];
        const stdin = req.stdin ?? '';
        const envObj: Record<string, string> = {};
        if (req.env) for (const [k, v] of req.env) envObj[k] = v;
        const cwd = req.cwd ?? '/';

        const result = await opts.extensionRegistry.invoke(name, {
          args, stdin, env: envObj, cwd,
        });

        return writeJson(memory, outPtr, outCap, {
          exit_code: result.exitCode,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, {
          exit_code: 1, stdout: '', stderr: `${msg}\n`,
        });
      }
    },

    // host_register_tool(name_ptr, name_len, path_ptr, path_len) -> i32
    // Register a pkg-installed tool with the process manager.
    host_register_tool(
      namePtr: number, nameLen: number,
      pathPtr: number, pathLen: number,
    ): number {
      const name = readString(memory, namePtr, nameLen);
      const path = readString(memory, pathPtr, pathLen);
      try {
        mgr.registerTool(name, path);
        return 0;
      } catch {
        return ERR_IO;
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
