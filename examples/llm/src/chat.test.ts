import { describe, it, expect, vi } from 'vitest';
import { runChat, MAX_TOOL_CALLS } from './chat.js';
import type { Part } from './types.js';

// Helpers to build fake stream chunks
function textChunk(text: string, finish?: string) {
  return { choices: [{ delta: { content: text, tool_calls: undefined }, finish_reason: finish ?? null }] };
}

function toolChunk(id: string, name: string, args: string, finish?: string) {
  return {
    choices: [{
      delta: {
        content: null,
        tool_calls: [{ index: 0, id, function: { name, arguments: args } }],
      },
      finish_reason: finish ?? null,
    }],
  };
}

function makeEngine(responses: object[][]): { chat: { completions: { create: ReturnType<typeof vi.fn> } } } {
  let call = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => responses[call++]),
      },
    },
  };
}

function makeSandbox(results: Array<{ stdout: string; stderr: string; exitCode: number }>) {
  let i = 0;
  return vi.fn(async (_cmd: string) => results[i++]);
}

describe('runChat', () => {
  it('emits text parts from a simple text response', async () => {
    const engine = makeEngine([[
      textChunk('Hello '),
      textChunk('world'),
      textChunk('', 'stop'),
    ]]);
    const sandbox = makeSandbox([]);
    const parts: Part[] = [];
    await runChat(engine as never, sandbox, [{ role: 'user', content: 'hi' }], (p) => parts.push(p));
    expect(parts.filter(p => p.kind === 'text').map(p => (p as { kind: 'text'; text: string }).text).join('')).toBe('Hello world');
  });

  it('runs a tool call and emits tool-call + tool-result parts', async () => {
    const engine = makeEngine([
      [toolChunk('c1', 'bash', '{"command":"ls /src"}', 'tool_calls')],
      [textChunk('Here are the files.', 'stop')],
    ]);
    const sandbox = makeSandbox([{ stdout: 'main.tsx\n', stderr: '', exitCode: 0 }]);
    const parts: Part[] = [];
    await runChat(engine as never, sandbox, [{ role: 'user', content: 'list files' }], (p) => parts.push(p));

    const toolCall = parts.find(p => p.kind === 'tool-call') as { kind: 'tool-call'; command: string } | undefined;
    const toolResult = parts.find(p => p.kind === 'tool-result') as { kind: 'tool-result'; stdout: string } | undefined;
    expect(toolCall?.command).toBe('ls /src');
    expect(toolResult?.stdout).toBe('main.tsx\n');
    expect(sandbox).toHaveBeenCalledWith('ls /src');
  });

  it('stops after MAX_TOOL_CALLS and emits a cap notice', async () => {
    const alwaysToolResponse = [toolChunk('c1', 'bash', '{"command":"echo hi"}', 'tool_calls')];
    const responses = Array(MAX_TOOL_CALLS + 1).fill(alwaysToolResponse);
    const engine = makeEngine(responses);
    const sandbox = makeSandbox(Array(MAX_TOOL_CALLS).fill({ stdout: 'hi\n', stderr: '', exitCode: 0 }));
    const parts: Part[] = [];
    await runChat(engine as never, sandbox, [{ role: 'user', content: 'loop' }], (p) => parts.push(p));

    const toolCalls = parts.filter(p => p.kind === 'tool-call');
    expect(toolCalls.length).toBe(MAX_TOOL_CALLS);
    const lastText = parts.filter(p => p.kind === 'text').pop() as { kind: 'text'; text: string } | undefined;
    expect(lastText?.text).toContain('Tool call limit reached');
  });
});
