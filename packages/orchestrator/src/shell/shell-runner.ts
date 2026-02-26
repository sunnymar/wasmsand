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
import type { VfsLike } from '../vfs/vfs-like.js';
import { VfsError } from '../vfs/inode.js';
import { PythonRunner } from '../python/python-runner.js';
import { WasiHost } from '../wasi/wasi-host.js';
import { NetworkGateway, NetworkAccessDenied } from '../network/gateway.js';
import type { ErrorClass } from '../security.js';
import { CancelledError } from '../security.js';
import type { PackageManager } from '../pkg/manager.js';
import { PkgError } from '../pkg/manager.js';
import { CommandHistory } from './history.js';
import type { HistoryEntry } from './history.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import { PackageRegistry } from '../packages/registry.js';

const PYTHON_COMMANDS = new Set(['python3', 'python']);
const SHELL_BUILTINS = new Set(['echo', 'which', 'chmod', 'test', '[', 'pwd', 'cd', 'export', 'unset', 'date', 'curl', 'wget', 'exit', 'true', 'false', 'pkg', 'pip', 'history', 'source', '.', 'set', 'read', 'eval', 'getopts', 'return', 'local', 'trap']);
const SHELL_COMMANDS = new Set(['sh', 'bash']);

/** Interpreter names that should be dispatched to PythonRunner. */
const PYTHON_INTERPRETERS = new Set(['python3', 'python']);

// ---- AST types matching the Rust serde output ----

interface Word {
  parts: WordPart[];
}

type WordPart =
  | { Literal: string }
  | { QuotedLiteral: string }
  | { Variable: string }
  | { CommandSub: string }
  | { ParamExpansion: { var: string; op: string; default: string } }
  | { ArithmeticExpansion: string }
  | { ProcessSub: string };

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
  | { BothOverwrite: string }
  | { Heredoc: string }
  | { HeredocStrip: string };

interface Assignment {
  name: string;
  value: string;
}

interface CaseItem {
  patterns: Word[];
  body: Command;
}

type Command =
  | { Simple: { words: Word[]; redirects: Redirect[]; assignments: Assignment[] } }
  | { Pipeline: { commands: Command[] } }
  | { List: { left: Command; op: ListOp; right: Command } }
  | { If: { condition: Command; then_body: Command; else_body: Command | null } }
  | { For: { var: string; words: Word[]; body: Command } }
  | { While: { condition: Command; body: Command } }
  | { Subshell: { body: Command } }
  | 'Break'
  | 'Continue'
  | { Negate: { body: Command } }
  | { Function: { name: string; body: Command } }
  | { Case: { word: Word; items: CaseItem[] } };

type ListOp = 'And' | 'Or' | 'Seq';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated?: { stdout: boolean; stderr: boolean };
  errorClass?: ErrorClass;
}

const EMPTY_RESULT: RunResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  executionTimeMs: 0,
};

const MAX_SUBSTITUTION_DEPTH = 50;
const MAX_FUNCTION_DEPTH = 100;

class BreakSignal { constructor(public depth: number = 1) {} }
class ContinueSignal { constructor(public depth: number = 1) {} }
class ReturnSignal { constructor(public code: number) {} }
class ExitSignal {
  constructor(public code: number, public stdout: string = '', public stderr: string = '') {}
}

export class ShellRunner {
  private vfs: VfsLike;
  private mgr: ProcessManager;
  private adapter: PlatformAdapter;
  private shellWasmPath: string;
  private shellModule: WebAssembly.Module | null = null;
  private pythonRunner: PythonRunner | null = null;
  private gateway: NetworkGateway | null = null;
  private env: Map<string, string> = new Map();
  private stdoutLimit: number | undefined;
  private stderrLimit: number | undefined;
  private memoryBytes: number | undefined;
  private cancelledReason: 'TIMEOUT' | 'CANCELLED' | null = null;
  private deadlineMs: number = Infinity;
  /** Current command substitution nesting depth. */
  private substitutionDepth = 0;
  /** Current shell function call depth. */
  private functionDepth = 0;
  /** Exit code of the last executed command (for $?). */
  private lastExitCode = 0;
  /** User-defined shell functions. */
  private functions: Map<string, Command> = new Map();
  /** Stack of saved local variable values for each function call. */
  private localVarStack: Map<string, string | undefined>[] = [];
  /** Package manager for the pkg builtin. */
  private packageManager: PackageManager | null = null;
  /** Audit event handler for emitting structured audit events. */
  private auditHandler: ((type: string, data?: Record<string, unknown>) => void) | null = null;
  /** Command history tracker. */
  private history = new CommandHistory();
  /** Host-provided extension registry for custom commands/packages. */
  private extensionRegistry: ExtensionRegistry | null = null;
  /** Optional allowlist of tool names permitted by security policy. */
  private toolAllowlist: Set<string> | null = null;
  /** Shell option flags (e=errexit, u=nounset). */
  private shellFlags = new Set<string>();
  /** Trap handlers (e.g. EXIT trap). */
  private trapHandlers: Map<string, string> = new Map();
  /** Array storage for bash-style arrays. */
  private arrays: Map<string, string[]> = new Map();
  /** Whether we're in a conditional context (if condition, || / && chains). */
  private inConditionalContext = false;
  /** Pipe stdin data threaded through compound commands (while, for, if, subshell). */
  private pipeStdin: Uint8Array | undefined;
  /** Sandbox-native package registry for pip install/uninstall at runtime. */
  private packageRegistry: PackageRegistry | null = null;
  /** Set of package names currently installed from PackageRegistry. */
  private installedPackages = new Set<string>();

  constructor(
    vfs: VfsLike,
    mgr: ProcessManager,
    adapter: PlatformAdapter,
    shellWasmPath: string,
    gateway?: NetworkGateway,
    options?: { skipPopulateBin?: boolean },
  ) {
    this.vfs = vfs;
    this.mgr = mgr;
    this.adapter = adapter;
    this.shellWasmPath = shellWasmPath;
    this.gateway = gateway ?? null;

    // Populate /bin with stubs for registered tools + python3 so that
    // `ls /bin` and `which <tool>` work as expected.
    if (!options?.skipPopulateBin) {
      this.vfs.withWriteAccess(() => this.populateBin());
    }

    // Set default environment variables so the shell starts in /home/user.
    this.env.set('HOME', '/home/user');
    this.env.set('PWD', '/home/user');
    this.env.set('USER', 'user');
    this.env.set('PATH', '/bin:/usr/bin');
    this.env.set('PYTHONPATH', '/usr/lib/python');
    this.env.set('SHELL', '/bin/sh');
  }

