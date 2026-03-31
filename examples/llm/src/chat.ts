import type { Part } from './types.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { extractCodeBlocks, parseFinalCall } from './parse.js';
import type { CodeBlock } from './parse.js';

export const MAX_TOOL_CALLS = 15;

export type LLMChunk = { choices: Array<{ delta: { content: string | null }; finish_reason: string | null }> };

export type Engine = {
  chat: {
    completions: {
      create: (opts: object) => Promise<AsyncIterable<LLMChunk>>;
    };
  };
};

/** Execute a code block and return its output. */
export type RunBlock = (block: CodeBlock) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string };


export async function runChat(
  engine: Engine,
  runBlock: RunBlock,
  query: string,
  onPart: (part: Part) => void,
): Promise<void> {
  const history: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: query },
  ];

  let toolCallCount = 0;

  while (true) {
    const stream = await engine.chat.completions.create({
      messages: history,
      stream: true,
    });

    // Stream tokens. Once a complete code block closes, stop emitting to the UI
    // but keep consuming so the WebLLM worker finishes naturally (breaking from
    // for-await leaves the worker busy and blocks the next create() call).
    let fullText = '';
    let blockDetected = false;
    for await (const chunk of stream) {
      const content = (chunk as { choices: Array<{ delta: { content?: string | null } }> }).choices[0].delta.content;
      if (content) {
        fullText += content;
        if (!blockDetected) {
          onPart({ kind: 'text', text: content });
          if (extractCodeBlocks(fullText).length > 0) blockDetected = true;
        }
      }
    }

    const blocks = extractCodeBlocks(fullText);
    if (blocks.length === 0) break;

    const resultLines: string[] = [];
    let finalAnswer: string | null = null;

    for (const block of blocks) {
      if (toolCallCount >= MAX_TOOL_CALLS) {
        onPart({ kind: 'text', text: '\n\n_Tool call limit reached — stopping._' });
        return;
      }

      const callId = crypto.randomUUID();
      onPart({ kind: 'tool-call', callId, command: block.code });
      const result = await runBlock(block);
      onPart({ kind: 'tool-result', callId, ...result });

      const output = [result.stdout, result.stderr ? `stderr: ${result.stderr}` : '']
        .filter(Boolean)
        .join('\n');
      resultLines.push(`$ ${block.code}\n${output || '(no output)'}`);

      toolCallCount++;

      // Check for FINAL() sentinel — Python code called FINAL(answer)
      finalAnswer = parseFinalCall(result.stdout);
      if (finalAnswer !== null) break;
    }

    if (finalAnswer !== null) {
      onPart({ kind: 'text', text: `\n\n${finalAnswer}` });
      return;
    }

    // Feed only the portion up to the first code block (what we actually executed)
    const idx = fullText.indexOf('```');
    const endIdx = idx >= 0 ? fullText.indexOf('\n```', idx + 3) : -1;
    const firstBlockText = endIdx >= 0 ? fullText.slice(0, endIdx + 4) : fullText;
    history.push({ role: 'assistant', content: firstBlockText });
    history.push({ role: 'user', content: `[RESULT]\n${resultLines.join('\n\n')}\n[/RESULT]\n\nNow answer based on the output above. Do NOT run the same command again.` });
  }
}
