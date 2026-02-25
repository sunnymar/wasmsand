/**
 * MCP server for wasmsand — exposes a WASM sandbox via the Model Context Protocol.
 *
 * Provides four tools: run_command, read_file, write_file, list_directory.
 * All debug/error output goes to stderr (stdout is reserved for MCP protocol).
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Sandbox } from '@wasmsand/sandbox';
import { NodeAdapter } from '@wasmsand/sandbox/node';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

function log(msg: string): void {
  process.stderr.write(`[mcp-server] ${msg}\n`);
}

// --- Environment configuration ---
const TIMEOUT_MS = Number(process.env.WASMSAND_TIMEOUT_MS) || 30_000;
const FS_LIMIT_BYTES = Number(process.env.WASMSAND_FS_LIMIT_BYTES) || 256 * 1024 * 1024;
const WASM_DIR = process.env.WASMSAND_WASM_DIR
  ?? resolve(__dirname, '../../orchestrator/src/platform/__tests__/fixtures');
const SHELL_WASM = process.env.WASMSAND_SHELL_WASM
  ?? resolve(__dirname, '../../orchestrator/src/shell/__tests__/fixtures/wasmsand-shell.wasm');

async function main(): Promise<void> {
  log('Starting wasmsand MCP server...');
  log(`  wasmDir:    ${WASM_DIR}`);
  log(`  shellWasm:  ${SHELL_WASM}`);
  log(`  timeoutMs:  ${TIMEOUT_MS}`);
  log(`  fsLimit:    ${FS_LIMIT_BYTES}`);

  // --- Create sandbox ---
  const sandbox = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    timeoutMs: TIMEOUT_MS,
    fsLimitBytes: FS_LIMIT_BYTES,
    shellWasmPath: SHELL_WASM,
  });

  // --- Create MCP server ---
  const server = new McpServer({
    name: 'wasmsand',
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
