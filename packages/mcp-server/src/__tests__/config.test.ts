import { describe, it, expect } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMount, parseCli, parseEnv, loadJsonConfig, loadConfig } from '../config.js';
import type { McpDefaults } from '../config.js';

const defaults: McpDefaults = {
  timeoutMs: 30_000,
  fsLimitBytes: 256 * 1024 * 1024,
  wasmDir: '/default/wasm',
  shellWasm: '/default/shell.wasm',
};

// ---------------------------------------------------------------------------
// parseMount
// ---------------------------------------------------------------------------

describe('parseMount', () => {
  it('parses host:sandbox (default ro)', () => {
    expect(parseMount('/src:/mnt/src')).toEqual({
      hostPath: '/src',
      sandboxPath: '/mnt/src',
      writable: false,
    });
  });

  it('parses host:sandbox:ro', () => {
    expect(parseMount('/src:/mnt/src:ro')).toEqual({
      hostPath: '/src',
      sandboxPath: '/mnt/src',
      writable: false,
    });
  });

  it('parses host:sandbox:rw', () => {
    expect(parseMount('/tmp/out:/mnt/out:rw')).toEqual({
      hostPath: '/tmp/out',
      sandboxPath: '/mnt/out',
      writable: true,
    });
  });

  it('throws on invalid format (too few parts)', () => {
    expect(() => parseMount('/only-one')).toThrow('Invalid mount format');
  });

  it('throws on invalid format (too many parts)', () => {
    expect(() => parseMount('a:b:c:d')).toThrow('Invalid mount format');
  });

  it('throws on invalid mode', () => {
    expect(() => parseMount('/src:/mnt:xx')).toThrow('Invalid mount mode');
  });
});

// ---------------------------------------------------------------------------
// parseCli
// ---------------------------------------------------------------------------

describe('parseCli', () => {
  it('parses --mount flags', () => {
    const result = parseCli(['--mount', '/src:/mnt/src:ro', '--mount', '/tmp:/mnt/tmp:rw']);
    expect(result.mounts).toEqual([
      { hostPath: '/src', sandboxPath: '/mnt/src', writable: false },
      { hostPath: '/tmp', sandboxPath: '/mnt/tmp', writable: true },
    ]);
  });

  it('parses --network-allow and --network-block', () => {
    const result = parseCli([
      '--network-allow', '*.pypi.org',
      '--network-allow', 'npmjs.com',
      '--network-block', 'evil.com',
    ]);
    expect(result.networkAllow).toEqual(['*.pypi.org', 'npmjs.com']);
    expect(result.networkBlock).toEqual(['evil.com']);
  });

  it('parses scalar options', () => {
    const result = parseCli([
      '--config', 'test.json',
      '--timeout', '60000',
      '--fs-limit', '536870912',
      '--wasm-dir', '/path/to/wasm',
      '--shell-wasm', '/path/to/shell.wasm',
    ]);
    expect(result.configPath).toBe('test.json');
    expect(result.timeoutMs).toBe(60000);
    expect(result.fsLimitBytes).toBe(536870912);
    expect(result.wasmDir).toBe('/path/to/wasm');
    expect(result.shellWasm).toBe('/path/to/shell.wasm');
  });

  it('returns empty result for no args', () => {
    const result = parseCli([]);
    expect(result.mounts).toBeUndefined();
    expect(result.networkAllow).toBeUndefined();
    expect(result.networkBlock).toBeUndefined();
    expect(result.configPath).toBeUndefined();
  });

  it('ignores unknown flags', () => {
    const result = parseCli(['--unknown', 'value']);
    expect(result).toEqual({});
  });

  it('throws when --mount has no value', () => {
    expect(() => parseCli(['--mount'])).toThrow('--mount requires a value');
  });
});

// ---------------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------------

