/**
 * AST types, signals, and constants shared across the shell module.
 */

import type { ErrorClass } from '../security.js';

// ---- Constants ----

export const PYTHON_COMMANDS = new Set(['python3', 'python']);
export const SHELL_BUILTINS = new Set(['echo', 'which', 'chmod', 'test', '[', 'pwd', 'cd', 'export', 'unset', 'date', 'curl', 'wget', 'exit', 'true', 'false', 'pkg', 'pip', 'history', 'source', '.', 'set', 'read', 'eval', 'getopts', 'return', 'local', 'trap', 'declare', 'typeset', 'shift', 'type', 'command', 'let', 'printf', 'mapfile', 'readarray']);
export const SHELL_COMMANDS = new Set(['sh', 'bash']);

/** Interpreter names that should be dispatched to PythonRunner. */
export const PYTHON_INTERPRETERS = new Set(['python3', 'python']);

export const MAX_SUBSTITUTION_DEPTH = 50;
export const MAX_FUNCTION_DEPTH = 100;

// ---- AST types matching the Rust serde output ----

export interface Word {
  parts: WordPart[];
}

export type WordPart =
  | { Literal: string }
  | { QuotedLiteral: string }
  | { Variable: string }
  | { CommandSub: string }
  | { ParamExpansion: { var: string; op: string; default: string } }
  | { ArithmeticExpansion: string }
  | { ProcessSub: string };

export interface Redirect {
  redirect_type: RedirectType;
}

export type RedirectType =
  | { StdoutOverwrite: string }
  | { StdoutAppend: string }
  | { StdinFrom: string }
  | { StderrOverwrite: string }
  | { StderrAppend: string }
  | 'StderrToStdout'
  | { BothOverwrite: string }
  | { Heredoc: string }
  | { HeredocStrip: string }
  | { HereString: string };

export interface Assignment {
  name: string;
  value: string;
}

export interface CaseItem {
  patterns: Word[];
  body: Command;
}

export type Command =
  | { Simple: { words: Word[]; redirects: Redirect[]; assignments: Assignment[] } }
  | { Pipeline: { commands: Command[] } }
  | { List: { left: Command; op: ListOp; right: Command } }
  | { If: { condition: Command; then_body: Command; else_body: Command | null } }
  | { For: { var: string; words: Word[]; body: Command } }
  | { CFor: { init: string; cond: string; step: string; body: Command } }
  | { While: { condition: Command; body: Command } }
  | { Subshell: { body: Command } }
  | { BraceGroup: { body: Command } }
  | 'Break'
  | 'Continue'
  | { Negate: { body: Command } }
  | { Function: { name: string; body: Command } }
  | { Case: { word: Word; items: CaseItem[] } }
  | { DoubleBracket: { expr: string } }
  | { ArithmeticCommand: { expr: string } };

export type ListOp = 'And' | 'Or' | 'Seq';

// ---- Result types ----

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated?: { stdout: boolean; stderr: boolean };
  errorClass?: ErrorClass;
}

export const EMPTY_RESULT: RunResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  executionTimeMs: 0,
};

// ---- Control flow signals ----

export class BreakSignal { constructor(public depth: number = 1) {} }
export class ContinueSignal { constructor(public depth: number = 1) {} }
export class ReturnSignal { constructor(public code: number) {} }
export class ExitSignal {
  constructor(public code: number, public stdout: string = '', public stderr: string = '') {}
}
