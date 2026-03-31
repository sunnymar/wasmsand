/**
 * Integration tests for the full runChat loop.
 * Uses a mock engine (no WebLLM / browser needed) and a mock block runner.
 *
 *   deno test src/chat.test.ts
 */
import { assertEquals } from 'jsr:@std/assert';
import { runChat, MAX_TOOL_CALLS } from './chat.ts';
import type { Engine, LLMChunk, RunBlock } from './chat.ts';
import type { CodeBlock } from './parse.ts';
import type { Part } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Engine that returns successive `responses` on each call. */
function mockEngine(responses: string[]): Engine {
  let call = 0;
  return {
    chat: {
      completions: {
        create: async (_opts: object): Promise<AsyncIterable<LLMChunk>> => {
          const text = responses[call++] ?? '';
          return (async function* (): AsyncGenerator<LLMChunk> {
            yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
          })();
        },
      },
    },
  };
}

/** Collect all parts from runChat into an array. */
async function collect(
  engine: Engine,
  runBlock: RunBlock,
  question: string,
): Promise<Part[]> {
  const parts: Part[] = [];
  await runChat(engine, runBlock, question, (p) => parts.push(p));
  return parts;
}

const noBlock: RunBlock = async () => ({ stdout: '', stderr: '', exitCode: 0 });

// ---------------------------------------------------------------------------
// Plain text (no tool calls)
// ---------------------------------------------------------------------------

Deno.test('plain text response — no tool calls', async () => {
  const parts = await collect(mockEngine(['The answer is 42.']), noBlock, 'What is 6 * 7?');
  assertEquals(parts, [{ kind: 'text', text: 'The answer is 42.' }]);
});

Deno.test('multiline plain text response', async () => {
  const parts = await collect(mockEngine(['Line one.\nLine two.']), noBlock, 'Give me two lines.');
  assertEquals(parts.length, 1);
  assertEquals((parts[0] as { kind: string; text: string }).text, 'Line one.\nLine two.');
});

// ---------------------------------------------------------------------------
// Bash blocks
// ---------------------------------------------------------------------------

Deno.test('bash block — executes command, feeds result back', async () => {
  const called: CodeBlock[] = [];
  const parts = await collect(
    mockEngine(['```bash\necho hello\n```', 'The output was: hello']),
    async (block) => { called.push(block); return { stdout: 'hello\n', stderr: '', exitCode: 0 }; },
    'Say hello',
  );
  assertEquals(called, [{ lang: 'bash', code: 'echo hello' }]);
  const tc = parts.find((p) => p.kind === 'tool-call') as Extract<Part, { kind: 'tool-call' }>;
  assertEquals(tc.command, 'echo hello');
  const tr = parts.find((p) => p.kind === 'tool-result') as Extract<Part, { kind: 'tool-result' }>;
  assertEquals(tr.stdout, 'hello\n');
  assertEquals(tr.exitCode, 0);
});

Deno.test('bash block with non-zero exit — still fed back', async () => {
  const parts = await collect(
    mockEngine(['```bash\ncat /nonexistent\n```', 'File not found.']),
    async () => ({ stdout: '', stderr: 'No such file', exitCode: 1 }),
    'Read a file',
  );
  const tr = parts.find((p) => p.kind === 'tool-result') as Extract<Part, { kind: 'tool-result' }>;
  assertEquals(tr.exitCode, 1);
  assertEquals(tr.stderr, 'No such file');
});

Deno.test('multiple sequential bash turns', async () => {
  const called: string[] = [];
  const parts = await collect(
    mockEngine(['```bash\necho step1\n```', '```bash\necho step2\n```', 'Done.']),
    async (block) => { called.push(block.code); return { stdout: block.code.replace('echo ', '') + '\n', stderr: '', exitCode: 0 }; },
    'Run two steps',
  );
  assertEquals(called, ['echo step1', 'echo step2']);
  assertEquals(parts.filter((p) => p.kind === 'tool-call').length, 2);
});

// ---------------------------------------------------------------------------
// Python blocks — lang: 'python', passed as CodeBlock to runBlock
// ---------------------------------------------------------------------------

