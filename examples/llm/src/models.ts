/** Curated list of WebLLM models for the RLM demo. */
export interface ModelOption {
  id: string;
  label: string;
  size: string; // human-readable download size
}

export const MODELS: ModelOption[] = [
  { id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',  label: 'Qwen2.5-Coder 3B',  size: '~1.7 GB' },
  { id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',  label: 'Qwen2.5-Coder 7B',  size: '~4.3 GB' },
  { id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',       label: 'Llama 3.1 8B',       size: '~4.6 GB' },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',        label: 'Phi 3.5 Mini 3.8B',  size: '~2.2 GB' },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;
