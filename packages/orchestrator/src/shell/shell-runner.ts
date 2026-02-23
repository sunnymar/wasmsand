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
import { PythonRunner } from '../python/python-runner.js';
import { WasiHost } from '../wasi/wasi-host.js';
import { NetworkGateway, NetworkAccessDenied } from '../network/gateway.js';

const PYTHON_COMMANDS = new Set(['python3', 'python']);
const SHELL_BUILTINS = new Set(['which', 'chmod', 'test', '[', 'pwd', 'cd', 'export', 'unset', 'date', 'curl', 'wget']);

/** Interpreter names that should be dispatched to PythonRunner. */
const PYTHON_INTERPRETERS = new Set(['python3', 'python']);

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

const MAX_SUBSTITUTION_DEPTH = 50;

export class ShellRunner {
  private vfs: VFS;
  private mgr: ProcessManager;
  private adapter: PlatformAdapter;
  private shellWasmPath: string;
  private shellModule: WebAssembly.Module | null = null;
  private pythonRunner: PythonRunner | null = null;
  private gateway: NetworkGateway | null = null;
  private env: Map<string, string> = new Map();
  /** Current command substitution nesting depth. */
  private substitutionDepth = 0;

  constructor(
    vfs: VFS,
    mgr: ProcessManager,
    adapter: PlatformAdapter,
    shellWasmPath: string,
    gateway?: NetworkGateway,
  ) {
    this.vfs = vfs;
    this.mgr = mgr;
    this.adapter = adapter;
    this.shellWasmPath = shellWasmPath;
    this.gateway = gateway ?? null;

    // Populate /bin with stubs for registered tools + python3 so that
    // `ls /bin` and `which <tool>` work as expected.
    this.populateBin();
  }

  /** Write executable stub files into /bin and /usr/bin for all registered tools + python. */
  private populateBin(): void {
    const encoder = new TextEncoder();
    const dirs = ['/bin', '/usr/bin'];
    const allTools = [
      ...this.mgr.getRegisteredTools(),
      ...PYTHON_COMMANDS,
      ...SHELL_BUILTINS,
    ];
    for (const dir of dirs) {
      for (const tool of allTools) {
        const path = `${dir}/${tool}`;
        try {
          this.vfs.writeFile(path, encoder.encode(`#!/bin/wasmsand\n# ${tool}\n`));
          this.vfs.chmod(path, 0o755);
        } catch { /* ignore */ }
      }
    }
  }

  setEnv(name: string, value: string): void {
    this.env.set(name, value);
  }

  getEnv(name: string): string | undefined {
    return this.env.get(name);
  }

  /** Return a copy of all env vars (for snapshot). */
  getEnvMap(): Map<string, string> {
    return new Map(this.env);
  }

  /** Replace all env vars (for restore). */
  setEnvMap(env: Map<string, string>): void {
    this.env = new Map(env);
  }

  /** Resolve a path relative to PWD. Absolute paths pass through unchanged. */
  private resolvePath(path: string): string {
    if (path.startsWith('/')) return path;
    const pwd = this.env.get('PWD') || '/';
    return pwd === '/' ? '/' + path : pwd + '/' + path;
  }

  // Commands that default to "." when no directory arg is given.
  private static readonly IMPLICIT_CWD_COMMANDS = new Set(['ls', 'find']);

  /** Returns true if the command defaults to "." and no non-flag args were given. */
  private needsDefaultDir(cmdName: string, args: string[]): boolean {
    if (!ShellRunner.IMPLICIT_CWD_COMMANDS.has(cmdName)) return false;
    return args.every(a => a.startsWith('-'));
  }

  // Commands whose non-flag args are NOT file paths and should not be resolved.
  private static readonly PASSTHROUGH_ARGS = new Set([
    'echo', 'printf', 'basename', 'dirname', 'env', 'true', 'false',
  ]);

  // Commands that always create files/dirs — resolve args unconditionally.
  private static readonly CREATION_COMMANDS = new Set([
    'mkdir', 'touch', 'cp', 'mv', 'tee',
  ]);

