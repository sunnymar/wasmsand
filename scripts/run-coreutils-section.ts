#!/usr/bin/env -S deno run -A
/**
 * Internal helper: run a single register_*_tests() section from test_coreutils.py
 * inside a codepod sandbox, print PASS/FAIL/SKIP lines, exit.
 *
 * Usage: deno run -A run-coreutils-section.ts <section_name>
 *
 * Output: PASS/FAIL/SKIP lines to stdout, one per test.
 * Exit 0 = success (even with test failures). Exit 1 = infrastructure error.
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Sandbox } from '../packages/orchestrator/src/sandbox.js';
import { NodeAdapter } from '../packages/orchestrator/src/platform/node-adapter.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/orchestrator/src/platform/__tests__/fixtures');
const TEST_SCRIPT = resolve(REPO_ROOT, 'packages/coreutils/tests/test_coreutils.py');

const section = Deno.args[0];
if (!section) {
  console.error('Usage: run-coreutils-section.ts <section_name>');
  Deno.exit(1);
}

const sectionRunner = [
  '#!/usr/bin/env python3',
  'import sys, importlib.util',
  'spec = importlib.util.spec_from_file_location("test_coreutils", "/tmp/test_coreutils.py")',
  'mod = importlib.util.module_from_spec(spec)',
  'mod.__name__ = "test_coreutils"',
  'spec.loader.exec_module(mod)',
  `mod.${section}()`,
  'print(f"\\nSection results: {mod.passed} passed, {mod.failed} failed, {mod.skipped} skipped")',
].join('\n');

const testScriptBytes = new Uint8Array(readFileSync(TEST_SCRIPT));

const sandbox = await Sandbox.create({
  wasmDir: FIXTURES,
  adapter: new NodeAdapter(),
});

try {
  sandbox.writeFile('/tmp/test_coreutils.py', testScriptBytes);
  sandbox.writeFile('/tmp/run_section.py', new TextEncoder().encode(sectionRunner));

  const result = await sandbox.run('python3 /tmp/run_section.py 2>&1');
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
} finally {
  sandbox.destroy();
}
