import { assertEquals } from 'jsr:@std/assert';
import { extractCodeBlocks, parseLlmCommand } from './parse.ts';

// ---------------------------------------------------------------------------
// extractCodeBlocks
// ---------------------------------------------------------------------------

Deno.test('extracts a bash block', () => {
  assertEquals(extractCodeBlocks('```bash\necho hello\n```'), [
    { lang: 'bash', code: 'echo hello' },
  ]);
});

Deno.test('extracts a python block', () => {
  assertEquals(extractCodeBlocks('```python\nimport math; print(math.pi)\n```'), [
    { lang: 'python', code: 'import math; print(math.pi)' },
  ]);
});

Deno.test('extracts a python3 block', () => {
  assertEquals(extractCodeBlocks('```python3\nimport numpy as np\nprint(np.e ** np.pi)\n```'), [
    { lang: 'python', code: 'import numpy as np\nprint(np.e ** np.pi)' },
  ]);
});

Deno.test('extracts a Python3 (mixed case) block', () => {
  assertEquals(extractCodeBlocks('```Python3\nimport os\nprint(os.getcwd())\n```'), [
    { lang: 'python', code: 'import os\nprint(os.getcwd())' },
  ]);
});

Deno.test('extracts a py block', () => {
  assertEquals(extractCodeBlocks('```py\nprint(42)\n```'), [
    { lang: 'python', code: 'print(42)' },
  ]);
});

Deno.test('handles trailing whitespace after language tag', () => {
  assertEquals(extractCodeBlocks('```python3  \nimport math\n```'), [
    { lang: 'python', code: 'import math' },
  ]);
});

Deno.test('handles sh and shell tags', () => {
  assertEquals(extractCodeBlocks('```sh\nls -la\n```'), [{ lang: 'bash', code: 'ls -la' }]);
  assertEquals(extractCodeBlocks('```shell\nls -la\n```'), [{ lang: 'bash', code: 'ls -la' }]);
});

Deno.test('ignores non-executable language blocks', () => {
  const text = '```json\n{"key": "value"}\n```\n```typescript\nconst x = 1;\n```';
  assertEquals(extractCodeBlocks(text), []);
});

Deno.test('extracts multiple blocks in order', () => {
  const text = [
    '```bash\necho step1\n```',
    'some text',
    '```python\nprint("step2")\n```',
  ].join('\n');
  assertEquals(extractCodeBlocks(text), [
    { lang: 'bash', code: 'echo step1' },
    { lang: 'python', code: 'print("step2")' },
  ]);
});

Deno.test('skips empty blocks', () => {
  assertEquals(extractCodeBlocks('```bash\n   \n```'), []);
});

Deno.test('stops at first complete block (early-break simulation)', () => {
  const partial = '```bash\necho hi\n```';
  const blocks = extractCodeBlocks(partial);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0], { lang: 'bash', code: 'echo hi' });
});

// ---------------------------------------------------------------------------
// parseLlmCommand
// ---------------------------------------------------------------------------

Deno.test('parses llm "query" (double quotes)', () => {
  assertEquals(parseLlmCommand('llm "what is pi?"'), 'what is pi?');
});

Deno.test("parses llm 'query' (single quotes)", () => {
  assertEquals(parseLlmCommand("llm 'what is pi?'"), 'what is pi?');
});

Deno.test('returns null for a non-llm command', () => {
  assertEquals(parseLlmCommand('echo hello'), null);
  assertEquals(parseLlmCommand('python3 script.py'), null);
});

Deno.test('returns null for llm without quotes', () => {
  assertEquals(parseLlmCommand('llm what is pi'), null);
});

Deno.test('trims whitespace from query', () => {
  assertEquals(parseLlmCommand('llm "  hello  "'), 'hello');
});