  /** Write executable stub files into /bin and /usr/bin for all registered tools + python. */
  private populateBin(): void {
    const encoder = new TextEncoder();
    const dirs = ['/bin', '/usr/bin'];
    const allTools = [
      ...this.mgr.getRegisteredTools(),
      ...PYTHON_COMMANDS,
      ...SHELL_BUILTINS,
      ...SHELL_COMMANDS,
    ];
    for (const dir of dirs) {
      for (const tool of allTools) {
        const path = `${dir}/${tool}`;
        try {
          this.vfs.writeFile(path, encoder.encode(`#!/bin/codepod\n# ${tool}\n`));
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

  /** Set output byte limits for stdout/stderr truncation. */
  setOutputLimits(stdoutBytes?: number, stderrBytes?: number): void {
    this.stdoutLimit = stdoutBytes;
    this.stderrLimit = stderrBytes;
  }

  /** Set WASM memory limit in bytes. */
  setMemoryLimit(bytes: number): void {
    this.memoryBytes = bytes;
  }

  /** Set the package manager for the pkg builtin. */
  setPackageManager(mgr: PackageManager): void {
    this.packageManager = mgr;
  }

  /** Set the audit event handler for emitting structured audit events. */
  setAuditHandler(handler: (type: string, data?: Record<string, unknown>) => void): void {
    this.auditHandler = handler;
  }

  /** Set the extension registry and write /bin stubs for discovery. */
  setExtensionRegistry(registry: ExtensionRegistry): void {
    this.extensionRegistry = registry;
    this.vfs.withWriteAccess(() => {
      const enc = new TextEncoder();
      for (const name of registry.getCommandNames()) {
        try {
          this.vfs.writeFile(`/bin/${name}`, enc.encode(`#!/bin/codepod\n# extension: ${name}\n`));
          this.vfs.chmod(`/bin/${name}`, 0o755);
        } catch { /* ignore if exists */ }
      }
    });
  }

  /** Set the sandbox-native package registry for runtime pip install/uninstall. */
  setPackageRegistry(registry: PackageRegistry): void {
    this.packageRegistry = registry;
  }

  /** Mark a package as already installed (e.g. from Sandbox.create pre-install). */
  markPackageInstalled(name: string): void {
    this.installedPackages.add(name);
  }

  /** Set the tool allowlist so extension commands are also gated. */
  setToolAllowlist(list: string[]): void {
    this.toolAllowlist = new Set(list);
  }

  /** Signal cancellation to the shell runner. */
  cancel(reason: 'TIMEOUT' | 'CANCELLED'): void {
    this.cancelledReason = reason;
  }

  /** Force deadline to now — causes immediate cancellation at next check. */
  setDeadlineNow(): void {
    this.deadlineMs = 0;
  }

  /** Reset cancellation flag and set deadline before a new run. */
  resetCancel(timeoutMs?: number): void {
    this.cancelledReason = null;
    this.deadlineMs = timeoutMs !== undefined ? Date.now() + timeoutMs : Infinity;
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
    'echo', 'printf', 'basename', 'dirname', 'env', 'true', 'false', 'find',
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
   * Also resolves args that look like filenames (contain a dot) so that
   * tools like tar/gzip can create new files relative to CWD.
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
      // Arg looks like a filename (e.g. "archive.tar") — resolve it so
      // tools can create new files relative to CWD.  Must end with a
      // file extension, not contain glob/pattern chars, and not start
      // with "." (which would match jq expressions like ".name").
      if (/\.\w+$/.test(arg) && !/[*?{}\/]/.test(arg) && !arg.startsWith('.')) {
        return resolved;
      }
      return arg;
    }
  }

  /**
   * Run a shell command string. Parses it via the shell Wasm binary,
   * then executes the AST.
   */
  async run(command: string): Promise<RunResult> {
    this.history.add(command);
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
    let result: RunResult;
    try {
      result = await this.execCommand(ast);
      this.lastExitCode = result.exitCode;
      result.executionTimeMs = performance.now() - startTime;
    } catch (e) {
      if (e instanceof ExitSignal) {
        this.lastExitCode = e.code;
        result = { exitCode: e.code, stdout: e.stdout, stderr: e.stderr, executionTimeMs: performance.now() - startTime };
      } else {
        throw e;
      }
    }

    // Execute EXIT trap handler at top level (not inside command substitutions)
    if (this.substitutionDepth === 0) {
      const exitHandler = this.trapHandlers.get('EXIT');
      if (exitHandler) {
        this.trapHandlers.delete('EXIT'); // prevent re-entrant firing
        const trapResult = await this.run(exitHandler);
        result = {
          ...result,
          stdout: result.stdout + trapResult.stdout,
          stderr: result.stderr + trapResult.stderr,
        };
      }
    }

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
      args: ['codepod-shell'],
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
    if (this.cancelledReason) {
      throw new CancelledError(this.cancelledReason);
    }
    if (Date.now() > this.deadlineMs) {
      throw new CancelledError('TIMEOUT');
    }
    // Handle string-typed commands (Break, Continue)
    if (typeof cmd === 'string') {
      if (cmd === 'Break') throw new BreakSignal();
      if (cmd === 'Continue') throw new ContinueSignal();
      return EMPTY_RESULT;
    }
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
      const savedEnv = new Map(this.env);
      const result = await this.execCommand(cmd.Subshell.body);
      this.env = savedEnv;
      return result;
    }
    // Break/Continue already handled as string type above
    if ('Negate' in cmd) {
      const result = await this.execCommand((cmd as { Negate: { body: Command } }).Negate.body);
      return { ...result, exitCode: result.exitCode === 0 ? 1 : 0 };
    }
    if ('Function' in cmd) {
      const fn = (cmd as { Function: { name: string; body: Command } }).Function;
      this.functions.set(fn.name, fn.body);
      return { ...EMPTY_RESULT };
    }
    if ('Case' in cmd) {
      return this.execCase((cmd as { Case: { word: Word; items: CaseItem[] } }).Case);
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
      // Detect array assignment: value is "(elem1 elem2 ...)"
      if (value.startsWith('(') && value.endsWith(')')) {
        const inner = value.slice(1, -1).trim();
        const elements = inner.length > 0 ? inner.split(/\s+/) : [];
        this.arrays.set(assignment.name, elements);
      } else {
        this.env.set(assignment.name, value);
      }
    }

    // If there are only assignments and no command words, it's a variable-setting command
    if (simple.words.length === 0) {
      return { ...EMPTY_RESULT };
    }

    // Expand words (async — may contain command substitutions)
    let rawWords: string[];
    try {
      rawWords = await this.expandWordsWithSplitting(simple.words);
    } catch (err: unknown) {
      if (err instanceof CancelledError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const expandErr: RunResult = { exitCode: 1, stdout: '', stderr: `${msg}\n`, executionTimeMs: 0 };
      if (this.shellFlags.has('e') && !this.inConditionalContext) {
        throw new ExitSignal(expandErr.exitCode, expandErr.stdout, expandErr.stderr);
      }
      return expandErr;
    }
    const bracedWords = this.expandBraces(rawWords);
    const restoredWords = bracedWords.map(w => w.replace(/\uE000/g, '{').replace(/\uE001/g, '}'));
    const expandedWords = this.expandGlobs(restoredWords);
    const cmdName = expandedWords[0];
    let args = expandedWords.slice(1);

    // Inject PWD for commands that default to "." when no path args given
    const pwd = this.env.get('PWD');
    if (pwd && this.needsDefaultDir(cmdName, args)) {
      args = [...args, pwd];
    }

    // Extract stdin redirect / heredoc early so builtins (e.g. read) can use it
    let stdinData: Uint8Array | undefined;
    for (const redirect of simple.redirects) {
      const rt = redirect.redirect_type;
      if (typeof rt === 'object' && 'StdinFrom' in rt) {
        stdinData = this.vfs.readFile(this.resolvePath(rt.StdinFrom));
      } else if (typeof rt === 'object' && 'Heredoc' in rt) {
        stdinData = new TextEncoder().encode(rt.Heredoc);
      } else if (typeof rt === 'object' && 'HeredocStrip' in rt) {
        stdinData = new TextEncoder().encode(rt.HeredocStrip);
      }
    }
    // Fall back to pipe stdin from enclosing pipeline (for compound commands)
    if (!stdinData && this.pipeStdin) {
      stdinData = this.pipeStdin;
    }

    // Handle shell builtins — capture result, then fall through to redirect handling
    let result: RunResult | undefined;

    if (cmdName === 'echo') {
      result = this.builtinEcho(args);
    } else if (cmdName === 'which') {
      result = this.builtinWhich(args);
    } else if (cmdName === 'chmod') {
      result = this.builtinChmod(args);
    } else if (cmdName === 'test') {
      result = this.builtinTest(args, false);
    } else if (cmdName === '[') {
      result = this.builtinTest(args, true);
    } else if (cmdName === 'pwd') {
      result = this.builtinPwd();
    } else if (cmdName === 'cd') {
      result = this.builtinCd(args);
    } else if (cmdName === 'export') {
      result = this.builtinExport(args);
    } else if (cmdName === 'unset') {
      result = this.builtinUnset(args);
    } else if (cmdName === 'date') {
      result = this.builtinDate(args);
    } else if (cmdName === 'curl') {
      result = await this.builtinCurl(args);
    } else if (cmdName === 'wget') {
      result = await this.builtinWget(args);
    } else if (cmdName === 'pkg') {
      result = await this.builtinPkg(args);
    } else if (cmdName === 'pip') {
      result = this.builtinPip(args);
    } else if (cmdName === 'history') {
      result = this.builtinHistory(args);
    } else if (cmdName === 'source' || cmdName === '.') {
      result = await this.builtinSource(args);
    } else if (cmdName === 'exit') {
      const code = args.length > 0 ? parseInt(args[0], 10) || 0 : this.lastExitCode;
      throw new ExitSignal(code);
    } else if (cmdName === 'true') {
      result = { ...EMPTY_RESULT };
    } else if (cmdName === 'false') {
      result = { exitCode: 1, stdout: '', stderr: '', executionTimeMs: 0 };
    } else if (cmdName === 'set') {
      const dashDash = args.indexOf('--');
      if (dashDash !== -1) {
        // set -- arg1 arg2 ... sets positional parameters
        const positionals = args.slice(dashDash + 1);
        // Clear old positional params
        const prevCount = this.getPositionalArgs().length;
        for (let i = 1; i <= prevCount; i++) this.env.delete(String(i));
        // Set new ones
        for (let i = 0; i < positionals.length; i++) {
          this.env.set(String(i + 1), positionals[i]);
        }
        this.env.set('#', String(positionals.length));
      } else {
        for (const arg of args) {
          if (arg.startsWith('-')) {
            for (const ch of arg.slice(1)) this.shellFlags.add(ch);
          } else if (arg.startsWith('+')) {
            for (const ch of arg.slice(1)) this.shellFlags.delete(ch);
          }
        }
      }
      result = { ...EMPTY_RESULT };
    } else if (cmdName === 'read') {
      result = this.builtinRead(args, stdinData);
    } else if (cmdName === 'eval') {
      result = await this.builtinEval(args);
    } else if (cmdName === 'getopts') {
      result = this.builtinGetopts(args);
    } else if (cmdName === 'return') {
      const code = args.length > 0 ? parseInt(args[0], 10) || 0 : this.lastExitCode;
      throw new ReturnSignal(code);
    } else if (cmdName === 'local') {
      // local VAR=value or local VAR — save previous value for restore on function return
      const frame = this.localVarStack.length > 0 ? this.localVarStack[this.localVarStack.length - 1] : null;
      for (const arg of args) {
        const eqIdx = arg.indexOf('=');
        const name = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (frame && !frame.has(name)) {
          frame.set(name, this.env.get(name));
        }
        if (eqIdx !== -1) {
          this.env.set(name, arg.slice(eqIdx + 1));
        }
      }
      result = { ...EMPTY_RESULT };
    } else if (cmdName === 'trap') {
      result = this.builtinTrap(args);
    }

    if (!result) {
      // Check if it's a user-defined function
      const fn = this.functions.get(cmdName);
      if (fn) {
        if (this.functionDepth >= MAX_FUNCTION_DEPTH) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `${cmdName}: maximum function nesting depth (${MAX_FUNCTION_DEPTH}) exceeded\n`,
            executionTimeMs: 0,
          };
        }
        // Set positional parameters
        const savedPositionals: Map<string, string | undefined> = new Map();
        savedPositionals.set('#', this.env.get('#'));
        // Save existing positional params (at least up to current count)
        const prevCount = this.getPositionalArgs().length;
        for (let i = 0; i < Math.max(args.length, prevCount, 9); i++) {
          savedPositionals.set(String(i + 1), this.env.get(String(i + 1)));
        }
        for (let i = 0; i < args.length; i++) {
          this.env.set(String(i + 1), args[i]);
        }
        // Clear stale positional params beyond args.length
        for (let i = args.length + 1; i <= prevCount; i++) {
          this.env.delete(String(i));
        }
        this.env.set('#', String(args.length));
        this.functionDepth++;
        const localFrame = new Map<string, string | undefined>();
        this.localVarStack.push(localFrame);
        try {
          result = await this.execCommand(fn);
        } catch (e) {
          if (e instanceof ReturnSignal) {
            result = { exitCode: e.code, stdout: '', stderr: '', executionTimeMs: 0 };
          } else {
            throw e;
          }
        } finally {
          this.localVarStack.pop();
          // Restore local variables
          for (const [name, prev] of localFrame) {
            if (prev !== undefined) this.env.set(name, prev);
            else this.env.delete(name);
          }
          this.functionDepth--;
          // Restore positional parameters
          for (const [key, val] of savedPositionals) {
            if (val !== undefined) this.env.set(key, val);
            else this.env.delete(key);
          }
        }
      }
    }

    if (!result) {
      // Spawn the process (or delegate to PythonRunner)
      try {
        result = await this.spawnOrPython(cmdName, args, stdinData);
      } catch (err: unknown) {
        if (err instanceof CancelledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          exitCode: 127,
          stdout: '',
          stderr: `${cmdName}: ${msg}\n`,
          executionTimeMs: 0,
        };
      }
    }

    // Handle output redirects
    let stdout = result.stdout;
    let stderr = result.stderr;

    let lastStdoutRedirectPath: string | null = null;
    for (const redirect of simple.redirects) {
      const rt = redirect.redirect_type;
      try {
        if (typeof rt === 'object' && 'StdoutOverwrite' in rt) {
          const resolved = this.resolvePath(rt.StdoutOverwrite);
          this.vfs.writeFile(resolved, new TextEncoder().encode(stdout));
          stdout = '';
          lastStdoutRedirectPath = resolved;
        } else if (typeof rt === 'object' && 'StdoutAppend' in rt) {
          const resolved = this.resolvePath(rt.StdoutAppend);
          const existing = this.tryReadFile(resolved);
          const combined = concatBytes(
            existing,
            new TextEncoder().encode(stdout),
          );
          this.vfs.writeFile(resolved, combined);
          stdout = '';
          lastStdoutRedirectPath = resolved;
        } else if (typeof rt === 'object' && 'StderrOverwrite' in rt) {
          this.vfs.writeFile(this.resolvePath(rt.StderrOverwrite), new TextEncoder().encode(stderr));
          stderr = '';
        } else if (typeof rt === 'object' && 'StderrAppend' in rt) {
          const resolved = this.resolvePath(rt.StderrAppend);
          const existing = this.tryReadFile(resolved);
          const combined = concatBytes(existing, new TextEncoder().encode(stderr));
          this.vfs.writeFile(resolved, combined);
          stderr = '';
        } else if (rt === 'StderrToStdout') {
          if (lastStdoutRedirectPath && stderr) {
            // Stdout was already redirected to a file — append stderr there
            const existing = this.tryReadFile(lastStdoutRedirectPath);
            const combined = concatBytes(existing, new TextEncoder().encode(stderr));
            this.vfs.writeFile(lastStdoutRedirectPath, combined);
          } else {
            stdout += stderr;
          }
          stderr = '';
        } else if (typeof rt === 'object' && 'BothOverwrite' in rt) {
          const combined = stdout + stderr;
          this.vfs.writeFile(this.resolvePath(rt.BothOverwrite), new TextEncoder().encode(combined));
          stdout = '';
          stderr = '';
        }
      } catch (err: unknown) {
        if (err instanceof CancelledError) throw err;
        if (err instanceof VfsError) {
          const target = typeof rt === 'object' && 'StdoutOverwrite' in rt
            ? rt.StdoutOverwrite
            : typeof rt === 'object' && 'StdoutAppend' in rt
              ? rt.StdoutAppend : '?';
          return {
            exitCode: 1,
            stdout: '',
            stderr: `${err.errno}: ${target}\n`,
            executionTimeMs: result.executionTimeMs,
          };
        }
        throw err;
      }
    }

    const finalResult: RunResult = {
      exitCode: result.exitCode,
      stdout,
      stderr,
      executionTimeMs: result.executionTimeMs,
      truncated: result.truncated,
    };

    // set -e (errexit): abort on non-zero exit unless in conditional context
    if (this.shellFlags.has('e') && !this.inConditionalContext && finalResult.exitCode !== 0) {
      throw new ExitSignal(finalResult.exitCode, finalResult.stdout, finalResult.stderr);
    }

    return finalResult;
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
      if (typeof cmd === 'object' && 'Simple' in cmd) {
        const simple = cmd.Simple;
        const rawWords = await this.expandWordsWithSplitting(simple.words);
        const bracedWords = this.expandBraces(rawWords);
        const restoredWords = bracedWords.map(w => w.replace(/\uE000/g, '{').replace(/\uE001/g, '}'));
        const expandedWords = this.expandGlobs(restoredWords);
        const cmdName = expandedWords[0];
        const args = expandedWords.slice(1);

        if (cmdName === 'read') {
          lastResult = this.builtinRead(args, stdinData);
        } else {
          try {
            const result = await this.spawnOrPython(cmdName, args, stdinData);
            lastResult = { ...result };
          } catch (err: unknown) {
            if (err instanceof CancelledError) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            lastResult = {
              exitCode: 127,
              stdout: '',
              stderr: `${cmdName}: ${msg}\n`,
              executionTimeMs: 0,
            };
          }
        }

        // Handle 2>&1 redirect in pipeline Simple commands: merge stderr into stdout
        for (const redirect of simple.redirects) {
          if (redirect.redirect_type === 'StderrToStdout') {
            lastResult = { ...lastResult, stdout: lastResult.stdout + lastResult.stderr, stderr: '' };
          }
        }
      } else {
        // For non-simple commands in a pipeline, thread stdin through
        // via the pipeStdin field so compound commands (while, for, if, subshell)
        // can access it.
        const savedPipeStdin = this.pipeStdin;
        this.pipeStdin = stdinData;
        try {
          lastResult = await this.execCommand(cmd);
        } finally {
          this.pipeStdin = savedPipeStdin;
        }
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
    let leftResult: RunResult;

    // For && and ||, the left side is in a conditional context (errexit suppressed)
    if (list.op === 'And' || list.op === 'Or') {
      const prevCtx = this.inConditionalContext;
      this.inConditionalContext = true;
      try {
        leftResult = await this.execCommand(list.left);
      } catch (e) {
        this.inConditionalContext = prevCtx;
        throw e;
      }
      this.inConditionalContext = prevCtx;
    } else {
      try {
        leftResult = await this.execCommand(list.left);
      } catch (e) {
        if (e instanceof ExitSignal) throw e;
        throw e;
      }
    }
    // Update lastExitCode so $? reflects intermediate results
    this.lastExitCode = leftResult.exitCode;

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
          const prevCtx = this.inConditionalContext;
          this.inConditionalContext = true;
          let rightResult: RunResult;
          try {
            rightResult = await this.execCommand(list.right);
          } finally {
            this.inConditionalContext = prevCtx;
          }
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
        try {
          const rightResult = await this.execCommand(list.right);
          const anyTruncated = leftResult.truncated || rightResult.truncated;
          return {
            exitCode: rightResult.exitCode,
            stdout: leftResult.stdout + rightResult.stdout,
            stderr: leftResult.stderr + rightResult.stderr,
            executionTimeMs:
              leftResult.executionTimeMs + rightResult.executionTimeMs,
            truncated: anyTruncated ? {
              stdout: !!(leftResult.truncated?.stdout || rightResult.truncated?.stdout),
              stderr: !!(leftResult.truncated?.stderr || rightResult.truncated?.stderr),
            } : undefined,
          };
        } catch (e) {
          if (e instanceof ExitSignal) {
            // Accumulate output from left side, then re-throw
            throw new ExitSignal(
              e.code,
              leftResult.stdout + e.stdout,
              leftResult.stderr + e.stderr,
            );
          }
          throw e;
        }
      }
    }
  }

