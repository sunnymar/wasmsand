import * as webllm from '@mlc-ai/web-llm';

export const MODEL_ID = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';

export type ProgressCallback = (progress: number, text: string) => void;

export async function initEngine(onProgress: ProgressCallback): Promise<webllm.MLCEngineInterface> {
  return webllm.CreateWebWorkerMLCEngine(
    new Worker(new URL('./llm.worker.ts', import.meta.url), { type: 'module' }),
    MODEL_ID,
    { initProgressCallback: (report) => onProgress(report.progress, report.text) },
  );
}

export const BASH_TOOL: webllm.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a bash command in the sandbox. The sandbox has 95+ Unix commands and Python 3 (with numpy). Working directory is /src/.',
    parameters: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to run.',
        },
      },
      required: ['command'],
    },
  },
};

export const SYSTEM_PROMPT =
  `You have access to a sandbox via the bash tool. The sandbox provides a full ` +
  `POSIX shell with 95+ Unix commands and a Python 3 runtime (including numpy).\n\n` +
  `The sandbox filesystem has the demo's source files at /src/. You can run shell ` +
  `commands, pipe them together, use awk/sed/jq, run python3 -c for quick ` +
  `computations, or write a script to /tmp/ and execute it.\n\n` +
  `Keep your commands focused. Prefer python3 for computation and data ` +
  `manipulation where shell syntax would be awkward.`;
