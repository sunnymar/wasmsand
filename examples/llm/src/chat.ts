import type { Part } from './types.js';
import { SYSTEM_PROMPT } from './llm.js';

export const MAX_TOOL_CALLS = 15;

type Engine = {
  chat: {
    completions: {
      create: (opts: object) => Promise<AsyncIterable<{ choices: Array<{ delta: { content: string | null }; finish_reason: string | null }> }>>;
    };
  };
};

type RunBash = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string };

/** Extract all bash code block bodies from a model response. */
function extractBashBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```bash\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cmd = m[1].trim();
    if (cmd) blocks.push(cmd);
  }
  return blocks;
}

export async function runChat(
  engine: Engine,
  runBash: RunBash,
  displayMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
  onPart: (part: Part) => void,
): Promise<void> {
  const history: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...displayMessages.map(m => ({ role: m.role, content: m.content })),
  ];

  let toolCallCount = 0;

  while (true) {
    const stream = await engine.chat.completions.create({
      messages: history,
      stream: true,
    });

    let fullText = '';
    for await (const chunk of stream) {
      const content = (chunk as { choices: Array<{ delta: { content?: string | null } }> }).choices[0].delta.content;
      if (content) {
        fullText += content;
        onPart({ kind: 'text', text: content });
      }
    }

    const commands = extractBashBlocks(fullText);
    if (commands.length === 0) break;

    const resultLines: string[] = [];
    for (const cmd of commands) {
      if (toolCallCount >= MAX_TOOL_CALLS) {
        onPart({ kind: 'text', text: '\n\n_Tool call limit reached — stopping._' });
        return;
      }

      const callId = crypto.randomUUID();
      onPart({ kind: 'tool-call', callId, command: cmd });

      const result = await runBash(cmd);
      onPart({ kind: 'tool-result', callId, ...result });

      const output = [result.stdout, result.stderr ? `stderr: ${result.stderr}` : '']
        .filter(Boolean)
        .join('\n');
      resultLines.push(`$ ${cmd}\n${output || '(no output)'}`);
      toolCallCount++;
    }

    history.push({ role: 'assistant', content: fullText });
    history.push({ role: 'user', content: resultLines.join('\n\n') });
  }
}
