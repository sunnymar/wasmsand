import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createKernelImports } from '../kernel-imports.js';
import { ProcessKernel } from '../../process/kernel.js';
import type { SocketBackend, SocketHandle } from '../../network/socket-backend.js';
import { WasiHost } from '../../wasi/wasi-host.js';
import { WASI_ESUCCESS } from '../../wasi/types.js';
import { VFS } from '../../vfs/vfs.js';

function writeString(memory: WebAssembly.Memory, ptr: number, value: string): number {
  const bytes = new TextEncoder().encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function readJson(memory: WebAssembly.Memory, ptr: number, len: number): unknown {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)));
}

describe('socket fd host imports', () => {
  it('tracks opaque backend handles on kernel fds and closes them through closeFd', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    const handle: SocketHandle = 77;
    const backend: SocketBackend = {
      connect(req) {
        requests.push({ op: 'connect', ...req });
        return { ok: true, socket: handle };
      },
      send(socket, dataB64) {
        requests.push({ op: 'send', socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: 3 };
      },
      recv(socket, maxBytes) {
        requests.push({ op: 'recv', socket, max_bytes: maxBytes });
        return { ok: true, data_b64: '' };
      },
      close(socket) {
        requests.push({ op: 'close', socket });
        return { ok: true };
      },
    };
    const imports = createKernelImports({ memory, kernel, socketBackend: backend });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(2, 1, 0);
    const reqLen = writeString(memory, 16, JSON.stringify({
      fd,
      host: '127.0.0.1',
      port: 9,
      tls: false,
    }));

    const connectLen = (imports.host_socket_connect as (...args: number[]) => number)(16, reqLen, 256, 4096);
    expect(readJson(memory, 256, connectLen)).toEqual({ ok: true });
    expect(kernel.getFdTarget(0, fd)).toMatchObject({ type: 'socket', socket: handle });

    expect((imports.host_close_fd as (...args: number[]) => number)(fd)).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'close', socket: handle });
    expect(kernel.getFdTarget(0, fd)).toBeNull();
  });

  it('routes WASI fd_read and fd_write for connected socket fds through the backend', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    const handle: SocketHandle = 77;
    const backend: SocketBackend = {
      connect(req) {
        requests.push({ op: 'connect', ...req });
        return { ok: true, socket: handle };
      },
      send(socket, dataB64) {
        requests.push({ op: 'send', socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: 4 };
      },
      recv(socket, maxBytes) {
        requests.push({ op: 'recv', socket, max_bytes: maxBytes });
        return { ok: true, data_b64: btoa('pong') };
      },
      close(socket) {
        requests.push({ op: 'close', socket });
        return { ok: true };
      },
    };
    const imports = createKernelImports({ memory, kernel, socketBackend: backend });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(2, 1, 0);
    const reqLen = writeString(memory, 16, JSON.stringify({
      fd,
      host: '127.0.0.1',
      port: 9,
      tls: false,
    }));
    (imports.host_socket_connect as (...args: number[]) => number)(16, reqLen, 256, 4096);

    const host = new WasiHost({
      vfs: new VFS(),
      args: ['socket-canary'],
      env: {},
      preopens: { '/': '/' },
      ioFds: kernel.getFdTable(0),
      kernel,
      pid: 0,
    });
    host.setMemory(memory);
    const wasi = host.getImports().wasi_snapshot_preview1;
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);

    writeString(memory, 512, 'ping');
    view.setUint32(32, 512, true);
    view.setUint32(36, 4, true);
    expect(wasi.fd_write(fd, 32, 1, 64)).toBe(WASI_ESUCCESS);
    expect(view.getUint32(64, true)).toBe(4);
    expect(requests.at(-1)).toEqual({ op: 'send', socket: handle, data_b64: btoa('ping') });

    view.setUint32(40, 600, true);
    view.setUint32(44, 8, true);
    expect(wasi.fd_read(fd, 40, 1, 68)).toBe(WASI_ESUCCESS);
    expect(view.getUint32(68, true)).toBe(4);
    expect(new TextDecoder().decode(bytes.subarray(600, 604))).toBe('pong');
    expect(requests.at(-1)).toEqual({ op: 'recv', socket: handle, max_bytes: 8 });
  });
});
