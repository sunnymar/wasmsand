import * as webllm from '@mlc-ai/web-llm';
export { SYSTEM_PROMPT } from './prompts.js';

export type ProgressCallback = (progress: number, text: string) => void;

export async function initEngine(modelId: string, onProgress: ProgressCallback): Promise<webllm.MLCEngineInterface> {
  return webllm.CreateWebWorkerMLCEngine(
    new Worker(new URL('./llm.worker.ts', import.meta.url), { type: 'module' }),
    modelId,
    { initProgressCallback: (report) => onProgress(report.progress, report.text) },
  );
}