  /**
   * Resolve a command arg to an absolute path if it looks like a relative
   * file path. Flags (starting with -) and absolute paths pass through.
   * Commands in PASSTHROUGH_ARGS never resolve their args.
   *
   * Uses VFS stat to disambiguate: only resolves if the resolved path
   * exists in VFS (avoids mangling non-path args like grep patterns).
   */
  private resolveArgIfPath(cmdName: string, arg: string): string {
    if (ShellRunner.PASSTHROUGH_ARGS.has(cmdName)) return arg;
    if (arg.startsWith('-') || arg.startsWith('/')) return arg;
    // Creation commands always resolve relative args
    if (ShellRunner.CREATION_COMMANDS.has(cmdName)) {
      return this.resolvePath(arg);
    }
    // For other commands, only resolve if the resolved path exists in VFS
    // (avoids mangling non-path args like grep patterns)
    const resolved = this.resolvePath(arg);
    try {
      this.vfs.stat(resolved);
      return resolved;
    } catch {
      return arg;
    }
  }

  /**
   * Run a shell command string. Parses it via the shell Wasm binary,
   * then executes the AST.
   */
  async run(command: string): Promise<RunResult> {
    const startTime = performance.now();

    // Pre-process: the Rust parser swallows NAME=VALUE tokens after `export`,
    // so we handle `export NAME=VALUE ...` by converting assignments into
    // env.set calls and stripping them from the command before parsing.
    const preprocessed = this.preprocessExport(command);
    if (preprocessed === null) {
      // Fully handled (e.g. `export FOO=bar` with no remaining command)
      const elapsed = performance.now() - startTime;
      return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: elapsed };
    }

