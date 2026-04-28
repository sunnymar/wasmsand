import type { KernelApi } from '../../orchestrator/src/kernel-api.ts';

const ERR_NOT_FOUND = -1;
const ERR_IO = -3;

function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      let j = i + 1;
      if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) j++;
      if (j < pattern.length && pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j++;
      if (j >= pattern.length) {
        re += '\\[';
        i++;
      } else {
        let cls = pattern.slice(i + 1, j);
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

function walkVfs(api: KernelApi, dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = api.vfs.readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = dir === '/' ? '/' + entry.name : dir + '/' + entry.name;
    results.push(fullPath);
    if (entry.type === 'dir') {
      results.push(...walkVfs(api, fullPath));
    }
  }
  return results;
}

function globMatch(api: KernelApi, pattern: string): string[] {
  const absPattern = pattern.startsWith('/') ? pattern : '/' + pattern;
  const baseDir = globBaseDir(absPattern);
  const regex = globToRegExp(absPattern);
  const matches = walkVfs(api, baseDir).filter((p) => regex.test(p));
  matches.sort();
  return matches;
}

export function bashBootImports(api: KernelApi): Record<string, WebAssembly.ImportValue> {
  return {
    host_has_tool(namePtr: number, nameLen: number): number {
      const name = api.memory.readString(namePtr, nameLen);
      return api.processManager.hasTool(name) ? 1 : 0;
    },

    host_time(): number {
      return api.time.now();
    },

    host_stat(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        const s = api.vfs.stat(path);
        return api.memory.writeJson({
          exists: true,
          is_file: s.type === 'file',
          is_dir: s.type === 'dir',
          is_symlink: s.type === 'symlink',
          size: s.size,
          mode: s.permissions,
          mtime_ms: s.mtime ? s.mtime.getTime() : 0,
        }, outPtr, outCap);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_read_file(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        return api.memory.writeBytes(api.vfs.readFile(path), outPtr, outCap);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_write_file(pathPtr: number, pathLen: number, dataPtr: number, dataLen: number, mode: number): number {
      const path = api.memory.readString(pathPtr, pathLen);
      const data = api.memory.readBytes(dataPtr, dataLen);
      try {
        if (mode === 1) {
          try {
            const existing = api.vfs.readFile(path);
            const combined = new Uint8Array(existing.length + data.length);
            combined.set(existing);
            combined.set(data, existing.length);
            api.vfs.writeFile(path, combined);
          } catch {
            api.vfs.writeFile(path, data);
          }
        } else {
          api.vfs.writeFile(path, data);
        }
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_readdir(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        return api.memory.writeJson(api.vfs.readdir(path).map((e) => e.name), outPtr, outCap);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_mkdir(pathPtr: number, pathLen: number): number {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        api.vfs.mkdir(path);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_remove(pathPtr: number, pathLen: number, recursive: number): number {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        if (recursive) {
          api.vfs.rmdir(path);
        } else {
          try {
            api.vfs.unlink(path);
          } catch {
            api.vfs.rmdir(path);
          }
        }
        return 0;
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_chmod(pathPtr: number, pathLen: number, mode: number): number {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        api.vfs.chmod(path, mode);
        return 0;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '';
        return msg.includes('ENOENT') || msg.includes('no such file') ? ERR_NOT_FOUND : ERR_IO;
      }
    },

    host_glob(patternPtr: number, patternLen: number, outPtr: number, outCap: number): number {
      const pattern = api.memory.readString(patternPtr, patternLen);
      try {
        return api.memory.writeJson(globMatch(api, pattern), outPtr, outCap);
      } catch {
        return api.memory.writeJson([], outPtr, outCap);
      }
    },

    host_rename(fromPtr: number, fromLen: number, toPtr: number, toLen: number): number {
      const from = api.memory.readString(fromPtr, fromLen);
      const to = api.memory.readString(toPtr, toLen);
      try {
        api.vfs.rename(from, to);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_symlink(targetPtr: number, targetLen: number, linkPtr: number, linkLen: number): number {
      const target = api.memory.readString(targetPtr, targetLen);
      const link = api.memory.readString(linkPtr, linkLen);
      try {
        api.vfs.symlink(target, link);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_readlink(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        return api.memory.writeString(api.vfs.readlink(path), outPtr, outCap);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    async host_register_tool(namePtr: number, nameLen: number, pathPtr: number, pathLen: number): Promise<number> {
      const name = api.memory.readString(namePtr, nameLen);
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        if (name.startsWith('__native__')) {
          await api.processManager.registerNativeModule(name.slice('__native__'.length), api.vfs.readFile(path));
          return 0;
        }
        await api.processManager.registerAndLoadTool(name, path);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_read_command(outPtr: number, outCap: number): number {
      void outPtr;
      void outCap;
      return 0;
    },

    host_write_result(resultPtr: number, resultLen: number): void {
      void resultPtr;
      void resultLen;
    },
  };
}
