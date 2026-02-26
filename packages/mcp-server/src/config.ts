/**
 * Unified configuration for the codepod MCP server.
 *
 * Three sources with precedence: CLI args > env vars > JSON config > defaults.
 * Higher-priority layer replaces (not merges) lower-priority mount/network lists.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MountEntry {
  hostPath: string;
  sandboxPath: string;
  writable: boolean;
}

export interface NetworkConfig {
  allow: string[];
  block: string[];
}

export interface McpConfig {
  mounts: MountEntry[];
  network: NetworkConfig;
  timeoutMs: number;
  fsLimitBytes: number;
  wasmDir: string;
  shellWasm: string;
}

interface JsonConfig {
  mounts?: Array<{ hostPath: string; sandboxPath: string; writable?: boolean }>;
  network?: { allow?: string[]; block?: string[] };
  timeoutMs?: number;
  fsLimitBytes?: number;
  wasmDir?: string;
  shellWasm?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export interface McpDefaults {
  timeoutMs: number;
  fsLimitBytes: number;
  wasmDir: string;
  shellWasm: string;
}

// ---------------------------------------------------------------------------
// Mount string parsing: "host:sandbox[:ro|rw]" (Docker-style)
// ---------------------------------------------------------------------------

export function parseMount(s: string): MountEntry {
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid mount format: "${s}" (expected host:sandbox[:ro|rw])`);
  }
  const mode = parts[2] ?? 'ro';
  if (mode !== 'ro' && mode !== 'rw') {
    throw new Error(`Invalid mount mode: "${mode}" (expected ro or rw)`);
  }
  return {
    hostPath: parts[0],
    sandboxPath: parts[1],
    writable: mode === 'rw',
  };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliResult {
  mounts?: MountEntry[];
  networkAllow?: string[];
  networkBlock?: string[];
  configPath?: string;
  timeoutMs?: number;
  fsLimitBytes?: number;
  wasmDir?: string;
  shellWasm?: string;
}

export function parseCli(argv: string[]): CliResult {
  const result: CliResult = {};
  let mounts: MountEntry[] | undefined;
  let allows: string[] | undefined;
  let blocks: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--mount':
        if (!next) throw new Error('--mount requires a value');
        mounts ??= [];
        mounts.push(parseMount(next));
        i++;
        break;
      case '--network-allow':
        if (!next) throw new Error('--network-allow requires a value');
        allows ??= [];
        allows.push(next);
        i++;
        break;
      case '--network-block':
        if (!next) throw new Error('--network-block requires a value');
        blocks ??= [];
        blocks.push(next);
        i++;
        break;
      case '--config':
        if (!next) throw new Error('--config requires a value');
        result.configPath = next;
        i++;
        break;
      case '--timeout':
        if (!next) throw new Error('--timeout requires a value');
        result.timeoutMs = Number(next);
        i++;
        break;
      case '--fs-limit':
        if (!next) throw new Error('--fs-limit requires a value');
        result.fsLimitBytes = Number(next);
        i++;
        break;
      case '--wasm-dir':
        if (!next) throw new Error('--wasm-dir requires a value');
        result.wasmDir = next;
        i++;
        break;
      case '--shell-wasm':
        if (!next) throw new Error('--shell-wasm requires a value');
        result.shellWasm = next;
        i++;
        break;
      default:
        // Ignore unknown args
        break;
    }
  }

  if (mounts) result.mounts = mounts;
  if (allows) result.networkAllow = allows;
  if (blocks) result.networkBlock = blocks;
  return result;
}

// ---------------------------------------------------------------------------
// Env var parsing
// ---------------------------------------------------------------------------

interface EnvResult {
  mounts?: MountEntry[];
  networkAllow?: string[];
  networkBlock?: string[];
  configPath?: string;
  timeoutMs?: number;
  fsLimitBytes?: number;
  wasmDir?: string;
  shellWasm?: string;
}

export function parseEnv(env: Record<string, string | undefined>): EnvResult {
  const result: EnvResult = {};

  // Indexed mounts: CODEPOD_MOUNT_0, CODEPOD_MOUNT_1, ...
  const mounts: MountEntry[] = [];
  for (let i = 0; ; i++) {
    const val = env[`CODEPOD_MOUNT_${i}`];
    if (val === undefined) break;
    mounts.push(parseMount(val));
  }
  if (mounts.length > 0) result.mounts = mounts;

  // Comma-separated network lists
  if (env.CODEPOD_NETWORK_ALLOW) {
    result.networkAllow = env.CODEPOD_NETWORK_ALLOW.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (env.CODEPOD_NETWORK_BLOCK) {
    result.networkBlock = env.CODEPOD_NETWORK_BLOCK.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (env.CODEPOD_CONFIG) result.configPath = env.CODEPOD_CONFIG;
  if (env.CODEPOD_TIMEOUT_MS) result.timeoutMs = Number(env.CODEPOD_TIMEOUT_MS);
  if (env.CODEPOD_FS_LIMIT_BYTES) result.fsLimitBytes = Number(env.CODEPOD_FS_LIMIT_BYTES);
  if (env.CODEPOD_WASM_DIR) result.wasmDir = env.CODEPOD_WASM_DIR;
  if (env.CODEPOD_SHELL_WASM) result.shellWasm = env.CODEPOD_SHELL_WASM;

  return result;
}

// ---------------------------------------------------------------------------
// JSON config loading
// ---------------------------------------------------------------------------

export function loadJsonConfig(filePath: string): JsonConfig {
  const raw = readFileSync(resolve(filePath), 'utf-8');
  return JSON.parse(raw) as JsonConfig;
}

// ---------------------------------------------------------------------------
// Main: loadConfig
// ---------------------------------------------------------------------------

export function loadConfig(argv: string[], defaults: McpDefaults): McpConfig {
  const cli = parseCli(argv);
  const env = parseEnv(process.env);

  // Determine config file path: CLI > env
  const configPath = cli.configPath ?? env.configPath;
  let json: JsonConfig = {};
  if (configPath) {
    json = loadJsonConfig(configPath);
  }

  // --- Mounts: CLI > env > JSON > empty ---
  const jsonMounts: MountEntry[] | undefined = json.mounts?.map(m => ({
    hostPath: m.hostPath,
    sandboxPath: m.sandboxPath,
    writable: m.writable ?? false,
  }));
  const mounts = cli.mounts ?? env.mounts ?? jsonMounts ?? [];

  // --- Network: CLI > env > JSON > empty ---
  const cliNetwork = (cli.networkAllow || cli.networkBlock)
    ? { allow: cli.networkAllow ?? [], block: cli.networkBlock ?? [] }
    : undefined;
  const envNetwork = (env.networkAllow || env.networkBlock)
    ? { allow: env.networkAllow ?? [], block: env.networkBlock ?? [] }
    : undefined;
  const jsonNetwork = json.network
    ? { allow: json.network.allow ?? [], block: json.network.block ?? [] }
    : undefined;
  const network = cliNetwork ?? envNetwork ?? jsonNetwork ?? { allow: [], block: [] };

  // --- Scalars: CLI > env > JSON > defaults ---
  const timeoutMs = cli.timeoutMs ?? env.timeoutMs ?? json.timeoutMs ?? defaults.timeoutMs;
  const fsLimitBytes = cli.fsLimitBytes ?? env.fsLimitBytes ?? json.fsLimitBytes ?? defaults.fsLimitBytes;
  const wasmDir = cli.wasmDir ?? env.wasmDir ?? json.wasmDir ?? defaults.wasmDir;
  const shellWasm = cli.shellWasm ?? env.shellWasm ?? json.shellWasm ?? defaults.shellWasm;

  return { mounts, network, timeoutMs, fsLimitBytes, wasmDir, shellWasm };
}
