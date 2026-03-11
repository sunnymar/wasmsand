/**
 * MCP server for codepod — exposes WASM sandboxes via the Model Context Protocol.
 *
 * Lifecycle tools:
 *   create_sandbox  — create a new isolated sandbox, returns its ID
 *   list_sandboxes  — list all active sandboxes
 *   destroy_sandbox — tear down a sandbox and free resources
 *   export_state    — serialize sandbox state to base64 for persistent storage
 *   import_state    — restore a sandbox from a previously exported state blob
 *
 * Per-sandbox tools (require sandbox_id):
 *   run_command    — execute shell commands (full POSIX shell + coreutils)
 *   read_file      — read a file from the sandbox VFS
 *   write_file     — write a file to the sandbox VFS
 *   list_directory — list directory contents with type/size
 *   snapshot       — take a CoW snapshot (in-memory, fast)
 *   restore        — restore to a previous in-memory snapshot
 *
 * All debug/error output goes to stderr (stdout is reserved for MCP protocol).
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Sandbox } from '@codepod/sandbox';
import type { NetworkPolicy } from '@codepod/sandbox';
import { NodeAdapter, HostFsProvider } from '@codepod/sandbox/node';
import { loadConfig } from './config.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

function log(msg: string): void {
  process.stderr.write(`[mcp-server] ${msg}\n`);
}

// --- Configuration ---
const config = loadConfig(process.argv.slice(2), {
  timeoutMs: 30_000,
  fsLimitBytes: 256 * 1024 * 1024,
  wasmDir: process.env.CODEPOD_WASM_DIR
    ?? resolve(__dirname, '../../orchestrator/src/platform/__tests__/fixtures'),
  shellWasm: process.env.CODEPOD_SHELL_WASM
    ?? resolve(__dirname, '../../orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm'),
});

// --- Sandbox registry ---
interface SandboxEntry {
  sandbox: Sandbox;
  createdAt: string;
  label?: string;
}

const sandboxes = new Map<string, SandboxEntry>();
const MAX_SANDBOXES = 64;

function getSandbox(id: string): Sandbox {
  const entry = sandboxes.get(id);
  if (!entry) throw new Error(`Unknown sandbox_id: ${id}`);
  return entry.sandbox;
}

async function createSandboxInstance(label?: string): Promise<{ id: string; sandbox: Sandbox }> {
  if (sandboxes.size >= MAX_SANDBOXES) {
    throw new Error(`Maximum of ${MAX_SANDBOXES} concurrent sandboxes reached`);
  }

  const hasNetwork = config.network.allow.length > 0 || config.network.block.length > 0;
  const network: NetworkPolicy | undefined = hasNetwork
    ? {
        allowedHosts: config.network.allow.length > 0 ? config.network.allow : undefined,
        blockedHosts: config.network.block.length > 0 ? config.network.block : undefined,
      }
    : undefined;

  const sandbox = await Sandbox.create({
    wasmDir: config.wasmDir,
    adapter: new NodeAdapter(),
    timeoutMs: config.timeoutMs,
    fsLimitBytes: config.fsLimitBytes,
    shellExecWasmPath: config.shellWasm,
    network,
    packages: config.packages,
    security: {
      limits: {
        stdoutBytes: 1 * 1024 * 1024,
        stderrBytes: 1 * 1024 * 1024,
        commandBytes: 65536,
      },
    },
  });

  // Mount host directories
  for (const mount of config.mounts) {
    const provider = new HostFsProvider(mount.hostPath, { writable: mount.writable });
    sandbox.mount(mount.sandboxPath, provider);
  }

  const id = sandbox.sessionId;
  sandboxes.set(id, {
    sandbox,
    createdAt: new Date().toISOString(),
    label,
  });
  log(`Sandbox created: ${id}${label ? ` (${label})` : ''}`);
  return { id, sandbox };
}

// --- MCP text response helpers ---
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data));
}
function errorResult(msg: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: msg }] };
}

async function main(): Promise<void> {
  log('Starting codepod MCP server...');
  log(`  wasmDir:    ${config.wasmDir}`);
  log(`  shellWasm:  ${config.shellWasm}`);
  log(`  timeoutMs:  ${config.timeoutMs}`);
  log(`  fsLimit:    ${config.fsLimitBytes}`);
  log(`  mounts:     ${config.mounts.length}`);
  log(`  packages:   ${config.packages.join(', ') || '(none)'}`);

  const server = new McpServer({
    name: 'codepod',
    version: '0.1.0',
  });

  // ── Lifecycle tools ─────────────────────────────────────────────

  server.tool(
    'create_sandbox',
    'Create a new isolated WASM sandbox. Returns the sandbox_id (UUID) to use with all other tools. Each sandbox has its own filesystem, env vars, shell state, and Python runtime.',
    {
      label: z.string().optional().describe('Optional human-readable label for this sandbox'),
    },
    async ({ label }) => {
      try {
        const { id } = await createSandboxInstance(label);
        return jsonResult({ sandbox_id: id, label: label ?? null });
      } catch (err) {
        return errorResult(`Error creating sandbox: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    'list_sandboxes',
    'List all active sandboxes with their IDs, labels, and creation times.',
    {},
    async () => {
      const list = Array.from(sandboxes.entries()).map(([id, entry]) => ({
        sandbox_id: id,
        label: entry.label ?? null,
        created_at: entry.createdAt,
      }));
      return jsonResult(list);
    },
  );

  server.tool(
    'destroy_sandbox',
    'Destroy a sandbox and free all its resources. The sandbox_id becomes invalid after this call.',
    {
      sandbox_id: z.string().describe('ID of the sandbox to destroy'),
    },
    async ({ sandbox_id }) => {
      const entry = sandboxes.get(sandbox_id);
      if (!entry) return errorResult(`Unknown sandbox_id: ${sandbox_id}`);
      try {
        entry.sandbox.destroy();
      } catch {
        // already destroyed or error during cleanup — proceed
      }
      sandboxes.delete(sandbox_id);
      log(`Sandbox destroyed: ${sandbox_id}`);
      return textResult(`Sandbox ${sandbox_id} destroyed`);
    },
  );

  server.tool(
    'export_state',
    'Export the full state of a sandbox (filesystem + env vars) as a base64 blob. Use this to persist sandbox state to a database or file. The sandbox remains active after export.',
    {
      sandbox_id: z.string().describe('ID of the sandbox to export'),
    },
    async ({ sandbox_id }) => {
      try {
        const sandbox = getSandbox(sandbox_id);
        const blob = sandbox.exportState();
        const b64 = Buffer.from(blob).toString('base64');
        return jsonResult({
          sandbox_id,
          size_bytes: blob.byteLength,
          data: b64,
        });
      } catch (err) {
        return errorResult(`Error exporting state: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    'import_state',
    'Create a new sandbox and restore it from a previously exported state blob. Returns the new sandbox_id.',
    {
      data: z.string().describe('Base64-encoded state blob from export_state'),
      label: z.string().optional().describe('Optional label for the restored sandbox'),
    },
    async ({ data, label }) => {
      try {
        const { id, sandbox } = await createSandboxInstance(label);
        const blob = new Uint8Array(Buffer.from(data, 'base64'));
        sandbox.importState(blob);
        log(`State imported into sandbox: ${id}`);
        return jsonResult({ sandbox_id: id, label: label ?? null });
      } catch (err) {
        return errorResult(`Error importing state: ${(err as Error).message}`);
      }
    },
  );

  // ── Per-sandbox tools ───────────────────────────────────────────

  server.tool(
    'run_command',
    'Run a shell command in a sandbox. Full POSIX shell with pipes, redirects, variables, loops, functions. All coreutils available (ls, grep, sed, awk, jq, find, python3, etc). State persists between calls.',
    {
      sandbox_id: z.string().describe('ID of the sandbox to run in'),
      command: z.string().describe('The shell command to execute'),
    },
    async ({ sandbox_id, command }) => {
      try {
        const sandbox = getSandbox(sandbox_id);
        const result = await sandbox.run(command);
        return jsonResult({
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (err) {
        return errorResult(`Error running command: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    'read_file',
    'Read a file from a sandbox virtual filesystem.',
    {
      sandbox_id: z.string().describe('ID of the sandbox'),
      path: z.string().describe('Absolute path of the file to read'),
    },
    async ({ sandbox_id, path }) => {
      try {
        const sandbox = getSandbox(sandbox_id);
        const data = sandbox.readFile(path);
        return textResult(new TextDecoder().decode(data));
      } catch (err) {
        return errorResult(`Error reading file: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    'write_file',
    'Write a file to a sandbox virtual filesystem.',
    {
      sandbox_id: z.string().describe('ID of the sandbox'),
      path: z.string().describe('Absolute path of the file to write'),
      contents: z.string().describe('Text contents to write'),
    },
    async ({ sandbox_id, path, contents }) => {
      try {
        const sandbox = getSandbox(sandbox_id);
        const data = new TextEncoder().encode(contents);
        sandbox.writeFile(path, data);
        return textResult(`Wrote ${data.byteLength} bytes to ${path}`);
      } catch (err) {
        return errorResult(`Error writing file: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    'list_directory',
    'List the contents of a directory in a sandbox filesystem.',
    {
      sandbox_id: z.string().describe('ID of the sandbox'),
      path: z.string().default('/home/user').describe('Absolute path of the directory to list'),
    },
    async ({ sandbox_id, path }) => {
      try {
        const sandbox = getSandbox(sandbox_id);
        const entries = sandbox.readDir(path);
        const enriched = entries.map((entry) => {
          let size = 0;
          try {
            const st = sandbox.stat(
              path.endsWith('/') ? `${path}${entry.name}` : `${path}/${entry.name}`,
            );
            size = st.size;
          } catch {
            // stat may fail for special entries
          }
          return { name: entry.name, type: entry.type, size };
        });
        return jsonResult(enriched);
      } catch (err) {
        return errorResult(`Error listing directory: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    'snapshot',
    'Take an in-memory copy-on-write snapshot of a sandbox filesystem. Returns a snapshot ID for later restore. Fast and cheap — use before destructive operations.',
    {
      sandbox_id: z.string().describe('ID of the sandbox'),
    },
    async ({ sandbox_id }) => {
      try {
        const sandbox = getSandbox(sandbox_id);
        const id = sandbox.snapshot();
        return jsonResult({ sandbox_id, snapshot_id: id });
      } catch (err) {
        return errorResult(`Error creating snapshot: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    'restore',
    'Restore a sandbox filesystem to a previous in-memory snapshot. All changes since the snapshot are discarded.',
    {
      sandbox_id: z.string().describe('ID of the sandbox'),
      snapshot_id: z.string().describe('Snapshot ID returned by the snapshot tool'),
    },
    async ({ sandbox_id, snapshot_id }) => {
      try {
        const sandbox = getSandbox(sandbox_id);
        sandbox.restore(snapshot_id);
        return textResult(`Restored sandbox ${sandbox_id} to snapshot ${snapshot_id}`);
      } catch (err) {
        return errorResult(`Error restoring snapshot: ${(err as Error).message}`);
      }
    },
  );

  // --- Connect transport ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server connected and ready.');
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
