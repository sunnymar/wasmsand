#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtures = resolve(root, 'packages/orchestrator/src/platform/__tests__/fixtures');

const [{ Sandbox }, { NodeAdapter }] = await Promise.all([
  import(new URL('../packages/orchestrator/dist/index.js', import.meta.url)),
  import(new URL('../packages/orchestrator/dist/node-adapter.js', import.meta.url)),
]);

const engine = typeof Bun !== 'undefined' ? 'bun' : 'node';
const allowKnownBunGaps = engine === 'bun' &&
  process.env.CODEPOD_ALLOW_KNOWN_BUN_ASYNC_GAPS === '1';

async function assertRun(sandbox, name, command, expectedStdout, { knownBunGap = false } = {}) {
  const result = await sandbox.run(command);
  const passed = result.exitCode === 0 && result.stdout === expectedStdout;
  if (passed) {
    console.log(`[${engine}] ok: ${name}`);
    return;
  }
  if (knownBunGap && allowKnownBunGaps) {
    console.warn(
      `[${engine}] known gap: ${name}: exit=${result.exitCode} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
    return;
  }
  assert.equal(result.exitCode, 0, `${name} exit: stderr=${result.stderr}`);
  assert.equal(result.stdout, expectedStdout, `${name} stdout`);
}

const sandbox = await Sandbox.create({
  wasmDir: fixtures,
  adapter: new NodeAdapter(),
  timeoutMs: 30_000,
  fsLimitBytes: 256 * 1024 * 1024,
});

try {
  await assertRun(sandbox, 'resident bash builtin', `echo ${engine}-ok`, `${engine}-ok\n`);
  await assertRun(sandbox, 'pipeline subprocess', `echo ${engine}-pipe | cat`, `${engine}-pipe\n`, {
    knownBunGap: true,
  });
  await assertRun(sandbox, 'python subprocess', 'python3 -c "print(123)"', '123\n', {
    knownBunGap: true,
  });
} finally {
  sandbox.destroy();
}
