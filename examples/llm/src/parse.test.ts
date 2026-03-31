import { assertEquals } from 'jsr:@std/assert';
import { extractCodeBlocks, parseFinalCall } from './parse.ts';

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
// parseFinalCall
// ---------------------------------------------------------------------------

Deno.test('parseFinalCall — detects sentinel in stdout', () => {
  assertEquals(parseFinalCall('__FINAL__:The answer is 42'), 'The answer is 42');
});

Deno.test('parseFinalCall — detects sentinel with leading text', () => {
  assertEquals(parseFinalCall('some output\n__FINAL__:done'), 'done');
});

Deno.test('parseFinalCall — returns null when no sentinel', () => {
  assertEquals(parseFinalCall('just some output'), null);
  assertEquals(parseFinalCall(''), null);
});

Deno.test('parseFinalCall — trims whitespace from answer', () => {
  assertEquals(parseFinalCall('__FINAL__:  hello  '), 'hello');
});

Deno.test('parseFinalCall — multiline answer captured', () => {
  const result = parseFinalCall('__FINAL__:line1\nline2\nline3');
  assertEquals(result, 'line1\nline2\nline3');
});
