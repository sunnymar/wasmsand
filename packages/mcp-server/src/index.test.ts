import { describe, it, expect, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = resolve(import.meta.dirname, 'index.ts');

function createClient() {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  return { client, transport };
}

describe('MCP Server (integration)', () => {
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

  it('lists 4 tools', async () => {
    const ctx = createClient();
    transport = ctx.transport;
    await ctx.client.connect(ctx.transport);

    const result = await ctx.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['list_directory', 'read_file', 'run_command', 'write_file']);
  }, 30_000);

  it('run_command executes shell commands', async () => {
    const ctx = createClient();
    transport = ctx.transport;
    await ctx.client.connect(ctx.transport);

    const result = await ctx.client.callTool({ name: 'run_command', arguments: { command: 'echo hello world' } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    const parsed = JSON.parse(content[0].text);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout.trim()).toBe('hello world');
  }, 30_000);

  it('write_file + read_file round-trip', async () => {
    const ctx = createClient();
    transport = ctx.transport;
    await ctx.client.connect(ctx.transport);

    const testContents = 'Hello from integration test!\nLine 2.';
    const testPath = '/home/user/test-roundtrip.txt';

    // Write
    const writeResult = await ctx.client.callTool({
      name: 'write_file',
      arguments: { path: testPath, contents: testContents },
    });
    expect(writeResult.isError).toBeFalsy();

    // Read back
    const readResult = await ctx.client.callTool({
      name: 'read_file',
      arguments: { path: testPath },
    });
    expect(readResult.isError).toBeFalsy();
    const content = readResult.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe(testContents);
  }, 30_000);

  it('list_directory returns entries', async () => {
    const ctx = createClient();
    transport = ctx.transport;
    await ctx.client.connect(ctx.transport);

    // Create a file so there's something to list
    await ctx.client.callTool({
      name: 'run_command',
      arguments: { command: 'touch /home/user/listed-file.txt' },
    });

    const result = await ctx.client.callTool({
      name: 'list_directory',
      arguments: { path: '/home/user' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const entries = JSON.parse(content[0].text) as Array<{ name: string; type: string; size: number }>;
    const names = entries.map((e) => e.name);
    expect(names).toContain('listed-file.txt');
  }, 30_000);

  it('run_command handles pipes', async () => {
    const ctx = createClient();
    transport = ctx.transport;
    await ctx.client.connect(ctx.transport);

    const result = await ctx.client.callTool({
      name: 'run_command',
      arguments: { command: 'echo one two three | wc -w' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout.trim()).toBe('3');
  }, 30_000);

  it('read_file returns error for missing file', async () => {
    const ctx = createClient();
    transport = ctx.transport;
    await ctx.client.connect(ctx.transport);

    const result = await ctx.client.callTool({
      name: 'read_file',
      arguments: { path: '/nonexistent/path/does-not-exist.txt' },
    });
    expect(result.isError).toBe(true);
  }, 30_000);
});
