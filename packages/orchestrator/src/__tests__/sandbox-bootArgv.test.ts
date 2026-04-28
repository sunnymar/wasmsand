import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { resolve } from 'node:path';
import { NodeAdapter } from '../platform/node-adapter.ts';
import { Sandbox } from '../sandbox.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

Deno.test('Sandbox.create accepts bootArgv and exposes sandbox.process(1)', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: ['/bin/bash'],
  });
  try {
    const p = sb.process(1);
    assert(p, 'sandbox.process(1) should return a Process');
    assertEquals(p.pid, 1);
    assertEquals(p.mode, 'resident');
    assert(typeof p.callExport === 'function');
  } finally {
    sb.destroy();
  }
});

Deno.test('Sandbox.create defaults bootArgv to /bin/bash for compat', async () => {
  const sb = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
  try {
    const p = sb.process(1);
    assert(p, 'PID 1 should exist with default bootArgv');
  } finally {
    sb.destroy();
  }
});

Deno.test('Sandbox creates exactly one bash instance for PID 1', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: ['/bin/bash'],
  });
  try {
    const procFromSandbox = sb.process(1)!;
    const procFromShell = sb.__getShellInstanceProcess();
    assert(
      procFromSandbox === procFromShell,
      'sandbox.process(1) and ShellInstance.process must be the same Process',
    );
  } finally {
    sb.destroy();
  }
});
