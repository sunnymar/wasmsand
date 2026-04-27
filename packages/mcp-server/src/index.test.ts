import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = resolve(import.meta.dirname, 'index.ts');

function createClient() {
  const transport = new StdioClientTransport({
    command: 'deno',
    args: ['run', '-A', '--no-check', '--unstable-sloppy-imports', SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  return { client, transport };
}

/** Connect, create a sandbox, and return the connected client + sandbox_id.
 *  Every per-sandbox tool requires a sandbox_id since the multi-sandbox
 *  refactor — this is the boilerplate every test needs. */
async function setupClientWithSandbox(): Promise<{
  client: Client;
  transport: StdioClientTransport;
  sandboxId: string;
}> {
  const ctx = createClient();
  await ctx.client.connect(ctx.transport);
  const create = await ctx.client.callTool({ name: 'create_sandbox', arguments: {} });
  const content = create.content as Array<{ type: string; text: string }>;
  const { sandbox_id } = JSON.parse(content[0].text);
  return { client: ctx.client, transport: ctx.transport, sandboxId: sandbox_id };
}

describe('MCP Server (integration)', { sanitizeOps: false, sanitizeResources: false }, () => {
  let transport: StdioClientTransport | undefined;

  afterEach(async () => {
    if (transport) {
      try {
        await transport.close();
      } catch {
        // ignore cleanup errors
      }
      transport = undefined;
    }
  });

  it('lists all tools', async () => {
    const ctx = createClient();
    transport = ctx.transport;
    await ctx.client.connect(ctx.transport);

    const result = await ctx.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'create_sandbox', 'destroy_sandbox',
      'export_state', 'import_state',
      'list_directory', 'list_sandboxes',
      'read_file', 'restore', 'run_command',
      'snapshot', 'write_file',
    ]);
  }, 30_000);

  it('run_command executes shell commands', async () => {
    const ctx = await setupClientWithSandbox();
    transport = ctx.transport;

    const result = await ctx.client.callTool({
      name: 'run_command',
      arguments: { sandbox_id: ctx.sandboxId, command: 'echo hello world' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    const parsed = JSON.parse(content[0].text);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout.trim()).toBe('hello world');
  }, 30_000);

  it('write_file + read_file round-trip', async () => {
    const ctx = await setupClientWithSandbox();
    transport = ctx.transport;

    const testContents = 'Hello from integration test!\nLine 2.';
    const testPath = '/home/user/test-roundtrip.txt';

    // Write
    const writeResult = await ctx.client.callTool({
      name: 'write_file',
      arguments: { sandbox_id: ctx.sandboxId, path: testPath, contents: testContents },
    });
    expect(writeResult.isError).toBeFalsy();

    // Read back
    const readResult = await ctx.client.callTool({
      name: 'read_file',
      arguments: { sandbox_id: ctx.sandboxId, path: testPath },
    });
    expect(readResult.isError).toBeFalsy();
    const content = readResult.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe(testContents);
  }, 30_000);

  it('list_directory returns entries', async () => {
    const ctx = await setupClientWithSandbox();
    transport = ctx.transport;

    // Create a file so there's something to list.  Use redirect rather
    // than `touch` — BusyBox 1.37.0's touch applet under codepod
    // currently exits 0 without creating the file (tracked separately,
    // pre-dates this PR).
    await ctx.client.callTool({
      name: 'run_command',
      arguments: { sandbox_id: ctx.sandboxId, command: 'echo > /home/user/listed-file.txt' },
    });

    const result = await ctx.client.callTool({
      name: 'list_directory',
      arguments: { sandbox_id: ctx.sandboxId, path: '/home/user' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const entries = JSON.parse(content[0].text) as Array<{ name: string; type: string; size: number }>;
    const names = entries.map((e) => e.name);
    expect(names).toContain('listed-file.txt');
  }, 30_000);

  it('run_command handles pipes', async () => {
    const ctx = await setupClientWithSandbox();
    transport = ctx.transport;

    const result = await ctx.client.callTool({
      name: 'run_command',
      arguments: { sandbox_id: ctx.sandboxId, command: 'echo one two three | wc -w' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout.trim()).toBe('3');
  }, 30_000);

  it('run_command preserves double quotes in commands', async () => {
    const ctx = await setupClientWithSandbox();
    transport = ctx.transport;

    const result = await ctx.client.callTool({
      name: 'run_command',
      arguments: { sandbox_id: ctx.sandboxId, command: 'echo "hello world"' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout.trim()).toBe('hello world');
  }, 30_000);

  it('run_command preserves single quotes in commands', async () => {
    const ctx = await setupClientWithSandbox();
    transport = ctx.transport;

    const result = await ctx.client.callTool({
      name: 'run_command',
      arguments: { sandbox_id: ctx.sandboxId, command: "echo 'hello world'" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout.trim()).toBe('hello world');
  }, 30_000);

  it('run_command preserves quoted redirect content', async () => {
    const ctx = await setupClientWithSandbox();
    transport = ctx.transport;

    // Write via quoted echo + redirect
    await ctx.client.callTool({
      name: 'run_command',
      arguments: { sandbox_id: ctx.sandboxId, command: 'echo "hello" > /tmp/quote-test.txt' },
    });
    // Read it back
    const result = await ctx.client.callTool({
      name: 'read_file',
      arguments: { sandbox_id: ctx.sandboxId, path: '/tmp/quote-test.txt' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text.trim()).toBe('hello');
  }, 30_000);

  it('read_file returns error for missing file', async () => {
    const ctx = await setupClientWithSandbox();
    transport = ctx.transport;

    const result = await ctx.client.callTool({
      name: 'read_file',
      arguments: { sandbox_id: ctx.sandboxId, path: '/nonexistent/path/does-not-exist.txt' },
    });
    expect(result.isError).toBe(true);
  }, 30_000);
});