describe('parseEnv', () => {
  it('parses indexed mounts', () => {
    const result = parseEnv({
      CODEPOD_MOUNT_0: '/src:/mnt/src:ro',
      CODEPOD_MOUNT_1: '/tmp:/mnt/tmp:rw',
    });
    expect(result.mounts).toEqual([
      { hostPath: '/src', sandboxPath: '/mnt/src', writable: false },
      { hostPath: '/tmp', sandboxPath: '/mnt/tmp', writable: true },
    ]);
  });

  it('stops at first missing index', () => {
    const result = parseEnv({
      CODEPOD_MOUNT_0: '/a:/b',
      CODEPOD_MOUNT_2: '/c:/d', // skipped, index 1 missing
    });
    expect(result.mounts).toEqual([
      { hostPath: '/a', sandboxPath: '/b', writable: false },
    ]);
  });

  it('parses comma-separated network lists', () => {
    const result = parseEnv({
      CODEPOD_NETWORK_ALLOW: '*.pypi.org, npmjs.com',
      CODEPOD_NETWORK_BLOCK: 'evil.com',
    });
    expect(result.networkAllow).toEqual(['*.pypi.org', 'npmjs.com']);
    expect(result.networkBlock).toEqual(['evil.com']);
  });

  it('parses scalar env vars', () => {
    const result = parseEnv({
      CODEPOD_CONFIG: 'config.json',
      CODEPOD_TIMEOUT_MS: '60000',
      CODEPOD_FS_LIMIT_BYTES: '536870912',
      CODEPOD_WASM_DIR: '/wasm',
      CODEPOD_SHELL_WASM: '/shell.wasm',
    });
    expect(result.configPath).toBe('config.json');
    expect(result.timeoutMs).toBe(60000);
    expect(result.fsLimitBytes).toBe(536870912);
    expect(result.wasmDir).toBe('/wasm');
    expect(result.shellWasm).toBe('/shell.wasm');
  });

  it('returns empty result for empty env', () => {
    const result = parseEnv({});
    expect(result.mounts).toBeUndefined();
    expect(result.networkAllow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadJsonConfig
// ---------------------------------------------------------------------------

describe('loadJsonConfig', () => {
  let tmpDir: string;

  it('loads a JSON config file', () => {
    tmpDir = join(tmpdir(), `config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mounts: [{ hostPath: '/src', sandboxPath: '/mnt/src', writable: false }],
      network: { allow: ['*.pypi.org'], block: [] },
    }));

    const config = loadJsonConfig(configPath);
    expect(config.mounts).toEqual([{ hostPath: '/src', sandboxPath: '/mnt/src', writable: false }]);
    expect(config.network?.allow).toEqual(['*.pypi.org']);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// loadConfig (precedence)
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns defaults when no args/env/json', () => {
    const config = loadConfig([], defaults);
    expect(config.timeoutMs).toBe(30_000);
    expect(config.fsLimitBytes).toBe(256 * 1024 * 1024);
    expect(config.wasmDir).toBe('/default/wasm');
    expect(config.shellWasm).toBe('/default/shell.wasm');
    expect(config.mounts).toEqual([]);
    expect(config.network).toEqual({ allow: [], block: [] });
  });

  it('CLI mounts override env mounts', () => {
    // Set env mount, then override with CLI
    const origEnv = process.env.CODEPOD_MOUNT_0;
    process.env.CODEPOD_MOUNT_0 = '/env:/mnt/env:ro';
    try {
      const config = loadConfig(['--mount', '/cli:/mnt/cli:rw'], defaults);
      expect(config.mounts).toEqual([
        { hostPath: '/cli', sandboxPath: '/mnt/cli', writable: true },
      ]);
    } finally {
      if (origEnv === undefined) delete process.env.CODEPOD_MOUNT_0;
      else process.env.CODEPOD_MOUNT_0 = origEnv;
    }
  });

  it('CLI timeout overrides default', () => {
    const config = loadConfig(['--timeout', '60000'], defaults);
    expect(config.timeoutMs).toBe(60000);
  });

  it('loads JSON config from --config', () => {
    const tmpDir = join(tmpdir(), `config-load-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mounts: [{ hostPath: '/json', sandboxPath: '/mnt/json' }],
      network: { allow: ['example.com'] },
      timeoutMs: 99999,
    }));

    try {
      const config = loadConfig(['--config', configPath], defaults);
      expect(config.mounts).toEqual([
        { hostPath: '/json', sandboxPath: '/mnt/json', writable: false },
      ]);
      expect(config.network.allow).toEqual(['example.com']);
      expect(config.timeoutMs).toBe(99999);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('CLI args override JSON config', () => {
    const tmpDir = join(tmpdir(), `config-override-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mounts: [{ hostPath: '/json', sandboxPath: '/mnt/json' }],
      timeoutMs: 99999,
    }));

    try {
      const config = loadConfig([
        '--config', configPath,
        '--mount', '/cli:/mnt/cli:rw',
        '--timeout', '5000',
      ], defaults);
      // CLI mounts replace JSON mounts
      expect(config.mounts).toEqual([
        { hostPath: '/cli', sandboxPath: '/mnt/cli', writable: true },
      ]);
      expect(config.timeoutMs).toBe(5000);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
