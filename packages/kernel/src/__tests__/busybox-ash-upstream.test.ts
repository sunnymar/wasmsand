import { assertEquals } from 'jsr:@std/assert';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', '..');

Deno.test({
  name: 'BusyBox upstream ash arithmetic tests pass in sandbox',
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    execFileSync('deno', ['run', '-A', 'scripts/run-busybox-ash-upstream-in-sandbox.ts'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    const summaryPath = resolve(
      repoRoot,
      'packages/c-ports/busybox/build/test-results/ash-upstream.json',
    );
    const summary = JSON.parse(Deno.readTextFileSync(summaryPath));
    assertEquals(summary.failed, 0);
    assertEquals(summary.passed, 19);
  },
});
