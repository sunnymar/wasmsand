import type { Part } from './types.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { extractCodeBlocks, parseLlmCommand } from './parse.js';
import type { CodeBlock } from './parse.js';

export const MAX_TOOL_CALLS = 15;
export const MAX_DEPTH = 2;

export type LLMChunk = { choices: Array<{ delta: { content: string | null }; finish_reason: string | null }> };

export type Engine = {
  chat: {
    completions: {
      create: (opts: object) => Promise<AsyncIterable<LLMChunk>>;
    };
  };
  interruptGenerate: () => void | Promise<void>;
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
  depth = 0,
): Promise<void> {
  const history: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: query },
  ];

  let toolCallCount = 0;

  while (true) {
    console.log('[chat] creating stream, history length:', history.length);
    const stream = await engine.chat.completions.create({
      messages: history,
      stream: true,
    });
    console.log('[chat] stream created');

    // Stream and break as soon as a complete code block closes — execute immediately.
    let fullText = '';
    let didBreak = false;
    for await (const chunk of stream) {
      const content = (chunk as { choices: Array<{ delta: { content?: string | null } }> }).choices[0].delta.content;
      if (content) {
        fullText += content;
        onPart({ kind: 'text', text: content });
        if (extractCodeBlocks(fullText).length > 0) { didBreak = true; break; }
      }
    }
    console.log('[chat] stream done, didBreak:', didBreak, 'fullText length:', fullText.length);

    // If we broke out early (code block detected), interrupt the WebLLM worker
    // so the engine is free for the next create() call.
    if (didBreak) {
      console.log('[chat] calling interruptGenerate');
      await engine.interruptGenerate();
      console.log('[chat] interruptGenerate resolved');
    }

    const blocks = extractCodeBlocks(fullText);
    console.log('[chat] extracted blocks:', blocks.length);
    if (blocks.length === 0) break;

    const resultLines: string[] = [];
    for (const block of blocks) {
      if (toolCallCount >= MAX_TOOL_CALLS) {
        onPart({ kind: 'text', text: '\n\n_Tool call limit reached — stopping._' });
        return;
      }

      const callId = crypto.randomUUID();
      // llm "..." is only valid as a bash command.
      const subQuery = block.lang === 'bash' ? parseLlmCommand(block.code) : null;

      if (subQuery !== null) {
        // Recursive sub-agent call.
        onPart({ kind: 'tool-call', callId, command: block.code });

        if (depth >= MAX_DEPTH) {
          const err = 'Max recursion depth reached.';
          onPart({ kind: 'tool-result', callId, stdout: '', stderr: err, exitCode: 1 });
          resultLines.push(`$ ${block.code}\nstderr: ${err}`);
        } else {
          // Run sub-agent; accumulate its text, forward its tool calls.
          let subText = '';
          await runChat(
            engine,
            runBlock,
            subQuery,
            (part) => {
              if (part.kind === 'text') {
                subText += part.text;
              } else {
                // Forward sub-agent tool calls/results so user can see the work.
                onPart(part);
              }
            },
            depth + 1,
          );
          onPart({ kind: 'tool-result', callId, stdout: subText, stderr: '', exitCode: 0 });
          resultLines.push(`$ ${block.code}\n${subText || '(no output)'}`);
        }
      } else {
        // Bash or Python block — execute via the runBlock callback.
        console.log('[chat] executing block:', block.lang, block.code.slice(0, 50));
        onPart({ kind: 'tool-call', callId, command: block.code });
        const result = await runBlock(block);
        console.log('[chat] block result:', result.exitCode, 'stdout:', result.stdout.slice(0, 100));
        onPart({ kind: 'tool-result', callId, ...result });

        const output = [result.stdout, result.stderr ? `stderr: ${result.stderr}` : '']
          .filter(Boolean)
          .join('\n');
        resultLines.push(`$ ${block.code}\n${output || '(no output)'}`);
      }

      toolCallCount++;
    }

    console.log('[chat] turn done, feeding result back');
    history.push({ role: 'assistant', content: fullText });
    history.push({ role: 'user', content: resultLines.join('\n\n') });
  }
}
