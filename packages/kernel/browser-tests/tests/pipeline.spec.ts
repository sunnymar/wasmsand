import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => (window as any).__sandboxReady === true,
    { timeout: 30_000 }
  );

  const err = await page.evaluate(() => (window as any).__sandboxError);
  if (err) throw new Error(`Sandbox boot failed: ${err}`);
});

test('pipeline: echo | cat', async ({ page }) => {
  const result = await page.evaluate(async () => {
    return await (window as any).__sandbox.run('echo hello | cat');
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('hello');
});

test('pipeline: echo | wc -w', async ({ page }) => {
  const result = await page.evaluate(async () => {
    return await (window as any).__sandbox.run('echo hello world | wc -w');
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('2');
});

test('multi-stage: seq | head | wc -l', async ({ page }) => {
  const result = await page.evaluate(async () => {
    return await (window as any).__sandbox.run('seq 1 10 | head -5 | wc -l');
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('5');
});

test('cat reads a written file', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const sb = (window as any).__sandbox;
    sb.writeFile('/tmp/pipeline-test.txt', new TextEncoder().encode('hello from browser'));
    return await sb.run('cat /tmp/pipeline-test.txt');
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('hello from browser');
});

test('env lists environment variables', async ({ page }) => {
  const result = await page.evaluate(async () => {
    return await (window as any).__sandbox.run('env');
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('HOME=');
});
