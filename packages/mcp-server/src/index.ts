/**
 * MCP server for codepod — exposes a WASM sandbox via the Model Context Protocol.
 *
 * Provides four tools: run_command, read_file, write_file, list_directory.
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
    ?? resolve(__dirname, '../../orchestrator/src/shell/__tests__/fixtures/codepod-shell.wasm'),
});

async function main(): Promise<void> {
  log('Starting codepod MCP server...');
  log(`  wasmDir:    ${config.wasmDir}`);
  log(`  shellWasm:  ${config.shellWasm}`);
  log(`  timeoutMs:  ${config.timeoutMs}`);
  log(`  fsLimit:    ${config.fsLimitBytes}`);
  log(`  mounts:     ${config.mounts.length}`);

  // --- Build network policy (only if allow/block are non-empty) ---
  const hasNetwork = config.network.allow.length > 0 || config.network.block.length > 0;
  const network: NetworkPolicy | undefined = hasNetwork
    ? {
        allowedHosts: config.network.allow.length > 0 ? config.network.allow : undefined,
        blockedHosts: config.network.block.length > 0 ? config.network.block : undefined,
      }
    : undefined;

  if (network) {
    log(`  network:    allow=${config.network.allow.join(',')} block=${config.network.block.join(',')}`);
  } else {
    log('  network:    disabled');
  }

  // --- Create sandbox ---
  const sandbox = await Sandbox.create({
    wasmDir: config.wasmDir,
    adapter: new NodeAdapter(),
    timeoutMs: config.timeoutMs,
    fsLimitBytes: config.fsLimitBytes,
    shellWasmPath: config.shellWasm,
    network,
  });

  // --- Mount host directories ---
  for (const mount of config.mounts) {
    const provider = new HostFsProvider(mount.hostPath, { writable: mount.writable });
    sandbox.mount(mount.sandboxPath, provider);
    log(`  mounted:    ${mount.hostPath} → ${mount.sandboxPath} (${mount.writable ? 'rw' : 'ro'})`);
  }

  // --- Create MCP server ---
  const server = new McpServer({
    name: 'codepod',
    version: '0.0.1',
  });

  // --- Tool: run_command ---
  server.tool(
    'run_command',
    'Run a shell command in the WASM sandbox',
    { command: z.string().describe('The shell command to execute') },
    async ({ command }) => {
      const result = await sandbox.run(command);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            exit_code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        }],
      };
    },
  );

  // --- Tool: read_file ---
  server.tool(
    'read_file',
    'Read a file from the sandbox filesystem',
    { path: z.string().describe('Absolute path of the file to read') },
    async ({ path }) => {
      try {
        const data = sandbox.readFile(path);
        const text = new TextDecoder().decode(data);
        return {
          content: [{ type: 'text' as const, text }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `Error reading file: ${(err as Error).message}`,
          }],
        };
      }
    },
  );

  // --- Tool: write_file ---
  server.tool(
    'write_file',
    'Write a file to the sandbox filesystem',
    {
      path: z.string().describe('Absolute path of the file to write'),
      contents: z.string().describe('Text contents to write'),
    },
    async ({ path, contents }) => {
      try {
        const data = new TextEncoder().encode(contents);
        sandbox.writeFile(path, data);
        return {
          content: [{
            type: 'text' as const,
            text: `Wrote ${data.byteLength} bytes to ${path}`,
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `Error writing file: ${(err as Error).message}`,
          }],
        };
      }
    },
  );

  // --- Tool: list_directory ---
  server.tool(
    'list_directory',
    'List the contents of a directory in the sandbox filesystem',
    {
      path: z.string().default('/home/user').describe('Absolute path of the directory to list'),
    },
    async ({ path }) => {
      try {
        const entries = sandbox.readDir(path);
        const enriched = entries.map((entry) => {
          let size = 0;
          try {
            const st = sandbox.stat(
              path.endsWith('/') ? `${path}${entry.name}` : `${path}/${entry.name}`,
            );
            size = st.size;
          } catch {
            // stat may fail for special entries; default to 0
          }
          return { name: entry.name, type: entry.type, size };
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(enriched),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `Error listing directory: ${(err as Error).message}`,
          }],
        };
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
