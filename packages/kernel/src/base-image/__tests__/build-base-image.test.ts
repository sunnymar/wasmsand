import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBaseImage } from '../build-base-image.ts';

describe('buildBaseImage', () => {
  it('copies a generic manifest into a root directory', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'codepod-base-src-'));
    const outDir = await mkdtemp(join(tmpdir(), 'codepod-base-'));
    await mkdir(join(sourceDir, 'fixtures'), { recursive: true });
    await writeFile(join(sourceDir, 'fixtures/tool.wasm'), new Uint8Array([0, 0x61, 0x73, 0x6d]));
    await writeFile(join(sourceDir, 'fixtures/config.json'), '{}');
    await writeFile(join(sourceDir, 'fixtures/cache.txt'), 'cache');

    const manifest = await buildBaseImage({
      outDir,
      dirs: [{ path: '/var/tmp', uid: 1000, gid: 1000, mode: 0o777 }],
      files: [
        { src: join(sourceDir, 'fixtures/tool.wasm'), dest: '/bin/tool', uid: 0, gid: 0, mode: 0o755 },
        { src: join(sourceDir, 'fixtures/config.json'), dest: '/etc/tool/config.json', uid: 1000, gid: 1000, mode: 0o644 },
        { src: join(sourceDir, 'fixtures/cache.txt'), dest: '/var/tmp/cache.txt', uid: 1000, gid: 1000, mode: 0o644 },
      ],
      tools: [{ name: 'tool', path: '/bin/tool' }],
    });

    expect(manifest.version).toBe(1);
    expect(manifest.id.length).toBeGreaterThanOrEqual(12);
    expect((await stat(join(outDir, 'bin/tool'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(outDir, 'etc/tool/config.json'))).mode & 0o777).toBe(0o644);
    expect(manifest.files.find((f) => f.path === '/bin/tool')?.uid).toBe(0);
    expect(manifest.files.find((f) => f.path === '/etc/tool/config.json')?.uid).toBe(1000);
    expect(manifest.files.find((f) => f.path === '/etc/tool')?.type).toBe('dir');
    expect(manifest.files.find((f) => f.path === '/etc')?.uid).toBe(0);
    expect(manifest.files.find((f) => f.path === '/var/tmp')?.uid).toBe(1000);
    expect(manifest.files.find((f) => f.path === '/var/tmp')?.mode).toBe(0o777);
    expect(manifest.tools).toEqual([{ name: 'tool', path: '/bin/tool' }]);
    expect(JSON.parse(await readFile(join(outDir, 'etc/codepod/base-image.json'), 'utf8')).id).toBe(manifest.id);
  });
});
