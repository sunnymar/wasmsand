/**
 * Shell builtin commands extracted from ShellRunner.
 *
 * ShellRunner extends this abstract class, providing concrete implementations
 * for the abstract fields and methods that builtins depend on.
 */

import type { VfsLike } from '../vfs/vfs-like.js';
import type { ProcessManager } from '../process/manager.js';
import type { PackageManager } from '../pkg/manager.js';
import { PkgError } from '../pkg/manager.js';
import { NetworkGateway, NetworkAccessDenied } from '../network/gateway.js';
import { CancelledError } from '../security.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { PackageRegistry } from '../packages/registry.js';
import type { CommandHistory } from './history.js';

import {
  PYTHON_COMMANDS,
  SHELL_BUILTINS,
  SHELL_COMMANDS,
  EMPTY_RESULT,
} from './shell-types.js';

import type {
  Command,
  RunResult,
} from './shell-types.js';

import {
  parseChmodMode,
  formatDate,
  normalizePath,
} from './shell-utils.js';

// ---- Abstract base class ----

export abstract class ShellBuiltins {
  // Fields that builtins read/write — provided by ShellRunner
  protected abstract env: Map<string, string>;
  protected abstract vfs: VfsLike;
  protected abstract mgr: ProcessManager;
  protected abstract gateway: NetworkGateway | null;
  protected abstract trapHandlers: Map<string, string>;
  protected abstract pipeStdin: Uint8Array | undefined;
  protected abstract lastExitCode: number;
  protected abstract extensionRegistry: ExtensionRegistry | null;
  protected abstract installedPackages: Set<string>;
  protected abstract packageRegistry: PackageRegistry | null;
  protected abstract history: CommandHistory;
  protected abstract packageManager: PackageManager | null;
  protected abstract auditHandler: ((type: string, data?: Record<string, unknown>) => void) | null;
  protected abstract arrays: Map<string, string[]>;
  protected abstract assocArrays: Map<string, Map<string, string>>;

  // Methods that builtins call back into on the runner
  protected abstract resolvePath(path: string): string;
  protected abstract getPositionalArgs(): string[];
  abstract run(command: string): Promise<RunResult>;
  protected abstract parse(command: string): Promise<Command | null>;
  protected abstract execCommand(cmd: Command): Promise<RunResult>;

  // ---- Builtin implementations ----

  protected builtinPwd(): RunResult {
    const cwd = this.env.get('PWD') || '/';
    return { exitCode: 0, stdout: cwd + '\n', stderr: '', executionTimeMs: 0 };
  }

