#!/usr/bin/env node
/**
 * codepod CLI — interactive shell running entirely in the WASM sandbox.
 */

import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VFS } from './vfs/vfs.js';
import { ProcessManager } from './process/manager.js';
import { NodeAdapter } from './platform/node-adapter.js';
import { ShellRunner } from './shell/shell-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES = resolve(__dirname, 'platform/__tests__/fixtures');
const SHELL_WASM = resolve(__dirname, 'shell/__tests__/fixtures/codepod-shell.wasm');

const TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf',
  'find', 'sed', 'awk', 'jq',
  'du', 'df',
  'gzip', 'gunzip', 'tar',
  'true', 'false',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
  return `${tool}.wasm`;
}

async function main() {
  const vfs = new VFS();
  const adapter = new NodeAdapter();
  const mgr = new ProcessManager(vfs, adapter);

  for (const tool of TOOLS) {
    mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
  }

  const shell = new ShellRunner(vfs, mgr, adapter, SHELL_WASM);
  shell.setEnv('HOME', '/home/user');
  shell.setEnv('PWD', '/home/user');
  shell.setEnv('USER', 'user');
  shell.setEnv('PATH', '/bin:/usr/bin');

  // Handle -c flag: run single command and exit
  const cIndex = process.argv.indexOf('-c');
  if (cIndex !== -1 && cIndex + 1 < process.argv.length) {
    const cmd = process.argv[cIndex + 1];
    const result = await shell.run(cmd);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }

  // Interactive REPL — queue lines so async handlers run sequentially
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'codepod$ ',
  });

  const queue: string[] = [];
  let processing = false;
  let closing = false;

  async function drain() {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
      const cmd = queue.shift()!.trim();
      if (!cmd) {
        rl.prompt();
        continue;
      }
      if (cmd === 'exit' || cmd === 'quit') {
        closing = true;
        break;
      }

      try {
        const result = await shell.run(cmd);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
      }

      if (!closing) rl.prompt();
    }

    processing = false;
    if (closing) {
      rl.close();
    }
  }

  console.log('codepod — WASM sandbox shell');
  console.log(`${TOOLS.length} tools + python3 available. Type "exit" to quit.\n`);
  rl.prompt();

  rl.on('line', (line: string) => {
    queue.push(line);
    drain();
  });

  rl.on('close', () => {
    // Wait for any remaining commands to finish
    const waitAndExit = async () => {
      while (processing) {
        await new Promise(r => setTimeout(r, 10));
      }
      console.log('\nbye');
      process.exit(0);
    };
    closing = true;
    waitAndExit();
  });
}

main();
