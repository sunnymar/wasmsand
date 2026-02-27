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
import { NetworkGateway } from '../network/gateway.js';
import { CancelledError } from '../security.js';
import type { PackageManager } from '../pkg/manager.js';
import { CommandHistory } from './history.js';
import type { HistoryEntry } from './history.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import { PackageRegistry } from '../packages/registry.js';
import {
  parseShebang,
  normalizePath,
  safeEvalArithmetic,
  concatBytes,
} from './shell-utils.js';

import {
  PYTHON_COMMANDS,
  SHELL_BUILTINS,
  SHELL_COMMANDS,
  PYTHON_INTERPRETERS,
  MAX_SUBSTITUTION_DEPTH,
  MAX_FUNCTION_DEPTH,
  EMPTY_RESULT,
  BreakSignal,
  ContinueSignal,
  ReturnSignal,
  ExitSignal,
} from './shell-types.js';

import type {
  Word,
  WordPart,
  Redirect,
  RedirectType,
  Command,
  ListOp,
  CaseItem,
  Assignment,
  RunResult,
} from './shell-types.js';

import { ShellBuiltins } from './shell-builtins.js';

export type { RunResult } from './shell-types.js';

export class ShellRunner extends ShellBuiltins {
  protected vfs: VfsLike;
  protected mgr: ProcessManager;
  private adapter: PlatformAdapter;
  private shellWasmPath: string;
  private shellModule: WebAssembly.Module | null = null;
  private pythonRunner: PythonRunner | null = null;
  protected gateway: NetworkGateway | null = null;
  protected env: Map<string, string> = new Map();
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
  protected lastExitCode = 0;
  /** User-defined shell functions. */
  private functions: Map<string, Command> = new Map();
  /** Stack of saved local variable values for each function call. */
  private localVarStack: Map<string, string | undefined>[] = [];
  /** Package manager for the pkg builtin. */
  protected packageManager: PackageManager | null = null;
  /** Audit event handler for emitting structured audit events. */
  protected auditHandler: ((type: string, data?: Record<string, unknown>) => void) | null = null;
  /** Command history tracker. */
  protected history = new CommandHistory();
  /** Host-provided extension registry for custom commands/packages. */
  protected extensionRegistry: ExtensionRegistry | null = null;
  /** Optional allowlist of tool names permitted by security policy. */
  private toolAllowlist: Set<string> | null = null;
  /** Shell option flags (e=errexit, u=nounset). */
  private shellFlags = new Set<string>();
  /** Trap handlers (e.g. EXIT trap). */
  protected trapHandlers: Map<string, string> = new Map();
  /** Variables marked as readonly. */
  private readonlyVars = new Set<string>();
  /** Time when the shell was started (for $SECONDS). */
  private startTime = performance.now();
  /** Current line number for $LINENO. */
  private currentLineNo = 1;
  /** Array storage for bash-style arrays. */
  protected arrays: Map<string, string[]> = new Map();
  /** Associative array storage (declare -A). */
  protected assocArrays: Map<string, Map<string, string>> = new Map();
  /** Whether we're in a conditional context (if condition, || / && chains). */
  private inConditionalContext = false;
  /** Pipe stdin data threaded through compound commands (while, for, if, subshell). */
  protected pipeStdin: Uint8Array | undefined;
  /** Sandbox-native package registry for pip install/uninstall at runtime. */
  protected packageRegistry: PackageRegistry | null = null;
  /** Set of package names currently installed from PackageRegistry. */
  protected installedPackages = new Set<string>();