    const ast = await this.parse(preprocessed);
    if (ast === null) {
      return EMPTY_RESULT;
    }
    const result = await this.execCommand(ast);
    result.executionTimeMs = performance.now() - startTime;
    return result;
  }

  /**
   * Pre-process `export` commands. The Rust shell parser swallows NAME=VALUE
   * tokens after `export`, so we extract and apply them before parsing.
   *
   * Returns the (possibly modified) command to parse, or null if the command
   * was fully handled (pure `export NAME=VALUE` with no other words).
   */
  private preprocessExport(command: string): string | null {
    const trimmed = command.trim();
    if (!trimmed.startsWith('export')) return command;

    // Match: export [NAME=VALUE ...] [NAME ...]
    const match = trimmed.match(/^export(\s+|$)/);
    if (!match) return command;

    const rest = trimmed.slice(match[0].length).trim();

    // `export` with no arguments — pass through to builtinExport
    if (rest === '') return command;

    // Split tokens and process assignments
    const tokens = rest.split(/\s+/);
    let hasAssignment = false;
    const remaining: string[] = [];

    for (const token of tokens) {
      const eqIdx = token.indexOf('=');
      if (eqIdx > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token.slice(0, eqIdx))) {
        // This is a NAME=VALUE assignment
        this.env.set(token.slice(0, eqIdx), token.slice(eqIdx + 1));
        hasAssignment = true;
      } else {
        remaining.push(token);
      }
    }

    if (remaining.length === 0 && hasAssignment) {
      // All tokens were assignments — fully handled
      return null;
    }

    // Rebuild: `export` + remaining non-assignment tokens
    return 'export ' + remaining.join(' ');
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
    // Process assignments (expand variables and command substitutions in values)
    for (const assignment of simple.assignments) {
      const value = await this.expandAssignmentValue(assignment.value);
      this.env.set(assignment.name, value);
    }

    // If there are only assignments and no command words, it's a variable-setting command
    if (simple.words.length === 0) {
      return { ...EMPTY_RESULT };
    }

    // Expand words (async — may contain command substitutions)
    const rawWords = await Promise.all(simple.words.map(w => this.expandWord(w)));
    const expandedWords = this.expandGlobs(rawWords);
    const cmdName = expandedWords[0];
    let args = expandedWords.slice(1);

    // Inject PWD for commands that default to "." when no path args given
    const pwd = this.env.get('PWD');
    if (pwd && this.needsDefaultDir(cmdName, args)) {
      args = [...args, pwd];
    }

    // Handle shell builtins
    if (cmdName === 'which') {
      return this.builtinWhich(args);
    }
    if (cmdName === 'chmod') {
      return this.builtinChmod(args);
    }
    if (cmdName === 'test') {
      return this.builtinTest(args, false);
    }
    if (cmdName === '[') {
      return this.builtinTest(args, true);
    }
    if (cmdName === 'pwd') {
      return this.builtinPwd();
    }
    if (cmdName === 'cd') {
      return this.builtinCd(args);
    }
    if (cmdName === 'export') {
      return this.builtinExport(args);
    }
    if (cmdName === 'unset') {
      return this.builtinUnset(args);
    }
    if (cmdName === 'date') {
      return this.builtinDate(args);
    }
    if (cmdName === 'curl') {
      return this.builtinCurl(args);
    }
    if (cmdName === 'wget') {
      return this.builtinWget(args);
    }

    // Handle stdin redirect
    let stdinData: Uint8Array | undefined;
    for (const redirect of simple.redirects) {
      const rt = redirect.redirect_type;
      if (typeof rt === 'object' && 'StdinFrom' in rt) {
        stdinData = this.vfs.readFile(this.resolvePath(rt.StdinFrom));
      }
    }

    // Spawn the process (or delegate to PythonRunner)
    let result: SpawnResult;
    try {
      result = await this.spawnOrPython(cmdName, args, stdinData);
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
          this.resolvePath(rt.StdoutOverwrite),
          new TextEncoder().encode(stdout),
        );
        stdout = '';
      } else if (typeof rt === 'object' && 'StdoutAppend' in rt) {
        const resolved = this.resolvePath(rt.StdoutAppend);
        const existing = this.tryReadFile(resolved);
        const combined = concatBytes(
          existing,
          new TextEncoder().encode(stdout),
        );
        this.vfs.writeFile(resolved, combined);
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
        const rawWords = await Promise.all(simple.words.map(w => this.expandWord(w)));
        const expandedWords = this.expandGlobs(rawWords);
        const cmdName = expandedWords[0];
        const args = expandedWords.slice(1);

        try {
          const result = await this.spawnOrPython(cmdName, args, stdinData);
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
    const rawWords = await Promise.all(forCmd.words.map(w => this.expandWord(w)));
    const expandedWords = this.expandGlobs(rawWords);
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
  private async expandWord(word: Word): Promise<string> {
    const parts = await Promise.all(
      word.parts.map(part => this.expandWordPart(part)),
    );
    return parts.join('');
  }

  private async expandWordPart(part: WordPart): Promise<string> {
    if ('Literal' in part) {
      return part.Literal;
    }
    if ('Variable' in part) {
      return this.env.get(part.Variable) ?? '';
    }
    if ('CommandSub' in part) {
      if (this.substitutionDepth >= MAX_SUBSTITUTION_DEPTH) {
        return ''; // prevent infinite recursion
      }
      this.substitutionDepth++;
      try {
        const result = await this.run(part.CommandSub);
        // Strip trailing newline (standard shell behavior)
        return result.stdout.replace(/\n$/, '');
      } finally {
        this.substitutionDepth--;
      }
    }
    return '';
  }

  private async spawnOrPython(
    cmdName: string,
    args: string[],
    stdinData: Uint8Array | undefined,
  ): Promise<SpawnResult> {
    // If the command looks like a path (./script.sh, /tmp/run.py),
    // try shebang-based execution before falling through to tool lookup.
    if (cmdName.includes('/')) {
      return this.execPath(cmdName, args, stdinData);
    }

    if (PYTHON_COMMANDS.has(cmdName)) {
      return this.execPython(args, stdinData);
    }
    // Resolve relative path args for WASI binaries. WASI resolves all
    // paths against the root preopen (/), so we must convert relative
    // paths to absolute ones using PWD before spawning.
    const resolvedArgs = args.map(a => this.resolveArgIfPath(cmdName, a));
    return this.mgr.spawn(cmdName, {
      args: resolvedArgs,
      env: Object.fromEntries(this.env),
      stdinData,
      cwd: this.env.get('PWD'),
    });
  }

  /** Run a Python script via PythonRunner. */
  private async execPython(
    args: string[],
    stdinData: Uint8Array | undefined,
  ): Promise<SpawnResult> {
    if (!this.pythonRunner) {
      this.pythonRunner = new PythonRunner(this.mgr);
    }
    return this.pythonRunner.run({
      args,
      env: Object.fromEntries(this.env),
      stdinData,
      cwd: this.env.get('PWD'),
    });
  }

  /**
   * Execute a file by path (e.g. ./script.sh, /tmp/run.py).
   * Reads the file, checks for a shebang line, and dispatches to
   * the appropriate interpreter. Falls back to shell execution.
   */
  private async execPath(
    cmdPath: string,
    args: string[],
    stdinData: Uint8Array | undefined,
  ): Promise<SpawnResult> {
    const resolved = this.resolvePath(cmdPath);

    // Read the file
    let content: Uint8Array;
    try {
      content = this.vfs.readFile(resolved);
    } catch {
      throw new Error(`no such file or directory: ${cmdPath}`);
    }

    const text = new TextDecoder().decode(content);
    const firstLine = text.split('\n', 1)[0];

    // Parse shebang
    const interpreter = parseShebang(firstLine);

    // Dispatch based on interpreter
    if (interpreter !== null && PYTHON_INTERPRETERS.has(interpreter)) {
      // Python script: pass file path + extra args.
      // PythonRunner reads the file from VFS; the #! line is a valid Python comment.
      return this.execPython([resolved, ...args], stdinData);
    }

    // Default: run as shell script (covers #!/bin/sh, #!/bin/bash, and no shebang)
    return this.execShellScript(text, args, stdinData);
  }

  /**
   * Execute a string as a shell script, running each statement through the shell.
   * Sets positional parameters $1, $2, etc. from args.
   */
  private async execShellScript(
    scriptText: string,
    args: string[],
    _stdinData: Uint8Array | undefined,
  ): Promise<SpawnResult> {
    // Strip shebang line if present
    let script = scriptText;
    if (script.startsWith('#!')) {
      const nl = script.indexOf('\n');
      script = nl >= 0 ? script.slice(nl + 1) : '';
    }

    // Set positional parameters
    for (let i = 0; i < args.length; i++) {
      this.env.set(String(i + 1), args[i]);
    }

    // Run the entire script as a single command string.
    // The shell parser handles semicolons, &&, newlines, etc.
    const result = await this.run(script);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      executionTimeMs: result.executionTimeMs,
    };
  }

  /**
   * Expand an assignment value string, handling $VAR, $(cmd), and `cmd` patterns.
   * The Rust lexer inlines these into the assignment value as literal text.
   */
  private async expandAssignmentValue(value: string): Promise<string> {
    let result = '';
    let i = 0;
    while (i < value.length) {
      if (value[i] === '$' && i + 1 < value.length && value[i + 1] === '(') {
        // Command substitution: $(...)
        if (this.substitutionDepth >= MAX_SUBSTITUTION_DEPTH) {
          i += 2; continue;
        }
        const content = this.extractBalanced(value, i + 2, '(', ')');
        this.substitutionDepth++;
        try {
          const subResult = await this.run(content.text);
          result += subResult.stdout.replace(/\n$/, '');
        } finally {
          this.substitutionDepth--;
        }
        i = content.end;
      } else if (value[i] === '`') {
        // Backtick substitution: `...`
        if (this.substitutionDepth >= MAX_SUBSTITUTION_DEPTH) {
          i = value.indexOf('`', i + 1); i = i >= 0 ? i + 1 : value.length; continue;
        }
        const end = value.indexOf('`', i + 1);
        const cmd = end >= 0 ? value.slice(i + 1, end) : value.slice(i + 1);
        this.substitutionDepth++;
        try {
          const subResult = await this.run(cmd);
          result += subResult.stdout.replace(/\n$/, '');
        } finally {
          this.substitutionDepth--;
        }
        i = end >= 0 ? end + 1 : value.length;
      } else if (value[i] === '$') {
        // Variable expansion: $VAR or ${VAR}
        i++;
        if (i < value.length && value[i] === '{') {
          const end = value.indexOf('}', i + 1);
          const varName = end >= 0 ? value.slice(i + 1, end) : value.slice(i + 1);
          result += this.env.get(varName) ?? '';
          i = end >= 0 ? end + 1 : value.length;
        } else {
          let varName = '';
          while (i < value.length && /[a-zA-Z0-9_]/.test(value[i])) {
            varName += value[i++];
          }
          result += this.env.get(varName) ?? '';
        }
      } else {
        result += value[i++];
      }
    }
    return result;
  }

  /** Extract balanced content between open/close chars. */
  private extractBalanced(
    s: string, start: number, open: string, close: string,
  ): { text: string; end: number } {
    let depth = 1;
    let i = start;
    while (i < s.length && depth > 0) {
      if (s[i] === open) depth++;
      else if (s[i] === close) depth--;
      if (depth > 0) i++;
    }
    return { text: s.slice(start, i), end: i + 1 };
  }

  /**
   * Expand glob patterns (* and ?) in a list of words.
   * Words without globs pass through unchanged.
   * If a glob matches nothing, the literal pattern is kept (POSIX behavior).
   */
  private expandGlobs(words: string[]): string[] {
    const result: string[] = [];
    for (const word of words) {
      if (word.includes('*') || word.includes('?')) {
        const matches = this.globMatch(word);
        if (matches.length > 0) {
          result.push(...matches.sort());
        } else {
          result.push(word); // no match → keep literal
        }
      } else {
        result.push(word);
      }
    }
    return result;
  }

  /**
   * Match a glob pattern against VFS entries.
   * Supports * (any sequence) and ? (any single char).
   * Pattern may be absolute (/tmp/*.txt) or relative (*.txt).
   */
  private globMatch(pattern: string): string[] {
    // Split into directory part and filename pattern
    const lastSlash = pattern.lastIndexOf('/');
    let dirPath: string;
    let filePattern: string;

    if (lastSlash >= 0) {
      dirPath = pattern.slice(0, lastSlash) || '/';
      filePattern = pattern.slice(lastSlash + 1);
    } else {
      // Relative: use PWD
      dirPath = this.env.get('PWD') || '/';
      filePattern = pattern;
    }

    // Convert glob pattern to regex
    const regexStr = '^' + filePattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials
      .replace(/\*/g, '.*')                     // * → .*
      .replace(/\?/g, '.')                      // ? → .
      + '$';
    const regex = new RegExp(regexStr);

    try {
      const entries = this.vfs.readdir(dirPath);
      const matches: string[] = [];
      for (const entry of entries) {
        if (regex.test(entry.name)) {
          if (lastSlash >= 0) {
            matches.push(dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`);
          } else {
            matches.push(entry.name);
          }
        }
      }
      return matches;
    } catch {
      return [];
    }
  }

  /** Builtin: pwd — print working directory. */
  private builtinPwd(): RunResult {
    const cwd = this.env.get('PWD') || '/';
    return { exitCode: 0, stdout: cwd + '\n', stderr: '', executionTimeMs: 0 };
  }

  /** Builtin: cd — change working directory. */
  private builtinCd(args: string[]): RunResult {
    let target: string;

    if (args.length === 0) {
      target = '/home/user';
    } else if (args[0] === '-') {
      const oldPwd = this.env.get('OLDPWD');
      if (!oldPwd) {
        return { exitCode: 1, stdout: '', stderr: 'cd: OLDPWD not set\n', executionTimeMs: 0 };
      }
      target = oldPwd;
    } else {
      target = this.resolvePath(args[0]);
    }

    // Normalize the path (resolve . and .. segments)
    target = normalizePath(target);

    try {
      const stat = this.vfs.stat(target);
      if (stat.type !== 'dir') {
        return { exitCode: 1, stdout: '', stderr: `cd: ${args[0] ?? target}: not a directory\n`, executionTimeMs: 0 };
      }
    } catch {
      return { exitCode: 1, stdout: '', stderr: `cd: ${args[0] ?? target}: no such file or directory\n`, executionTimeMs: 0 };
    }

    const oldPwd = this.env.get('PWD') || '/';
    this.env.set('OLDPWD', oldPwd);
    this.env.set('PWD', target);
    return { ...EMPTY_RESULT };
  }

  /** Builtin: export — set env variables (alias for assignment). */
  private builtinExport(args: string[]): RunResult {
    if (args.length === 0) {
      let stdout = '';
      for (const [key, value] of this.env) {
        stdout += `${key}=${value}\n`;
      }
      return { exitCode: 0, stdout, stderr: '', executionTimeMs: 0 };
    }

    for (const arg of args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx >= 0) {
        this.env.set(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
      }
      // export FOO with no value is a no-op
    }
    return { ...EMPTY_RESULT };
  }

  /** Builtin: unset — remove env variables. */
  private builtinUnset(args: string[]): RunResult {
    for (const name of args) {
      this.env.delete(name);
    }
    return { ...EMPTY_RESULT };
  }

  /** Builtin: date — print current date/time. */
  private builtinDate(args: string[]): RunResult {
    const now = new Date();

    if (args.length > 0 && args[0].startsWith('+')) {
      const format = args[0].slice(1);
      const stdout = formatDate(now, format) + '\n';
      return { exitCode: 0, stdout, stderr: '', executionTimeMs: 0 };
    }

    const stdout = now.toUTCString() + '\n';
    return { exitCode: 0, stdout, stderr: '', executionTimeMs: 0 };
  }

  /** Builtin: test / [ — evaluate conditional expressions. */
  private builtinTest(args: string[], isBracket: boolean): RunResult {
    // If [ syntax, require and strip trailing ]
    if (isBracket) {
      if (args.length === 0 || args[args.length - 1] !== ']') {
        return { exitCode: 2, stdout: '', stderr: '[: missing \']\'\n', executionTimeMs: 0 };
      }
      args = args.slice(0, -1);
    }

    const result = this.evalTest(args);
    return { exitCode: result ? 0 : 1, stdout: '', stderr: '', executionTimeMs: 0 };
  }

  private evalTest(args: string[]): boolean {
    if (args.length === 0) return false;

    // Handle ! negation
    if (args[0] === '!' && args.length > 1) {
      return !this.evalTest(args.slice(1));
    }

    // Unary operators
    if (args.length === 2) {
      const [op, val] = args;
      switch (op) {
        case '-f': {
          try { const s = this.vfs.stat(this.resolvePath(val)); return s.type === 'file'; }
          catch { return false; }
        }
        case '-d': {
          try { const s = this.vfs.stat(this.resolvePath(val)); return s.type === 'dir'; }
          catch { return false; }
        }
        case '-e': {
          try { this.vfs.stat(this.resolvePath(val)); return true; }
          catch { return false; }
        }
        case '-s': {
          try { const s = this.vfs.stat(this.resolvePath(val)); return s.size > 0; }
          catch { return false; }
        }
        case '-r': case '-w': case '-x': {
          try { this.vfs.stat(this.resolvePath(val)); return true; }
          catch { return false; }
        }
        case '-z': return val.length === 0;
        case '-n': return val.length > 0;
        default: break;
      }
    }

    // Single arg: true if non-empty string
    if (args.length === 1) {
      return args[0].length > 0;
    }

    // Binary operators
    if (args.length === 3) {
      const [left, op, right] = args;
      switch (op) {
        case '=': case '==': return left === right;
        case '!=': return left !== right;
        case '-eq': return parseInt(left) === parseInt(right);
        case '-ne': return parseInt(left) !== parseInt(right);
        case '-lt': return parseInt(left) < parseInt(right);
        case '-le': return parseInt(left) <= parseInt(right);
        case '-gt': return parseInt(left) > parseInt(right);
        case '-ge': return parseInt(left) >= parseInt(right);
        default: return false;
      }
    }

    return false;
  }

  /** Builtin: which — locate a command by searching known tool names. */
  private builtinWhich(args: string[]): RunResult {
    let stdout = '';
    let exitCode = 0;
    for (const name of args) {
      if (this.mgr.hasTool(name) || PYTHON_COMMANDS.has(name) || SHELL_BUILTINS.has(name)) {
        stdout += `/bin/${name}\n`;
      } else {
        exitCode = 1;
      }
    }
    return { exitCode, stdout, stderr: '', executionTimeMs: 0 };
  }

  /** Builtin: chmod — change file permissions. */
  private builtinChmod(args: string[]): RunResult {
    if (args.length < 2) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'chmod: missing operand\n',
        executionTimeMs: 0,
      };
    }

    const modeArg = args[0];
    const files = args.slice(1);
    let stderr = '';
    let exitCode = 0;

    for (const file of files) {
      const resolved = this.resolvePath(file);
      try {
        const currentMode = this.vfs.stat(resolved).permissions;
        const newMode = parseChmodMode(modeArg, currentMode);
        if (newMode === null) {
          stderr += `chmod: invalid mode: '${modeArg}'\n`;
          exitCode = 1;
          continue;
        }
        this.vfs.chmod(resolved, newMode);
      } catch {
        stderr += `chmod: cannot access '${file}': No such file or directory\n`;
        exitCode = 1;
      }
    }

    return { exitCode, stdout: '', stderr, executionTimeMs: 0 };
  }

  /** Builtin: curl — HTTP client delegating to NetworkGateway. */
  private async builtinCurl(args: string[]): Promise<RunResult> {
    if (!this.gateway) {
      return { exitCode: 1, stdout: '', stderr: 'curl: network access not configured\n', executionTimeMs: 0 };
    }

    let method = 'GET';
    const headers: Record<string, string> = {};
    let data: string | undefined;
    let outputFile: string | undefined;
    let headOnly = false;
    let url: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-X' && i + 1 < args.length) { method = args[++i]; }
      else if (arg === '-H' && i + 1 < args.length) {
        const header = args[++i];
        const colonIdx = header.indexOf(':');
        if (colonIdx > 0) headers[header.slice(0, colonIdx).trim()] = header.slice(colonIdx + 1).trim();
      }
      else if ((arg === '-d' || arg === '--data') && i + 1 < args.length) {
        data = args[++i];
        if (method === 'GET') method = 'POST';
      }
      else if (arg === '-o' && i + 1 < args.length) { outputFile = this.resolvePath(args[++i]); }
      else if (arg === '-s' || arg === '--silent') { /* silent mode */ }
      else if (arg === '-I' || arg === '--head') { headOnly = true; method = 'HEAD'; }
      else if (arg === '-L' || arg === '--location') { /* follow redirects is default with fetch() */ }
      else if (!arg.startsWith('-')) { url = arg; }
    }

    if (!url) return { exitCode: 1, stdout: '', stderr: 'curl: no URL specified\n', executionTimeMs: 0 };

    try {
      const init: RequestInit = { method, headers };
      if (data) {
        init.body = data;
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      const response = await this.gateway.fetch(url, init);

      if (headOnly) {
        let headerStr = `HTTP/${response.status}\n`;
        response.headers.forEach((v, k) => { headerStr += `${k}: ${v}\n`; });
        return { exitCode: 0, stdout: headerStr, stderr: '', executionTimeMs: 0 };
      }

      const body = await response.text();
      if (outputFile) {
        this.vfs.writeFile(outputFile, new TextEncoder().encode(body));
        return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
      }
      return { exitCode: 0, stdout: body, stderr: '', executionTimeMs: 0 };
    } catch (err) {
      if (err instanceof NetworkAccessDenied) return { exitCode: 1, stdout: '', stderr: `curl: ${err.message}\n`, executionTimeMs: 0 };
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, stdout: '', stderr: `curl: ${msg}\n`, executionTimeMs: 0 };
    }
  }

  /** Builtin: wget — download files via NetworkGateway. */
  private async builtinWget(args: string[]): Promise<RunResult> {
    if (!this.gateway) {
      return { exitCode: 1, stdout: '', stderr: 'wget: network access not configured\n', executionTimeMs: 0 };
    }

    let outputFile: string | undefined;
    let toStdout = false;
    let quiet = false;
    let url: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-O' && i + 1 < args.length) {
        const val = args[++i];
        if (val === '-') toStdout = true;
        else outputFile = this.resolvePath(val);
      } else if (arg === '-q') { quiet = true; }
      else if (!arg.startsWith('-')) { url = arg; }
    }

    if (!url) return { exitCode: 1, stdout: '', stderr: 'wget: no URL specified\n', executionTimeMs: 0 };

    try {
      const response = await this.gateway.fetch(url);
      const body = await response.text();

      if (toStdout) return { exitCode: 0, stdout: body, stderr: '', executionTimeMs: 0 };

      const destPath = outputFile ?? this.resolvePath(url.split('/').pop() || 'index.html');
      this.vfs.writeFile(destPath, new TextEncoder().encode(body));
      const stderr = quiet ? '' : `saved to ${destPath}\n`;
      return { exitCode: 0, stdout: '', stderr, executionTimeMs: 0 };
    } catch (err) {
      if (err instanceof NetworkAccessDenied) return { exitCode: 1, stdout: '', stderr: `wget: ${err.message}\n`, executionTimeMs: 0 };
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, stdout: '', stderr: `wget: ${msg}\n`, executionTimeMs: 0 };
    }
  }

  private tryReadFile(path: string): Uint8Array {
    try {
      return this.vfs.readFile(path);
    } catch {
      return new Uint8Array(0);
    }
  }
}

/**
 * Parse a chmod mode argument. Returns the new octal mode or null if invalid.
 *
 * Supports:
 *   - Octal: "755", "644", "0755"
 *   - Symbolic: "+x", "-w", "u+x", "go-w", "a+rx"
 */
function parseChmodMode(modeArg: string, currentMode: number): number | null {
  // Try octal first
  if (/^0?[0-7]{3}$/.test(modeArg)) {
    return parseInt(modeArg, 8);
  }

  // Symbolic mode: [ugoa]*[+-][rwx]+
  const match = modeArg.match(/^([ugoa]*)([+-])([rwx]+)$/);
  if (!match) return null;

  const [, whoStr, op, permsStr] = match;
  const who = whoStr === '' || whoStr === 'a' ? 'ugo' : whoStr;

  // Build the bit mask for the specified permissions
  let mask = 0;
  for (const w of who) {
    const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
    for (const p of permsStr) {
      const bit = p === 'r' ? 4 : p === 'w' ? 2 : 1;
      mask |= bit << shift;
    }
  }

  return op === '+' ? currentMode | mask : currentMode & ~mask;
}

/**
 * Parse a shebang line and return the interpreter base name, or null.
 *
 * Handles:
 *   #!/usr/bin/env python3  → "python3"
 *   #!/usr/bin/python3      → "python3"
 *   #!/bin/sh               → "sh"
 *   #!/bin/bash              → "bash"
 *   (no shebang)            → null
 */
function parseShebang(firstLine: string): string | null {
  if (!firstLine.startsWith('#!')) return null;

  const rest = firstLine.slice(2).trim();
  const parts = rest.split(/\s+/);

  // #!/usr/bin/env <interpreter> — use the second word
  if (parts.length >= 2 && parts[0].endsWith('/env')) {
    return parts[1];
  }

  // #!/path/to/interpreter — use the basename
  if (parts.length >= 1) {
    const slash = parts[0].lastIndexOf('/');
    return slash >= 0 ? parts[0].slice(slash + 1) : parts[0];
  }

  return null;
}

/**
 * Normalize an absolute path by resolving `.` and `..` segments.
 * E.g. "/home/user/.." → "/home", "/home/./user" → "/home/user".
 */
function normalizePath(path: string): string {
  const parts = path.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return '/' + resolved.join('/');
}

/** Simple strftime-like date formatter. Supports common % tokens. */
function formatDate(d: Date, format: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return format.replace(/%([YmdHMSaAbBpZsnT%])/g, (_, code: string) => {
    switch (code) {
      case 'Y': return String(d.getUTCFullYear());
      case 'm': return pad(d.getUTCMonth() + 1);
      case 'd': return pad(d.getUTCDate());
      case 'H': return pad(d.getUTCHours());
      case 'M': return pad(d.getUTCMinutes());
      case 'S': return pad(d.getUTCSeconds());
      case 'a': return days[d.getUTCDay()];
      case 'A': return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
      case 'b': return months[d.getUTCMonth()];
      case 'B': return ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()];
      case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      case 'Z': return 'UTC';
      case 's': return String(Math.floor(d.getTime() / 1000));
      case 'n': return '\n';
      case 'T': return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      case '%': return '%';
      default: return `%${code}`;
    }
  });
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}
