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

test('echo hello returns exit 0 and correct stdout', async ({ page }) => {
  const result = await page.evaluate(async () => {
    return await (window as any).__sandbox.run('echo hello');
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('hello');
});

test('pwd returns /home/user', async ({ page }) => {
  const result = await page.evaluate(async () => {
    return await (window as any).__sandbox.run('pwd');
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('/home/user');
});

// writeFile via JS API, read back via JS API — no external tool needed
test('writeFile persists in VFS', async ({ page }) => {
  const content = await page.evaluate(async () => {
    const sb = (window as any).__sandbox;
    sb.writeFile('/tmp/browser-test.txt', new TextEncoder().encode('hello from browser'));
    return new TextDecoder().decode(sb.readFile('/tmp/browser-test.txt'));
  });
  expect(content).toBe('hello from browser');
});

// $HOME expansion is a shell builtin — no external 'env' process needed
test('HOME env var is set', async ({ page }) => {
  const result = await page.evaluate(async () => {
    return await (window as any).__sandbox.run('echo $HOME');
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('/home/user');
});
