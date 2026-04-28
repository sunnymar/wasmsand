import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { resolve } from 'node:path';
import { Sandbox } from '../../orchestrator/src/sandbox.ts';
import { NodeAdapter } from '../../orchestrator/src/platform/node-adapter.ts';
import { bashBootImports } from './bash-host-imports.ts';
import { makeRunCommandHandler, runCommand } from './bash-dispatch.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../../orchestrator/src/platform/__tests__/fixtures');

Deno.test('runCommand drives PID 1 through the bash protocol', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootImports: (api) => bashBootImports(api),
    runCommandHandler: makeRunCommandHandler(),
  } as Parameters<typeof Sandbox.create>[0] & Record<string, unknown>);
  try {
    const result = await runCommand(sb, 'echo hello');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'hello\n');
  } finally {
    sb.destroy();
  }
});

Deno.test('runCommand threads stdin through PID 1 fd 0', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootImports: (api) => bashBootImports(api),
    runCommandHandler: makeRunCommandHandler(),
  } as Parameters<typeof Sandbox.create>[0] & Record<string, unknown>);
  try {
    const result = await runCommand(sb, 'cat', { stdin: 'hello stdin\n' });
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'hello stdin\n');
  } finally {
    sb.destroy();
  }
});

Deno.test('runCommand syncs host-set env into PID 1', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootImports: (api) => bashBootImports(api),
    runCommandHandler: makeRunCommandHandler(),
  } as Parameters<typeof Sandbox.create>[0] & Record<string, unknown>);
  try {
    sb.setEnv('HOST_SET_VALUE', 'from-host');
    const result = await runCommand(sb, 'echo $HOST_SET_VALUE');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'from-host\n');
  } finally {
    sb.destroy();
  }
});

Deno.test('makeRunCommandHandler uses a fresh resident bash for nested subprocess calls', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootImports: (api) => bashBootImports(api),
    runCommandHandler: makeRunCommandHandler(),
  } as Parameters<typeof Sandbox.create>[0] & Record<string, unknown>);
  try {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('deadlock detected')), 30_000);
    });
    const result = await Promise.race([
      runCommand(
        sb,
        'python3 -c "import _codepod; print(_codepod.spawn(\'echo nested\')[\'stdout\'], end=\'\')"',
      ),
      timeout,
    ]).finally(() => clearTimeout(timer));
    assertEquals(result.exitCode, 0);
    assert(result.stdout.includes('nested'));
  } finally {
    sb.destroy();
  }
});
