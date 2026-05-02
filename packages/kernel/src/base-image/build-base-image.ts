import { chmod, chown, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface BaseImageFile {
  src: string;
  dest: string;
  uid?: number;
  gid?: number;
  mode?: number;
}

export interface BaseImageTool {
  name: string;
  path: string;
}

export interface BuildBaseImageOptions {
  outDir: string;
  dirs?: Array<{ path: string; uid?: number; gid?: number; mode?: number }>;
  files: BaseImageFile[];
  tools?: BaseImageTool[];
}

export interface BaseImageManifest {
  version: 1;
  id: string;
  files: Array<{ path: string; type: 'file' | 'dir'; uid: number; gid: number; mode: number }>;
  tools: BaseImageTool[];
}

type BaseImageManifestEntry = BaseImageManifest['files'][number];

function validateBasePath(path: string, kind: string): void {
  if (!path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`invalid base image ${kind}: ${path}`);
  }
}

function ancestors(path: string): string[] {
  const parts = dirname(path).split('/').filter(Boolean);
  const out: string[] = ['/'];
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    out.push(current);
  }
  return out;
}

async function materializeDir(
  root: string,
  path: string,
  files: Map<string, BaseImageManifestEntry>,
  metadata: { uid?: number; gid?: number; mode?: number } = {},
  explicit = false,
): Promise<void> {
  if (files.has(path) && !explicit) return;
  const hostPath = join(root, `.${path}`);
  await mkdir(hostPath, { recursive: true });
  await chmod(hostPath, metadata.mode ?? 0o755);
  try {
    await chown(hostPath, metadata.uid ?? 0, metadata.gid ?? 0);
  } catch {
    // Manifest metadata is authoritative when local chown is unavailable.
  }
  files.set(path, {
    path,
    type: 'dir',
    uid: metadata.uid ?? 0,
    gid: metadata.gid ?? 0,
    mode: metadata.mode ?? 0o755,
  });
}

async function copy(
  root: string,
  src: string,
  dst: string,
  file: BaseImageFile,
  files: Map<string, BaseImageManifestEntry>,
): Promise<void> {
  for (const dir of ancestors(dst)) await materializeDir(root, dir, files);
  const hostPath = join(root, `.${dst}`);
  await copyFile(src, hostPath);
  await chmod(hostPath, file.mode ?? 0o644);
  try {
    await chown(hostPath, file.uid ?? 0, file.gid ?? 0);
  } catch {
    // Non-root local development may be unable to chown. The manifest still
    // records intended ownership; root providers should prefer manifest data.
  }
  files.set(dst, {
    path: dst,
    type: 'file',
    uid: file.uid ?? 0,
    gid: file.gid ?? 0,
    mode: file.mode ?? 0o644,
  });
}

export async function buildBaseImage(options: BuildBaseImageOptions): Promise<BaseImageManifest> {
  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });

  const copied = new Map<string, BaseImageManifestEntry>();
  for (const dir of options.dirs ?? []) {
    validateBasePath(dir.path, 'directory');
    for (const ancestor of ancestors(`${dir.path}/.keep`).slice(0, -1)) {
      await materializeDir(options.outDir, ancestor, copied);
    }
    await materializeDir(options.outDir, dir.path, copied, dir, true);
  }

  for (const file of options.files) {
    validateBasePath(file.dest, 'destination');
    await copy(options.outDir, file.src, file.dest, file, copied);
  }

  const hash = createHash('sha256');
  for (const file of Array.from(copied.values()).sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(JSON.stringify({ type: file.type, uid: file.uid, gid: file.gid, mode: file.mode }));
    if (file.type === 'file') hash.update(await readFile(join(options.outDir, `.${file.path}`)));
  }

  const manifest: BaseImageManifest = {
    version: 1,
    id: hash.digest('hex'),
    files: Array.from(copied.values()).sort((a, b) => a.path.localeCompare(b.path)),
    tools: options.tools ?? [],
  };
  await mkdir(join(options.outDir, 'etc/codepod'), { recursive: true });
  await writeFile(join(options.outDir, 'etc/codepod/base-image.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
