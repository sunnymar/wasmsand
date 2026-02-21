/**
 * ShellRunner: parses shell commands via the Rust shell Wasm binary,
 * then executes the resulting AST in TypeScript.
 *
 * The shell Wasm binary is a pure parser — it reads a command string from
 * stdin and outputs a JSON AST to stdout. The ShellRunner walks the AST,
 * handling control flow (&&, ||, if, for, while), variable expansion,
 * redirects, and dispatches pipelines to the ProcessManager.
 */

import type { PlatformAdapter } from '../platform/adapter.js';
import type { ProcessManager } from '../process/manager.js';
import type { SpawnResult } from '../process/process.js';
import type { VFS } from '../vfs/vfs.js';
import { WasiHost } from '../wasi/wasi-host.js';

// ---- AST types matching the Rust serde output ----

interface Word {
  parts: WordPart[];
}

type WordPart =
  | { Literal: string }
  | { Variable: string }
  | { CommandSub: string };

interface Redirect {
  redirect_type: RedirectType;
}

type RedirectType =
  | { StdoutOverwrite: string }
  | { StdoutAppend: string }
  | { StdinFrom: string }
  | { StderrOverwrite: string }
  | { StderrAppend: string }
  | 'StderrToStdout'
  | { BothOverwrite: string };

interface Assignment {
  name: string;
  value: string;
}

type Command =
  | { Simple: { words: Word[]; redirects: Redirect[]; assignments: Assignment[] } }
  | { Pipeline: { commands: Command[] } }
  | { List: { left: Command; op: ListOp; right: Command } }
  | { If: { condition: Command; then_body: Command; else_body: Command | null } }
  | { For: { var: string; words: Word[]; body: Command } }
  | { While: { condition: Command; body: Command } }
  | { Subshell: { body: Command } };

type ListOp = 'And' | 'Or' | 'Seq';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
}

const EMPTY_RESULT: RunResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  executionTimeMs: 0,
};

export class ShellRunner {
  private vfs: VFS;
  private mgr: ProcessManager;
  private adapter: PlatformAdapter;
  private shellWasmPath: string;
  private shellModule: WebAssembly.Module | null = null;
  private env: Map<string, string> = new Map();

  constructor(
    vfs: VFS,
    mgr: ProcessManager,
    adapter: PlatformAdapter,
    shellWasmPath: string,
  ) {
    this.vfs = vfs;
    this.mgr = mgr;
    this.adapter = adapter;
    this.shellWasmPath = shellWasmPath;
  }

  setEnv(name: string, value: string): void {
    this.env.set(name, value);
  }

  getEnv(name: string): string | undefined {
    return this.env.get(name);
  }

  /**
   * Run a shell command string. Parses it via the shell Wasm binary,
   * then executes the AST.
   */
  async run(command: string): Promise<RunResult> {
    const startTime = performance.now();
    const ast = await this.parse(command);
    if (ast === null) {
      return EMPTY_RESULT;
    }
    const result = await this.execCommand(ast);
    result.executionTimeMs = performance.now() - startTime;
    return result;
  }

  /**
   * Parse a command string by running the shell Wasm binary.
   */
  private async parse(command: string): Promise<Command | null> {
    if (!this.shellModule) {
      this.shellModule = await this.adapter.loadModule(this.shellWasmPath);
    }

    const encoder = new TextEncoder();
    const host = new WasiHost({
      vfs: this.vfs,
      args: ['wasmsand-shell'],
      env: Object.fromEntries(this.env),
      preopens: { '/': '/' },
      stdin: encoder.encode(command),
    });

    const instance = await this.adapter.instantiate(
      this.shellModule,
      host.getImports(),
    );
    host.start(instance);

    const output = host.getStdout().trim();
    if (output === '' || output === 'null') {
      return null;
    }

    return JSON.parse(output) as Command;
  }

  // ---- AST execution ----