Deno.test('python3 block — passed as python CodeBlock', async () => {
  const called: CodeBlock[] = [];
  const parts = await collect(
    mockEngine(['```python3\nimport math\nprint(math.pi)\n```', 'Pi is ~3.14.']),
    async (block) => { called.push(block); return { stdout: '3.14\n', stderr: '', exitCode: 0 }; },
    'What is pi?',
  );
  assertEquals(called[0], { lang: 'python', code: 'import math\nprint(math.pi)' });
  const tc = parts.find((p) => p.kind === 'tool-call') as Extract<Part, { kind: 'tool-call' }>;
  assertEquals(tc.command, 'import math\nprint(math.pi)');
});

Deno.test('Python3 (mixed case) also lang: python', async () => {
  const called: CodeBlock[] = [];
  await collect(
    mockEngine(['```Python3\nprint(42)\n```', 'Done.']),
    async (block) => { called.push(block); return { stdout: '42\n', stderr: '', exitCode: 0 }; },
    'Print 42',
  );
  assertEquals(called[0].lang, 'python');
  assertEquals(called[0].code, 'print(42)');
});

// ---------------------------------------------------------------------------
// Tool call limit
// ---------------------------------------------------------------------------

Deno.test('tool call limit stops the loop', async () => {
  const parts = await collect(
    mockEngine(Array(MAX_TOOL_CALLS + 5).fill('```bash\necho x\n```')),
    async () => ({ stdout: 'x\n', stderr: '', exitCode: 0 }),
    'Loop',
  );
  const limitMsg = parts.find(
    (p) => p.kind === 'text' && (p as { kind: string; text: string }).text.includes('Tool call limit'),
  );
  assertEquals(limitMsg !== undefined, true);
  assertEquals(parts.filter((p) => p.kind === 'tool-call').length, MAX_TOOL_CALLS);
});

// ---------------------------------------------------------------------------
// FINAL() sentinel detection
// ---------------------------------------------------------------------------

Deno.test('FINAL() sentinel in stdout terminates the loop early', async () => {
  // Model writes Python code; runBlock returns stdout with __FINAL__: marker.
  const parts = await collect(
    mockEngine(['```python\nfrom llm import sub_llm, FINAL\nFINAL("The answer is 42")\n```']),
    async () => ({ stdout: '__FINAL__:The answer is 42', stderr: '', exitCode: 0 }),
    'Answer with FINAL',
  );
  // Should see: tool-call, tool-result, then a text part with the answer
  const tc = parts.find((p) => p.kind === 'tool-call');
  assertEquals(tc !== undefined, true);
  const tr = parts.find((p) => p.kind === 'tool-result');
  assertEquals(tr !== undefined, true);
  const textPart = parts.find(
    (p) => p.kind === 'text' && (p as Extract<Part, { kind: 'text' }>).text.includes('The answer is 42'),
  );
  assertEquals(textPart !== undefined, true);
});

Deno.test('FINAL() stops the loop — no further engine calls after sentinel', async () => {
  let callCount = 0;
  const engine: Engine = {
    chat: {
      completions: {
        create: async (): Promise<AsyncIterable<LLMChunk>> => {
          callCount++;
          const text = '```python\nFINAL("done")\n```';
          return (async function* (): AsyncGenerator<LLMChunk> {
            yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
          })();
        },
      },
    },
  };
  await runChat(engine, async () => ({ stdout: '__FINAL__:done', stderr: '', exitCode: 0 }), 'Go', () => {});
  // Only one engine call — the loop exits after FINAL, never re-enters
  assertEquals(callCount, 1);
});

// ---------------------------------------------------------------------------
// History construction
// ---------------------------------------------------------------------------

Deno.test('tool output included in next turn user message', async () => {
  const seenMessages: Array<Array<{ role: string; content: string }>> = [];
  let turn = 0;
  const engine: Engine = {
    chat: {
      completions: {
        create: async (opts: object): Promise<AsyncIterable<LLMChunk>> => {
          seenMessages.push([...(opts as { messages: Array<{ role: string; content: string }> }).messages]);
          const text = turn++ === 0 ? '```bash\necho hi\n```' : 'Done.';
          return (async function* (): AsyncGenerator<LLMChunk> {
            yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
          })();
        },
      },
    },
  };

  await runChat(
    engine,
    async () => ({ stdout: 'hi\n', stderr: '', exitCode: 0 }),
    'Say hi',
    () => {},
  );

  assertEquals(seenMessages.length, 2);
  const resultMsg = seenMessages[1].find(
    (m) => m.role === 'user' && m.content.includes('echo hi') && m.content.includes('hi\n'),
  );
  assertEquals(resultMsg !== undefined, true);
});
