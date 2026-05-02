#!/usr/bin/env -S deno run -A

import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Sandbox } from '../packages/kernel/src/sandbox.js';
import { NodeAdapter } from '../packages/kernel/src/platform/node-adapter.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/kernel/src/platform/__tests__/fixtures');
const BUSYBOX_DIR = resolve(REPO_ROOT, 'packages/c-ports/busybox');
const SHELL_WASM = resolve(BUSYBOX_DIR, 'build-shell/busybox-shell.wasm');
const SHELL_MANIFEST = resolve(BUSYBOX_DIR, 'busybox-shell.manifest.json');
const WORK_WASM_DIR = resolve(BUSYBOX_DIR, 'build/ash-smoke-wasm-dir');
const RESULTS_JSON = resolve(BUSYBOX_DIR, 'build/test-results/ash-smoke.json');

interface Smoke {
  name: string;
  command: string;
  expectedStdout: string;
  expectedExitCode: number;
}

interface SmokeResult extends Smoke {
  stdout: string;
  stderr: string;
  exitCode: number;
  pass: boolean;
}

const smokes: Smoke[] = [
  { name: 'echo', command: "sh -c 'echo ok'", expectedStdout: 'ok\n', expectedExitCode: 0 },
  { name: 'pipeline', command: "sh -c 'echo hi | cat'", expectedStdout: 'hi\n', expectedExitCode: 0 },
  { name: 'subshell', command: "sh -c '(echo child); echo parent'", expectedStdout: 'child\nparent\n', expectedExitCode: 0 },
  { name: 'command-substitution', command: 'sh -c \'x=$(echo sub); echo "$x"\'', expectedStdout: 'sub\n', expectedExitCode: 0 },
  { name: 'status', command: "sh -c 'true; false; echo $?'", expectedStdout: '1\n', expectedExitCode: 0 },
  {
    name: 'shebang',
    command: "printf '%s\\n' '#!/bin/sh' 'echo script-ok' > /tmp/script.sh && chmod +x /tmp/script.sh && /tmp/script.sh",
    expectedStdout: 'script-ok\n',
    expectedExitCode: 0,
  },
];

function ensureBuilt(): void {
  execSync('make -C packages/c-ports/busybox shell', { cwd: REPO_ROOT, stdio: 'inherit' });
}

function prepareWasmDir(): void {
  rmSync(WORK_WASM_DIR, { recursive: true, force: true });
  mkdirSync(WORK_WASM_DIR, { recursive: true });
  cpSync(FIXTURES, WORK_WASM_DIR, { recursive: true });
  copyFileSync(SHELL_WASM, resolve(WORK_WASM_DIR, 'busybox-shell.wasm'));
  copyFileSync(SHELL_MANIFEST, resolve(WORK_WASM_DIR, 'busybox-shell.manifest.json'));
}

async function runSmoke(smoke: Smoke): Promise<SmokeResult> {
  const sandbox = await Sandbox.create({
    wasmDir: WORK_WASM_DIR,
    adapter: new NodeAdapter(),
    timeoutMs: 30_000,
  });
  try {
    const result = await sandbox.run(smoke.command);
    return {
      ...smoke,
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      exitCode: result.exitCode,
      pass: result.exitCode === smoke.expectedExitCode && result.stdout === smoke.expectedStdout,
    };
  } finally {
    sandbox.destroy();
  }
}

ensureBuilt();
prepareWasmDir();
mkdirSync(dirname(RESULTS_JSON), { recursive: true });

const trace = execSync('bash scripts/trace-busybox-ash-process-paths.sh', {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
});

const results: SmokeResult[] = [];
for (const smoke of smokes) {
  const result = await runSmoke(smoke);
  results.push(result);
  const status = result.pass ? 'PASS' : 'FAIL';
  console.log(`[busybox-ash] ${status} ${smoke.name}`);
  if (!result.pass) {
    console.log(`  command: ${smoke.command}`);
    console.log(`  expected stdout: ${JSON.stringify(smoke.expectedStdout)}`);
    console.log(`  actual stdout:   ${JSON.stringify(result.stdout)}`);
    console.log(`  stderr:          ${JSON.stringify(result.stderr)}`);
    console.log(`  exit:            ${result.exitCode}`);
  }
}

const summary = {
  trace,
  total: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
};

writeFileSync(RESULTS_JSON, JSON.stringify(summary, null, 2) + '\n');

if (summary.failed > 0) {
  console.error(`[busybox-ash] FAIL: ${summary.failed}/${summary.total} smoke(s) failed`);
  Deno.exit(1);
}

console.log(`[busybox-ash] OK: ${summary.passed}/${summary.total} smokes passed`);
console.log(`[busybox-ash] results: ${RESULTS_JSON}`);
