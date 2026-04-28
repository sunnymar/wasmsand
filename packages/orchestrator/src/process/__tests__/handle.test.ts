import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { Process } from '../handle.ts';

Deno.test('Process exposes pid, mode, and exitCode', () => {
  const p = Process.__forTesting({
    pid: 7,
    mode: 'resident',
  });

  assertEquals(p.pid, 7);
  assertEquals(p.mode, 'resident');
  assertEquals(p.exitCode, undefined);
});

Deno.test('Process.callExport rejects when no export wired', async () => {
  const p = Process.__forTesting({ pid: 7, mode: 'resident' });

  await assertRejects(
    () => p.callExport('__run_command', 0, 3),
    Error,
    'no export named __run_command',
  );
});
