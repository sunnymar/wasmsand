import * as webllm from '@mlc-ai/web-llm';

export const MODEL_ID = 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC';

export type ProgressCallback = (progress: number, text: string) => void;

export async function initEngine(onProgress: ProgressCallback): Promise<webllm.MLCEngineInterface> {
  return webllm.CreateWebWorkerMLCEngine(
    new Worker(new URL('./llm.worker.ts', import.meta.url), { type: 'module' }),
    MODEL_ID,
    { initProgressCallback: (report) => onProgress(report.progress, report.text) },
  );
}

// System prompt for the RLM-style bash loop.
// No JSON tool schema — the model emits plain ```bash blocks.
export const SYSTEM_PROMPT =
  `You are an assistant with access to a bash sandbox. To run shell commands, ` +
  `write them in a bash code block:\n\n` +
  `\`\`\`bash\n<command>\n\`\`\`\n\n` +
  `The output will be shown to you and you can run more commands. ` +
  `Run as many commands as needed, then give your final answer in plain text ` +
  `(with no bash block).\n\n` +
  `The sandbox has 95+ Unix commands and Python 3 (with numpy). ` +
  `Working directory is /src/, which contains this demo's source files. ` +
  `Prefer python3 -c for computation and data work where shell syntax is awkward.`;
