import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createKernelImports, type KernelImportsOptions } from '../kernel-imports.js';
import { ProcessKernel } from '../../process/kernel.js';
import type { SandboxOptions } from '../../sandbox.js';
import type { SocketListenPolicy } from '../../network/socket-backend.js';

function writeString(memory: WebAssembly.Memory, ptr: number, value: string): number {
  const bytes = new TextEncoder().encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function readJson(memory: WebAssembly.Memory, ptr: number, len: number): unknown {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)));
}

describe('socket listener policy preparation', () => {
  it('accepts listener policy on sandbox and kernel options without enabling listen', () => {
    const listenPolicy: SocketListenPolicy = {
      allowLoopback: true,
      portMappings: [
        { sandboxHost: '0.0.0.0', sandboxPort: 8080, hostPort: 18080 },
      ],
      onListen: () => false,
    };
    const sandboxOptions = {
      wasmDir: '/tmp/wasm',
      serverSockets: listenPolicy,
    } satisfies SandboxOptions;
    expect(sandboxOptions.serverSockets).toBe(listenPolicy);

    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const kernelOptions = {
      memory,
      kernel,
      serverSockets: listenPolicy,
    } satisfies KernelImportsOptions;
    const imports = createKernelImports(kernelOptions);
    const fd = (imports.host_socket_open as (...args: number[]) => number)(2, 1, 0);
    const reqLen = writeString(memory, 16, JSON.stringify({
      fd,
      host: '127.0.0.1',
      port: 8080,
      backlog: 16,
    }));

    const len = (imports.host_socket_listen as (...args: number[]) => number)(16, reqLen, 256, 4096);

    expect(readJson(memory, 256, len)).toEqual({
      ok: false,
      error: 'server sockets are not implemented',
    });
  });
});
