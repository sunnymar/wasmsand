import type { Part } from './types.js';
import { BASH_TOOL, SYSTEM_PROMPT } from './llm.js';

export const MAX_TOOL_CALLS = 15;

type Engine = {
  chat: {
    completions: {
      create: (opts: object) => Promise<AsyncIterable<{ choices: Array<{ delta: { content: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason: string | null }> }>>;
    };
  };
};

type RunBash = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// OpenAI message format for the LLM (separate from display ChatMessage)
type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

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
      tools: [BASH_TOOL],
      stream: true,
    });

    let textBuffer = '';
    let toolCallId = '';
    let toolCallName = '';
    let toolCallArgs = '';
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta;

      if (delta.content) {
        textBuffer += delta.content;
        onPart({ kind: 'text', text: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) toolCallId = tc.id;
          if (tc.function?.name) toolCallName = tc.function.name;
          if (tc.function?.arguments) toolCallArgs += tc.function.arguments;
        }
      }
    }

    if (finishReason === 'tool_calls' && toolCallName === 'bash') {
      let command = '';
      try {
        command = (JSON.parse(toolCallArgs) as { command: string }).command;
      } catch {
        command = toolCallArgs;
      }

      onPart({ kind: 'tool-call', callId: toolCallId, command });

      const result = await runBash(command);
      onPart({ kind: 'tool-result', callId: toolCallId, ...result });

      history.push({
        role: 'assistant',
        content: textBuffer || null,
        tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'bash', arguments: toolCallArgs } }],
      });
      history.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: result.stdout + (result.stderr ? `\nstderr: ${result.stderr}` : ''),
      });

      toolCallCount++;
      if (toolCallCount >= MAX_TOOL_CALLS) {
        onPart({ kind: 'text', text: '\n\n_Tool call limit reached — stopping._' });
        break;
      }

      textBuffer = '';
      toolCallId = '';
      toolCallName = '';
      toolCallArgs = '';
      finishReason = null;
      continue;
    }

    break;
  }
}
