/**
 * CLI runner for the RLM chat loop — uses a real LLM API + real bash.
 * Lets you interact with (and debug) the chat loop without a browser.
 *
 * Quickstart:
 *   deno task cli "What is e^pi?"           # auto-detects provider from env
 *   deno task cli --provider ollama "..."   # local Ollama
 *
 * Provider auto-detection (first match wins):
 *   ANTHROPIC_API_KEY  → Anthropic  (default model: claude-haiku-4-5-20251001)
 *   OPENAI_API_KEY     → OpenAI     (default model: gpt-4o-mini)
 *   OPENROUTER_API_KEY → OpenRouter (default model: meta-llama/llama-3.2-8b-instruct:free)
 *   (none)             → Ollama     (default model: llama3.2, baseURL: localhost:11434)
 *
 * Flags:
 *   --provider  anthropic|openai|openrouter|ollama   override auto-detection
 *   --model     <model-id>                           override default model
 */
import Anthropic from 'npm:@anthropic-ai/sdk';
import OpenAI from 'npm:openai';
import { runChat } from './chat.ts';
import type { Engine, LLMChunk, RunBlock } from './chat.ts';
import type { Part } from './types.ts';

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

function makeAnthropicEngine(apiKey: string, model: string): Engine {
  const client = new Anthropic({ apiKey });
  return {
    chat: {
      completions: {
        create: async (opts: object): Promise<AsyncIterable<LLMChunk>> => {
          const { messages } = opts as { messages: Array<{ role: string; content: string }> };
          const systemMsg = messages.find((m) => m.role === 'system');
          const otherMsgs = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

          const stream = await client.messages.stream({
            model,
            max_tokens: 4096,
            ...(systemMsg ? { system: systemMsg.content } : {}),
            messages: otherMsgs,
          });

          return (async function* (): AsyncGenerator<LLMChunk> {
            for await (const event of stream) {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield { choices: [{ delta: { content: event.delta.text }, finish_reason: null }] };
              }
            }
          })();
        },
      },
    },
  };
}

/** Works for OpenAI, OpenRouter, and Ollama — all share the OpenAI-compatible API. */
function makeOpenAICompatEngine(apiKey: string, model: string, baseURL?: string): Engine {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return {
    chat: {
      completions: {
        create: async (opts: object): Promise<AsyncIterable<LLMChunk>> => {
          const { messages } = opts as { messages: Array<{ role: string; content: string }> };
          const stream = await client.chat.completions.create({
            model,
            messages: messages as OpenAI.ChatCompletionMessageParam[],
            stream: true,
          });
          // OpenAI stream chunks are structurally compatible with LLMChunk.
          return stream as unknown as AsyncIterable<LLMChunk>;
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Real bash via Deno.Command
// ---------------------------------------------------------------------------

async function runBash(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = new Deno.Command('bash', {
    args: ['-c', command],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await proc.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    exitCode: code,
  };
}

const runBlock: RunBlock = async (block) => {
  if (block.lang === 'python') {
    await Deno.writeTextFile('/tmp/_cp.py', block.code);
    return runBash('python3 /tmp/_cp.py');
  }
  return runBash(block.code);
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

function renderPart(part: Part): void {
  switch (part.kind) {
    case 'text':
      Deno.stdout.writeSync(new TextEncoder().encode(part.text));
      break;
    case 'tool-call':
      console.error(`\n${CYAN}▶${RESET} ${DIM}${part.command.split('\n')[0]}${RESET}`);
      break;
    case 'tool-result': {
      const icon = part.exitCode === 0 ? `${GREEN}✓${RESET}` : `${RED}✗ ${part.exitCode}${RESET}`;
      if (part.stdout) console.error(`${DIM}${part.stdout.trimEnd()}${RESET}`);
      if (part.stderr) console.error(`${RED}${part.stderr.trimEnd()}${RESET}`);
      console.error(icon);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = [...Deno.args];
let providerFlag: string | undefined;
let modelFlag: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--provider' && args[i + 1]) {
    providerFlag = args.splice(i, 2)[1];
    i--;
  } else if (args[i] === '--model' && args[i + 1]) {
    modelFlag = args.splice(i, 2)[1];
    i--;
  }
}
const question = args.join(' ').trim();

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

type ProviderName = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

function detectProvider(): ProviderName {
  if (providerFlag) return providerFlag as ProviderName;
  if (Deno.env.get('ANTHROPIC_API_KEY')) return 'anthropic';
  if (Deno.env.get('OPENAI_API_KEY')) return 'openai';
  if (Deno.env.get('OPENROUTER_API_KEY')) return 'openrouter';
  return 'ollama';
}

function buildEngine(provider: ProviderName): { engine: Engine; model: string; label: string } {
  switch (provider) {
    case 'anthropic': {
      const key = Deno.env.get('ANTHROPIC_API_KEY');
      if (!key) { console.error(`${RED}Error: ANTHROPIC_API_KEY not set${RESET}`); Deno.exit(1); }
      const model = modelFlag ?? 'claude-haiku-4-5-20251001';
      return { engine: makeAnthropicEngine(key, model), model, label: `Anthropic/${model}` };
    }
    case 'openai': {
      const key = Deno.env.get('OPENAI_API_KEY');
      if (!key) { console.error(`${RED}Error: OPENAI_API_KEY not set${RESET}`); Deno.exit(1); }
      const model = modelFlag ?? 'gpt-4o-mini';
      return { engine: makeOpenAICompatEngine(key, model), model, label: `OpenAI/${model}` };
    }
    case 'openrouter': {
      const key = Deno.env.get('OPENROUTER_API_KEY');
      if (!key) { console.error(`${RED}Error: OPENROUTER_API_KEY not set${RESET}`); Deno.exit(1); }
      const model = modelFlag ?? 'meta-llama/llama-3.2-8b-instruct:free';
      return {
        engine: makeOpenAICompatEngine(key, model, 'https://openrouter.ai/api/v1'),
        model,
        label: `OpenRouter/${model}`,
      };
    }
    case 'ollama': {
      const baseURL = Deno.env.get('OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1';
      const model = modelFlag ?? 'llama3.2';
      return {
        engine: makeOpenAICompatEngine('ollama', model, baseURL),
        model,
        label: `Ollama/${model}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!question) {
  console.error([
    `Usage: deno task cli [--provider <p>] [--model <m>] "your question"`,
    ``,
    `Providers: anthropic  openai  openrouter  ollama`,
    ``,
    `Examples:`,
    `  deno task cli "What is e^pi?"`,
    `  deno task cli --provider ollama --model llama3.2 "List /tmp"`,
    `  deno task cli --provider openrouter --model anthropic/claude-haiku-3 "..."`,
  ].join('\n'));
  Deno.exit(1);
}

const provider = detectProvider();
const { engine, label } = buildEngine(provider);

console.error(`${BOLD}${YELLOW}[${label}]${RESET} ${question}\n`);

await runChat(
  engine,
  runBlock,
  question,
  renderPart,
);

console.error('');