  /** Builtin: cd — change working directory. */
  protected builtinCd(args: string[]): RunResult {
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
  protected builtinExport(args: string[]): RunResult {
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
  protected builtinUnset(args: string[]): RunResult {
    for (const name of args) {
      // Check for array element: unset arr[idx]
      const arrMatch = name.match(/^(\w+)\[(.+)\]$/);
      if (arrMatch) {
        const arrName = arrMatch[1];
        const subscript = arrMatch[2];
        const assoc = this.assocArrays.get(arrName);
        if (assoc) {
          assoc.delete(subscript);
          continue;
        }
        const arr = this.arrays.get(arrName);
        if (arr) {
          const idx = parseInt(subscript, 10);
          if (!isNaN(idx) && idx >= 0 && idx < arr.length) {
            arr[idx] = '';
          }
          continue;
        }
      }
      this.env.delete(name);
      this.arrays.delete(name);
      this.assocArrays.delete(name);
    }
    return { ...EMPTY_RESULT };
  }

  /** Builtin: trap — set signal/exit handlers. */
  protected builtinTrap(args: string[]): RunResult {
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

  /** Builtin: declare/typeset — declare variables with attributes. */
  protected builtinDeclare(args: string[]): RunResult {
    let assoc = false;
    let indexed = false;
    let doExport = false;
    const assignments: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('-') && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          switch (ch) {
            case 'A': assoc = true; break;
            case 'a': indexed = true; break;
            case 'i': break; // integer attribute — ignored
            case 'x': doExport = true; break;
            case 'r': break; // readonly — ignored
            default: break;
          }
        }
      } else {
        assignments.push(arg);
      }
    }

    for (const assign of assignments) {
      const eqIdx = assign.indexOf('=');
      const name = eqIdx !== -1 ? assign.slice(0, eqIdx) : assign;
      const value = eqIdx !== -1 ? assign.slice(eqIdx + 1) : '';

      if (assoc) {
        if (!this.assocArrays.has(name)) {
          this.assocArrays.set(name, new Map());
        }
        if (eqIdx !== -1 && value.startsWith('(') && value.endsWith(')')) {
          // declare -A map=([key1]=val1 [key2]=val2)
          const inner = value.slice(1, -1).trim();
          const map = this.assocArrays.get(name)!;
          const pairRe = /\[([^\]]+)\]=(\S+)/g;
          let m;
          while ((m = pairRe.exec(inner)) !== null) {
            map.set(m[1], m[2]);
          }
        }
      } else if (indexed) {
        if (!this.arrays.has(name)) {
          this.arrays.set(name, []);
        }
        if (eqIdx !== -1 && value.startsWith('(') && value.endsWith(')')) {
          const inner = value.slice(1, -1).trim();
          this.arrays.set(name, inner.length > 0 ? inner.split(/\s+/) : []);
        }
      } else {
        if (eqIdx !== -1) {
          this.env.set(name, value);
        }
        if (doExport) {
          this.env.set(name, this.env.get(name) ?? '');
        }
      }
    }