  private async execCommand(cmd: Command): Promise<RunResult> {
    if ('Simple' in cmd) {
      return this.execSimple(cmd.Simple);
    }
    if ('Pipeline' in cmd) {
      return this.execPipeline(cmd.Pipeline);
    }
    if ('List' in cmd) {
      return this.execList(cmd.List);
    }
    if ('If' in cmd) {
      return this.execIf(cmd.If);
    }
    if ('For' in cmd) {
      return this.execFor(cmd.For);
    }
    if ('While' in cmd) {
      return this.execWhile(cmd.While);
    }
    if ('Subshell' in cmd) {
      return this.execCommand(cmd.Subshell.body);
    }
    return EMPTY_RESULT;
  }

  private async execSimple(simple: {
    words: Word[];
    redirects: Redirect[];
    assignments: Assignment[];
  }): Promise<RunResult> {
    // Process assignments
    for (const assignment of simple.assignments) {
      this.env.set(assignment.name, assignment.value);
    }

    // If there are only assignments and no command words, it's a variable-setting command
    if (simple.words.length === 0) {
      return { ...EMPTY_RESULT };
    }

    // Expand words
    const expandedWords = simple.words.map(w => this.expandWord(w));
    const cmdName = expandedWords[0];
    const args = expandedWords.slice(1);

    // Handle stdin redirect
    let stdinData: Uint8Array | undefined;
    for (const redirect of simple.redirects) {
      const rt = redirect.redirect_type;
      if (typeof rt === 'object' && 'StdinFrom' in rt) {
        stdinData = this.vfs.readFile(rt.StdinFrom);
      }
    }

    // Spawn the process
    let result: SpawnResult;
    try {
      result = await this.mgr.spawn(cmdName, {
        args,
        env: Object.fromEntries(this.env),
        stdinData,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 127,
        stdout: '',
        stderr: `${cmdName}: ${msg}\n`,
        executionTimeMs: 0,
      };
    }

    // Handle output redirects
    let stdout = result.stdout;
    const stderr = result.stderr;

    for (const redirect of simple.redirects) {
      const rt = redirect.redirect_type;
      if (typeof rt === 'object' && 'StdoutOverwrite' in rt) {
        this.vfs.writeFile(
          rt.StdoutOverwrite,
          new TextEncoder().encode(stdout),
        );
        stdout = '';
      } else if (typeof rt === 'object' && 'StdoutAppend' in rt) {
        const existing = this.tryReadFile(rt.StdoutAppend);
        const combined = concatBytes(
          existing,
          new TextEncoder().encode(stdout),
        );
        this.vfs.writeFile(rt.StdoutAppend, combined);
        stdout = '';
      }
    }

    return {
      exitCode: result.exitCode,
      stdout,
      stderr,
      executionTimeMs: result.executionTimeMs,
    };
  }

  private async execPipeline(pipeline: {
    commands: Command[];
  }): Promise<RunResult> {
    if (pipeline.commands.length === 0) {
      return { ...EMPTY_RESULT };
    }

    if (pipeline.commands.length === 1) {
      return this.execCommand(pipeline.commands[0]);
    }

    // Build a multi-stage pipeline: each command's stdout becomes the next's stdin
    let stdinData: Uint8Array | undefined;
    let lastResult: RunResult = { ...EMPTY_RESULT };
    const encoder = new TextEncoder();

    for (let i = 0; i < pipeline.commands.length; i++) {
      const cmd = pipeline.commands[i];

      // For pipeline stages, we need to inject stdin from previous stage
      if ('Simple' in cmd) {
        const simple = cmd.Simple;
        const expandedWords = simple.words.map(w => this.expandWord(w));
        const cmdName = expandedWords[0];
        const args = expandedWords.slice(1);

        try {
          const result = await this.mgr.spawn(cmdName, {
            args,
            env: Object.fromEntries(this.env),
            stdinData,
          });
          lastResult = { ...result };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          lastResult = {
            exitCode: 127,
            stdout: '',
            stderr: `${cmdName}: ${msg}\n`,
            executionTimeMs: 0,
          };
        }
      } else {
        // For non-simple commands in a pipeline, execute them normally
        lastResult = await this.execCommand(cmd);
      }

      stdinData = encoder.encode(lastResult.stdout);
    }

    return lastResult;
  }

  private async execList(list: {
    left: Command;
    op: ListOp;
    right: Command;
  }): Promise<RunResult> {
    const leftResult = await this.execCommand(list.left);

    switch (list.op) {
      case 'And': {
        if (leftResult.exitCode === 0) {
          const rightResult = await this.execCommand(list.right);
          return {
            exitCode: rightResult.exitCode,
            stdout: leftResult.stdout + rightResult.stdout,
            stderr: leftResult.stderr + rightResult.stderr,
            executionTimeMs:
              leftResult.executionTimeMs + rightResult.executionTimeMs,
          };
        }
        return leftResult;
      }
      case 'Or': {
        if (leftResult.exitCode !== 0) {
          const rightResult = await this.execCommand(list.right);
          return {
            exitCode: rightResult.exitCode,
            stdout: leftResult.stdout + rightResult.stdout,
            stderr: leftResult.stderr + rightResult.stderr,
            executionTimeMs:
              leftResult.executionTimeMs + rightResult.executionTimeMs,
          };
        }
        return leftResult;
      }
      case 'Seq': {
        const rightResult = await this.execCommand(list.right);
        return {
          exitCode: rightResult.exitCode,
          stdout: leftResult.stdout + rightResult.stdout,
          stderr: leftResult.stderr + rightResult.stderr,
          executionTimeMs:
            leftResult.executionTimeMs + rightResult.executionTimeMs,
        };
      }
    }
  }

  private async execIf(ifCmd: {
    condition: Command;
    then_body: Command;
    else_body: Command | null;
  }): Promise<RunResult> {
    const condResult = await this.execCommand(ifCmd.condition);

    if (condResult.exitCode === 0) {
      return this.execCommand(ifCmd.then_body);
    } else if (ifCmd.else_body !== null) {
      return this.execCommand(ifCmd.else_body);
    }

    return { ...EMPTY_RESULT };
  }

  private async execFor(forCmd: {
    var: string;
    words: Word[];
    body: Command;
  }): Promise<RunResult> {
    const expandedWords = forCmd.words.map(w => this.expandWord(w));
    let combinedStdout = '';
    let combinedStderr = '';
    let lastExitCode = 0;
    let totalTime = 0;

    for (const word of expandedWords) {
      this.env.set(forCmd.var, word);
      const result = await this.execCommand(forCmd.body);
      combinedStdout += result.stdout;
      combinedStderr += result.stderr;
      lastExitCode = result.exitCode;
      totalTime += result.executionTimeMs;
    }

    return {
      exitCode: lastExitCode,
      stdout: combinedStdout,
      stderr: combinedStderr,
      executionTimeMs: totalTime,
    };
  }

  private async execWhile(whileCmd: {
    condition: Command;
    body: Command;
  }): Promise<RunResult> {
    let combinedStdout = '';
    let combinedStderr = '';
    let lastExitCode = 0;
    let totalTime = 0;
    const MAX_ITERATIONS = 10000;
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      const condResult = await this.execCommand(whileCmd.condition);
      if (condResult.exitCode !== 0) {
        break;
      }
      const bodyResult = await this.execCommand(whileCmd.body);
      combinedStdout += bodyResult.stdout;
      combinedStderr += bodyResult.stderr;
      lastExitCode = bodyResult.exitCode;
      totalTime += bodyResult.executionTimeMs;
      iterations++;
    }

    return {
      exitCode: lastExitCode,
      stdout: combinedStdout,
      stderr: combinedStderr,
      executionTimeMs: totalTime,
    };
  }

  // ---- Helpers ----

  /**
   * Expand a Word (which may contain variables and command substitutions)
   * into a plain string.
   */
  private expandWord(word: Word): string {
    return word.parts.map(part => this.expandWordPart(part)).join('');
  }

  private expandWordPart(part: WordPart): string {
    if ('Literal' in part) {
      return part.Literal;
    }
    if ('Variable' in part) {
      return this.env.get(part.Variable) ?? '';
    }
    if ('CommandSub' in part) {
      // Command substitution would require recursive execution.
      // For now return empty — will be implemented as needed.
      return '';
    }
    return '';
  }

  private tryReadFile(path: string): Uint8Array {
    try {
      return this.vfs.readFile(path);
    } catch {
      return new Uint8Array(0);
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}