  private async execIf(ifCmd: {
    condition: Command;
    then_body: Command;
    else_body: Command | null;
  }): Promise<RunResult> {
    const prevCtx = this.inConditionalContext;
    this.inConditionalContext = true;
    let condResult: RunResult;
    try {
      condResult = await this.execCommand(ifCmd.condition);
    } finally {
      this.inConditionalContext = prevCtx;
    }

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
    const rawWords = await this.expandWordsWithSplitting(forCmd.words);
    const bracedWords = this.expandBraces(rawWords);
    const restoredWords = bracedWords.map(w => w.replace(/\uE000/g, '{').replace(/\uE001/g, '}'));
    const expandedWords = this.expandGlobs(restoredWords);
    let combinedStdout = '';
    let combinedStderr = '';
    let lastExitCode = 0;
    let totalTime = 0;

    for (const word of expandedWords) {
      this.env.set(forCmd.var, word);
      try {
        const result = await this.execCommand(forCmd.body);
        combinedStdout += result.stdout;
        combinedStderr += result.stderr;
        lastExitCode = result.exitCode;
        totalTime += result.executionTimeMs;
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
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
      const prevCtx = this.inConditionalContext;
      this.inConditionalContext = true;
      let condResult: RunResult;
      try {
        condResult = await this.execCommand(whileCmd.condition);
      } finally {
        this.inConditionalContext = prevCtx;
      }
      if (condResult.exitCode !== 0) {
        break;
      }
      try {
        const bodyResult = await this.execCommand(whileCmd.body);
        combinedStdout += bodyResult.stdout;
        combinedStderr += bodyResult.stderr;
        lastExitCode = bodyResult.exitCode;
        totalTime += bodyResult.executionTimeMs;
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) { iterations++; continue; }
        throw e;
      }
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

  /**
   * Does this word need IFS-based splitting after expansion?
   * A word needs splitting if it contains CommandSub or Variable parts
   * and is not inside double quotes (indicated by QuotedLiteral parts).
   */
  private wordNeedsSplitting(word: Word): boolean {
    const hasSubstitution = word.parts.some(p => 'CommandSub' in p || 'Variable' in p);
    const isQuoted = word.parts.some(p => 'QuotedLiteral' in p);
    return hasSubstitution && !isQuoted;
  }

  /**
   * Expand a list of Words, performing IFS-based word splitting on unquoted
   * command substitutions and variable expansions.
   */
  private async expandWordsWithSplitting(words: Word[]): Promise<string[]> {
    const result: string[] = [];
    for (const w of words) {
      const expanded = await this.expandWord(w);
      if (this.wordNeedsSplitting(w)) {
        const split = expanded.split(/[ \t\n]+/).filter(s => s !== '');
        result.push(...split);
      } else {
        result.push(expanded);
      }
    }
    return result;
  }

  private async expandWordPart(part: WordPart): Promise<string> {
    if ('Literal' in part) {
      const s = part.Literal;
      if (s === '~') return this.env.get('HOME') ?? '/home/user';
      if (s.startsWith('~/')) return (this.env.get('HOME') ?? '/home/user') + s.slice(1);
      return s;
    }
    if ('QuotedLiteral' in part) {
      // Replace { and } with sentinels so brace expansion skips them
      return part.QuotedLiteral
        .replace(/\{/g, '\uE000')
        .replace(/\}/g, '\uE001');
    }
    if ('Variable' in part) {
      if (part.Variable === '?') return String(this.lastExitCode);
      if (part.Variable === '@' || part.Variable === '*') {
        return this.getPositionalArgs().join(' ');
      }
      if (part.Variable === '#') {
        return String(this.getPositionalArgs().length);
      }
      if (part.Variable === 'RANDOM') {
        return String(Math.floor(Math.random() * 32768));
      }
      // Array access: arr[n], arr[@], arr[*]
      const arrMatch = part.Variable.match(/^(\w+)\[(.+)\]$/);
      if (arrMatch) {
        const arrName = arrMatch[1];
        const index = arrMatch[2];
        const arr = this.arrays.get(arrName);
        if (arr) {
          if (index === '@' || index === '*') {
            return arr.join(' ');
          }
          const idx = parseInt(index, 10);
          if (!isNaN(idx) && idx >= 0 && idx < arr.length) {
            return arr[idx];
          }
          return '';
        }
        return '';
      }
      const val = this.env.get(part.Variable);
      if (val === undefined && this.shellFlags.has('u') && !/^\d+$/.test(part.Variable)) {
        throw new Error(`${part.Variable}: unbound variable`);
      }
      return val ?? '';
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
    if ('ProcessSub' in part) {
      // Process substitution: execute the command, write output to a temp VFS file,
      // and return the file path so the outer command can read it.
      const tmpPath = `/tmp/.procsub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const result = await this.run(part.ProcessSub);
      this.vfs.writeFile(tmpPath, new TextEncoder().encode(result.stdout));
      return tmpPath;
    }
    if ('ParamExpansion' in part) {
      const { var: name, op, default: operand } = part.ParamExpansion;
      const val = this.env.get(name);
      switch (op) {
        case ':-': return (val !== undefined && val !== '') ? val : operand;
        case ':=': {
          if (val === undefined || val === '') {
            this.env.set(name, operand);
            return operand;
          }
          return val;
        }
        case ':+': return (val !== undefined && val !== '') ? operand : '';
        case ':?': {
          if (val === undefined || val === '') {
            throw new Error(`${name}: ${operand || 'parameter null or not set'}`);
          }
          return val;
        }
        case '#': {
          // ${#VAR} — string length (parser produces var="" op="#" default="VAR")
          if (name === '' && operand) {
            // Check for array length: ${#arr[@]} or ${#arr[*]}
            const arrLenMatch = operand.match(/^(\w+)\[[@*]\]$/);
            if (arrLenMatch) {
              const arr = this.arrays.get(arrLenMatch[1]);
              return String(arr ? arr.length : 0);
            }
            const v = this.env.get(operand) ?? '';
            return String(v.length);
          }
          if (val === undefined) return '';
          return this.trimPrefix(val, operand, false);
        }
        case '##': {
          if (val === undefined) return '';
          return this.trimPrefix(val, operand, true);
        }
        case '%': {
          if (val === undefined) return '';
          return this.trimSuffix(val, operand, false);
        }
        case '%%': {
          if (val === undefined) return '';
          return this.trimSuffix(val, operand, true);
        }
        case '/': {
          if (val === undefined) return '';
          return this.replacePattern(val, operand, false);
        }
        case '//': {
          if (val === undefined) return '';
          return this.replacePattern(val, operand, true);
        }
        case '^^': return (val ?? '').toUpperCase();
        case ',,': return (val ?? '').toLowerCase();
        case '^': {
          const s = val ?? '';
          return s.charAt(0).toUpperCase() + s.slice(1);
        }
        case ',': {
          const s = val ?? '';
          return s.charAt(0).toLowerCase() + s.slice(1);
        }
        case ':': {
          const s = val ?? '';
          const parts = operand.split(':');
          const offset = parseInt(parts[0], 10) || 0;
          if (parts.length > 1) {
            const length = parseInt(parts[1], 10);
            return s.slice(offset, offset + length);
          }
          return s.slice(offset);
        }
        default: return val ?? '';
      }
    }
    if ('ArithmeticExpansion' in part) {
      return String(this.evalArithmetic(part.ArithmeticExpansion));
    }
    return '';
  }

  /** Collect positional parameters $1, $2, ... from env until a gap. */
  private getPositionalArgs(): string[] {
    const args: string[] = [];
    for (let i = 1; ; i++) {
      const val = this.env.get(String(i));
      if (val === undefined) break;
      args.push(val);
    }
    return args;
  }

  /** Convert a shell glob pattern to a RegExp (anchored). */
  private globToRegex(pattern: string): RegExp {
    const re = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp('^' + re + '$');
  }

  /** Remove prefix matching glob pattern. greedy=true for longest match (##). */
  private trimPrefix(val: string, pattern: string, greedy: boolean): string {
    const re = this.globToRegex(pattern);
    if (greedy) {
      for (let i = val.length; i >= 0; i--) {
        if (re.test(val.slice(0, i))) return val.slice(i);
      }
    } else {
      for (let i = 0; i <= val.length; i++) {
        if (re.test(val.slice(0, i))) return val.slice(i);
      }
    }
    return val;
  }

  /** Remove suffix matching glob pattern. greedy=true for longest match (%%). */
  private trimSuffix(val: string, pattern: string, greedy: boolean): string {
    const re = this.globToRegex(pattern);
    if (greedy) {
      for (let i = 0; i <= val.length; i++) {
        if (re.test(val.slice(i))) return val.slice(0, i);
      }
    } else {
      for (let i = val.length; i >= 0; i--) {
        if (re.test(val.slice(i))) return val.slice(0, i);
      }
    }
    return val;
  }

  /** Replace first or all occurrences. Operand format: "pattern/replacement". */
  private replacePattern(val: string, operand: string, all: boolean): string {
    const slashIdx = operand.indexOf('/');
    const pattern = slashIdx >= 0 ? operand.slice(0, slashIdx) : operand;
    const replacement = slashIdx >= 0 ? operand.slice(slashIdx + 1) : '';
    const re = this.globToRegex(pattern);

    if (all) {
      let result = '';
      let i = 0;
      while (i < val.length) {
        let matched = false;
        for (let j = val.length; j > i; j--) {
          if (re.test(val.slice(i, j))) {
            result += replacement;
            i = j;
            matched = true;
            break;
          }
        }
        if (!matched) {
          result += val[i];
          i++;
        }
      }
      return result;
    } else {
      for (let i = 0; i < val.length; i++) {
        for (let j = val.length; j > i; j--) {
          if (re.test(val.slice(i, j))) {
            return val.slice(0, i) + replacement + val.slice(j);
          }
        }
      }
      return val;
    }
  }

  private async spawnOrPython(
    cmdName: string,
    args: string[],
    stdinData: Uint8Array | undefined,
  ): Promise<SpawnResult> {
    let result: SpawnResult;

    // If the command looks like a path (./script.sh, /tmp/run.py),
    // try shebang-based execution before falling through to tool lookup.
    if (cmdName.includes('/')) {
      result = await this.execPath(cmdName, args, stdinData);
    } else if (SHELL_COMMANDS.has(cmdName)) {
      result = await this.execShellCommand(cmdName, args, stdinData);
    } else if (PYTHON_COMMANDS.has(cmdName)) {
      result = await this.execPython(args, stdinData);
    } else if (this.extensionRegistry?.has(cmdName) && this.extensionRegistry.get(cmdName)!.command) {
      if (this.toolAllowlist && !this.toolAllowlist.has(cmdName)) {
        result = {
          exitCode: 126,
          stdout: '',
          stderr: `${cmdName}: tool not allowed by security policy\n`,
          executionTimeMs: 0,
        };
      } else {
        result = await this.execExtension(cmdName, args, stdinData);
      }
    } else {
      // Resolve relative path args for WASI binaries. WASI resolves all
      // paths against the root preopen (/), so we must convert relative
      // paths to absolute ones using PWD before spawning.
      const resolvedArgs = args.map(a => this.resolveArgIfPath(cmdName, a));
      result = await this.mgr.spawn(cmdName, {
        args: resolvedArgs,
        env: Object.fromEntries(this.env),
        stdinData,
        cwd: this.env.get('PWD'),
        stdoutLimit: this.stdoutLimit,
        stderrLimit: this.stderrLimit,
        deadlineMs: this.deadlineMs,
        memoryBytes: this.memoryBytes,
      });
    }

    // Check if execution was terminated by deadline or cancellation
    if (this.cancelledReason) throw new CancelledError(this.cancelledReason);
    if (Date.now() > this.deadlineMs) throw new CancelledError('TIMEOUT');

    return result;
  }

  /** Execute a host-provided extension command. */
  private async execExtension(
    cmdName: string, args: string[], stdinData: Uint8Array | undefined,
  ): Promise<SpawnResult> {
    if (Date.now() > this.deadlineMs) throw new CancelledError('TIMEOUT');

    const start = performance.now();
    if (args.includes('--help')) {
      const desc = this.extensionRegistry!.get(cmdName)!.description ?? `${cmdName}: extension command\n`;
      return {
        exitCode: 0,
        stdout: desc.endsWith('\n') ? desc : desc + '\n',
        stderr: '',
        executionTimeMs: performance.now() - start,
      };
    }
    const stdin = stdinData ? new TextDecoder().decode(stdinData) : '';
    const r = await this.extensionRegistry!.invoke(cmdName, {
      args,
      stdin,
      env: Object.fromEntries(this.env),
      cwd: this.env.get('PWD') ?? '/',
    });

    let stdout = r.stdout;
    let stderr = r.stderr ?? '';
    let truncated: { stdout: boolean; stderr: boolean } | undefined;

    if (this.stdoutLimit !== undefined && stdout.length > this.stdoutLimit) {
      stdout = stdout.slice(0, this.stdoutLimit);
      truncated = { stdout: true, stderr: false };
    }
    if (this.stderrLimit !== undefined && stderr.length > this.stderrLimit) {
      stderr = stderr.slice(0, this.stderrLimit);
      truncated = truncated ? { ...truncated, stderr: true } : { stdout: false, stderr: true };
    }

    return {
      exitCode: r.exitCode,
      stdout,
      stderr,
      executionTimeMs: performance.now() - start,
      truncated,
    };
  }

  /** Run a command via the shell (handles sh -c 'cmd' and sh script.sh). */
  private async execShellCommand(
    cmdName: string, args: string[], stdinData: Uint8Array | undefined,
  ): Promise<SpawnResult> {
    // sh -c 'command string'
    if (args.length >= 2 && args[0] === '-c') {
      return this.run(args[1]);
    }
    // sh script.sh — read and execute as shell script
    if (args.length >= 1 && !args[0].startsWith('-')) {
      return this.execPath(args[0], args.slice(1), stdinData);
    }
    // Bare sh/bash with no args — not interactive, just succeed
    return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
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
      stdoutLimit: this.stdoutLimit,
      stderrLimit: this.stderrLimit,
      deadlineMs: this.deadlineMs,
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
    // Clear stale positional params beyond args.length
    for (let i = args.length + 1; ; i++) {
      if (this.env.has(String(i))) {
        this.env.delete(String(i));
      } else {
        break;
      }
    }
    this.env.set('#', String(args.length));

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
      if (value[i] === '$' && i + 2 < value.length && value[i + 1] === '(' && value[i + 2] === '(') {
        // Arithmetic expansion: $((...))
        const start = i + 3;
        const endIdx = value.indexOf('))', start);
        if (endIdx >= 0) {
          const expr = value.slice(start, endIdx);
          result += String(this.evalArithmetic(expr));
          i = endIdx + 2;
        } else {
          result += value[i++];
        }
      } else if (value[i] === '$' && i + 1 < value.length && value[i + 1] === '(') {
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
   * Expand brace patterns in a list of words.
   * {a,b,c} → ['a', 'b', 'c'], prefix{a,b}suffix → ['prefixasuffix', 'prefixbsuffix']
   * {1..5} → ['1', '2', '3', '4', '5'], {a..e} → ['a', 'b', 'c', 'd', 'e']
   */
  private expandBraces(words: string[]): string[] {
    const result: string[] = [];
    for (const word of words) {
      result.push(...this.expandBrace(word));
    }
    return result;
  }

  private expandBrace(word: string): string[] {
    // Find the first top-level { } pair
    let depth = 0;
    let start = -1;
    for (let i = 0; i < word.length; i++) {
      if (word[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (word[i] === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const prefix = word.slice(0, start);
          const inner = word.slice(start + 1, i);
          const suffix = word.slice(i + 1);

          // Check for range pattern: {a..z} or {1..10}
          const rangeMatch = inner.match(/^(-?\w+)\.\.(-?\w+)$/);
          if (rangeMatch) {
            const items = this.expandRange(rangeMatch[1], rangeMatch[2]);
            if (items.length > 0) {
              return items.flatMap(item => this.expandBrace(prefix + item + suffix));
            }
          }

          // Check for comma-separated list (must have at least one comma)
          if (inner.includes(',')) {
            const items = this.splitBraceItems(inner);
            if (items.length > 1) {
              return items.flatMap(item => this.expandBrace(prefix + item + suffix));
            }
          }

          // Not a valid brace expansion — treat as literal
          return [word];
        }
      }
    }
    return [word];
  }

  private splitBraceItems(inner: string): string[] {
    const items: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of inner) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        items.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    items.push(current);
    return items;
  }

  private expandRange(startStr: string, endStr: string): string[] {
    // Numeric range
    const startNum = parseInt(startStr, 10);
    const endNum = parseInt(endStr, 10);
    if (!isNaN(startNum) && !isNaN(endNum)) {
      const items: string[] = [];
      const step = startNum <= endNum ? 1 : -1;
      for (let i = startNum; step > 0 ? i <= endNum : i >= endNum; i += step) {
        items.push(String(i));
      }
      return items;
    }
    // Alpha range (single chars)
    if (startStr.length === 1 && endStr.length === 1) {
      const s = startStr.charCodeAt(0);
      const e = endStr.charCodeAt(0);
      const items: string[] = [];
      const step = s <= e ? 1 : -1;
      for (let i = s; step > 0 ? i <= e : i >= e; i += step) {
        items.push(String.fromCharCode(i));
      }
      return items;
    }
    return [];
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

  private async execCase(caseCmd: { word: Word; items: CaseItem[] }): Promise<RunResult> {
    const value = await this.expandWord(caseCmd.word);
    for (const item of caseCmd.items) {
      for (const pattern of item.patterns) {
        const patStr = await this.expandWord(pattern);
        if (this.caseGlobMatch(value, patStr)) {
          return this.execCommand(item.body);
        }
      }
    }
    return { ...EMPTY_RESULT };
  }

  /** Match a string against a shell glob pattern (for case statements). */
  private caseGlobMatch(value: string, pattern: string): boolean {
    if (pattern === '*') return true;
    const regexStr = '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      + '$';
    return new RegExp(regexStr).test(value);
  }

  /** Evaluate a shell arithmetic expression. */
  private evalArithmetic(expr: string): number {
    // Handle simple assignment: VAR=expr (before variable expansion)
    const assignMatch = expr.match(/^\s*([a-zA-Z_]\w*)\s*=\s*(.+)$/);
    if (assignMatch) {
      const value = this.evalArithmetic(assignMatch[2]);
      this.env.set(assignMatch[1], String(value));
      return value;
    }
    // Expand $VAR references and bare variable names
    let expanded = expr.replace(/\$(\w+)/g, (_, name) => this.env.get(name) ?? '0');
    // Replace bare variable names (not already a number)
    expanded = expanded.replace(/\b([a-zA-Z_]\w*)\b/g, (match) => {
      return this.env.get(match) ?? '0';
    });
    return safeEvalArithmetic(expanded);
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

  /** Builtin: trap — set signal/exit handlers. */
  private builtinTrap(args: string[]): RunResult {
    if (args.length < 2) {
      return { ...EMPTY_RESULT };
    }
    const action = args[0];
    for (let i = 1; i < args.length; i++) {
      const signal = args[i];
      if (action === '') {
        this.trapHandlers.delete(signal);
      } else {
        this.trapHandlers.set(signal, action);
      }
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

    // Compound operators: -a (AND) and -o (OR)
    // Search for -o first (lower precedence), then -a
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-o') {
        return this.evalTest(args.slice(0, i)) || this.evalTest(args.slice(i + 1));
      }
    }
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-a') {
        return this.evalTest(args.slice(0, i)) && this.evalTest(args.slice(i + 1));
      }
    }

    return false;
  }

  /** Builtin: echo — print arguments to stdout. */
  private builtinEcho(args: string[]): RunResult {
    let trailingNewline = true;
    let interpretEscapes = false;
    let startIdx = 0;

    // Parse flags: -n (no newline), -e (interpret escapes), -E (no escapes, default)
    // Support combined flags like -en, -ne, -neE, etc.
    while (startIdx < args.length && args[startIdx].startsWith('-') && args[startIdx].length > 1 && /^-[neE]+$/.test(args[startIdx])) {
      const flags = args[startIdx].slice(1);
      for (const ch of flags) {
        if (ch === 'n') trailingNewline = false;
        else if (ch === 'e') interpretEscapes = true;
        else if (ch === 'E') interpretEscapes = false;
      }
      startIdx++;
    }

    let output = args.slice(startIdx).join(' ');

    if (interpretEscapes) {
      output = this.interpretEchoEscapes(output);
    }

    output += trailingNewline ? '\n' : '';
    return { exitCode: 0, stdout: output, stderr: '', executionTimeMs: 0 };
  }

  /** Interpret backslash escape sequences for echo -e. */
  private interpretEchoEscapes(s: string): string {
    let result = '';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const next = s[i + 1];
        switch (next) {
          case 'n': result += '\n'; i += 2; break;
          case 't': result += '\t'; i += 2; break;
          case 'r': result += '\r'; i += 2; break;
          case 'a': result += '\x07'; i += 2; break;
          case 'b': result += '\b'; i += 2; break;
          case 'f': result += '\f'; i += 2; break;
          case 'v': result += '\v'; i += 2; break;
          case '\\': result += '\\'; i += 2; break;
          case '0': {
            // Octal: \0NNN (up to 3 octal digits)
            let octal = '';
            let j = i + 2;
            while (j < s.length && j < i + 5 && s[j] >= '0' && s[j] <= '7') {
              octal += s[j];
              j++;
            }
            result += String.fromCharCode(parseInt(octal || '0', 8));
            i = j;
            break;
          }
          case 'x': {
            // Hex: \xHH (up to 2 hex digits)
            let hex = '';
            let j = i + 2;
            while (j < s.length && j < i + 4 && /[0-9a-fA-F]/.test(s[j])) {
              hex += s[j];
              j++;
            }
            if (hex.length > 0) {
              result += String.fromCharCode(parseInt(hex, 16));
              i = j;
            } else {
              result += '\\x';
              i += 2;
            }
            break;
          }
          case 'c':
            // \c — suppress further output (including trailing newline)
            return result;
          default:
            result += '\\' + next;
            i += 2;
            break;
        }
      } else {
        result += s[i];
        i++;
      }
    }
    return result;
  }

  /** Builtin: read — read a line from stdin and assign to variables. */
  private builtinRead(args: string[], stdinData: Uint8Array | undefined): RunResult {
    let raw = false;
    const varNames: string[] = [];
    for (const a of args) {
      if (a === '-r') { raw = true; continue; }
      varNames.push(a);
    }
    if (varNames.length === 0) varNames.push('REPLY');

    // Get first line from stdin
    const input = stdinData ? new TextDecoder().decode(stdinData) : '';
    const nlIndex = input.indexOf('\n');
    const firstLine = nlIndex !== -1 ? input.slice(0, nlIndex) : input;
    if (!stdinData?.length || (firstLine === '' && input === '')) {
      return { exitCode: 1, stdout: '', stderr: '', executionTimeMs: 0 };
    }
    const line = raw ? firstLine : firstLine.replace(/\\(.)/g, '$1');
    const parts = line.split(/[ \t]+/);
    for (let i = 0; i < varNames.length; i++) {
      if (i === varNames.length - 1) {
        // Last variable gets the remainder
        this.env.set(varNames[i], parts.slice(i).join(' '));
      } else {
        this.env.set(varNames[i], parts[i] ?? '');
      }
    }

    // Advance pipeStdin past the consumed line so the next `read` in a
    // while loop gets the next line instead of re-reading the same one.
    if (this.pipeStdin && stdinData === this.pipeStdin) {
      const remaining = nlIndex !== -1 ? input.slice(nlIndex + 1) : '';
      this.pipeStdin = remaining.length > 0
        ? new TextEncoder().encode(remaining)
        : undefined;
    }

    return { ...EMPTY_RESULT };
  }

  /** Builtin: eval — concatenate args and execute as a shell command. */
  private async builtinEval(args: string[]): Promise<RunResult> {
    if (args.length === 0) return { ...EMPTY_RESULT };
    const command = args.join(' ');
    // Re-parse and execute through the full pipeline (expansion, parsing, execution)
    const ast = await this.parse(command);
    if (ast === null) return { ...EMPTY_RESULT };
    const result = await this.execCommand(ast);
    this.lastExitCode = result.exitCode;
    return result;
  }

  /**
   * Builtin: getopts — POSIX option parsing for shell scripts.
   *
   * Usage: getopts OPTSTRING NAME [ARGS...]
   *
   * Uses shell variable OPTIND (1-based index into args) to track position.
   * Sets NAME to the option character found (or '?' on error).
   * Sets OPTARG for options that take arguments.
   * Returns 0 while options remain, 1 when done.
   */
  private builtinGetopts(args: string[]): RunResult {
    if (args.length < 2) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'getopts: usage: getopts optstring name [arg ...]\n',
        executionTimeMs: 0,
      };
    }
    const optstring = args[0];
    const varName = args[1];
    // If extra args given, parse those; otherwise use positional params ($1, $2, ...)
    const optArgs = args.length > 2 ? args.slice(2) : this.getPositionalArgs();

    const optind = parseInt(this.env.get('OPTIND') ?? '1', 10);
    const idx = optind - 1; // 0-based

    if (idx >= optArgs.length) {
      this.env.set(varName, '?');
      return { exitCode: 1, stdout: '', stderr: '', executionTimeMs: 0 };
    }

    const current = optArgs[idx];
    if (!current.startsWith('-') || current === '-' || current === '--') {
      this.env.set(varName, '?');
      return { exitCode: 1, stdout: '', stderr: '', executionTimeMs: 0 };
    }

    // Get the current character position within the option group
    let charPos = parseInt(this.env.get('_GETOPTS_CHARPOS') ?? '1', 10);
    const optChar = current[charPos];

    if (!optChar) {
      // Exhausted this arg group, move to next
      this.env.set('OPTIND', String(optind + 1));
      this.env.delete('_GETOPTS_CHARPOS');
      this.env.set(varName, '?');
      return { exitCode: 1, stdout: '', stderr: '', executionTimeMs: 0 };
    }

    const optPos = optstring.indexOf(optChar);
    if (optPos === -1) {
      // Unknown option
      const silent = optstring.startsWith(':');
      this.env.set(varName, '?');
      if (!silent) {
        // Advance position
        if (charPos + 1 < current.length) {
          this.env.set('_GETOPTS_CHARPOS', String(charPos + 1));
        } else {
          this.env.set('OPTIND', String(optind + 1));
          this.env.delete('_GETOPTS_CHARPOS');
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: `getopts: illegal option -- ${optChar}\n`,
          executionTimeMs: 0,
        };
      }
      this.env.set('OPTARG', optChar);
      if (charPos + 1 < current.length) {
        this.env.set('_GETOPTS_CHARPOS', String(charPos + 1));
      } else {
        this.env.set('OPTIND', String(optind + 1));
        this.env.delete('_GETOPTS_CHARPOS');
      }
      return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
    }

    const needsArg = optstring[optPos + 1] === ':';
    this.env.set(varName, optChar);

    if (needsArg) {
      // Check for argument attached to this option (e.g. -fVALUE)
      const remainder = current.slice(charPos + 1);
      if (remainder.length > 0) {
        this.env.set('OPTARG', remainder);
        this.env.set('OPTIND', String(optind + 1));
        this.env.delete('_GETOPTS_CHARPOS');
      } else if (idx + 1 < optArgs.length) {
        this.env.set('OPTARG', optArgs[idx + 1]);
        this.env.set('OPTIND', String(optind + 2));
        this.env.delete('_GETOPTS_CHARPOS');
      } else {
        // Missing argument
        const silent = optstring.startsWith(':');
        if (silent) {
          this.env.set(varName, ':');
          this.env.set('OPTARG', optChar);
        } else {
          this.env.set(varName, '?');
          return {
            exitCode: 0,
            stdout: '',
            stderr: `getopts: option requires an argument -- ${optChar}\n`,
            executionTimeMs: 0,
          };
        }
        this.env.set('OPTIND', String(optind + 1));
        this.env.delete('_GETOPTS_CHARPOS');
      }
    } else {
      // No argument needed — advance within option group or to next arg
      if (charPos + 1 < current.length) {
        this.env.set('_GETOPTS_CHARPOS', String(charPos + 1));
      } else {
        this.env.set('OPTIND', String(optind + 1));
        this.env.delete('_GETOPTS_CHARPOS');
      }
      this.env.delete('OPTARG');
    }

    return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
  }

  /** Builtin: which — locate a command by searching known tool names. */
  private builtinWhich(args: string[]): RunResult {
    let stdout = '';
    let exitCode = 0;
    for (const name of args) {
      if (this.mgr.hasTool(name) || PYTHON_COMMANDS.has(name) || SHELL_BUILTINS.has(name) || SHELL_COMMANDS.has(name) || this.extensionRegistry?.has(name)) {
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

  /** Emit an audit event if an audit handler is configured. */
  private audit(type: string, data?: Record<string, unknown>): void {
    if (this.auditHandler) this.auditHandler(type, data);
  }

  /** Builtin: source / . — execute commands from a file in the current shell. */
  private async builtinSource(args: string[]): Promise<RunResult> {
    if (args.length === 0) {
      return { exitCode: 2, stdout: '', stderr: 'source: filename argument required\n', executionTimeMs: 0 };
    }

    const filePath = this.resolvePath(args[0]);
    let content: Uint8Array;
    try {
      content = this.vfs.readFile(filePath);
    } catch {
      return { exitCode: 1, stdout: '', stderr: `source: ${args[0]}: No such file or directory\n`, executionTimeMs: 0 };
    }

    let script = new TextDecoder().decode(content);

    // Strip shebang line if present
    if (script.startsWith('#!')) {
      const nl = script.indexOf('\n');
      script = nl >= 0 ? script.slice(nl + 1) : '';
    }

    const extraArgs = args.slice(1);

    if (extraArgs.length > 0) {
      // Save and set positional parameters
      const savedPositionals: Map<string, string | undefined> = new Map();
      savedPositionals.set('#', this.env.get('#'));
      const prevCount = this.getPositionalArgs().length;
      for (let i = 0; i < Math.max(extraArgs.length, prevCount, 9); i++) {
        savedPositionals.set(String(i + 1), this.env.get(String(i + 1)));
      }
      for (let i = 0; i < extraArgs.length; i++) {
        this.env.set(String(i + 1), extraArgs[i]);
      }
      for (let i = extraArgs.length + 1; i <= prevCount; i++) {
        this.env.delete(String(i));
      }
      this.env.set('#', String(extraArgs.length));

      try {
        const result = await this.run(script);
        return result;
      } finally {
        // Restore positional parameters
        for (const [key, val] of savedPositionals) {
          if (val !== undefined) this.env.set(key, val);
          else this.env.delete(key);
        }
      }
    }

    // No extra args — just run in current shell
    return this.run(script);
  }

  /** Builtin: pip — package install/uninstall/list/show. */
  private builtinPip(args: string[]): RunResult {
    const sub = args[0];
    if (sub === '--help' || sub === '-h' || sub === undefined) {
      return {
        exitCode: 0,
        stdout: 'Usage: pip <command> [options]\n\nCommands:\n  install    Install packages\n  uninstall  Uninstall packages\n  list       List installed packages\n  show       Show package details\n',
        stderr: '',
        executionTimeMs: 0,
      };
    }

    if (sub === 'install') {
      const name = args[1];
      if (!name) {
        return { exitCode: 1, stdout: '', stderr: 'ERROR: You must give at least one requirement to install\n', executionTimeMs: 0 };
      }
      // Check extension registry first (backwards compat)
      const ext = this.extensionRegistry?.get(name);
      if (ext?.pythonPackage) {
        return { exitCode: 0, stdout: `Requirement already satisfied: ${name}\n`, stderr: '', executionTimeMs: 0 };
      }
      // Check if already installed from PackageRegistry
      if (this.installedPackages.has(name)) {
        return { exitCode: 0, stdout: `Requirement already satisfied: ${name}\n`, stderr: '', executionTimeMs: 0 };
      }
      // Try to install from PackageRegistry
      if (this.packageRegistry?.has(name)) {
        const toInstall = this.packageRegistry.resolveDeps(name);
        const newlyInstalled: string[] = [];
        this.vfs.withWriteAccess(() => {
          for (const depName of toInstall) {
            if (this.installedPackages.has(depName)) continue;
            const meta = this.packageRegistry!.get(depName)!;
            for (const [relPath, content] of Object.entries(meta.pythonFiles)) {
              const fullPath = `/usr/lib/python/${relPath}`;
              const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
              this.vfs.mkdirp(dir);
              this.vfs.writeFile(fullPath, new TextEncoder().encode(content));
            }
            this.installedPackages.add(depName);
            newlyInstalled.push(`${depName}-${meta.version}`);
          }
        });
        return { exitCode: 0, stdout: `Successfully installed ${newlyInstalled.join(' ')}\n`, stderr: '', executionTimeMs: 0 };
      }
      // Not found anywhere
      return {
        exitCode: 1,
        stdout: '',
        stderr: `ERROR: Could not find a version that satisfies the requirement ${name} (not found in sandbox registry)\nAvailable packages: ${this.packageRegistry?.available().join(', ') ?? ''}\n`,
        executionTimeMs: 0,
      };
    }

    if (sub === 'uninstall') {
      const name = args[1];
      if (!name) {
        return { exitCode: 1, stdout: '', stderr: 'ERROR: You must give at least one requirement to uninstall\n', executionTimeMs: 0 };
      }
      if (!this.installedPackages.has(name)) {
        return { exitCode: 1, stdout: '', stderr: `WARNING: Skipping ${name} as it is not installed\n`, executionTimeMs: 0 };
      }
      const meta = this.packageRegistry?.get(name);
      if (meta) {
        this.vfs.withWriteAccess(() => {
          for (const relPath of Object.keys(meta.pythonFiles)) {
            try { this.vfs.unlink(`/usr/lib/python/${relPath}`); } catch {}
          }
          try { this.vfs.rmdir(`/usr/lib/python/${name}`); } catch {}
        });
      }
      this.installedPackages.delete(name);
      return { exitCode: 0, stdout: `Successfully uninstalled ${name}\n`, stderr: '', executionTimeMs: 0 };
    }

    if (sub === 'list') {
      let out = 'Package         Version\n--------------- -------\n';
      // Show packages from PackageRegistry that are installed
      for (const name of [...this.installedPackages].sort()) {
        const meta = this.packageRegistry?.get(name);
        if (meta) {
          out += `${name.padEnd(16)}${meta.version}\n`;
        }
      }
      // Show extension packages (backwards compat)
      const extNames = this.extensionRegistry?.getPackageNames() ?? [];
      for (const name of extNames) {
        if (!this.installedPackages.has(name)) {
          const ext = this.extensionRegistry!.get(name)!;
          out += `${name.padEnd(16)}${ext.pythonPackage!.version}\n`;
        }
      }
      return { exitCode: 0, stdout: out, stderr: '', executionTimeMs: 0 };
    }

    if (sub === 'show') {
      const name = args[1];
      if (!name) {
        return { exitCode: 1, stdout: '', stderr: 'ERROR: Please provide a package name\n', executionTimeMs: 0 };
      }
      // Check PackageRegistry first
      const meta = this.packageRegistry?.get(name);
      if (meta) {
        const installed = this.installedPackages.has(name);
        let out = `Name: ${meta.name}\nVersion: ${meta.version}\nSummary: ${meta.summary}\n`;
        out += `Status: ${installed ? 'installed' : 'available'}\nLocation: /usr/lib/python\n`;
        if (meta.dependencies.length > 0) out += `Requires: ${meta.dependencies.join(', ')}\n`;
        return { exitCode: 0, stdout: out, stderr: '', executionTimeMs: 0 };
      }
      // Check extension registry (backwards compat)
      const ext = this.extensionRegistry?.get(name);
      if (ext?.pythonPackage) {
        const pkg = ext.pythonPackage;
        const files = Object.keys(pkg.files);
        let out = `Name: ${name}\nVersion: ${pkg.version}\n`;
        if (pkg.summary) out += `Summary: ${pkg.summary}\n`;
        out += `Location: /usr/lib/python\nFiles:\n`;
        for (const f of files) out += `  ${name}/${f}\n`;
        return { exitCode: 0, stdout: out, stderr: '', executionTimeMs: 0 };
      }
      return { exitCode: 1, stdout: '', stderr: `WARNING: Package(s) not found: ${name}\n`, executionTimeMs: 0 };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `ERROR: unknown command "${sub}"\n`,
      executionTimeMs: 0,
    };
  }

  /** Builtin: history — list or clear command history. */
  private builtinHistory(args: string[]): RunResult {
    const sub = args[0] ?? 'list';

    if (sub === 'clear') {
      this.history.clear();
      return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
    }

    if (sub === 'list') {
      const entries = this.history.list();
      const lines = entries.map(e => `  ${e.index}  ${e.command}`);
      return { exitCode: 0, stdout: lines.join('\n') + (lines.length > 0 ? '\n' : ''), stderr: '', executionTimeMs: 0 };
    }

    return { exitCode: 1, stdout: '', stderr: `history: unknown subcommand: ${sub}\n`, executionTimeMs: 0 };
  }

  /** Return the command history entries. */
  getHistory(): HistoryEntry[] {
    return this.history.list();
  }

  /** Clear the command history. */
  clearHistory(): void {
    this.history.clear();
  }

  /** Builtin: pkg — manage WASI binary packages. */
  private async builtinPkg(args: string[]): Promise<RunResult> {
    const sub = args[0];

    if (!sub) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'usage: pkg <install|remove|list|info> [args...]\n',
        executionTimeMs: 0,
      };
    }

    if (!this.packageManager) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'pkg: package manager is disabled\n',
        executionTimeMs: 0,
      };
    }

    const encoder = new TextEncoder();

    if (sub === 'install') {
      return this.builtinPkgInstall(args.slice(1), encoder);
    } else if (sub === 'remove') {
      return this.builtinPkgRemove(args.slice(1));
    } else if (sub === 'list') {
      return this.builtinPkgList();
    } else if (sub === 'info') {
      return this.builtinPkgInfo(args.slice(1));
    } else {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `pkg: unknown subcommand '${sub}'\n`,
        executionTimeMs: 0,
      };
    }
  }

  /** Builtin: pkg install <url> [--name <name>] */
  private async builtinPkgInstall(args: string[], encoder: TextEncoder): Promise<RunResult> {
    let url: string | undefined;
    let name: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--name' && i + 1 < args.length) {
        name = args[++i];
      } else if (!arg.startsWith('-')) {
        url = arg;
      }
    }

    if (!url) {
      return { exitCode: 1, stdout: '', stderr: 'pkg install: no URL specified\n', executionTimeMs: 0 };
    }

    // Derive name from URL filename without .wasm extension
    if (!name) {
      const filename = url.split('/').pop() ?? '';
      name = filename.endsWith('.wasm') ? filename.slice(0, -5) : filename;
    }
    if (!name) {
      return { exitCode: 1, stdout: '', stderr: 'pkg install: could not derive package name from URL\n', executionTimeMs: 0 };
    }

    // Reject invalid package names (path traversal, empty, dots-only)
    if (name === '' || name === '.' || name === '..' || name.includes('/')) {
      return { exitCode: 1, stdout: '', stderr: `pkg install: invalid package name '${name}'\n`, executionTimeMs: 0 };
    }

    // Check host against policy BEFORE fetching (to emit audit event early)
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return { exitCode: 1, stdout: '', stderr: `pkg install: invalid URL '${url}'\n`, executionTimeMs: 0 };
    }

    this.audit('package.install.start', { name, url, host });

    // Check host against policy BEFORE fetching
    try {
      this.packageManager!.checkHost(url);
    } catch (err) {
      if (err instanceof PkgError) {
        this.audit('package.install.denied', { name, url, host, reason: err.message, code: err.code });
        return { exitCode: 1, stdout: '', stderr: `pkg install: ${err.message}\n`, executionTimeMs: 0 };
      }
      throw err;
    }

    try {
      // Fetch the WASM binary
      const response = await (this.gateway?.fetch(url) ?? globalThis.fetch(url));
      if (!response.ok) {
        this.audit('package.install.denied', { name, url, host, reason: `HTTP ${response.status}` });
        return { exitCode: 1, stdout: '', stderr: `pkg install: fetch failed with HTTP ${response.status}\n`, executionTimeMs: 0 };
      }

      const arrayBuf = await NetworkGateway.readResponseArrayBuffer(response);
      if (arrayBuf === null) {
        this.audit('package.install.denied', { name, url, host, reason: 'response too large' });
        return { exitCode: 1, stdout: '', stderr: 'pkg install: response body too large\n', executionTimeMs: 0 };
      }
      const wasmBytes = new Uint8Array(arrayBuf);

      // Install via PackageManager (validates host, size, count limits)
      this.packageManager!.install(name, wasmBytes, url);

      // Register with ProcessManager so the tool can be spawned
      const wasmPath = this.packageManager!.getWasmPath(name)!;
      this.mgr.registerTool(name, wasmPath);

      // Write a stub to /bin so `which` and `ls /bin` see it
      this.vfs.withWriteAccess(() => {
        this.vfs.writeFile('/bin/' + name, encoder.encode('#!/bin/codepod\n# ' + name + '\n'));
        try {
          this.vfs.chmod('/bin/' + name, 0o755);
        } catch { /* ignore */ }
      });

      this.audit('package.install.complete', { name, url, host, size: wasmBytes.byteLength });

      return {
        exitCode: 0,
        stdout: `installed ${name} (${wasmBytes.byteLength} bytes) from ${url}\n`,
        stderr: '',
        executionTimeMs: 0,
      };
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      const reason = err instanceof PkgError ? err.message : (err instanceof Error ? err.message : String(err));
      const code = err instanceof PkgError ? err.code : 'E_PKG_FETCH';
      this.audit('package.install.denied', { name, url, host, reason, code });
      return { exitCode: 1, stdout: '', stderr: `pkg install: ${reason}\n`, executionTimeMs: 0 };
    }
  }

  /** Builtin: pkg remove <name> */
  private async builtinPkgRemove(args: string[]): Promise<RunResult> {
    const name = args[0];
    if (!name) {
      return { exitCode: 1, stdout: '', stderr: 'pkg remove: no package name specified\n', executionTimeMs: 0 };
    }

    try {
      this.packageManager!.remove(name);
      this.audit('package.remove', { name });
      return { exitCode: 0, stdout: `removed ${name}\n`, stderr: '', executionTimeMs: 0 };
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      const reason = err instanceof PkgError ? err.message : (err instanceof Error ? err.message : String(err));
      return { exitCode: 1, stdout: '', stderr: `pkg remove: ${reason}\n`, executionTimeMs: 0 };
    }
  }

  /** Builtin: pkg list */
  private builtinPkgList(): RunResult {
    const packages = this.packageManager!.list();
    if (packages.length === 0) {
      return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
    }
    const lines = packages.map(p => `${p.name}\t${p.size}\t${p.url}`).join('\n') + '\n';
    return { exitCode: 0, stdout: lines, stderr: '', executionTimeMs: 0 };
  }

  /** Builtin: pkg info <name> */
  private builtinPkgInfo(args: string[]): RunResult {
    const name = args[0];
    if (!name) {
      return { exitCode: 1, stdout: '', stderr: 'pkg info: no package name specified\n', executionTimeMs: 0 };
    }

    const info = this.packageManager!.info(name);
    if (!info) {
      return { exitCode: 1, stdout: '', stderr: `pkg info: package '${name}' not found\n`, executionTimeMs: 0 };
    }

    const out = [
      `Name: ${info.name}`,
      `URL: ${info.url}`,
      `Size: ${info.size}`,
      `Installed: ${new Date(info.installedAt).toISOString()}`,
    ].join('\n') + '\n';

    return { exitCode: 0, stdout: out, stderr: '', executionTimeMs: 0 };
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

      const body = await NetworkGateway.readResponseBody(response);
      if (outputFile) {
        this.vfs.writeFile(outputFile, new TextEncoder().encode(body));
        return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
      }
      return { exitCode: 0, stdout: body, stderr: '', executionTimeMs: 0 };
    } catch (err) {
      if (err instanceof CancelledError) throw err;
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
      const body = await NetworkGateway.readResponseBody(response);

      if (toStdout) return { exitCode: 0, stdout: body, stderr: '', executionTimeMs: 0 };

      const destPath = outputFile ?? this.resolvePath(url.split('/').pop() || 'index.html');
      this.vfs.writeFile(destPath, new TextEncoder().encode(body));
      const stderr = quiet ? '' : `saved to ${destPath}\n`;
      return { exitCode: 0, stdout: '', stderr, executionTimeMs: 0 };
    } catch (err) {
      if (err instanceof CancelledError) throw err;
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

/**
 * Safe arithmetic evaluator using recursive descent.
 * Supports: +, -, *, /, %, parentheses, comparisons (==, !=, <, >, <=, >=).
 */
function safeEvalArithmetic(expr: string): number {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === ' ' || expr[i] === '\t') { i++; continue; }
    if ('0123456789'.includes(expr[i])) {
      let num = '';
      while (i < expr.length && '0123456789'.includes(expr[i])) { num += expr[i++]; }
      tokens.push(num);
    } else if ('+-*/%()'.includes(expr[i])) {
      tokens.push(expr[i++]);
    } else if (expr[i] === '<' || expr[i] === '>' || expr[i] === '=' || expr[i] === '!') {
      let op = expr[i++];
      if (i < expr.length && expr[i] === '=') { op += expr[i++]; }
      tokens.push(op);
    } else {
      i++; // skip unknown
    }
  }
  let pos = 0;
  function peek(): string | undefined { return tokens[pos]; }
  function next(): string { return tokens[pos++]; }
  function parseExpr(): number { return parseComparison(); }
  function parseComparison(): number {
    let left = parseAddSub();
    while (peek() === '==' || peek() === '!=' || peek() === '<' || peek() === '>' || peek() === '<=' || peek() === '>=') {
      const op = next();
      const right = parseAddSub();
      switch (op) {
        case '==': left = left === right ? 1 : 0; break;
        case '!=': left = left !== right ? 1 : 0; break;
        case '<': left = left < right ? 1 : 0; break;
        case '>': left = left > right ? 1 : 0; break;
        case '<=': left = left <= right ? 1 : 0; break;
        case '>=': left = left >= right ? 1 : 0; break;
      }
    }
    return left;
  }
  function parseAddSub(): number {
    let left = parseMulDiv();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const right = parseMulDiv();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function parseMulDiv(): number {
    let left = parseUnary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const right = parseUnary();
      if (op === '*') left = left * right;
      else if (op === '/') left = right !== 0 ? Math.trunc(left / right) : 0;
      else left = right !== 0 ? left % right : 0;
    }
    return left;
  }
  function parseUnary(): number {
    if (peek() === '-') { next(); return -parsePrimary(); }
    if (peek() === '+') { next(); return parsePrimary(); }
    return parsePrimary();
  }
  function parsePrimary(): number {
    if (peek() === '(') {
      next(); // skip (
      const val = parseExpr();
      if (peek() === ')') next();
      return val;
    }
    const tok = next();
    return tok !== undefined ? parseInt(tok, 10) || 0 : 0;
  }
  return parseExpr();
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}