    return { ...EMPTY_RESULT };
  }

  /** Builtin: date — print current date/time. */
  protected builtinDate(args: string[]): RunResult {
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
  protected builtinTest(args: string[], isBracket: boolean): RunResult {
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

  protected evalTest(args: string[]): boolean {
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

  /** Builtin: mapfile/readarray — read lines from stdin into an array. */
  protected builtinMapfile(args: string[], stdinData: Uint8Array | undefined): RunResult {
    let stripNewline = false;
    let maxLines = 0;
    let arrayName = 'MAPFILE';
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t') {
        stripNewline = true;
      } else if (args[i] === '-n' && i + 1 < args.length) {
        maxLines = parseInt(args[++i], 10) || 0;
      } else if (!args[i].startsWith('-')) {
        positional.push(args[i]);
      }
    }
    if (positional.length > 0) arrayName = positional[0];

    const input = stdinData ? new TextDecoder().decode(stdinData) : '';
    let lines = input.split('\n');
    // Remove trailing empty element from final newline
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (maxLines > 0) lines = lines.slice(0, maxLines);
    if (stripNewline) {
      lines = lines.map(l => l.replace(/\n$/, ''));
    }
    this.arrays.set(arrayName, lines);
    return { ...EMPTY_RESULT };
  }

  /** Builtin: echo — print arguments to stdout. */
  protected builtinEcho(args: string[]): RunResult {
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
  protected interpretEchoEscapes(s: string): string {
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
  protected builtinRead(args: string[], stdinData: Uint8Array | undefined): RunResult {
    let raw = false;
    let delimiter = '\n';
    let nchars = -1; // -1 means unlimited
    let arrayVar: string | undefined;
    const varNames: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-r') { raw = true; continue; }
      if (a === '-d' && i + 1 < args.length) { delimiter = args[++i]; continue; }
      if (a === '-n' && i + 1 < args.length) { nchars = parseInt(args[++i], 10) || 0; continue; }
      if (a === '-p' && i + 1 < args.length) { i++; continue; } // skip prompt (no terminal)
      if (a === '-a' && i + 1 < args.length) { arrayVar = args[++i]; continue; }
      if (a === '-s') continue; // silent — no terminal, skip
      varNames.push(a);
    }
    if (!arrayVar && varNames.length === 0) varNames.push('REPLY');

    const input = stdinData ? new TextDecoder().decode(stdinData) : '';
    if (!stdinData?.length || input === '') {
      return { exitCode: 1, stdout: '', stderr: '', executionTimeMs: 0 };
    }

    // Determine how much input to consume
    let consumed: string;
    let consumedLen: number; // bytes past the delimiter
    if (nchars >= 0) {
      consumed = input.slice(0, nchars);
      consumedLen = consumed.length;
    } else {
      const delimIdx = input.indexOf(delimiter);
      if (delimIdx !== -1) {
        consumed = input.slice(0, delimIdx);
        consumedLen = delimIdx + delimiter.length;
      } else {
        consumed = input;
        consumedLen = input.length;
      }
    }

    const line = raw ? consumed : consumed.replace(/\\(.)/g, '$1');

    if (arrayVar) {
      // -a: split into array
      const elements = line.length > 0 ? line.split(/[ \t]+/) : [];
      this.arrays.set(arrayVar, elements);
    } else {
      const parts = line.split(/[ \t]+/);
      for (let i = 0; i < varNames.length; i++) {
        if (i === varNames.length - 1) {
          this.env.set(varNames[i], parts.slice(i).join(' '));
        } else {
          this.env.set(varNames[i], parts[i] ?? '');
        }
      }
    }

    // Advance pipeStdin past the consumed content
    if (this.pipeStdin && stdinData === this.pipeStdin) {
      const remaining = input.slice(consumedLen);
      this.pipeStdin = remaining.length > 0
        ? new TextEncoder().encode(remaining)
        : undefined;
    }

    return { ...EMPTY_RESULT };
  }

  /** Builtin: eval — concatenate args and execute as a shell command. */
  protected async builtinEval(args: string[]): Promise<RunResult> {
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
  protected builtinGetopts(args: string[]): RunResult {
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
  protected builtinWhich(args: string[]): RunResult {
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
  protected builtinChmod(args: string[]): RunResult {
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
  protected audit(type: string, data?: Record<string, unknown>): void {
    if (this.auditHandler) this.auditHandler(type, data);
  }

  /** Builtin: source / . — execute commands from a file in the current shell. */
  protected async builtinSource(args: string[]): Promise<RunResult> {
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
    // Set BASH_SOURCE for the duration of the sourced script
    const prevBashSource = this.env.get('BASH_SOURCE');
    this.env.set('BASH_SOURCE', filePath);

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
        // Restore BASH_SOURCE
        if (prevBashSource !== undefined) this.env.set('BASH_SOURCE', prevBashSource);
        else this.env.delete('BASH_SOURCE');
      }
    }

    // No extra args — just run in current shell
    try {
      return await this.run(script);
    } finally {
      if (prevBashSource !== undefined) this.env.set('BASH_SOURCE', prevBashSource);
      else this.env.delete('BASH_SOURCE');
    }
  }

  /** Builtin: pip — package install/uninstall/list/show. */
  protected builtinPip(args: string[]): RunResult {
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
  protected builtinHistory(args: string[]): RunResult {
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

  /** Builtin: pkg — manage WASI binary packages. */
  protected async builtinPkg(args: string[]): Promise<RunResult> {
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
  protected async builtinPkgInstall(args: string[], encoder: TextEncoder): Promise<RunResult> {
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
  protected async builtinPkgRemove(args: string[]): Promise<RunResult> {
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
  protected builtinPkgList(): RunResult {
    const packages = this.packageManager!.list();
    if (packages.length === 0) {
      return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
    }
    const lines = packages.map(p => `${p.name}\t${p.size}\t${p.url}`).join('\n') + '\n';
    return { exitCode: 0, stdout: lines, stderr: '', executionTimeMs: 0 };
  }

  /** Builtin: pkg info <name> */
  protected builtinPkgInfo(args: string[]): RunResult {
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
  protected async builtinCurl(args: string[]): Promise<RunResult> {
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
  protected async builtinWget(args: string[]): Promise<RunResult> {
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

  protected tryReadFile(path: string): Uint8Array {
    try {
      return this.vfs.readFile(path);
    } catch {
      return new Uint8Array(0);
    }
  }
}