  constructor(
    vfs: VfsLike,
    mgr: ProcessManager,
    adapter: PlatformAdapter,
    shellWasmPath: string,
    gateway?: NetworkGateway,
    options?: { skipPopulateBin?: boolean },
  ) {
    super();
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
  protected resolvePath(path: string): string {
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

  // Commands whose first positional arg is a regex/pattern, not a file path.
  // For these, skip path resolution on the first non-flag positional argument.
  private static readonly PATTERN_COMMANDS = new Set([
    'grep', 'sed', 'awk', 'rg',
  ]);

  /**
   * Resolve command args, but for PATTERN_COMMANDS skip resolution of
   * the first positional (non-flag) argument (the regex/script pattern).
   */
  private static resolveCommandArgs(
    cmdName: string,
    args: string[],
    resolve: (a: string) => string,
  ): string[] {
    if (!ShellRunner.PATTERN_COMMANDS.has(cmdName)) {
      return args.map(resolve);
    }
    // Find the first positional arg (not a flag) — that's the pattern.
    const patIdx = args.findIndex(a => !a.startsWith('-'));
    return args.map((a, i) => (i === patIdx ? a : resolve(a)));
  }

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
  protected async parse(command: string): Promise<Command | null> {
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

  protected async execCommand(cmd: Command): Promise<RunResult> {
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
    if ('CFor' in cmd) {
      return this.execCFor(
        (cmd as { CFor: { init: string; cond: string; step: string; body: Command } }).CFor,
      );
    }
    if ('Subshell' in cmd) {
      const savedEnv = new Map(this.env);
      const result = await this.execCommand(cmd.Subshell.body);
      this.env = savedEnv;
      return result;
    }
    if ('BraceGroup' in cmd) {
      return this.execCommand(
        (cmd as { BraceGroup: { body: Command } }).BraceGroup.body,
      );
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
    if ('DoubleBracket' in cmd) {
      const expr = (cmd as { DoubleBracket: { expr: string } }).DoubleBracket.expr;
      const result = await this.evalDoubleBracket(expr);
      return { exitCode: result ? 0 : 1, stdout: '', stderr: '', executionTimeMs: 0 };
    }
    if ('ArithmeticCommand' in cmd) {
      const expr = (cmd as { ArithmeticCommand: { expr: string } }).ArithmeticCommand.expr;
      const val = this.evalArithmetic(expr);
      return { exitCode: val !== 0 ? 0 : 1, stdout: '', stderr: '', executionTimeMs: 0 };
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
      const baseName = assignment.name.endsWith('+') ? assignment.name.slice(0, -1) : assignment.name.replace(/\[.*\]$/, '');
      if (this.readonlyVars.has(baseName)) {
        return { exitCode: 1, stdout: '', stderr: `bash: ${baseName}: readonly variable\n`, executionTimeMs: 0 };
      }
      const value = await this.expandAssignmentValue(assignment.value);
      // Append assignment: name ends with "+" (e.g. VAR+=value, arr+=(elem))
      if (assignment.name.endsWith('+')) {
        const realName = assignment.name.slice(0, -1);
        if (value.startsWith('(') && value.endsWith(')')) {
          // Array append: arr+=(elem1 elem2)
          const inner = value.slice(1, -1).trim();
          const elements = inner.length > 0 ? inner.split(/\s+/) : [];
          const arr = this.arrays.get(realName) ?? [];
          arr.push(...elements);
          this.arrays.set(realName, arr);
        } else {
          // String append: var+=string
          const prev = this.env.get(realName) ?? '';
          this.env.set(realName, prev + value);
        }
        continue;
      }
      // Array element assignment: arr[idx]=value or assoc[key]=value
      const arrAssignMatch = assignment.name.match(/^(\w+)\[(.+)\]$/);
      if (arrAssignMatch) {
        const arrName = arrAssignMatch[1];
        const subscript = arrAssignMatch[2];
        const assoc = this.assocArrays.get(arrName);
        if (assoc) {
          assoc.set(subscript, value);
        } else {
          const idx = parseInt(subscript, 10);
          if (!isNaN(idx)) {
            if (!this.arrays.has(arrName)) this.arrays.set(arrName, []);
            const arr = this.arrays.get(arrName)!;
            while (arr.length <= idx) arr.push('');
            arr[idx] = value;
          }
        }
      } else if (value.startsWith('(') && value.endsWith(')')) {
        // Detect array assignment: value is "(elem1 elem2 ...)"
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
      } else if (typeof rt === 'object' && 'HereString' in rt) {
        const expanded = await this.expandAssignmentValue(rt.HereString);
        stdinData = new TextEncoder().encode(expanded + '\n');
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
        for (let si = 0; si < args.length; si++) {
          const arg = args[si];
          if (arg === '-o' && si + 1 < args.length) {
            this.shellFlags.add('o:' + args[++si]);
          } else if (arg === '+o' && si + 1 < args.length) {
            this.shellFlags.delete('o:' + args[++si]);
          } else if (arg.startsWith('-')) {
            for (const ch of arg.slice(1)) {
              if (ch === 'o' && si + 1 < args.length) {
                this.shellFlags.add('o:' + args[++si]);
                break;
              }
              this.shellFlags.add(ch);
            }
          } else if (arg.startsWith('+')) {
            for (const ch of arg.slice(1)) {
              if (ch === 'o' && si + 1 < args.length) {
                this.shellFlags.delete('o:' + args[++si]);
                break;
              }
              this.shellFlags.delete(ch);
            }
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
    } else if (cmdName === 'exec') {
      // exec with a command: run it and adopt its exit code
      if (args.length > 0) {
        // Re-dispatch the command (not as exec — just run it directly)
        const execWords: Word[] = args.map(a => ({ parts: [{ Literal: a }] }));
        const execCmd: Command = { Simple: { words: execWords, redirects: simple.redirects, assignments: [] } };
        result = await this.execCommand(execCmd);
      } else {
        // exec with no command but possibly redirects — redirects already applied above
        result = { ...EMPTY_RESULT };
      }
    } else if (cmdName === 'readonly') {
      // readonly VAR=value or readonly VAR
      for (const arg of args) {
        const eqIdx = arg.indexOf('=');
        if (eqIdx !== -1) {
          const name = arg.slice(0, eqIdx);
          const value = arg.slice(eqIdx + 1);
          this.env.set(name, value);
          this.readonlyVars.add(name);
        } else {
          this.readonlyVars.add(arg);
        }
      }
      result = { ...EMPTY_RESULT };
    } else if (cmdName === 'trap') {
      result = this.builtinTrap(args);
    } else if (cmdName === 'declare' || cmdName === 'typeset') {
      result = this.builtinDeclare(args);
    } else if (cmdName === 'shift') {
      const n = args.length > 0 ? parseInt(args[0], 10) || 1 : 1;
      const positionals = this.getPositionalArgs();
      const remaining = positionals.slice(n);
      // Clear old positional params
      for (let pi = 1; pi <= positionals.length; pi++) this.env.delete(String(pi));
      // Set new ones
      for (let pi = 0; pi < remaining.length; pi++) this.env.set(String(pi + 1), remaining[pi]);
      this.env.set('#', String(remaining.length));
      result = { ...EMPTY_RESULT };
    } else if (cmdName === 'type') {
      let stdout = '';
      let exitCode = 0;
      for (const name of args) {
        if (SHELL_BUILTINS.has(name)) {
          stdout += `${name} is a shell builtin\n`;
        } else if (this.functions.get(name)) {
          stdout += `${name} is a function\n`;
        } else if (this.mgr.hasTool(name)) {
          stdout += `${name} is /usr/bin/${name}\n`;
        } else {
          stdout += `bash: type: ${name}: not found\n`;
          exitCode = 1;
        }
      }
      result = { exitCode, stdout, stderr: '', executionTimeMs: 0 };
    } else if (cmdName === 'command') {
      // command [-v] name — run command bypassing functions, or -v to check existence
      if (args.length > 0 && args[0] === '-v') {
        let stdout = '';
        let exitCode = 0;
        for (const name of args.slice(1)) {
          if (SHELL_BUILTINS.has(name)) {
            stdout += `${name}\n`;
          } else if (this.mgr.hasTool(name)) {
            stdout += `/usr/bin/${name}\n`;
          } else {
            exitCode = 1;
          }
        }
        result = { exitCode, stdout, stderr: '', executionTimeMs: 0 };
      }
      // Without -v, fall through to normal command execution (bypasses functions)
    } else if (cmdName === 'let') {
      let exitCode = 0;
      for (const expr of args) {
        const val = this.evalArithmetic(expr);
        exitCode = val === 0 ? 1 : 0;
      }
      result = { exitCode, stdout: '', stderr: '', executionTimeMs: 0 };
    } else if (cmdName === 'printf') {
      // Handle printf -v (assign to variable) as builtin
      if (args.length >= 3 && args[0] === '-v') {
        const varName = args[1];
        const output = this.formatPrintf(args.slice(2));
        this.env.set(varName, output);
        result = { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
      }
      // Without -v, fall through to external printf tool
    } else if (cmdName === 'mapfile' || cmdName === 'readarray') {
      result = this.builtinMapfile(args, stdinData);
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
    const pipefail = this.shellFlags.has('o:pipefail');
    let pipefailCode = 0;

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

      // Track non-zero exit codes for pipefail
      if (pipefail && lastResult.exitCode !== 0) {
        pipefailCode = lastResult.exitCode;
      }

      stdinData = encoder.encode(lastResult.stdout);
    }

    // With pipefail, use the last non-zero exit code from any stage
    if (pipefail && pipefailCode !== 0 && lastResult.exitCode === 0) {
      lastResult = { ...lastResult, exitCode: pipefailCode };
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

  private async execCFor(cfor: {
    init: string;
    cond: string;
    step: string;
    body: Command;
  }): Promise<RunResult> {
    // Evaluate init expression
    if (cfor.init) {
      this.evalArithmetic(cfor.init);
    }

    let combinedStdout = '';
    let combinedStderr = '';
    let lastExitCode = 0;
    let totalTime = 0;
    const MAX_ITERATIONS = 100_000;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // Evaluate condition — empty condition means infinite loop (like C)
      if (cfor.cond) {
        const condVal = this.evalArithmetic(cfor.cond);
        if (condVal === 0) break; // 0 = false in C arithmetic
      }

      try {
        const result = await this.execCommand(cfor.body);
        combinedStdout += result.stdout;
        combinedStderr += result.stderr;
        lastExitCode = result.exitCode;
        totalTime += result.executionTimeMs;
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) {
          // fall through to step
        } else {
          throw e;
        }
      }

      // Evaluate step expression
      if (cfor.step) {
        this.evalArithmetic(cfor.step);
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
      if (part.Variable === 'SECONDS') {
        return String(Math.floor((performance.now() - this.startTime) / 1000));
      }
      if (part.Variable === 'LINENO') {
        return String(this.currentLineNo);
      }
      // Array access: arr[n], arr[@], arr[*], and slicing arr[@]:offset:length
      const arrSliceMatch = part.Variable.match(/^(\w+)\[(.+?)\]:(.+)$/);
      if (arrSliceMatch) {
        const arrName = arrSliceMatch[1];
        const subscript = arrSliceMatch[2];
        const sliceSpec = arrSliceMatch[3];
        if (subscript === '@' || subscript === '*') {
          const arr = this.arrays.get(arrName);
          if (arr) {
            const parts = sliceSpec.split(':');
            let offset = parseInt(parts[0], 10) || 0;
            if (offset < 0) offset = Math.max(0, arr.length + offset);
            if (parts.length > 1) {
              const length = parseInt(parts[1], 10);
              return arr.slice(offset, offset + length).join(' ');
            }
            return arr.slice(offset).join(' ');
          }
        }
        return '';
      }
      const arrMatch = part.Variable.match(/^(\w+)\[(.+)\]$/);
      if (arrMatch) {
        const arrName = arrMatch[1];
        const index = arrMatch[2];
        // Check associative arrays first
        const assoc = this.assocArrays.get(arrName);
        if (assoc) {
          if (index === '@' || index === '*') {
            return Array.from(assoc.values()).join(' ');
          }
          return assoc.get(index) ?? '';
        }
        const arr = this.arrays.get(arrName);
        if (arr) {
          if (index === '@' || index === '*') {
            return arr.join(' ');
          }
          let idx = parseInt(index, 10);
          if (!isNaN(idx)) {
            if (idx < 0) idx = arr.length + idx;
            if (idx >= 0 && idx < arr.length) {
              return arr[idx];
            }
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
              const assoc = this.assocArrays.get(arrLenMatch[1]);
              if (assoc) return String(assoc.size);
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
          // Array slicing: ${arr[@]:offset:length}
          const arrSlice = name.match(/^(\w+)\[[@*]\]$/);
          if (arrSlice) {
            const arr = this.arrays.get(arrSlice[1]);
            if (arr) {
              const parts = operand.split(':');
              let offset = parseInt(parts[0], 10) || 0;
              if (offset < 0) offset = Math.max(0, arr.length + offset);
              if (parts.length > 1) {
                const length = parseInt(parts[1], 10);
                return arr.slice(offset, offset + length).join(' ');
              }
              return arr.slice(offset).join(' ');
            }
            return '';
          }
          const s = val ?? '';
          const parts = operand.split(':');
          let offset = parseInt(parts[0], 10) || 0;
          // Negative offset: count from end of string
          if (offset < 0) offset = Math.max(0, s.length + offset);
          if (parts.length > 1) {
            const length = parseInt(parts[1], 10);
            if (length < 0) {
              // Negative length: end position counted from end
              const endPos = Math.max(0, s.length + length);
              return s.slice(offset, endPos);
            }
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
  protected getPositionalArgs(): string[] {
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
      const resolvedArgs = ShellRunner.resolveCommandArgs(cmdName, args, a => this.resolveArgIfPath(cmdName, a));
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

    // When stdin data is provided but no -c or script file argument,
    // write to a temp file so Python runs in script mode (not REPL).
    let tempScript: string | undefined;
    if (stdinData && stdinData.length > 0 && !args.includes('-c') &&
        (args.length === 0 || args[0].startsWith('-'))) {
      tempScript = `/tmp/_py_stdin_${Date.now()}.py`;
      this.vfs.withWriteAccess(() => this.vfs.writeFile(tempScript!, stdinData!));
      args = [tempScript, ...args];
      stdinData = undefined;
    }

    const result = await this.pythonRunner.run({
      args,
      env: Object.fromEntries(this.env),
      stdinData,
      cwd: this.env.get('PWD'),
      stdoutLimit: this.stdoutLimit,
      stderrLimit: this.stderrLimit,
      deadlineMs: this.deadlineMs,
    });

    if (tempScript) {
      try { this.vfs.withWriteAccess(() => this.vfs.unlink(tempScript!)); } catch {}
    }

    return result;
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
          result += this.resolveAssignmentVar(varName);
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

  /** Simple printf format string processor for -v flag. */
  private formatPrintf(args: string[]): string {
    if (args.length === 0) return '';
    const fmt = args[0];
    const fmtArgs = args.slice(1);
    let result = '';
    let argIdx = 0;
    let i = 0;
    while (i < fmt.length) {
      if (fmt[i] === '\\') {
        i++;
        if (i < fmt.length) {
          switch (fmt[i]) {
            case 'n': result += '\n'; break;
            case 't': result += '\t'; break;
            case '\\': result += '\\'; break;
            case '0': result += '\0'; break;
            default: result += '\\' + fmt[i];
          }
          i++;
        }
      } else if (fmt[i] === '%') {
        i++;
        if (i >= fmt.length) break;
        if (fmt[i] === '%') { result += '%'; i++; continue; }
        // Skip flags, width, precision
        while (i < fmt.length && '-+ 0#'.includes(fmt[i])) i++;
        while (i < fmt.length && /\d/.test(fmt[i])) i++;
        if (i < fmt.length && fmt[i] === '.') { i++; while (i < fmt.length && /\d/.test(fmt[i])) i++; }
        const spec = i < fmt.length ? fmt[i] : '';
        i++;
        const arg = argIdx < fmtArgs.length ? fmtArgs[argIdx++] : '';
        switch (spec) {
          case 's': result += arg; break;
          case 'd': case 'i': result += String(parseInt(arg) || 0); break;
          case 'f': result += String(parseFloat(arg) || 0); break;
          case 'x': result += (parseInt(arg) || 0).toString(16); break;
          case 'X': result += (parseInt(arg) || 0).toString(16).toUpperCase(); break;
          case 'o': result += (parseInt(arg) || 0).toString(8); break;
          case 'c': result += arg.charAt(0); break;
          default: result += arg;
        }
      } else {
        result += fmt[i++];
      }
    }
    return result;
  }

  /** Resolve a variable name from assignment context, supporting arrays and assoc arrays. */
  private resolveAssignmentVar(varName: string): string {
    const arrMatch = varName.match(/^(\w+)\[(.+)\]$/);
    if (arrMatch) {
      const name = arrMatch[1];
      const idx = arrMatch[2];
      const assoc = this.assocArrays.get(name);
      if (assoc) {
        if (idx === '@' || idx === '*') return Array.from(assoc.values()).join(' ');
        return assoc.get(idx) ?? '';
      }
      const arr = this.arrays.get(name);
      if (arr) {
        if (idx === '@' || idx === '*') return arr.join(' ');
        const n = parseInt(idx, 10);
        if (!isNaN(n) && n >= 0 && n < arr.length) return arr[n];
        return '';
      }
      return '';
    }
    return this.env.get(varName) ?? '';
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
   * Supports * (any sequence), ? (any single char), and ** (recursive).
   * Pattern may be absolute (/tmp/*.txt) or relative (*.txt).
   */
  private globMatch(pattern: string): string[] {
    // If pattern contains **, use recursive matching
    if (pattern.includes('**')) {
      return this.globMatchRecursive(pattern);
    }

    // Split into directory part and filename pattern
    const lastSlash = pattern.lastIndexOf('/');
    let dirPath: string;
    let filePattern: string;

    if (lastSlash >= 0) {
      dirPath = pattern.slice(0, lastSlash) || '/';
      filePattern = pattern.slice(lastSlash + 1);
    } else {
      dirPath = this.env.get('PWD') || '/';
      filePattern = pattern;
    }

    const regex = this.fileGlobToRegex(filePattern);

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

  /** Convert a simple file glob (no path separators) to a RegExp. */
  private fileGlobToRegex(pat: string): RegExp {
    const regexStr = '^' + pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      + '$';
    return new RegExp(regexStr);
  }

  /**
   * Recursive glob matching for patterns containing **.
   * ** matches zero or more directory levels.
   */
  private globMatchRecursive(pattern: string): string[] {
    const pwd = this.env.get('PWD') || '/';
    const isAbsolute = pattern.startsWith('/');

    // Determine the fixed prefix before the first glob segment
    const segments = pattern.split('/').filter(s => s !== '');
    let fixedPrefixSegments: string[] = [];
    let globSegments: string[] = [];
    let hitGlob = false;
    for (const seg of segments) {
      if (!hitGlob && !seg.includes('*') && !seg.includes('?')) {
        fixedPrefixSegments.push(seg);
      } else {
        hitGlob = true;
        globSegments.push(seg);
      }
    }

    const baseDir = isAbsolute
      ? (fixedPrefixSegments.length > 0 ? '/' + fixedPrefixSegments.join('/') : '/')
      : (fixedPrefixSegments.length > 0
        ? pwd + '/' + fixedPrefixSegments.join('/')
        : pwd);

    // Collect all files recursively
    const walkDir = (dir: string): string[] => {
      const results: string[] = [];
      try {
        const entries = this.vfs.readdir(dir);
        for (const entry of entries) {
          const fullPath = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
          results.push(fullPath);
          if (entry.type === 'dir') {
            results.push(...walkDir(fullPath));
          }
        }
      } catch { /* ignore */ }
      return results;
    };

    // Build regex from glob segments only
    const regexParts: string[] = [];
    for (const seg of globSegments) {
      if (seg === '**') {
        regexParts.push('(?:.+/)?'); // zero or more directory levels
      } else {
        const part = seg
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]');
        regexParts.push(part + '/');
      }
    }
    let regexStr = regexParts.join('');
    if (regexStr.endsWith('/')) regexStr = regexStr.slice(0, -1);
    regexStr = '^' + regexStr + '$';
    const regex = new RegExp(regexStr);

    const allFiles = walkDir(baseDir);
    const matches: string[] = [];
    const prefix = baseDir === '/' ? '/' : baseDir + '/';
    for (const filePath of allFiles) {
      // Strip the base directory prefix to get the part matched by glob segments
      if (!filePath.startsWith(prefix)) continue;
      const relative = filePath.slice(prefix.length);
      if (regex.test(relative)) {
        if (isAbsolute) {
          matches.push(filePath);
        } else {
          // Reconstruct relative path from PWD
          const fromPwd = filePath.startsWith(pwd + '/')
            ? filePath.slice(pwd.length + 1)
            : filePath;
          matches.push(fromPwd);
        }
      }
    }
    return matches;
  }

  /** Evaluate a [[ ... ]] conditional expression. */
  private async evalDoubleBracket(expr: string): Promise<boolean> {
    const tokens = await this.tokenizeCondExpr(expr);
    return this.evalCondTokens(tokens);
  }

  /** Tokenize a [[ ]] expression, expanding variables. */
  private async tokenizeCondExpr(expr: string): Promise<string[]> {
    const tokens: string[] = [];
    let i = 0;
    while (i < expr.length) {
      while (i < expr.length && (expr[i] === ' ' || expr[i] === '\t')) i++;
      if (i >= expr.length) break;

      // Two-char operators
      const two = expr.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '!=' || two === '==') {
        tokens.push(two); i += 2; continue;
      }
      if (two === '=~') {
        tokens.push(two); i += 2;
        // After =~, collect the entire RHS as a single regex token (until && or ||)
        while (i < expr.length && (expr[i] === ' ' || expr[i] === '\t')) i++;
        let regex = '';
        let depth = 0;
        while (i < expr.length) {
          if (depth === 0 && (expr.slice(i, i + 2) === '&&' || expr.slice(i, i + 2) === '||')) break;
          if (expr[i] === '(') depth++;
          else if (expr[i] === ')') depth--;
          regex += expr[i++];
        }
        tokens.push(regex.trim());
        continue;
      }
      // Single-char operators
      if (expr[i] === '!' || expr[i] === '(' || expr[i] === ')' ||
          expr[i] === '<' || expr[i] === '>' || expr[i] === '=') {
        tokens.push(expr[i]); i++; continue;
      }
      // Quoted string
      if (expr[i] === '"' || expr[i] === "'") {
        const quote = expr[i]; i++;
        let s = '';
        while (i < expr.length && expr[i] !== quote) {
          if (quote === '"' && expr[i] === '$') {
            i++;
            if (i < expr.length && expr[i] === '{') {
              const end = expr.indexOf('}', i + 1);
              const varName = end >= 0 ? expr.slice(i + 1, end) : expr.slice(i + 1);
              s += this.resolveAssignmentVar(varName);
              i = end >= 0 ? end + 1 : expr.length;
            } else {
              let varName = '';
              while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) varName += expr[i++];
              s += this.env.get(varName) ?? '';
            }
          } else {
            s += expr[i++];
          }
        }
        if (i < expr.length) i++; // skip closing quote
        tokens.push(s); continue;
      }
      // Variable expansion
      if (expr[i] === '$') {
        i++;
        if (i < expr.length && expr[i] === '{') {
          const end = expr.indexOf('}', i + 1);
          const varName = end >= 0 ? expr.slice(i + 1, end) : expr.slice(i + 1);
          tokens.push(this.resolveAssignmentVar(varName));
          i = end >= 0 ? end + 1 : expr.length;
        } else {
          let varName = '';
          while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) varName += expr[i++];
          if (varName === '?') {
            tokens.push(String(this.lastExitCode));
          } else {
            tokens.push(this.env.get(varName) ?? '');
          }
        }
        continue;
      }
      // Unquoted word
      let word = '';
      while (i < expr.length && !/[\s&|!=<>()$"']/.test(expr[i])) word += expr[i++];
      if (word.length > 0) tokens.push(word);
    }
    return tokens;
  }

  /** Evaluate tokenized [[ ]] expression with && || ! ( ) support. */
  private evalCondTokens(tokens: string[]): boolean {
    let pos = 0;

    const parseOr = (): boolean => {
      let result = parseAnd();
      while (pos < tokens.length && tokens[pos] === '||') {
        pos++;
        result = parseAnd() || result;
      }
      return result;
    };

    const parseAnd = (): boolean => {
      let result = parsePrimary();
      while (pos < tokens.length && tokens[pos] === '&&') {
        pos++;
        result = parsePrimary() && result;
      }
      return result;
    };

    const parsePrimary = (): boolean => {
      if (pos >= tokens.length) return false;

      // Negation
      if (tokens[pos] === '!') {
        pos++;
        return !parsePrimary();
      }

      // Grouped expression
      if (tokens[pos] === '(') {
        pos++;
        const result = parseOr();
        if (pos < tokens.length && tokens[pos] === ')') pos++;
        return result;
      }

      // Unary operators
      if (tokens[pos].startsWith('-') && tokens[pos].length === 2 && pos + 1 < tokens.length) {
        const op = tokens[pos];
        const val = tokens[pos + 1];
        if (['-z', '-n', '-f', '-d', '-e', '-s', '-r', '-w', '-x'].includes(op)) {
          pos += 2;
          return this.evalTest([op, val]);
        }
      }

      // Look ahead for binary operator
      if (pos + 2 <= tokens.length) {
        const left = tokens[pos];
        const op = tokens[pos + 1];
        if (op === '==' || op === '=' || op === '!=' || op === '=~' ||
            op === '<' || op === '>' ||
            op === '-eq' || op === '-ne' || op === '-lt' || op === '-le' ||
            op === '-gt' || op === '-ge') {
          const right = tokens[pos + 2] ?? '';
          pos += 3;
          if (op === '=~') {
            try {
              const re = new RegExp(right);
              const m = re.exec(left);
              if (m) {
                this.arrays.set('BASH_REMATCH', m.map(s => s ?? ''));
                return true;
              }
              this.arrays.set('BASH_REMATCH', []);
              return false;
            } catch {
              return false;
            }
          }
          if (op === '<') return left < right;
          if (op === '>') return left > right;
          return this.evalTest([left, op, right]);
        }
      }

      // Single value: true if non-empty
      const val = tokens[pos];
      pos++;
      return val.length > 0;
    };

    return parseOr();
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
    // Handle comma expressions: eval each part, return last
    if (expr.includes(',')) {
      const parts = expr.split(',');
      let result = 0;
      for (const part of parts) {
        result = this.evalArithmetic(part.trim());
      }
      return result;
    }

    // Handle post-increment/decrement: VAR++, VAR--
    const postMatch = expr.match(/^\s*([a-zA-Z_]\w*)\s*(\+\+|--)\s*$/);
    if (postMatch) {
      const cur = parseInt(this.env.get(postMatch[1]) ?? '0', 10) || 0;
      this.env.set(postMatch[1], String(postMatch[2] === '++' ? cur + 1 : cur - 1));
      return cur; // post: return old value
    }

    // Handle pre-increment/decrement: ++VAR, --VAR
    const preMatch = expr.match(/^\s*(\+\+|--)([a-zA-Z_]\w*)\s*$/);
    if (preMatch) {
      const cur = parseInt(this.env.get(preMatch[2]) ?? '0', 10) || 0;
      const newVal = preMatch[1] === '++' ? cur + 1 : cur - 1;
      this.env.set(preMatch[2], String(newVal));
      return newVal; // pre: return new value
    }

    // Handle compound assignment: VAR+=expr, VAR-=expr, VAR*=expr, VAR/=expr, VAR%=expr
    const compoundMatch = expr.match(/^\s*([a-zA-Z_]\w*)\s*([+\-*/%])=\s*(.+)$/);
    if (compoundMatch) {
      const cur = parseInt(this.env.get(compoundMatch[1]) ?? '0', 10) || 0;
      const rhs = this.evalArithmetic(compoundMatch[3]);
      let result: number;
      switch (compoundMatch[2]) {
        case '+': result = cur + rhs; break;
        case '-': result = cur - rhs; break;
        case '*': result = cur * rhs; break;
        case '/': result = rhs !== 0 ? Math.trunc(cur / rhs) : 0; break;
        case '%': result = rhs !== 0 ? cur % rhs : 0; break;
        default: result = rhs;
      }
      this.env.set(compoundMatch[1], String(result));
      return result;
    }

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

  /** Return the command history entries. */
  getHistory(): HistoryEntry[] {
    return this.history.list();
  }

  /** Clear the command history. */
  clearHistory(): void {
    this.history.clear();
  }
}

