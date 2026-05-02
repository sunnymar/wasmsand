#!/usr/bin/env -S deno run -A

import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Sandbox } from '../packages/kernel/src/sandbox.js';
import { NodeAdapter } from '../packages/kernel/src/platform/node-adapter.js';
import { bashBootImports } from '../packages/sdk-server/src/bash-host-imports.ts';
import { makeRunCommandHandler } from '../packages/sdk-server/src/bash-dispatch.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/kernel/src/platform/__tests__/fixtures');
const BUSYBOX_DIR = resolve(REPO_ROOT, 'packages/c-ports/busybox');
const SHELL_WASM = resolve(BUSYBOX_DIR, 'build-shell/busybox-shell.wasm');
const SHELL_MANIFEST = resolve(BUSYBOX_DIR, 'busybox-shell.manifest.json');
const WORK_WASM_DIR = resolve(BUSYBOX_DIR, 'build/ash-smoke-wasm-dir');
const RESULTS_JSON = resolve(BUSYBOX_DIR, 'build/test-results/ash-smoke.json');

interface Smoke {
  name: string;
  script: string;
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
  { name: 'echo', script: 'echo ok', expectedStdout: 'ok\n', expectedExitCode: 0 },
  { name: 'pipeline', script: 'echo hi | cat', expectedStdout: 'hi\n', expectedExitCode: 0 },
  { name: 'subshell', script: '(echo child); echo parent', expectedStdout: 'child\nparent\n', expectedExitCode: 0 },
  { name: 'command-substitution', script: 'x=$(echo sub); echo "$x"', expectedStdout: 'sub\n', expectedExitCode: 0 },
  { name: 'status', script: 'true; false; echo $?', expectedStdout: '1\n', expectedExitCode: 0 },
  {
    name: 'shebang',
    script: "printf '%s\\n' '#!/bin/sh' 'echo script-ok' > /tmp/script.sh && chmod +x /tmp/script.sh && /tmp/script.sh",
    expectedStdout: 'script-ok\n',
    expectedExitCode: 0,
  },
  {
    name: 'userland-diff-cp',
    script: "printf 'a\\nb\\n' > /tmp/a.txt && cp /tmp/a.txt /tmp/b.txt && diff /tmp/a.txt /tmp/b.txt; echo diff:$?",
    expectedStdout: 'diff:0\n',
    expectedExitCode: 0,
  },
  {
    name: 'userland-tail-head-wc',
    script: "printf 'a\\nb\\nc\\n' > /tmp/lines.txt && head -n 2 /tmp/lines.txt | tail -n 1 && wc -l /tmp/lines.txt | cut -d' ' -f1",
    expectedStdout: 'b\n3\n',
    expectedExitCode: 0,
  },
  {
    name: 'userland-find-sort-grep',
    script: "mkdir -p /tmp/tree && touch /tmp/tree/b /tmp/tree/a && find /tmp/tree -type f | sort | grep '/a$'",
    expectedStdout: '/tmp/tree/a\n',
    expectedExitCode: 0,
  },
  {
    name: 'userland-xargs-paths',
    script: "printf 'hello world\\n' | xargs echo; dirname /tmp/tree/a; pwd; uname",
    expectedStdout: 'hello world\n/tmp/tree\n/\ncodepod\n',
    expectedExitCode: 0,
  },
  {
    name: 'cd-external-relative-path',
    script: "mkdir -p /tmp/cwd-check && printf 'cwd-ok\\n' > /tmp/cwd-check/marker.txt && cd /tmp/cwd-check && cat marker.txt",
    expectedStdout: 'cwd-ok\n',
    expectedExitCode: 0,
  },
  {
    name: 'nested-script-external-relative-path',
    script: "mkdir -p /tmp/cwd-script && printf 'nested-ok\\n' > /tmp/cwd-script/marker.txt && printf 'cat marker.txt\\n' > /tmp/cwd-script/child.sh && cd /tmp/cwd-script && /bin/sh ./child.sh",
    expectedStdout: 'nested-ok\n',
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
    bootWasmPath: resolve(WORK_WASM_DIR, 'codepod-shell-exec.wasm'),
    adapter: new NodeAdapter(),
    bootImports: bashBootImports,
    runCommandHandler: makeRunCommandHandler(),
    timeoutMs: 30_000,
  });
  try {
    const proc = await sandbox.spawn(['/bin/sh', '-c', smoke.script]);
    const stdout = proc.fdReadAndClear(1).data;
    const stderr = proc.fdReadAndClear(2).data;
    return {
      ...smoke,
      stdout,
      stderr,
      exitCode: proc.exitCode ?? 0,
      pass: (proc.exitCode ?? 0) === smoke.expectedExitCode && stdout === smoke.expectedStdout,
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
    console.log(`  script: ${smoke.script}`);
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
