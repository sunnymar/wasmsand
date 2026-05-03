import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { resolve } from 'node:path';
import { NodeAdapter } from '../platform/node-adapter.ts';
import { Sandbox } from '../sandbox.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');
const BOOT_WASM = `${WASM_DIR}/true-cmd.wasm`;

async function createSpawnTestSandbox(
  adapter: NodeAdapter,
  options: Parameters<typeof Sandbox.create>[0] = { wasmDir: WASM_DIR },
): Promise<Sandbox> {
  return await Sandbox.create({
    ...options,
    wasmDir: WASM_DIR,
    adapter,
    bootWasmPath: BOOT_WASM,
    bootArgv: ['/bin/boot'],
  });
}

Deno.test('sandbox.spawn can create an explicit resident process', async () => {
  const adapter = new NodeAdapter();
  const sb = await createSpawnTestSandbox(adapter);
  try {
    sb.writeFile('/tmp/true.wasm', await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`));
    const child = await sb.spawn(['/tmp/true.wasm'], { mode: 'resident' });
    assertEquals(child.mode, 'resident');
    assert(child.pid > 1, 'spawned child should have pid > 1 (PID 1 is sandbox init)');
    await child.terminate();
  } finally {
    sb.destroy();
  }
});

Deno.test('sandbox.spawn without a mode runs top-level _start to completion', async () => {
  const adapter = new NodeAdapter();
  const sb = await createSpawnTestSandbox(adapter);
  try {
    sb.writeFile('/tmp/true.wasm', await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`));
    const child = await sb.spawn(['/tmp/true.wasm']);
    assertEquals(child.mode, 'cli');
    assertEquals(child.exitCode, 0);
  } finally {
    sb.destroy();
  }
});

Deno.test('sandbox.spawn without a mode preserves captured stdout', async () => {
  const adapter = new NodeAdapter();
  const sb = await createSpawnTestSandbox(adapter);
  try {
    sb.writeFile('/tmp/echo-args.wasm', await adapter.readBytes(`${WASM_DIR}/echo-args.wasm`));
    const child = await sb.spawn(['/tmp/echo-args.wasm', 'hello', 'world']);
    assertEquals(child.exitCode, 0);
    assertEquals(child.fdReadAndClear(1).data, 'hello\nworld\n');
  } finally {
    sb.destroy();
  }
});

Deno.test('sandbox.spawn without a mode releases process slot after exit', async () => {
  const adapter = new NodeAdapter();
  const sb = await createSpawnTestSandbox(adapter, {
    wasmDir: WASM_DIR,
    security: { limits: { processes: 2 } },
  });
  try {
    sb.writeFile('/tmp/true.wasm', await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`));

    const first = await sb.spawn(['/tmp/true.wasm']);
    assertEquals(first.exitCode, 0);

    const second = await sb.spawn(['/tmp/true.wasm']);
    assertEquals(second.exitCode, 0);
  } finally {
    sb.destroy();
  }
});
