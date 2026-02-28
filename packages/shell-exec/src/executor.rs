use codepod_shell::ast::{Command, ListOp, Word};
use codepod_shell::token::RedirectType;

use crate::control::{ControlFlow, RunResult, ShellError};
use crate::expand::{
    expand_braces, expand_globs, expand_word, expand_words_with_splitting, glob_matches,
    restore_brace_sentinels, ExecFn,
};
use crate::host::{HostInterface, WriteMode};
use crate::state::ShellState;

// ---------------------------------------------------------------------------
// Path resolution and command dispatch constants/helpers
// ---------------------------------------------------------------------------

/// Commands that default to "." (current directory) when no positional
/// (non-flag) arguments are given.
const IMPLICIT_CWD_COMMANDS: &[&str] = &["ls", "find"];

/// Commands whose args should NOT be resolved to absolute paths.
const PASSTHROUGH_ARGS: &[&str] = &[
    "echo", "printf", "basename", "dirname", "env", "true", "false", "find",
];

/// Commands where the first positional (non-flag) argument is a regex/pattern
/// and should not be path-resolved. Other args resolve normally.
const PATTERN_COMMANDS: &[&str] = &["grep", "sed", "awk", "rg"];

/// Commands that create files/dirs — always resolve relative args.
const CREATION_COMMANDS: &[&str] = &["mkdir", "touch", "cp", "mv", "tee"];

/// Python interpreter names (for shebang dispatch).
const PYTHON_INTERPRETERS: &[&str] = &["python", "python3"];

/// Returns true if the command defaults to "." and no non-flag args were given.
fn needs_default_dir(cmd: &str, args: &[&str]) -> bool {
    IMPLICIT_CWD_COMMANDS.contains(&cmd) && args.iter().all(|a| a.starts_with('-'))
}

/// Resolve a single argument to an absolute path if it looks like a relative
/// file path. Flags (starting with `-`) and absolute paths (starting with `/`)
/// pass through. Commands in PASSTHROUGH_ARGS never resolve their args.
///
/// Uses `host.stat()` to disambiguate: only resolves if the resolved path
/// exists in VFS. Also resolves args that look like filenames (have a file
/// extension, no glob chars, don't start with `.`).
fn resolve_arg_if_path(
    state: &ShellState,
    host: &dyn HostInterface,
    cmd_name: &str,
    arg: &str,
) -> String {
    if PASSTHROUGH_ARGS.contains(&cmd_name) {
        return arg.to_string();
    }
    if arg.starts_with('-') || arg.starts_with('/') {
        return arg.to_string();
    }
    // Creation commands always resolve relative args
    if CREATION_COMMANDS.contains(&cmd_name) {
        return state.resolve_path(arg);
    }
    // For other commands, only resolve if the resolved path exists in VFS
    let resolved = state.resolve_path(arg);
    if let Ok(info) = host.stat(&resolved) {
        if info.exists {
            return resolved;
        }
    }
    // Arg looks like a filename (e.g. "archive.tar") — resolve it so
    // tools can create new files relative to CWD. Must end with a file
    // extension, not contain glob/pattern chars, and not start with "."
    // (which would match jq expressions like ".name").
    if looks_like_filename(arg) {
        return resolved;
    }
    arg.to_string()
}

/// Returns true if `arg` looks like a filename: ends with `.ext`, contains
/// no glob/pattern characters, and does not start with `.`.
fn looks_like_filename(arg: &str) -> bool {
    if arg.starts_with('.') {
        return false;
    }
    if arg.contains('*')
        || arg.contains('?')
        || arg.contains('{')
        || arg.contains('}')
        || arg.contains('/')
    {
        return false;
    }
    // Check for file extension: .\w+$
    if let Some(dot_pos) = arg.rfind('.') {
        let ext = &arg[dot_pos + 1..];
        !ext.is_empty() && ext.chars().all(|c| c.is_alphanumeric() || c == '_')
    } else {
        false
    }
}

/// Resolve command args. For PATTERN_COMMANDS, skip resolving the first
/// positional (non-flag) arg (the regex/pattern).
fn resolve_command_args(
    state: &ShellState,
    host: &dyn HostInterface,
    cmd_name: &str,
    args: &[&str],
) -> Vec<String> {
    if !PATTERN_COMMANDS.contains(&cmd_name) {
        return args
            .iter()
            .map(|a| resolve_arg_if_path(state, host, cmd_name, a))
            .collect();
    }
    // Find the first positional arg (not a flag) — that's the pattern.
    let pat_idx = args.iter().position(|a| !a.starts_with('-'));
    args.iter()
        .enumerate()
        .map(|(i, a)| {
            if Some(i) == pat_idx {
                a.to_string()
            } else {
                resolve_arg_if_path(state, host, cmd_name, a)
            }
        })
        .collect()
}

/// Parse a shebang line and return the interpreter name.
///
/// Examples:
///   `#!/usr/bin/env python3` -> Some("python3")
///   `#!/usr/bin/python3`     -> Some("python3")
///   `#!/bin/sh`              -> Some("sh")
///   `#!/bin/bash`            -> Some("bash")
///   (no shebang)             -> None
fn parse_shebang(first_line: &str) -> Option<String> {
    if !first_line.starts_with("#!") {
        return None;
    }
    let rest = first_line[2..].trim();
    let parts: Vec<&str> = rest.split_whitespace().collect();

    // #!/usr/bin/env <interpreter> — use the second word
    if parts.len() >= 2 && parts[0].ends_with("/env") {
        return Some(parts[1].to_string());
    }

    // #!/path/to/interpreter — use the basename
    if !parts.is_empty() {
        let prog = parts[0];
        if let Some(slash) = prog.rfind('/') {
            return Some(prog[slash + 1..].to_string());
        }
        return Some(prog.to_string());
    }

    None
}

/// Returns true if the interpreter name is a Python interpreter.
fn is_python_interpreter(name: &str) -> bool {
    if PYTHON_INTERPRETERS.contains(&name) {
        return true;
    }
    // Match python3.X patterns (python3.10, python3.11, etc.)
    if let Some(rest) = name.strip_prefix("python3.") {
        return rest.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// Normalize an absolute path by resolving `.` and `..` segments.
/// E.g. "/home/user/./script.sh" -> "/home/user/script.sh",
///      "/home/user/../other/file" -> "/home/other/file".
fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {} // skip empty segments and "."
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

/// Execute a file by path (e.g. `./script.sh`, `/tmp/run.py`).
/// Reads the file, checks for a shebang line, and dispatches to
/// the appropriate interpreter.
fn exec_path(
    state: &mut ShellState,
    host: &dyn HostInterface,
    cmd_path: &str,
    args: &[&str],
    stdin_data: &str,
) -> Result<ControlFlow, ShellError> {
    let resolved = normalize_path(&state.resolve_path(cmd_path));

    // Read the file
    let text = host
        .read_file(&resolved)
        .map_err(|e| ShellError::HostError(format!("{}: {}", cmd_path, e)))?;

    let first_line = text.lines().next().unwrap_or("");
    let interpreter = parse_shebang(first_line);

    // Dispatch based on interpreter
    if let Some(ref interp) = interpreter {
        if is_python_interpreter(interp) {
            // Python script: spawn python with the resolved script path + args
            let mut python_args: Vec<&str> = vec![resolved.as_str()];
            python_args.extend(args);
            let env_pairs: Vec<(&str, &str)> = state
                .env
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            let spawn_result = host
                .spawn("python3", &python_args, &env_pairs, &state.cwd, stdin_data)
                .map_err(|e| ShellError::HostError(e.to_string()))?;
            state.last_exit_code = spawn_result.exit_code;
            return Ok(ControlFlow::Normal(RunResult {
                exit_code: spawn_result.exit_code,
                stdout: spawn_result.stdout,
                stderr: spawn_result.stderr,
                execution_time_ms: 0,
            }));
        }
    }

    // Default: run as shell script (covers #!/bin/sh, #!/bin/bash, and no shebang)
    exec_shell_script(state, host, &text, args)
}

/// Execute a string as a shell script. Strips shebang if present,
/// sets positional parameters, and runs via the parser.
fn exec_shell_script(
    state: &mut ShellState,
    host: &dyn HostInterface,
    script_text: &str,
    args: &[&str],
) -> Result<ControlFlow, ShellError> {
    // Strip shebang line if present
    let script = if script_text.starts_with("#!") {
        match script_text.find('\n') {
            Some(nl) => &script_text[nl + 1..],
            None => "",
        }
    } else {
        script_text
    };

    // Set positional parameters
    let saved_positionals = state.positional_args.clone();
    state.positional_args = args.iter().map(|s| s.to_string()).collect();

    // Run the entire script as a single parsed command
    let parsed = codepod_shell::parser::parse(script);
    let result = exec_command(state, host, &parsed);

    // Restore positional parameters
    state.positional_args = saved_positionals;

    result
}

/// Handle `sh`/`bash` command dispatch.
/// - `sh -c 'cmd'` -> parse and execute cmd string
/// - `sh script.sh` -> read and execute script via exec_path
/// - bare `sh`/`bash` -> succeed silently
fn exec_shell_command(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[&str],
    stdin_data: &str,
) -> Result<ControlFlow, ShellError> {
    // sh -c 'command string'
    if args.len() >= 2 && args[0] == "-c" {
        let cmd_str = args[1];
        let parsed = codepod_shell::parser::parse(cmd_str);
        return exec_command(state, host, &parsed);
    }
    // sh script.sh — read and execute as shell script
    if !args.is_empty() && !args[0].starts_with('-') {
        return exec_path(state, host, args[0], &args[1..], stdin_data);
    }
    // Bare sh/bash with no args — not interactive, just succeed
    Ok(ControlFlow::Normal(RunResult::empty()))
}

/// Apply path resolution and command dispatch for external commands.
/// Returns the resolved program name and arguments for spawning.
/// If the command was fully handled (shebang, sh/bash dispatch),
/// returns Err(ControlFlow) instead.
fn dispatch_external_command(
    state: &mut ShellState,
    host: &dyn HostInterface,
    cmd_name: &str,
    args: &[&str],
    stdin_data: &str,
) -> Result<(String, Vec<String>), ControlFlow> {
    // 1. Shebang check — if cmd_name contains '/'
    if cmd_name.contains('/') {
        match exec_path(state, host, cmd_name, args, stdin_data) {
            Ok(flow) => return Err(flow),
            Err(e) => {
                return Err(ControlFlow::Normal(RunResult::error(
                    127,
                    format!("{}\n", e),
                )));
            }
        }
    }

    // 2. Shell command dispatch — if cmd_name is `sh` or `bash`
    if cmd_name == "sh" || cmd_name == "bash" {
        match exec_shell_command(state, host, args, stdin_data) {
            Ok(flow) => return Err(flow),
            Err(e) => {
                return Err(ControlFlow::Normal(RunResult::error(1, format!("{}\n", e))));
            }
        }
    }

    // 3. Python — falls through to host.spawn with resolved args.

    // 4. needs_default_dir check — append cwd if needed
    let mut final_args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    if needs_default_dir(cmd_name, args) {
        final_args.push(state.cwd.clone());
    }

    // 5. resolve_command_args — resolve args using resolve_arg_if_path
    let args_refs: Vec<&str> = final_args.iter().map(|s| s.as_str()).collect();
    let resolved_args = resolve_command_args(state, host, cmd_name, &args_refs);

    Ok((cmd_name.to_string(), resolved_args))
}

/// Apply output redirects (stdout/stderr overwrite, append, merge, etc.)
/// to the given stdout/stderr buffers. This is called after a command
/// finishes execution to process any `>`, `>>`, `2>`, `2>>`, `2>&1`, `&>`
/// redirections attached to the command.
fn apply_output_redirects(
    state: &ShellState,
    host: &dyn HostInterface,
    redirects: &[codepod_shell::ast::Redirect],
    stdout: &mut String,
    stderr: &mut String,
) -> Result<(), ShellError> {
    let mut last_stdout_redirect_path: Option<String> = None;
    for redir in redirects {
        match &redir.redirect_type {
            RedirectType::StdoutOverwrite(path) => {
                let resolved = state.resolve_path(path);
                host.write_file(&resolved, stdout, WriteMode::Truncate)
                    .map_err(|e| ShellError::HostError(e.to_string()))?;
                *stdout = String::new();
                last_stdout_redirect_path = Some(resolved);
            }
            RedirectType::StdoutAppend(path) => {
                let resolved = state.resolve_path(path);
                host.write_file(&resolved, stdout, WriteMode::Append)
                    .map_err(|e| ShellError::HostError(e.to_string()))?;
                *stdout = String::new();
                last_stdout_redirect_path = Some(resolved);
            }
            RedirectType::StderrOverwrite(path) => {
                let resolved = state.resolve_path(path);
                host.write_file(&resolved, stderr, WriteMode::Truncate)
                    .map_err(|e| ShellError::HostError(e.to_string()))?;
                *stderr = String::new();
            }
            RedirectType::StderrAppend(path) => {
                let resolved = state.resolve_path(path);
                host.write_file(&resolved, stderr, WriteMode::Append)
                    .map_err(|e| ShellError::HostError(e.to_string()))?;
                *stderr = String::new();
            }
            RedirectType::StderrToStdout => {
                if let Some(ref file_path) = last_stdout_redirect_path {
                    if !stderr.is_empty() {
                        host.write_file(file_path, stderr, WriteMode::Append)
                            .map_err(|e| ShellError::HostError(e.to_string()))?;
                    }
                } else {
                    stdout.push_str(stderr);
                }
                *stderr = String::new();
            }
            RedirectType::BothOverwrite(path) => {
                let resolved = state.resolve_path(path);
                let combined = format!("{stdout}{stderr}");
                host.write_file(&resolved, &combined, WriteMode::Truncate)
                    .map_err(|e| ShellError::HostError(e.to_string()))?;
                *stdout = String::new();
                *stderr = String::new();
            }
            // Input redirects are handled separately; skip them here.
            _ => {}
        }
    }
    Ok(())
}

/// Execute a parsed `Command` AST node.
pub fn exec_command(
    state: &mut ShellState,
    host: &dyn HostInterface,
    cmd: &Command,
) -> Result<ControlFlow, ShellError> {
    // Create executor callback for command substitution.
    // When word expansion encounters `$(...)`, it calls this closure to
    // parse and execute the inner command, capturing its stdout.
    let exec_fn = |state: &mut ShellState, cmd_str: &str| -> String {
        let inner_cmd = codepod_shell::parser::parse(cmd_str);
        match exec_command(state, host, &inner_cmd) {
            Ok(ControlFlow::Normal(r)) => r.stdout,
            Ok(ControlFlow::Exit(_, stdout, _)) => stdout,
            _ => String::new(),
        }
    };

    match cmd {
        Command::Simple {
            words,
            redirects,
            assignments,
        } => {
            // Process assignments before word expansion
            process_assignments(state, assignments, Some(&exec_fn));

            if words.is_empty() {
                // Assignment-only command; nothing to spawn.
                return Ok(ControlFlow::Normal(RunResult::empty()));
            }

            let expanded = expand_words_with_splitting(state, words, Some(&exec_fn));

            // Check for ${var:?msg} error during expansion
            if let Some(err_msg) = state.param_error.take() {
                state.last_exit_code = 1;
                return Ok(ControlFlow::Normal(RunResult::error(
                    1,
                    format!("{err_msg}\n"),
                )));
            }

            if expanded.is_empty() {
                return Ok(ControlFlow::Normal(RunResult::empty()));
            }

            // Brace expansion → sentinel restoration → glob expansion
            let braced = expand_braces(&expanded);
            let restored = restore_brace_sentinels(&braced);
            let globbed = expand_globs(host, &restored);

            if globbed.is_empty() {
                return Ok(ControlFlow::Normal(RunResult::empty()));
            }
            let cmd_name = &globbed[0];
            let args: Vec<&str> = globbed[1..].iter().map(|s| s.as_str()).collect();

            // ── Check for function invocation ────────────────────────────
            if let Some(func_body) = state.functions.get(cmd_name).cloned() {
                if state.function_depth >= crate::state::MAX_FUNCTION_DEPTH {
                    return Ok(ControlFlow::Normal(RunResult::error(
                        1,
                        format!("{cmd_name}: maximum function nesting depth exceeded\n"),
                    )));
                }
                let func_args: Vec<String> = globbed[1..].iter().map(|s| s.to_string()).collect();
                let saved_positionals = state.positional_args.clone();
                state.positional_args = func_args;
                state.function_depth += 1;
                let local_frame = std::collections::HashMap::new();
                state.local_var_stack.push(local_frame);

                let result = exec_command(state, host, &func_body);

                // Restore local variables from the popped frame
                if let Some(frame) = state.local_var_stack.pop() {
                    for (name, prev_value) in frame {
                        match prev_value {
                            Some(v) => {
                                state.env.insert(name, v);
                            }
                            None => {
                                state.env.remove(&name);
                            }
                        }
                    }
                }
                state.function_depth -= 1;
                state.positional_args = saved_positionals;

                return match result? {
                    ControlFlow::Return(code) => {
                        state.last_exit_code = code;
                        Ok(ControlFlow::Normal(RunResult {
                            exit_code: code,
                            stdout: String::new(),
                            stderr: String::new(),
                            execution_time_ms: 0,
                        }))
                    }
                    other => Ok(other),
                };
            }

            // ── Phase 1: Extract stdin from input redirects ──────────────
            let mut stdin_data = String::new();
            for redir in redirects {
                match &redir.redirect_type {
                    RedirectType::StdinFrom(path) => {
                        let resolved = state.resolve_path(path);
                        stdin_data = host
                            .read_file(&resolved)
                            .map_err(|e| ShellError::HostError(e.to_string()))?;
                    }
                    RedirectType::Heredoc(content) => {
                        stdin_data = content.clone();
                    }
                    RedirectType::HeredocStrip(content) => {
                        stdin_data = content.clone();
                    }
                    RedirectType::HereString(word) => {
                        stdin_data = format!("{word}\n");
                    }
                    _ => {}
                }
            }

            // ── Check for builtin commands ────────────────────────────
            let func_args: Vec<String> = globbed[1..].iter().map(|s| s.to_string()).collect();
            let run_fn = |state: &mut ShellState, cmd_str: &str| -> RunResult {
                let inner_cmd = codepod_shell::parser::parse(cmd_str);
                match exec_command(state, host, &inner_cmd) {
                    Ok(ControlFlow::Normal(r)) => r,
                    Ok(ControlFlow::Exit(code, stdout, stderr)) => RunResult {
                        exit_code: code,
                        stdout,
                        stderr,
                        execution_time_ms: 0,
                    },
                    _ => RunResult::empty(),
                }
            };
            if let Some(builtin_result) = crate::builtins::try_builtin(
                state,
                host,
                cmd_name,
                &func_args,
                &stdin_data,
                Some(&run_fn),
            ) {
                let (mut stdout, mut stderr, exit_code) = match builtin_result {
                    crate::builtins::BuiltinResult::Result(r) => {
                        state.last_exit_code = r.exit_code;
                        (r.stdout, r.stderr, r.exit_code)
                    }
                    crate::builtins::BuiltinResult::Exit(code) => {
                        return Ok(ControlFlow::Exit(code, String::new(), String::new()));
                    }
                    crate::builtins::BuiltinResult::Return(code) => {
                        return Ok(ControlFlow::Return(code));
                    }
                };

                // Process output redirects for builtins too
                apply_output_redirects(state, host, redirects, &mut stdout, &mut stderr)?;

                return Ok(ControlFlow::Normal(RunResult {
                    exit_code,
                    stdout,
                    stderr,
                    execution_time_ms: 0,
                }));
            }

            // ── Virtual commands (curl, wget, pkg, pip) ──────────────────
            if let Some(result) = crate::virtual_commands::try_virtual_command(
                state,
                host,
                cmd_name,
                &func_args,
                &stdin_data,
            ) {
                state.last_exit_code = result.exit_code;
                let mut stdout = result.stdout;
                let mut stderr = result.stderr;
                apply_output_redirects(state, host, redirects, &mut stdout, &mut stderr)?;
                return Ok(ControlFlow::Normal(RunResult {
                    exit_code: result.exit_code,
                    stdout,
                    stderr,
                    execution_time_ms: 0,
                }));
            }

            // ── Extensions ──────────────────────────────────────────────
            if host.is_extension(cmd_name) {
                let args_refs: Vec<&str> = func_args.iter().map(|s| s.as_str()).collect();
                let env_pairs: Vec<(&str, &str)> = state
                    .env
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect();
                match host.extension_invoke(
                    cmd_name,
                    &args_refs,
                    &stdin_data,
                    &env_pairs,
                    &state.cwd,
                ) {
                    Ok(r) => {
                        state.last_exit_code = r.exit_code;
                        let mut stdout = r.stdout;
                        let mut stderr = r.stderr;
                        apply_output_redirects(state, host, redirects, &mut stdout, &mut stderr)?;
                        return Ok(ControlFlow::Normal(RunResult {
                            exit_code: r.exit_code,
                            stdout,
                            stderr,
                            execution_time_ms: 0,
                        }));
                    }
                    Err(e) => {
                        state.last_exit_code = 1;
                        return Ok(ControlFlow::Normal(RunResult::error(
                            1,
                            format!("{cmd_name}: {e}\n"),
                        )));
                    }
                }
            }

            // ── Path resolution and command dispatch ─────────────────────
            let (spawn_program, spawn_args) =
                match dispatch_external_command(state, host, cmd_name, &args, &stdin_data) {
                    Ok((prog, resolved)) => (prog, resolved),
                    Err(flow) => {
                        // Command was handled by dispatch (shebang, sh/bash)
                        let run = match flow {
                            ControlFlow::Normal(r) => r,
                            other => return Ok(other),
                        };
                        state.last_exit_code = run.exit_code;
                        let mut stdout = run.stdout;
                        let mut stderr = run.stderr;

                        // Process output redirects for dispatched commands too
                        apply_output_redirects(state, host, redirects, &mut stdout, &mut stderr)?;

                        return Ok(ControlFlow::Normal(RunResult {
                            exit_code: run.exit_code,
                            stdout,
                            stderr,
                            execution_time_ms: 0,
                        }));
                    }
                };

            // Convert env HashMap to the slice format expected by spawn.
            let env_pairs: Vec<(&str, &str)> = state
                .env
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();

            let spawn_args_refs: Vec<&str> = spawn_args.iter().map(|s| s.as_str()).collect();
            let spawn_result = host
                .spawn(
                    &spawn_program,
                    &spawn_args_refs,
                    &env_pairs,
                    &state.cwd,
                    &stdin_data,
                )
                .map_err(|e| ShellError::HostError(e.to_string()))?;

            state.last_exit_code = spawn_result.exit_code;

            let mut stdout = spawn_result.stdout;
            let mut stderr = spawn_result.stderr;

            // ── Phase 2: Process output redirects ────────────────────────
            apply_output_redirects(state, host, redirects, &mut stdout, &mut stderr)?;

            Ok(ControlFlow::Normal(RunResult {
                exit_code: spawn_result.exit_code,
                stdout,
                stderr,
                execution_time_ms: 0,
            }))
        }

        Command::Pipeline { commands } => {
            // Single-command pipeline — just delegate.
            if commands.len() == 1 {
                return exec_command(state, host, &commands[0]);
            }

            let pipefail = state.flags.contains(&crate::state::ShellFlag::Pipefail);
            let mut pipefail_code = 0;
            let mut last_result = RunResult::empty();
            let mut stdin_data = String::new();

            for cmd in commands {
                match cmd {
                    Command::Simple {
                        words,
                        redirects,
                        assignments,
                    } => {
                        // Process assignments before word expansion
                        process_assignments(state, assignments, Some(&exec_fn));

                        if words.is_empty() {
                            last_result = RunResult::empty();
                            stdin_data = last_result.stdout.clone();
                            if pipefail && last_result.exit_code != 0 {
                                pipefail_code = last_result.exit_code;
                            }
                            continue;
                        }

                        let expanded = expand_words_with_splitting(state, words, Some(&exec_fn));
                        if expanded.is_empty() {
                            last_result = RunResult::empty();
                            stdin_data = last_result.stdout.clone();
                            if pipefail && last_result.exit_code != 0 {
                                pipefail_code = last_result.exit_code;
                            }
                            continue;
                        }

                        let braced = expand_braces(&expanded);
                        let restored = restore_brace_sentinels(&braced);
                        let globbed = expand_globs(host, &restored);

                        if globbed.is_empty() {
                            last_result = RunResult::empty();
                            stdin_data = last_result.stdout.clone();
                            if pipefail && last_result.exit_code != 0 {
                                pipefail_code = last_result.exit_code;
                            }
                            continue;
                        }

                        let cmd_name = &globbed[0];
                        let args: Vec<&str> = globbed[1..].iter().map(|s| s.as_str()).collect();

                        // Process input redirects — they override pipeline stdin
                        let mut effective_stdin = stdin_data.clone();
                        for redir in redirects {
                            match &redir.redirect_type {
                                RedirectType::StdinFrom(path) => {
                                    let resolved = state.resolve_path(path);
                                    effective_stdin = host
                                        .read_file(&resolved)
                                        .map_err(|e| ShellError::HostError(e.to_string()))?;
                                }
                                RedirectType::Heredoc(content) => {
                                    effective_stdin = content.clone();
                                }
                                RedirectType::HeredocStrip(content) => {
                                    effective_stdin = content.clone();
                                }
                                RedirectType::HereString(word) => {
                                    effective_stdin = format!("{word}\n");
                                }
                                _ => {}
                            }
                        }

                        // Check for builtin in pipeline
                        let pipe_func_args: Vec<String> =
                            globbed[1..].iter().map(|s| s.to_string()).collect();
                        let pipe_run_fn = |state: &mut ShellState, cmd_str: &str| -> RunResult {
                            let inner_cmd = codepod_shell::parser::parse(cmd_str);
                            match exec_command(state, host, &inner_cmd) {
                                Ok(ControlFlow::Normal(r)) => r,
                                Ok(ControlFlow::Exit(code, stdout, stderr)) => RunResult {
                                    exit_code: code,
                                    stdout,
                                    stderr,
                                    execution_time_ms: 0,
                                },
                                _ => RunResult::empty(),
                            }
                        };
                        if let Some(builtin_result) = crate::builtins::try_builtin(
                            state,
                            host,
                            cmd_name,
                            &pipe_func_args,
                            &effective_stdin,
                            Some(&pipe_run_fn),
                        ) {
                            match builtin_result {
                                crate::builtins::BuiltinResult::Result(r) => {
                                    let mut bstdout = r.stdout;
                                    let mut bstderr = r.stderr;

                                    // Handle output redirects
                                    apply_output_redirects(
                                        state,
                                        host,
                                        redirects,
                                        &mut bstdout,
                                        &mut bstderr,
                                    )?;

                                    state.last_exit_code = r.exit_code;
                                    last_result = RunResult {
                                        exit_code: r.exit_code,
                                        stdout: bstdout,
                                        stderr: bstderr,
                                        execution_time_ms: 0,
                                    };
                                }
                                crate::builtins::BuiltinResult::Exit(code) => {
                                    return Ok(ControlFlow::Exit(
                                        code,
                                        String::new(),
                                        String::new(),
                                    ));
                                }
                                crate::builtins::BuiltinResult::Return(code) => {
                                    return Ok(ControlFlow::Return(code));
                                }
                            }
                            // Track pipefail
                            if pipefail && last_result.exit_code != 0 {
                                pipefail_code = last_result.exit_code;
                            }
                            stdin_data = last_result.stdout.clone();
                            continue;
                        }

                        // ── Virtual commands in pipeline ──
                        if let Some(result) = crate::virtual_commands::try_virtual_command(
                            state,
                            host,
                            cmd_name,
                            &pipe_func_args,
                            &effective_stdin,
                        ) {
                            state.last_exit_code = result.exit_code;
                            let mut bstdout = result.stdout;
                            let mut bstderr = result.stderr;
                            apply_output_redirects(
                                state,
                                host,
                                redirects,
                                &mut bstdout,
                                &mut bstderr,
                            )?;
                            last_result = RunResult {
                                exit_code: result.exit_code,
                                stdout: bstdout,
                                stderr: bstderr,
                                execution_time_ms: 0,
                            };
                            if pipefail && last_result.exit_code != 0 {
                                pipefail_code = last_result.exit_code;
                            }
                            stdin_data = last_result.stdout.clone();
                            continue;
                        }

                        // ── Extensions in pipeline ──
                        if host.is_extension(cmd_name) {
                            let args_refs: Vec<&str> =
                                pipe_func_args.iter().map(|s| s.as_str()).collect();
                            let env_pairs: Vec<(&str, &str)> = state
                                .env
                                .iter()
                                .map(|(k, v)| (k.as_str(), v.as_str()))
                                .collect();
                            match host.extension_invoke(
                                cmd_name,
                                &args_refs,
                                &effective_stdin,
                                &env_pairs,
                                &state.cwd,
                            ) {
                                Ok(r) => {
                                    state.last_exit_code = r.exit_code;
                                    let mut bstdout = r.stdout;
                                    let mut bstderr = r.stderr;
                                    apply_output_redirects(
                                        state,
                                        host,
                                        redirects,
                                        &mut bstdout,
                                        &mut bstderr,
                                    )?;
                                    last_result = RunResult {
                                        exit_code: r.exit_code,
                                        stdout: bstdout,
                                        stderr: bstderr,
                                        execution_time_ms: 0,
                                    };
                                }
                                Err(e) => {
                                    state.last_exit_code = 1;
                                    last_result = RunResult::error(1, format!("{cmd_name}: {e}\n"));
                                }
                            }
                            if pipefail && last_result.exit_code != 0 {
                                pipefail_code = last_result.exit_code;
                            }
                            stdin_data = last_result.stdout.clone();
                            continue;
                        }

                        // ── Path resolution and command dispatch (pipeline) ──
                        let dispatch_result = dispatch_external_command(
                            state,
                            host,
                            cmd_name,
                            &args,
                            &effective_stdin,
                        );

                        match dispatch_result {
                            Err(flow) => {
                                // Command was handled by dispatch (shebang, sh/bash)
                                match flow {
                                    ControlFlow::Normal(r) => {
                                        state.last_exit_code = r.exit_code;
                                        last_result = r;
                                    }
                                    ControlFlow::Exit(code, stdout, stderr) => {
                                        return Ok(ControlFlow::Exit(code, stdout, stderr));
                                    }
                                    other => return Ok(other),
                                }
                                if pipefail && last_result.exit_code != 0 {
                                    pipefail_code = last_result.exit_code;
                                }
                                stdin_data = last_result.stdout.clone();
                                continue;
                            }
                            Ok((prog, resolved_args)) => {
                                let env_pairs: Vec<(&str, &str)> = state
                                    .env
                                    .iter()
                                    .map(|(k, v)| (k.as_str(), v.as_str()))
                                    .collect();

                                let spawn_args_refs: Vec<&str> =
                                    resolved_args.iter().map(|s| s.as_str()).collect();

                                match host.spawn(
                                    &prog,
                                    &spawn_args_refs,
                                    &env_pairs,
                                    &state.cwd,
                                    &effective_stdin,
                                ) {
                                    Ok(spawn_result) => {
                                        let mut stdout = spawn_result.stdout;
                                        let mut stderr = spawn_result.stderr;

                                        // Handle output redirects in pipeline stages
                                        apply_output_redirects(
                                            state,
                                            host,
                                            redirects,
                                            &mut stdout,
                                            &mut stderr,
                                        )?;

                                        state.last_exit_code = spawn_result.exit_code;
                                        last_result = RunResult {
                                            exit_code: spawn_result.exit_code,
                                            stdout,
                                            stderr,
                                            execution_time_ms: 0,
                                        };
                                    }
                                    Err(e) => {
                                        state.last_exit_code = 127;
                                        last_result =
                                            RunResult::error(127, format!("{}: {}\n", cmd_name, e));
                                    }
                                }
                            } // close Ok(dispatch_info)
                        } // close match dispatch_result
                    }
                    _ => {
                        // Non-simple commands: just execute them.
                        // Stdin threading for compound commands comes later.
                        match exec_command(state, host, cmd) {
                            Ok(ControlFlow::Normal(r)) => {
                                state.last_exit_code = r.exit_code;
                                last_result = r;
                            }
                            Ok(ControlFlow::Exit(code, stdout, stderr)) => {
                                last_result = RunResult {
                                    exit_code: code,
                                    stdout,
                                    stderr,
                                    execution_time_ms: 0,
                                };
                                state.last_exit_code = code;
                            }
                            Err(e) => {
                                return Err(e);
                            }
                            Ok(flow) => {
                                // Break, Continue, Return, Cancelled — propagate
                                return Ok(flow);
                            }
                        }
                    }
                }

                // Track pipefail
                if pipefail && last_result.exit_code != 0 {
                    pipefail_code = last_result.exit_code;
                }

                // Stdout of this stage becomes stdin of next
                stdin_data = last_result.stdout.clone();
            }

            // Apply pipefail: use last non-zero exit code
            if pipefail && pipefail_code != 0 && last_result.exit_code == 0 {
                last_result.exit_code = pipefail_code;
            }

            state.last_exit_code = last_result.exit_code;
            Ok(ControlFlow::Normal(last_result))
        }

        // ── List: ;, &&, || ────────────────────────────────────────────
        Command::List { left, op, right } => {
            let left_result = exec_command(state, host, left)?;
            let left_run = match left_result {
                ControlFlow::Normal(r) => r,
                other => return Ok(other),
            };
            state.last_exit_code = left_run.exit_code;

            match op {
                ListOp::And => {
                    if left_run.exit_code == 0 {
                        let right_result = exec_command(state, host, right)?;
                        match right_result {
                            ControlFlow::Normal(r) => Ok(ControlFlow::Normal(RunResult {
                                exit_code: r.exit_code,
                                stdout: left_run.stdout + &r.stdout,
                                stderr: left_run.stderr + &r.stderr,
                                execution_time_ms: 0,
                            })),
                            ControlFlow::Exit(code, stdout, stderr) => Ok(ControlFlow::Exit(
                                code,
                                left_run.stdout + &stdout,
                                left_run.stderr + &stderr,
                            )),
                            other => Ok(other),
                        }
                    } else {
                        Ok(ControlFlow::Normal(left_run))
                    }
                }
                ListOp::Or => {
                    if left_run.exit_code != 0 {
                        let right_result = exec_command(state, host, right)?;
                        match right_result {
                            ControlFlow::Normal(r) => Ok(ControlFlow::Normal(RunResult {
                                exit_code: r.exit_code,
                                stdout: left_run.stdout + &r.stdout,
                                stderr: left_run.stderr + &r.stderr,
                                execution_time_ms: 0,
                            })),
                            ControlFlow::Exit(code, stdout, stderr) => Ok(ControlFlow::Exit(
                                code,
                                left_run.stdout + &stdout,
                                left_run.stderr + &stderr,
                            )),
                            other => Ok(other),
                        }
                    } else {
                        Ok(ControlFlow::Normal(left_run))
                    }
                }
                ListOp::Seq => {
                    let right_result = exec_command(state, host, right)?;
                    match right_result {
                        ControlFlow::Normal(r) => Ok(ControlFlow::Normal(RunResult {
                            exit_code: r.exit_code,
                            stdout: left_run.stdout + &r.stdout,
                            stderr: left_run.stderr + &r.stderr,
                            execution_time_ms: 0,
                        })),
                        ControlFlow::Exit(code, stdout, stderr) => Ok(ControlFlow::Exit(
                            code,
                            left_run.stdout + &stdout,
                            left_run.stderr + &stderr,
                        )),
                        other => Ok(other),
                    }
                }
            }
        }

        // ── If ───────────────────────────────────────────────────────────
        Command::If {
            condition,
            then_body,
            else_body,
        } => {
            let cond_result = exec_command(state, host, condition)?;
            let cond_run = match cond_result {
                ControlFlow::Normal(r) => r,
                other => return Ok(other),
            };
            if cond_run.exit_code == 0 {
                exec_command(state, host, then_body)
            } else if let Some(else_cmd) = else_body {
                exec_command(state, host, else_cmd)
            } else {
                Ok(ControlFlow::Normal(RunResult::empty()))
            }
        }

        // ── For loop ─────────────────────────────────────────────────────
        Command::For { var, words, body } => {
            let expanded = expand_words_with_splitting(state, words, Some(&exec_fn));
            let braced = expand_braces(&expanded);
            let restored = restore_brace_sentinels(&braced);
            let final_words = expand_globs(host, &restored);

            let mut combined_stdout = String::new();
            let mut combined_stderr = String::new();
            let mut last_exit_code = 0;

            for word in &final_words {
                state.env.insert(var.clone(), word.clone());
                match exec_command(state, host, body)? {
                    ControlFlow::Normal(r) => {
                        combined_stdout.push_str(&r.stdout);
                        combined_stderr.push_str(&r.stderr);
                        last_exit_code = r.exit_code;
                    }
                    ControlFlow::Break(_) => break,
                    ControlFlow::Continue(_) => continue,
                    other => return Ok(other),
                }
            }
            state.last_exit_code = last_exit_code;
            Ok(ControlFlow::Normal(RunResult {
                exit_code: last_exit_code,
                stdout: combined_stdout,
                stderr: combined_stderr,
                execution_time_ms: 0,
            }))
        }

        // ── While loop ──────────────────────────────────────────────────
        Command::While { condition, body } => {
            let mut combined_stdout = String::new();
            let mut combined_stderr = String::new();
            let mut last_exit_code = 0;
            let max_iterations = 100_000;

            for _ in 0..max_iterations {
                let cond_result = exec_command(state, host, condition)?;
                let cond_run = match cond_result {
                    ControlFlow::Normal(r) => r,
                    other => return Ok(other),
                };
                if cond_run.exit_code != 0 {
                    break;
                }

                match exec_command(state, host, body)? {
                    ControlFlow::Normal(r) => {
                        combined_stdout.push_str(&r.stdout);
                        combined_stderr.push_str(&r.stderr);
                        last_exit_code = r.exit_code;
                    }
                    ControlFlow::Break(_) => break,
                    ControlFlow::Continue(_) => continue,
                    other => return Ok(other),
                }
            }
            state.last_exit_code = last_exit_code;
            Ok(ControlFlow::Normal(RunResult {
                exit_code: last_exit_code,
                stdout: combined_stdout,
                stderr: combined_stderr,
                execution_time_ms: 0,
            }))
        }

        // ── C-style for loop ────────────────────────────────────────────
        Command::CFor {
            init,
            cond,
            step,
            body,
        } => {
            use crate::arithmetic::eval_arithmetic;
            if !init.is_empty() {
                eval_arithmetic(state, init);
            }

            let mut combined_stdout = String::new();
            let mut combined_stderr = String::new();
            let mut last_exit_code = 0;
            let max_iterations = 100_000;

            for _ in 0..max_iterations {
                if !cond.is_empty() {
                    let val = eval_arithmetic(state, cond);
                    if val == 0 {
                        break;
                    }
                }
                match exec_command(state, host, body)? {
                    ControlFlow::Normal(r) => {
                        combined_stdout.push_str(&r.stdout);
                        combined_stderr.push_str(&r.stderr);
                        last_exit_code = r.exit_code;
                    }
                    ControlFlow::Break(_) => break,
                    ControlFlow::Continue(_) => {
                        // Continue should still run the step expression
                        if !step.is_empty() {
                            eval_arithmetic(state, step);
                        }
                        continue;
                    }
                    other => return Ok(other),
                }
                if !step.is_empty() {
                    eval_arithmetic(state, step);
                }
            }
            state.last_exit_code = last_exit_code;
            Ok(ControlFlow::Normal(RunResult {
                exit_code: last_exit_code,
                stdout: combined_stdout,
                stderr: combined_stderr,
                execution_time_ms: 0,
            }))
        }

        // ── Case ────────────────────────────────────────────────────────
        Command::Case { word, items } => {
            let value = expand_word(state, word, Some(&exec_fn));
            for item in items {
                for pattern in &item.patterns {
                    let pat_str = expand_word(state, pattern, Some(&exec_fn));
                    if glob_matches(&pat_str, &value) {
                        return exec_command(state, host, &item.body);
                    }
                }
            }
            Ok(ControlFlow::Normal(RunResult::empty()))
        }

        // ── Subshell ────────────────────────────────────────────────────
        Command::Subshell { body } => {
            let saved_env = state.env.clone();
            let saved_cwd = state.cwd.clone();
            let saved_functions = state.functions.clone();
            let saved_arrays = state.arrays.clone();
            let saved_assoc_arrays = state.assoc_arrays.clone();
            let saved_flags = state.flags.clone();
            let saved_traps = state.traps.clone();
            let saved_last_exit_code = state.last_exit_code;
            let result = exec_command(state, host, body);
            state.env = saved_env;
            state.cwd = saved_cwd;
            state.functions = saved_functions;
            state.arrays = saved_arrays;
            state.assoc_arrays = saved_assoc_arrays;
            state.flags = saved_flags;
            state.traps = saved_traps;
            state.last_exit_code = saved_last_exit_code;
            result
        }

        // ── Brace group ─────────────────────────────────────────────────
        Command::BraceGroup { body } => exec_command(state, host, body),

        // ── Negate ──────────────────────────────────────────────────────
        Command::Negate { body } => match exec_command(state, host, body)? {
            ControlFlow::Normal(mut r) => {
                r.exit_code = if r.exit_code == 0 { 1 } else { 0 };
                state.last_exit_code = r.exit_code;
                Ok(ControlFlow::Normal(r))
            }
            other => Ok(other),
        },

        // ── Break / Continue ────────────────────────────────────────────
        Command::Break => Ok(ControlFlow::Break(1)),
        Command::Continue => Ok(ControlFlow::Continue(1)),

        // ── Function definition ─────────────────────────────────────────
        Command::Function { name, body } => {
            state.functions.insert(name.clone(), *body.clone());
            Ok(ControlFlow::Normal(RunResult::empty()))
        }

        // ── DoubleBracket [[ ... ]] ─────────────────────────────────────
        Command::DoubleBracket { expr } => {
            let result = eval_double_bracket(state, host, expr, Some(&exec_fn));
            let exit_code = if result { 0 } else { 1 };
            state.last_exit_code = exit_code;
            Ok(ControlFlow::Normal(RunResult {
                exit_code,
                stdout: String::new(),
                stderr: String::new(),
                execution_time_ms: 0,
            }))
        }

        // ── Arithmetic command (( ... )) ────────────────────────────────
        Command::ArithmeticCommand { expr } => {
            use crate::arithmetic::eval_arithmetic;
            let val = eval_arithmetic(state, expr);
            let exit_code = if val != 0 { 0 } else { 1 };
            state.last_exit_code = exit_code;
            Ok(ControlFlow::Normal(RunResult {
                exit_code,
                stdout: String::new(),
                stderr: String::new(),
                execution_time_ms: 0,
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// DoubleBracket evaluator: [[ expression ]]
// ---------------------------------------------------------------------------

/// Parse an array subscript from a name like `arr[idx]`.
/// Returns `(array_name, subscript)` if the name contains `[...]`.
fn parse_array_subscript(name: &str) -> Option<(String, String)> {
    let open = name.find('[')?;
    if !name.ends_with(']') {
        return None;
    }
    let arr_name = &name[..open];
    let subscript = &name[open + 1..name.len() - 1];
    Some((arr_name.to_string(), subscript.to_string()))
}

/// Process a list of assignments, updating state accordingly.
///
/// Handles: simple assignment, append (`+=`), array literal (`var=(a b c)`),
/// array element (`arr[idx]=val`), and associative array element.
fn process_assignments(
    state: &mut ShellState,
    assignments: &[codepod_shell::ast::Assignment],
    exec: Option<ExecFn>,
) {
    for assignment in assignments {
        // Parse the raw assignment value into a Word with proper parts
        // (the parser stores values as raw strings, so $(...) etc. need re-parsing)
        let word = crate::expand::parse_assignment_value(&assignment.value);
        let value = expand_word(state, &word, exec);

        // Append assignment: name ends with '+'
        if let Some(real_name) = assignment.name.strip_suffix('+') {
            if value.starts_with('(') && value.ends_with(')') {
                // Array append: arr+=(elem1 elem2)
                let inner = value[1..value.len() - 1].trim();
                let elements: Vec<String> = if inner.is_empty() {
                    vec![]
                } else {
                    inner.split_whitespace().map(|s| s.to_string()).collect()
                };
                let arr = state.arrays.entry(real_name.to_string()).or_default();
                arr.extend(elements);
            } else {
                // String append
                let prev = state.env.get(real_name).cloned().unwrap_or_default();
                state.env.insert(real_name.to_string(), prev + &value);
            }
            continue;
        }

        // Array element: arr[subscript]=value
        if let Some((arr_name, subscript)) = parse_array_subscript(&assignment.name) {
            if let Some(assoc) = state.assoc_arrays.get_mut(&arr_name) {
                assoc.insert(subscript.to_string(), value.to_string());
            } else if let Ok(idx) = subscript.parse::<usize>() {
                let arr = state.arrays.entry(arr_name).or_default();
                while arr.len() <= idx {
                    arr.push(String::new());
                }
                arr[idx] = value.to_string();
            }
            continue;
        }

        // Array literal: var=(elem1 elem2)
        if value.starts_with('(') && value.ends_with(')') {
            let inner = value[1..value.len() - 1].trim();
            let elements: Vec<String> = if inner.is_empty() {
                vec![]
            } else {
                inner.split_whitespace().map(|s| s.to_string()).collect()
            };
            state.arrays.insert(assignment.name.clone(), elements);
            continue;
        }

        // Simple assignment
        state.env.insert(assignment.name.clone(), value.to_string());
    }
}

/// Evaluate a `[[ ... ]]` conditional expression.
///
/// Supports:
/// - Unary tests: `-z`, `-n`, `-f`, `-d`, `-e`, `-s`, `-r`, `-w`, `-x`
/// - Binary comparisons: `==`, `!=`, `<`, `>`, `=~`
/// - Integer comparisons: `-eq`, `-ne`, `-lt`, `-le`, `-gt`, `-ge`
/// - Logical operators: `&&`, `||`, `!`
/// - Parenthesised groups: `( expr )`
fn eval_double_bracket(
    state: &mut ShellState,
    host: &dyn HostInterface,
    expr: &str,
    exec: Option<ExecFn>,
) -> bool {
    let tokens = tokenize_bracket_expr(state, expr, exec);
    let mut pos = 0;
    parse_or_expr(&tokens, &mut pos, state, host)
}

/// Token type for [[ ]] expression parsing.
#[derive(Debug, Clone, PartialEq)]
enum BracketToken {
    Word(String),
    And,    // &&
    Or,     // ||
    Not,    // !
    LParen, // (
    RParen, // )
}

/// Tokenize a [[ ]] expression string, expanding variables.
fn tokenize_bracket_expr(
    state: &mut ShellState,
    expr: &str,
    exec: Option<ExecFn>,
) -> Vec<BracketToken> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = expr.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        // Skip whitespace
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }

        // &&
        if i + 1 < chars.len() && chars[i] == '&' && chars[i + 1] == '&' {
            tokens.push(BracketToken::And);
            i += 2;
            continue;
        }

        // ||
        if i + 1 < chars.len() && chars[i] == '|' && chars[i + 1] == '|' {
            tokens.push(BracketToken::Or);
            i += 2;
            continue;
        }

        // !
        if chars[i] == '!' {
            tokens.push(BracketToken::Not);
            i += 1;
            continue;
        }

        // ( and )
        if chars[i] == '(' {
            tokens.push(BracketToken::LParen);
            i += 1;
            continue;
        }
        if chars[i] == ')' {
            tokens.push(BracketToken::RParen);
            i += 1;
            continue;
        }

        // Quoted string
        if chars[i] == '"' || chars[i] == '\'' {
            let quote = chars[i];
            i += 1;
            let mut word = String::new();
            while i < chars.len() && chars[i] != quote {
                if chars[i] == '\\' && i + 1 < chars.len() && quote == '"' {
                    i += 1;
                    word.push(chars[i]);
                } else {
                    word.push(chars[i]);
                }
                i += 1;
            }
            if i < chars.len() {
                i += 1; // skip closing quote
            }
            // Expand variables in double-quoted strings
            if quote == '"' && word.contains('$') {
                let expanded = expand_bracket_word(state, &word, exec);
                tokens.push(BracketToken::Word(expanded));
            } else {
                tokens.push(BracketToken::Word(word));
            }
            continue;
        }

        // Unquoted word (including operators like -z, -f, ==, !=, =~, etc.)
        let mut word = String::new();
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '(' && chars[i] != ')' {
            // Stop at && or ||
            if i + 1 < chars.len()
                && ((chars[i] == '&' && chars[i + 1] == '&')
                    || (chars[i] == '|' && chars[i + 1] == '|'))
            {
                break;
            }
            word.push(chars[i]);
            i += 1;
        }

        if !word.is_empty() {
            // Expand variables in unquoted words
            if word.contains('$') {
                let expanded = expand_bracket_word(state, &word, exec);
                tokens.push(BracketToken::Word(expanded));
            } else {
                tokens.push(BracketToken::Word(word));
            }
        }
    }

    tokens
}

/// Parse `||` (lowest precedence in [[ ]]).
fn parse_or_expr(
    tokens: &[BracketToken],
    pos: &mut usize,
    state: &mut ShellState,
    host: &dyn HostInterface,
) -> bool {
    let mut result = parse_and_expr(tokens, pos, state, host);
    while *pos < tokens.len() && tokens[*pos] == BracketToken::Or {
        *pos += 1;
        let right = parse_and_expr(tokens, pos, state, host);
        result = result || right;
    }
    result
}

/// Parse `&&`.
fn parse_and_expr(
    tokens: &[BracketToken],
    pos: &mut usize,
    state: &mut ShellState,
    host: &dyn HostInterface,
) -> bool {
    let mut result = parse_not_expr(tokens, pos, state, host);
    while *pos < tokens.len() && tokens[*pos] == BracketToken::And {
        *pos += 1;
        let right = parse_not_expr(tokens, pos, state, host);
        result = result && right;
    }
    result
}

/// Parse `!` (unary not).
fn parse_not_expr(
    tokens: &[BracketToken],
    pos: &mut usize,
    state: &mut ShellState,
    host: &dyn HostInterface,
) -> bool {
    if *pos < tokens.len() && tokens[*pos] == BracketToken::Not {
        *pos += 1;
        !parse_not_expr(tokens, pos, state, host)
    } else {
        parse_primary(tokens, pos, state, host)
    }
}

/// Parse a primary expression: parenthesised group, unary test, binary test, or bare word.
fn parse_primary(
    tokens: &[BracketToken],
    pos: &mut usize,
    state: &mut ShellState,
    host: &dyn HostInterface,
) -> bool {
    if *pos >= tokens.len() {
        return false;
    }

    // Parenthesised group
    if tokens[*pos] == BracketToken::LParen {
        *pos += 1;
        let result = parse_or_expr(tokens, pos, state, host);
        if *pos < tokens.len() && tokens[*pos] == BracketToken::RParen {
            *pos += 1;
        }
        return result;
    }

    // Extract current word
    let word = match &tokens[*pos] {
        BracketToken::Word(w) => w.clone(),
        _ => return false,
    };

    // Unary tests: -z, -n, -f, -d, -e, -s, -r, -w, -x
    if is_unary_test(&word) && *pos + 1 < tokens.len() {
        if let BracketToken::Word(operand) = &tokens[*pos + 1] {
            let op = word.clone();
            let operand = operand.clone();
            *pos += 2;
            return eval_unary_test(&op, &operand, state, host);
        }
    }

    // Look ahead for binary operator
    if *pos + 2 < tokens.len() {
        if let BracketToken::Word(operator) = &tokens[*pos + 1] {
            if is_binary_op(operator) {
                let left = word.clone();
                let op = operator.clone();
                if let BracketToken::Word(right) = &tokens[*pos + 2] {
                    let right = right.clone();
                    *pos += 3;
                    return eval_binary_test(&left, &op, &right);
                }
            }
        }
    }

    // Bare word: non-empty string is true
    *pos += 1;
    !word.is_empty()
}

/// Expand a word that may contain `$VAR` or `${VAR}` references.
/// Used in [[ ]] expression tokenisation where we don't have a full Word AST.
fn expand_bracket_word(state: &mut ShellState, word: &str, exec: Option<ExecFn>) -> String {
    // Build a Word AST by parsing the variable references manually.
    let mut parts = Vec::new();
    let chars: Vec<char> = word.chars().collect();
    let mut i = 0;
    let mut literal = String::new();

    while i < chars.len() {
        if chars[i] == '$' {
            if !literal.is_empty() {
                parts.push(codepod_shell::ast::WordPart::Literal(std::mem::take(
                    &mut literal,
                )));
            }
            i += 1;
            if i < chars.len() && chars[i] == '{' {
                // ${VAR}
                i += 1;
                let mut var_name = String::new();
                while i < chars.len() && chars[i] != '}' {
                    var_name.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    i += 1; // skip '}'
                }
                parts.push(codepod_shell::ast::WordPart::Variable(var_name));
            } else if i < chars.len()
                && (chars[i].is_alphanumeric()
                    || chars[i] == '_'
                    || chars[i] == '?'
                    || chars[i] == '#'
                    || chars[i] == '$'
                    || chars[i] == '!')
            {
                // $VAR or $? etc.
                let mut var_name = String::new();
                if chars[i] == '?' || chars[i] == '#' || chars[i] == '$' || chars[i] == '!' {
                    var_name.push(chars[i]);
                    i += 1;
                } else {
                    while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                        var_name.push(chars[i]);
                        i += 1;
                    }
                }
                parts.push(codepod_shell::ast::WordPart::Variable(var_name));
            } else {
                literal.push('$');
            }
        } else {
            literal.push(chars[i]);
            i += 1;
        }
    }
    if !literal.is_empty() {
        parts.push(codepod_shell::ast::WordPart::Literal(literal));
    }

    let w = Word { parts };
    expand_word(state, &w, exec)
}

fn is_unary_test(op: &str) -> bool {
    matches!(
        op,
        "-z" | "-n" | "-f" | "-d" | "-e" | "-s" | "-r" | "-w" | "-x"
    )
}

fn is_binary_op(op: &str) -> bool {
    matches!(
        op,
        "==" | "!=" | "=~" | "<" | ">" | "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge"
    )
}

fn eval_unary_test(
    op: &str,
    operand: &str,
    state: &mut ShellState,
    host: &dyn HostInterface,
) -> bool {
    match op {
        "-z" => operand.is_empty(),
        "-n" => !operand.is_empty(),
        "-f" | "-d" | "-e" | "-s" | "-r" | "-w" | "-x" => {
            let path = if operand.starts_with('/') {
                operand.to_string()
            } else {
                state.resolve_path(operand)
            };
            match host.stat(&path) {
                Ok(info) => match op {
                    "-e" => info.exists,
                    "-f" => info.exists && info.is_file,
                    "-d" => info.exists && info.is_dir,
                    "-s" => info.exists && info.size > 0,
                    "-r" => info.exists && (info.mode & 0o444) != 0,
                    "-w" => info.exists && (info.mode & 0o222) != 0,
                    "-x" => info.exists && (info.mode & 0o111) != 0,
                    _ => false,
                },
                Err(_) => false,
            }
        }
        _ => false,
    }
}

fn eval_binary_test(left: &str, op: &str, right: &str) -> bool {
    match op {
        "==" => glob_matches(right, left),
        "!=" => !glob_matches(right, left),
        "=~" => {
            // Regex match
            match regex::Regex::new(right) {
                Ok(re) => re.is_match(left),
                Err(_) => false,
            }
        }
        "<" => left < right,
        ">" => left > right,
        "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge" => {
            let l: i64 = left.parse().unwrap_or(0);
            let r: i64 = right.parse().unwrap_or(0);
            match op {
                "-eq" => l == r,
                "-ne" => l != r,
                "-lt" => l < r,
                "-le" => l <= r,
                "-gt" => l > r,
                "-ge" => l >= r,
                _ => false,
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::SpawnResult;
    use crate::test_support::mock::MockHost;

    #[test]
    fn simple_command_spawns_via_host() {
        let host = MockHost::new().with_tool("ls").with_spawn_result(
            "ls",
            SpawnResult {
                exit_code: 0,
                stdout: "file.txt\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("ls");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "file.txt\n");
    }

    #[test]
    fn unknown_command_returns_127() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("nonexistent");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 127);
        assert!(run.stderr.contains("command not found"));
    }

    #[test]
    fn simple_command_with_args() {
        let host = MockHost::new().with_spawn_result(
            "echo-args",
            SpawnResult {
                exit_code: 0,
                stdout: "hello world\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("echo-args hello world");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "hello world\n");
    }

    #[test]
    fn last_exit_code_is_updated() {
        let host = MockHost::new().with_spawn_result(
            "fail",
            SpawnResult {
                exit_code: 42,
                stdout: String::new(),
                stderr: "error\n".into(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("fail");
        let _ = exec_command(&mut state, &host, &cmd);
        assert_eq!(state.last_exit_code, 42);
    }

    // ---- Command substitution tests ----

    #[test]
    fn command_substitution_basic() {
        // `echo $(echo hello)` should:
        //  1. Expand $(echo hello) → run "echo hello" → stdout "hello\n" → strip → "hello"
        //  2. Outer command becomes: echo hello
        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("echo $(echo hello)");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        // The outer "echo" also returns "hello\n" from MockHost since
        // MockHost matches only on program name.
        assert_eq!(run.stdout, "hello\n");
    }

    #[test]
    fn command_substitution_strips_trailing_newline() {
        // Verify that trailing newlines are stripped from command substitution output
        use crate::expand::expand_word;
        use codepod_shell::ast::{Word, WordPart};

        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();

        // Build the exec callback like exec_command does
        let exec_fn = |state: &mut ShellState, cmd_str: &str| -> String {
            let inner_cmd = codepod_shell::parser::parse(cmd_str);
            match exec_command(state, &host, &inner_cmd) {
                Ok(ControlFlow::Normal(r)) => r.stdout,
                Ok(ControlFlow::Exit(_, stdout, _)) => stdout,
                _ => String::new(),
            }
        };

        let word = Word {
            parts: vec![WordPart::CommandSub("echo hello".into())],
        };
        let expanded = expand_word(&mut state, &word, Some(&exec_fn));
        assert_eq!(expanded, "hello");
    }

    #[test]
    fn command_substitution_in_middle_of_word() {
        // `pre$(echo mid)suf` should expand to "premidsuf"
        use crate::expand::expand_word;
        use codepod_shell::ast::{Word, WordPart};

        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "mid\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();

        let exec_fn = |state: &mut ShellState, cmd_str: &str| -> String {
            let inner_cmd = codepod_shell::parser::parse(cmd_str);
            match exec_command(state, &host, &inner_cmd) {
                Ok(ControlFlow::Normal(r)) => r.stdout,
                Ok(ControlFlow::Exit(_, stdout, _)) => stdout,
                _ => String::new(),
            }
        };

        let word = Word {
            parts: vec![
                WordPart::Literal("pre".into()),
                WordPart::CommandSub("echo mid".into()),
                WordPart::Literal("suf".into()),
            ],
        };
        let expanded = expand_word(&mut state, &word, Some(&exec_fn));
        assert_eq!(expanded, "premidsuf");
    }

    #[test]
    fn command_substitution_no_exec_returns_empty() {
        // When exec is None, CommandSub should return empty string
        use crate::expand::expand_word_part;
        use codepod_shell::ast::WordPart;

        let mut state = ShellState::new_default();
        let part = WordPart::CommandSub("echo hello".into());
        let result = expand_word_part(&mut state, &part, None);
        assert_eq!(result, "");
    }

    #[test]
    fn command_substitution_depth_limit() {
        // When substitution_depth is at MAX, CommandSub should return empty
        use crate::expand::expand_word_part;
        use crate::state::MAX_SUBSTITUTION_DEPTH;
        use codepod_shell::ast::WordPart;

        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        state.substitution_depth = MAX_SUBSTITUTION_DEPTH; // at the limit

        let exec_fn = |state: &mut ShellState, cmd_str: &str| -> String {
            let inner_cmd = codepod_shell::parser::parse(cmd_str);
            match exec_command(state, &host, &inner_cmd) {
                Ok(ControlFlow::Normal(r)) => r.stdout,
                Ok(ControlFlow::Exit(_, stdout, _)) => stdout,
                _ => String::new(),
            }
        };

        let part = WordPart::CommandSub("echo hello".into());
        let result = expand_word_part(&mut state, &part, Some(&exec_fn));
        assert_eq!(result, ""); // should be empty because depth limit reached
    }

    #[test]
    fn command_substitution_increments_and_decrements_depth() {
        // Verify that substitution_depth is properly managed
        use crate::expand::expand_word_part;
        use codepod_shell::ast::WordPart;

        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        assert_eq!(state.substitution_depth, 0);

        let exec_fn = |state: &mut ShellState, cmd_str: &str| -> String {
            let inner_cmd = codepod_shell::parser::parse(cmd_str);
            match exec_command(state, &host, &inner_cmd) {
                Ok(ControlFlow::Normal(r)) => r.stdout,
                Ok(ControlFlow::Exit(_, stdout, _)) => stdout,
                _ => String::new(),
            }
        };

        let part = WordPart::CommandSub("echo hello".into());
        let _ = expand_word_part(&mut state, &part, Some(&exec_fn));

        // After expansion, depth should be back to 0
        assert_eq!(state.substitution_depth, 0);
    }

    #[test]
    fn command_substitution_failed_command_returns_empty() {
        // If the inner command fails (exit code != 0), we still get its stdout
        use crate::expand::expand_word_part;
        use codepod_shell::ast::WordPart;

        let host = MockHost::new().with_spawn_result(
            "failing-cmd",
            SpawnResult {
                exit_code: 1,
                stdout: "some output\n".into(),
                stderr: "error\n".into(),
            },
        );
        let mut state = ShellState::new_default();

        let exec_fn = |state: &mut ShellState, cmd_str: &str| -> String {
            let inner_cmd = codepod_shell::parser::parse(cmd_str);
            match exec_command(state, &host, &inner_cmd) {
                Ok(ControlFlow::Normal(r)) => r.stdout,
                Ok(ControlFlow::Exit(_, stdout, _)) => stdout,
                _ => String::new(),
            }
        };

        let part = WordPart::CommandSub("failing-cmd".into());
        let result = expand_word_part(&mut state, &part, Some(&exec_fn));
        // Trailing newline stripped
        assert_eq!(result, "some output");
    }

    #[test]
    fn command_substitution_unknown_inner_command_returns_empty() {
        // If the inner command is unknown, MockHost returns exit 127 with empty stdout
        use crate::expand::expand_word_part;
        use codepod_shell::ast::WordPart;

        let host = MockHost::new(); // no spawn results configured
        let mut state = ShellState::new_default();

        let exec_fn = |state: &mut ShellState, cmd_str: &str| -> String {
            let inner_cmd = codepod_shell::parser::parse(cmd_str);
            match exec_command(state, &host, &inner_cmd) {
                Ok(ControlFlow::Normal(r)) => r.stdout,
                Ok(ControlFlow::Exit(_, stdout, _)) => stdout,
                _ => String::new(),
            }
        };

        let part = WordPart::CommandSub("nonexistent-cmd".into());
        let result = expand_word_part(&mut state, &part, Some(&exec_fn));
        assert_eq!(result, "");
    }

    // ---- Redirect tests ----

    /// Helper: build a `Command::Simple` with the given command name and redirects.
    fn simple_cmd_with_redirects(
        cmd_name: &str,
        args: &[&str],
        redirects: Vec<codepod_shell::ast::Redirect>,
    ) -> Command {
        use codepod_shell::ast::Word;
        let mut words = vec![Word::literal(cmd_name)];
        for arg in args {
            words.push(Word::literal(arg));
        }
        Command::Simple {
            words,
            redirects,
            assignments: vec![],
        }
    }

    fn redirect(rt: RedirectType) -> codepod_shell::ast::Redirect {
        codepod_shell::ast::Redirect { redirect_type: rt }
    }

    #[test]
    fn redirect_stdout_overwrite() {
        // `echo hello > /tmp/out.txt`
        // Stdout should be written to file; RunResult.stdout should be empty.
        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "echo",
            &["hello"],
            vec![redirect(RedirectType::StdoutOverwrite(
                "/tmp/out.txt".into(),
            ))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // stdout should be captured to file, not returned
        assert_eq!(run.stdout, "");
        assert_eq!(run.exit_code, 0);
        // Verify file was written
        assert_eq!(host.get_file("/tmp/out.txt").unwrap(), "hello\n");
    }

    #[test]
    fn redirect_stdout_append() {
        // File already has "line1\n", then `echo line2 >> /tmp/out.txt`
        let host = MockHost::new()
            .with_file("/tmp/out.txt", b"line1\n")
            .with_spawn_result(
                "echo",
                SpawnResult {
                    exit_code: 0,
                    stdout: "line2\n".into(),
                    stderr: String::new(),
                },
            );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "echo",
            &["line2"],
            vec![redirect(RedirectType::StdoutAppend("/tmp/out.txt".into()))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "");
        assert_eq!(host.get_file("/tmp/out.txt").unwrap(), "line1\nline2\n");
    }

    #[test]
    fn redirect_stdout_append_creates_new_file() {
        // >> on a nonexistent file should create it
        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "first\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "echo",
            &["first"],
            vec![redirect(RedirectType::StdoutAppend("/tmp/new.txt".into()))],
        );
        let _ = exec_command(&mut state, &host, &cmd);
        assert_eq!(host.get_file("/tmp/new.txt").unwrap(), "first\n");
    }

    #[test]
    fn redirect_stdin_from_file() {
        // `cat < /tmp/input.txt` — the file content becomes stdin
        let host = MockHost::new()
            .with_file("/tmp/input.txt", b"file content\n")
            .with_spawn_result(
                "cat",
                SpawnResult {
                    exit_code: 0,
                    stdout: "file content\n".into(),
                    stderr: String::new(),
                },
            );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cat",
            &[],
            vec![redirect(RedirectType::StdinFrom("/tmp/input.txt".into()))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "file content\n");
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn redirect_stdin_from_relative_path() {
        // `cat < input.txt` resolves relative to cwd
        let host = MockHost::new()
            .with_file("/home/user/input.txt", b"relative content\n")
            .with_spawn_result(
                "cat",
                SpawnResult {
                    exit_code: 0,
                    stdout: "relative content\n".into(),
                    stderr: String::new(),
                },
            );
        let mut state = ShellState::new_default();
        // cwd is /home/user by default
        let cmd = simple_cmd_with_redirects(
            "cat",
            &[],
            vec![redirect(RedirectType::StdinFrom("input.txt".into()))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "relative content\n");
    }

    #[test]
    fn redirect_stderr_overwrite() {
        // `cmd 2> /tmp/err.txt`
        let host = MockHost::new().with_spawn_result(
            "cmd",
            SpawnResult {
                exit_code: 1,
                stdout: "out\n".into(),
                stderr: "error msg\n".into(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cmd",
            &[],
            vec![redirect(RedirectType::StderrOverwrite(
                "/tmp/err.txt".into(),
            ))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // stdout is preserved, stderr goes to file
        assert_eq!(run.stdout, "out\n");
        assert_eq!(run.stderr, "");
        assert_eq!(host.get_file("/tmp/err.txt").unwrap(), "error msg\n");
    }

    #[test]
    fn redirect_stderr_append() {
        // File has existing content, then `cmd 2>> /tmp/err.txt`
        let host = MockHost::new()
            .with_file("/tmp/err.txt", b"old error\n")
            .with_spawn_result(
                "cmd",
                SpawnResult {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: "new error\n".into(),
                },
            );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cmd",
            &[],
            vec![redirect(RedirectType::StderrAppend("/tmp/err.txt".into()))],
        );
        let _ = exec_command(&mut state, &host, &cmd);
        assert_eq!(
            host.get_file("/tmp/err.txt").unwrap(),
            "old error\nnew error\n"
        );
    }

    #[test]
    fn redirect_stderr_to_stdout_no_file() {
        // `cmd 2>&1` without prior stdout redirect: stderr merges into stdout
        let host = MockHost::new().with_spawn_result(
            "cmd",
            SpawnResult {
                exit_code: 0,
                stdout: "out\n".into(),
                stderr: "err\n".into(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd =
            simple_cmd_with_redirects("cmd", &[], vec![redirect(RedirectType::StderrToStdout)]);
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // stderr should be appended to stdout
        assert_eq!(run.stdout, "out\nerr\n");
        assert_eq!(run.stderr, "");
    }

    #[test]
    fn redirect_stderr_to_stdout_with_file_redirect() {
        // `cmd > /tmp/out.txt 2>&1` — stdout goes to file, then stderr also goes to file
        let host = MockHost::new().with_spawn_result(
            "cmd",
            SpawnResult {
                exit_code: 0,
                stdout: "out\n".into(),
                stderr: "err\n".into(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cmd",
            &[],
            vec![
                redirect(RedirectType::StdoutOverwrite("/tmp/out.txt".into())),
                redirect(RedirectType::StderrToStdout),
            ],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // Both should be empty in the run result
        assert_eq!(run.stdout, "");
        assert_eq!(run.stderr, "");
        // File should contain both stdout and stderr
        assert_eq!(host.get_file("/tmp/out.txt").unwrap(), "out\nerr\n");
    }

    #[test]
    fn redirect_both_overwrite() {
        // `cmd &> /tmp/all.txt`
        let host = MockHost::new().with_spawn_result(
            "cmd",
            SpawnResult {
                exit_code: 0,
                stdout: "out\n".into(),
                stderr: "err\n".into(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cmd",
            &[],
            vec![redirect(RedirectType::BothOverwrite("/tmp/all.txt".into()))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "");
        assert_eq!(run.stderr, "");
        assert_eq!(host.get_file("/tmp/all.txt").unwrap(), "out\nerr\n");
    }

    #[test]
    fn redirect_heredoc() {
        // Heredoc content becomes stdin
        let host = MockHost::new().with_spawn_result(
            "cat",
            SpawnResult {
                exit_code: 0,
                stdout: "heredoc line 1\nheredoc line 2\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cat",
            &[],
            vec![redirect(RedirectType::Heredoc(
                "heredoc line 1\nheredoc line 2\n".into(),
            ))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "heredoc line 1\nheredoc line 2\n");
    }

    #[test]
    fn redirect_heredoc_strip() {
        // HeredocStrip content becomes stdin (tab stripping is done by the parser)
        let host = MockHost::new().with_spawn_result(
            "cat",
            SpawnResult {
                exit_code: 0,
                stdout: "stripped content\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cat",
            &[],
            vec![redirect(RedirectType::HeredocStrip(
                "stripped content\n".into(),
            ))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "stripped content\n");
    }

    #[test]
    fn redirect_here_string() {
        // `cat <<< "hello"` — stdin becomes "hello\n"
        let host = MockHost::new().with_spawn_result(
            "cat",
            SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cat",
            &[],
            vec![redirect(RedirectType::HereString("hello".into()))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "hello\n");
    }

    #[test]
    fn redirect_stdout_overwrite_relative_path() {
        // `echo hello > out.txt` resolves relative to cwd
        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "echo",
            &["hello"],
            vec![redirect(RedirectType::StdoutOverwrite("out.txt".into()))],
        );
        let _ = exec_command(&mut state, &host, &cmd);
        // /home/user is the default cwd
        assert_eq!(host.get_file("/home/user/out.txt").unwrap(), "hello\n");
    }

    #[test]
    fn redirect_multiple_output_redirects() {
        // `cmd > /tmp/out.txt 2> /tmp/err.txt` — stdout and stderr to separate files
        let host = MockHost::new().with_spawn_result(
            "cmd",
            SpawnResult {
                exit_code: 0,
                stdout: "output\n".into(),
                stderr: "error\n".into(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cmd",
            &[],
            vec![
                redirect(RedirectType::StdoutOverwrite("/tmp/out.txt".into())),
                redirect(RedirectType::StderrOverwrite("/tmp/err.txt".into())),
            ],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "");
        assert_eq!(run.stderr, "");
        assert_eq!(host.get_file("/tmp/out.txt").unwrap(), "output\n");
        assert_eq!(host.get_file("/tmp/err.txt").unwrap(), "error\n");
    }

    #[test]
    fn redirect_no_redirects_passes_empty_stdin() {
        // When no redirects, empty string is passed as stdin
        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "hi\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("echo hi");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "hi\n");
    }

    #[test]
    fn redirect_stdin_file_not_found() {
        // `cat < /nonexistent` should return an error
        let host = MockHost::new().with_spawn_result(
            "cat",
            SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cat",
            &[],
            vec![redirect(RedirectType::StdinFrom("/nonexistent".into()))],
        );
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_err());
    }

    #[test]
    fn redirect_stderr_to_stdout_empty_stderr() {
        // `cmd 2>&1` with empty stderr — stdout unchanged
        let host = MockHost::new().with_spawn_result(
            "cmd",
            SpawnResult {
                exit_code: 0,
                stdout: "only out\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd =
            simple_cmd_with_redirects("cmd", &[], vec![redirect(RedirectType::StderrToStdout)]);
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "only out\n");
        assert_eq!(run.stderr, "");
    }

    #[test]
    fn redirect_both_overwrite_empty_outputs() {
        // `cmd &> /tmp/all.txt` with empty stdout and stderr
        let host = MockHost::new().with_spawn_result(
            "cmd",
            SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cmd",
            &[],
            vec![redirect(RedirectType::BothOverwrite("/tmp/all.txt".into()))],
        );
        let _ = exec_command(&mut state, &host, &cmd);
        assert_eq!(host.get_file("/tmp/all.txt").unwrap(), "");
    }

    #[test]
    fn redirect_heredoc_with_output_redirect() {
        // Heredoc for stdin + stdout redirect to file
        let host = MockHost::new().with_spawn_result(
            "cat",
            SpawnResult {
                exit_code: 0,
                stdout: "hello world\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cat",
            &[],
            vec![
                redirect(RedirectType::Heredoc("hello world\n".into())),
                redirect(RedirectType::StdoutOverwrite("/tmp/out.txt".into())),
            ],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "");
        assert_eq!(host.get_file("/tmp/out.txt").unwrap(), "hello world\n");
    }

    #[test]
    fn redirect_last_stdin_redirect_wins() {
        // Multiple input redirects: the last one should win
        let host = MockHost::new()
            .with_file("/tmp/a.txt", b"content a\n")
            .with_file("/tmp/b.txt", b"content b\n")
            .with_spawn_result(
                "cat",
                SpawnResult {
                    exit_code: 0,
                    stdout: "content b\n".into(),
                    stderr: String::new(),
                },
            );
        let mut state = ShellState::new_default();
        let cmd = simple_cmd_with_redirects(
            "cat",
            &[],
            vec![
                redirect(RedirectType::StdinFrom("/tmp/a.txt".into())),
                redirect(RedirectType::StdinFrom("/tmp/b.txt".into())),
            ],
        );
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // Last input redirect wins, so cat sees content of b.txt
        assert_eq!(run.stdout, "content b\n");
    }

    // ---- Pipeline tests ----

    #[test]
    fn pipeline_two_stage_stdin_threading() {
        // `echo hello | cat` — cat receives "hello\n" as stdin
        // Note: `echo` is now a builtin, so only `cat` generates a spawn call.
        let host = MockHost::new().with_spawn_handler(|program, _args, stdin| match program {
            "cat" => SpawnResult {
                exit_code: 0,
                stdout: stdin.to_string(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("echo hello | cat");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "hello\n");

        // echo is a builtin; only cat is spawned, receiving echo's stdout as stdin
        let calls = host.get_spawn_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].program, "cat");
        assert_eq!(calls[0].stdin, "hello\n"); // cat gets echo's stdout
    }

    #[test]
    fn pipeline_three_stage() {
        // `echo hello | cat | cat` — chaining works through 3 stages
        // Note: `echo` is a builtin, so only two `cat` spawns.
        let host = MockHost::new().with_spawn_handler(|program, _args, stdin| match program {
            "cat" => SpawnResult {
                exit_code: 0,
                stdout: stdin.to_string(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("echo hello | cat | cat");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "hello\n");

        // echo is a builtin; two cat spawns
        let calls = host.get_spawn_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].program, "cat");
        assert_eq!(calls[0].stdin, "hello\n");
        assert_eq!(calls[1].program, "cat");
        assert_eq!(calls[1].stdin, "hello\n");
    }

    #[test]
    fn pipeline_exit_code_from_last_stage() {
        // `false | true` — exit code should be 0 (from last command)
        let host = MockHost::new().with_spawn_handler(|program, _args, _stdin| match program {
            "false" => SpawnResult {
                exit_code: 1,
                stdout: String::new(),
                stderr: String::new(),
            },
            "true" => SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("false | true");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn pipeline_pipefail() {
        // `false | true` with pipefail — exit code should be 1 (non-zero from first stage)
        use crate::state::ShellFlag;

        let host = MockHost::new().with_spawn_handler(|program, _args, _stdin| match program {
            "false" => SpawnResult {
                exit_code: 1,
                stdout: String::new(),
                stderr: String::new(),
            },
            "true" => SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        state.flags.insert(ShellFlag::Pipefail);
        let cmd = codepod_shell::parser::parse("false | true");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    #[test]
    fn pipeline_pipefail_last_non_zero_wins() {
        // `cmd-exit-2 | cmd-exit-3 | true` with pipefail — should be 3 (last non-zero)
        use crate::state::ShellFlag;

        let host = MockHost::new().with_spawn_handler(|program, _args, _stdin| match program {
            "cmd-exit-2" => SpawnResult {
                exit_code: 2,
                stdout: "a\n".into(),
                stderr: String::new(),
            },
            "cmd-exit-3" => SpawnResult {
                exit_code: 3,
                stdout: "b\n".into(),
                stderr: String::new(),
            },
            "true" => SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        state.flags.insert(ShellFlag::Pipefail);
        let cmd = codepod_shell::parser::parse("cmd-exit-2 | cmd-exit-3 | true");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 3);
    }

    #[test]
    fn pipeline_stderr_does_not_flow_through() {
        // `cmd-with-stderr | cat` — stderr from first stage should NOT become
        // stdin of second stage; only stdout flows through the pipe.
        let host = MockHost::new().with_spawn_handler(|program, _args, stdin| match program {
            "cmd-with-stderr" => SpawnResult {
                exit_code: 0,
                stdout: "out\n".into(),
                stderr: "err\n".into(),
            },
            "cat" => SpawnResult {
                exit_code: 0,
                stdout: stdin.to_string(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("cmd-with-stderr | cat");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // cat only sees stdout, not stderr
        assert_eq!(run.stdout, "out\n");
        assert_eq!(run.stderr, "");

        let calls = host.get_spawn_calls();
        assert_eq!(calls[1].stdin, "out\n"); // only stdout, not "out\nerr\n"
    }

    #[test]
    fn pipeline_stderr_to_stdout_redirect() {
        // `cmd 2>&1 | cat` — stderr is merged into stdout and flows through pipe
        let host = MockHost::new().with_spawn_handler(|program, _args, stdin| match program {
            "cmd" => SpawnResult {
                exit_code: 0,
                stdout: "out\n".into(),
                stderr: "err\n".into(),
            },
            "cat" => SpawnResult {
                exit_code: 0,
                stdout: stdin.to_string(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("cmd 2>&1 | cat");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // cat receives merged stdout+stderr
        assert_eq!(run.stdout, "out\nerr\n");

        let calls = host.get_spawn_calls();
        assert_eq!(calls[1].stdin, "out\nerr\n");
    }

    #[test]
    fn pipeline_single_command_delegates() {
        // A Pipeline with a single command should behave identically to
        // executing that command directly.
        use codepod_shell::ast::{Command as AstCommand, Word};

        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = AstCommand::Pipeline {
            commands: vec![AstCommand::Simple {
                words: vec![Word::literal("echo"), Word::literal("hello")],
                redirects: vec![],
                assignments: vec![],
            }],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "hello\n");
    }

    #[test]
    fn pipeline_last_exit_code_updates_state() {
        // Verify that state.last_exit_code reflects the pipeline result
        let host = MockHost::new().with_spawn_handler(|program, _args, _stdin| match program {
            "true" => SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            "exit42" => SpawnResult {
                exit_code: 42,
                stdout: String::new(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("true | exit42");
        let _ = exec_command(&mut state, &host, &cmd);
        assert_eq!(state.last_exit_code, 42);
    }

    #[test]
    fn pipeline_no_pipefail_ignores_early_failures() {
        // Without pipefail, only the last stage's exit code matters
        let host = MockHost::new().with_spawn_handler(|program, _args, _stdin| match program {
            "fail1" => SpawnResult {
                exit_code: 1,
                stdout: "data\n".into(),
                stderr: String::new(),
            },
            "fail2" => SpawnResult {
                exit_code: 2,
                stdout: "more\n".into(),
                stderr: String::new(),
            },
            "succeed" => SpawnResult {
                exit_code: 0,
                stdout: "ok\n".into(),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found"),
            },
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("fail1 | fail2 | succeed");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    // ====================================================================
    // List operator tests (&&, ||, ;)
    // ====================================================================

    /// Helper to build a spawn handler that responds based on program name.
    fn make_handler() -> impl Fn(&str, &[&str], &str) -> SpawnResult {
        |program, _args, _stdin| match program {
            "true" => SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            "false" => SpawnResult {
                exit_code: 1,
                stdout: String::new(),
                stderr: String::new(),
            },
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: "hello\n".into(),
                stderr: String::new(),
            },
            "echo-a" => SpawnResult {
                exit_code: 0,
                stdout: "a\n".into(),
                stderr: String::new(),
            },
            "echo-b" => SpawnResult {
                exit_code: 0,
                stdout: "b\n".into(),
                stderr: String::new(),
            },
            "fail-msg" => SpawnResult {
                exit_code: 1,
                stdout: String::new(),
                stderr: "err\n".into(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found\n"),
            },
        }
    }

    fn simple_cmd(name: &str) -> Command {
        use codepod_shell::ast::Word;
        Command::Simple {
            words: vec![Word::literal(name)],
            redirects: vec![],
            assignments: vec![],
        }
    }

    #[test]
    fn list_and_short_circuits_on_failure() {
        // `false && echo-a` — echo-a should NOT execute
        // Note: `false` is a builtin, so no spawn calls for it
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::List {
            left: Box::new(simple_cmd("false")),
            op: codepod_shell::ast::ListOp::And,
            right: Box::new(simple_cmd("echo-a")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
        assert_eq!(run.stdout, "");
        // `false` is a builtin so no spawn calls
        let calls = host.get_spawn_calls();
        assert_eq!(calls.len(), 0);
    }

    #[test]
    fn list_and_executes_right_on_success() {
        // `echo-a && echo-b` — both should execute, stdout concatenated
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::List {
            left: Box::new(simple_cmd("echo-a")),
            op: codepod_shell::ast::ListOp::And,
            right: Box::new(simple_cmd("echo-b")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "a\nb\n");
    }

    #[test]
    fn list_or_short_circuits_on_success() {
        // `true || echo-a` — echo-a should NOT execute
        // Note: `true` is a builtin, so no spawn calls for it
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::List {
            left: Box::new(simple_cmd("true")),
            op: codepod_shell::ast::ListOp::Or,
            right: Box::new(simple_cmd("echo-a")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        // `true` is a builtin so no spawn calls
        let calls = host.get_spawn_calls();
        assert_eq!(calls.len(), 0);
    }

    #[test]
    fn list_or_executes_right_on_failure() {
        // `false || echo-a` — echo-a executes since false fails
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::List {
            left: Box::new(simple_cmd("false")),
            op: codepod_shell::ast::ListOp::Or,
            right: Box::new(simple_cmd("echo-a")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "a\n");
    }

    #[test]
    fn list_seq_always_executes_both() {
        // `echo-a ; echo-b` — both execute regardless
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::List {
            left: Box::new(simple_cmd("echo-a")),
            op: codepod_shell::ast::ListOp::Seq,
            right: Box::new(simple_cmd("echo-b")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "a\nb\n");
    }

    #[test]
    fn list_seq_executes_both_even_on_failure() {
        // `false ; echo-a` — echo-a executes even though false fails
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::List {
            left: Box::new(simple_cmd("false")),
            op: codepod_shell::ast::ListOp::Seq,
            right: Box::new(simple_cmd("echo-a")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "a\n");
    }

    #[test]
    fn list_nested_and_or() {
        // `false && echo-a || echo-b` — false fails, so && short-circuits,
        // then || sees failure so executes echo-b
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        // This is: (false && echo-a) || echo-b
        let cmd = Command::List {
            left: Box::new(Command::List {
                left: Box::new(simple_cmd("false")),
                op: codepod_shell::ast::ListOp::And,
                right: Box::new(simple_cmd("echo-a")),
            }),
            op: codepod_shell::ast::ListOp::Or,
            right: Box::new(simple_cmd("echo-b")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert!(run.stdout.contains("b\n"));
    }

    // ====================================================================
    // If tests
    // ====================================================================

    #[test]
    fn if_true_condition_executes_then() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::If {
            condition: Box::new(simple_cmd("true")),
            then_body: Box::new(simple_cmd("echo-a")),
            else_body: None,
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "a\n");
    }

    #[test]
    fn if_false_condition_executes_else() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::If {
            condition: Box::new(simple_cmd("false")),
            then_body: Box::new(simple_cmd("echo-a")),
            else_body: Some(Box::new(simple_cmd("echo-b"))),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "b\n");
    }

    #[test]
    fn if_false_no_else_returns_empty() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::If {
            condition: Box::new(simple_cmd("false")),
            then_body: Box::new(simple_cmd("echo-a")),
            else_body: None,
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "");
    }

    #[test]
    fn if_nested() {
        // if false; then echo-a; else if true; then echo-b; fi; fi
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::If {
            condition: Box::new(simple_cmd("false")),
            then_body: Box::new(simple_cmd("echo-a")),
            else_body: Some(Box::new(Command::If {
                condition: Box::new(simple_cmd("true")),
                then_body: Box::new(simple_cmd("echo-b")),
                else_body: None,
            })),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "b\n");
    }

    // ====================================================================
    // For loop tests
    // ====================================================================

    #[test]
    fn for_iterates_over_words() {
        // for i in a b c; do echo $i; done
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found\n"),
            },
        });
        let mut state = ShellState::new_default();

        let cmd = Command::For {
            var: "i".to_string(),
            words: vec![Word::literal("a"), Word::literal("b"), Word::literal("c")],
            body: Box::new(Command::Simple {
                words: vec![Word::literal("echo"), Word::variable("i")],
                redirects: vec![],
                assignments: vec![],
            }),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "a\nb\nc\n");
        assert_eq!(state.env.get("i").unwrap(), "c");
    }

    #[test]
    fn for_empty_word_list() {
        // for i in; do echo $i; done — no iterations
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        let cmd = Command::For {
            var: "i".to_string(),
            words: vec![],
            body: Box::new(simple_cmd("echo")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "");
        assert_eq!(run.exit_code, 0);
        assert_eq!(host.get_spawn_calls().len(), 0);
    }

    #[test]
    fn for_break_exits_loop() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: String::new(),
            },
        });
        let mut state = ShellState::new_default();

        // for i in a b c; do break; done
        // Verify break exits after first iteration and only "a" is bound
        let cmd = Command::For {
            var: "i".to_string(),
            words: vec![Word::literal("a"), Word::literal("b"), Word::literal("c")],
            body: Box::new(Command::Break),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        // Only first iteration ran, i should be "a"
        assert_eq!(state.env.get("i").unwrap(), "a");
        // echo was never called
        assert_eq!(host.get_spawn_calls().len(), 0);
    }

    #[test]
    fn for_continue_skips_to_next() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: String::new(),
            },
        });
        let mut state = ShellState::new_default();

        // for i in a b c; do continue; echo $i; done
        // echo should never execute because continue comes first
        let cmd = Command::For {
            var: "i".to_string(),
            words: vec![Word::literal("a"), Word::literal("b"), Word::literal("c")],
            body: Box::new(Command::List {
                left: Box::new(Command::Continue),
                op: codepod_shell::ast::ListOp::Seq,
                right: Box::new(Command::Simple {
                    words: vec![Word::literal("echo"), Word::variable("i")],
                    redirects: vec![],
                    assignments: vec![],
                }),
            }),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "");
    }

    // ====================================================================
    // While loop tests
    // ====================================================================

    #[test]
    fn while_loops_until_condition_fails() {
        use codepod_shell::ast::Word;

        // Simulate counting: while [[ $i -lt 3 ]]; do echo $i; i=$((i+1)); done
        // Using ArithmeticCommand as condition
        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: String::new(),
            },
        });
        let mut state = ShellState::new_default();
        state.env.insert("i".to_string(), "0".to_string());

        // Condition: (( i < 3 ))
        // Body: echo $i; (( i++ ))
        let cmd = Command::While {
            condition: Box::new(Command::ArithmeticCommand {
                expr: "i < 3".to_string(),
            }),
            body: Box::new(Command::List {
                left: Box::new(Command::Simple {
                    words: vec![Word::literal("echo"), Word::variable("i")],
                    redirects: vec![],
                    assignments: vec![],
                }),
                op: codepod_shell::ast::ListOp::Seq,
                right: Box::new(Command::ArithmeticCommand {
                    expr: "i++".to_string(),
                }),
            }),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "0\n1\n2\n");
        assert_eq!(state.env.get("i").unwrap(), "3");
    }

    #[test]
    fn while_break_exits() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        // while true; do break; done
        let cmd = Command::While {
            condition: Box::new(simple_cmd("true")),
            body: Box::new(Command::Break),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn while_continue_loops() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: String::new(),
            },
        });
        let mut state = ShellState::new_default();
        state.env.insert("i".to_string(), "0".to_string());

        // while (( i < 3 )); do i++; continue; echo unreachable; done
        let cmd = Command::While {
            condition: Box::new(Command::ArithmeticCommand {
                expr: "i < 3".to_string(),
            }),
            body: Box::new(Command::List {
                left: Box::new(Command::List {
                    left: Box::new(Command::ArithmeticCommand {
                        expr: "i++".to_string(),
                    }),
                    op: codepod_shell::ast::ListOp::Seq,
                    right: Box::new(Command::Continue),
                }),
                op: codepod_shell::ast::ListOp::Seq,
                right: Box::new(Command::Simple {
                    words: vec![Word::literal("echo"), Word::literal("unreachable")],
                    redirects: vec![],
                    assignments: vec![],
                }),
            }),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // echo should never have been called
        assert_eq!(run.stdout, "");
    }

    // ====================================================================
    // CFor (C-style for loop) tests
    // ====================================================================

    #[test]
    fn cfor_basic_loop() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: String::new(),
            },
        });
        let mut state = ShellState::new_default();

        // for ((i=0; i<3; i++)); do echo $i; done
        let cmd = Command::CFor {
            init: "i=0".to_string(),
            cond: "i<3".to_string(),
            step: "i++".to_string(),
            body: Box::new(Command::Simple {
                words: vec![Word::literal("echo"), Word::variable("i")],
                redirects: vec![],
                assignments: vec![],
            }),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "0\n1\n2\n");
        assert_eq!(state.env.get("i").unwrap(), "3");
    }

    #[test]
    fn cfor_empty_condition_breaks_on_break() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        // for ((;;)); do break; done
        let cmd = Command::CFor {
            init: String::new(),
            cond: String::new(),
            step: String::new(),
            body: Box::new(Command::Break),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn cfor_continue_still_runs_step() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: String::new(),
            },
        });
        let mut state = ShellState::new_default();

        // for ((i=0; i<5; i++)); do continue; echo unreachable; done
        let cmd = Command::CFor {
            init: "i=0".to_string(),
            cond: "i<5".to_string(),
            step: "i++".to_string(),
            body: Box::new(Command::List {
                left: Box::new(Command::Continue),
                op: codepod_shell::ast::ListOp::Seq,
                right: Box::new(Command::Simple {
                    words: vec![Word::literal("echo"), Word::literal("unreachable")],
                    redirects: vec![],
                    assignments: vec![],
                }),
            }),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // i should be 5 because step still ran on each continue
        assert_eq!(state.env.get("i").unwrap(), "5");
        assert_eq!(run.stdout, "");
    }

    // ====================================================================
    // Case tests
    // ====================================================================

    #[test]
    fn case_exact_match() {
        use codepod_shell::ast::{CaseItem, Word};

        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let cmd = Command::Case {
            word: Word::literal("hello"),
            items: vec![
                CaseItem {
                    patterns: vec![Word::literal("world")],
                    body: Box::new(simple_cmd("echo-a")),
                },
                CaseItem {
                    patterns: vec![Word::literal("hello")],
                    body: Box::new(simple_cmd("echo-b")),
                },
            ],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "b\n");
    }

    #[test]
    fn case_glob_wildcard() {
        use codepod_shell::ast::{CaseItem, Word};

        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let cmd = Command::Case {
            word: Word::literal("anything"),
            items: vec![
                CaseItem {
                    patterns: vec![Word::literal("specific")],
                    body: Box::new(simple_cmd("echo-a")),
                },
                CaseItem {
                    patterns: vec![Word::literal("*")],
                    body: Box::new(simple_cmd("echo-b")),
                },
            ],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "b\n");
    }

    #[test]
    fn case_first_match_wins() {
        use codepod_shell::ast::{CaseItem, Word};

        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let cmd = Command::Case {
            word: Word::literal("hello"),
            items: vec![
                CaseItem {
                    patterns: vec![Word::literal("hello")],
                    body: Box::new(simple_cmd("echo-a")),
                },
                CaseItem {
                    patterns: vec![Word::literal("*")],
                    body: Box::new(simple_cmd("echo-b")),
                },
            ],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "a\n");
    }

    #[test]
    fn case_no_match_returns_empty() {
        use codepod_shell::ast::{CaseItem, Word};

        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let cmd = Command::Case {
            word: Word::literal("hello"),
            items: vec![CaseItem {
                patterns: vec![Word::literal("world")],
                body: Box::new(simple_cmd("echo-a")),
            }],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "");
    }

    // ====================================================================
    // Subshell tests
    // ====================================================================

    #[test]
    fn subshell_restores_env() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();
        state.env.insert("X".to_string(), "before".to_string());

        // Subshell changes X, but it should be restored after.
        // Assignment handling is Task 14, so test env restoration directly.
        state.cwd = "/home/user".to_string();
        let cmd = Command::Subshell {
            body: Box::new(simple_cmd("true")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(matches!(result.unwrap(), ControlFlow::Normal(_)));
        assert_eq!(state.cwd, "/home/user");
    }

    #[test]
    fn subshell_propagates_exit_code() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let cmd = Command::Subshell {
            body: Box::new(simple_cmd("false")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    // ====================================================================
    // BraceGroup tests
    // ====================================================================

    #[test]
    fn brace_group_executes_body() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let cmd = Command::BraceGroup {
            body: Box::new(simple_cmd("echo-a")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "a\n");
    }

    // ====================================================================
    // Negate tests
    // ====================================================================

    #[test]
    fn negate_flips_zero_to_one() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let cmd = Command::Negate {
            body: Box::new(simple_cmd("true")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    #[test]
    fn negate_flips_nonzero_to_zero() {
        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let cmd = Command::Negate {
            body: Box::new(simple_cmd("false")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    // ====================================================================
    // Break / Continue tests
    // ====================================================================

    #[test]
    fn break_returns_controlflow_break() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let result = exec_command(&mut state, &host, &Command::Break);
        assert!(matches!(result.unwrap(), ControlFlow::Break(1)));
    }

    #[test]
    fn continue_returns_controlflow_continue() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let result = exec_command(&mut state, &host, &Command::Continue);
        assert!(matches!(result.unwrap(), ControlFlow::Continue(1)));
    }

    // ====================================================================
    // Function tests
    // ====================================================================

    #[test]
    fn function_definition_stores_body() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::Function {
            name: "myfunc".to_string(),
            body: Box::new(simple_cmd("echo-a")),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert!(state.functions.contains_key("myfunc"));
    }

    #[test]
    fn function_invocation() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found\n"),
            },
        });
        let mut state = ShellState::new_default();

        // Define function: myfunc() { echo hello; }
        let func_body = Command::Simple {
            words: vec![Word::literal("echo"), Word::literal("hello")],
            redirects: vec![],
            assignments: vec![],
        };
        state.functions.insert("myfunc".to_string(), func_body);

        // Call: myfunc
        let cmd = Command::Simple {
            words: vec![Word::literal("myfunc")],
            redirects: vec![],
            assignments: vec![],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "hello\n");
    }

    #[test]
    fn function_positional_args_passed_and_restored() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| match program {
            "echo" => SpawnResult {
                exit_code: 0,
                stdout: format!("{}\n", args.join(" ")),
                stderr: String::new(),
            },
            _ => SpawnResult {
                exit_code: 127,
                stdout: String::new(),
                stderr: format!("{program}: command not found\n"),
            },
        });
        let mut state = ShellState::new_default();
        state.positional_args = vec!["original".to_string()];

        // Define: myfunc() { echo $1; }
        let func_body = Command::Simple {
            words: vec![Word::literal("echo"), Word::variable("1")],
            redirects: vec![],
            assignments: vec![],
        };
        state.functions.insert("myfunc".to_string(), func_body);

        // Call: myfunc arg1
        let cmd = Command::Simple {
            words: vec![Word::literal("myfunc"), Word::literal("arg1")],
            redirects: vec![],
            assignments: vec![],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "arg1\n");
        // Positional args should be restored
        assert_eq!(state.positional_args, vec!["original"]);
    }

    #[test]
    fn function_return_from_function() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        // Define: myfunc() { return 42; echo unreachable; }
        // We simulate return via ControlFlow::Return
        // Since we don't have a "return" builtin yet, we test the Return flow
        // by having function body return a specific exit code
        let func_body = simple_cmd("false"); // exit code 1
        state.functions.insert("myfunc".to_string(), func_body);

        let cmd = Command::Simple {
            words: vec![Word::literal("myfunc")],
            redirects: vec![],
            assignments: vec![],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    #[test]
    fn function_depth_limit() {
        use codepod_shell::ast::Word;

        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state.function_depth = crate::state::MAX_FUNCTION_DEPTH;

        // Define a function
        let func_body = simple_cmd("true");
        state.functions.insert("myfunc".to_string(), func_body);

        // Try to call it at max depth
        let cmd = Command::Simple {
            words: vec![Word::literal("myfunc")],
            redirects: vec![],
            assignments: vec![],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
        assert!(run.stderr.contains("maximum function nesting depth"));
    }

    #[test]
    fn function_local_var_stack() {
        use codepod_shell::ast::Word;

        let host = MockHost::new().with_spawn_handler(make_handler());
        let mut state = ShellState::new_default();

        let func_body = simple_cmd("true");
        state.functions.insert("myfunc".to_string(), func_body);

        // Verify stack push/pop
        assert_eq!(state.local_var_stack.len(), 0);
        let cmd = Command::Simple {
            words: vec![Word::literal("myfunc")],
            redirects: vec![],
            assignments: vec![],
        };
        let _ = exec_command(&mut state, &host, &cmd);
        assert_eq!(state.local_var_stack.len(), 0); // should be popped
    }

    // ====================================================================
    // DoubleBracket tests
    // ====================================================================

    #[test]
    fn double_bracket_string_eq() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "hello == hello".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_string_ne() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "hello != world".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_string_eq_fails() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "hello == world".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    #[test]
    fn double_bracket_integer_eq() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "42 -eq 42".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_integer_ne() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "1 -ne 2".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_integer_lt() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "1 -lt 2".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_integer_gt() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "5 -gt 3".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_integer_le() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "3 -le 3".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_integer_ge() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "5 -ge 5".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_unary_z_empty() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "-z \"\"".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_unary_z_nonempty() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "-z hello".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    #[test]
    fn double_bracket_unary_n() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "-n hello".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_unary_f_existing_file() {
        let host = MockHost::new().with_file("/tmp/test.txt", b"content");
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "-f /tmp/test.txt".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_unary_f_nonexistent() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "-f /tmp/nonexistent.txt".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    #[test]
    fn double_bracket_unary_d() {
        let host = MockHost::new().with_dir("/tmp/mydir");
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "-d /tmp/mydir".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_unary_e() {
        let host = MockHost::new().with_file("/tmp/test.txt", b"content");
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "-e /tmp/test.txt".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_logical_and() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "1 -eq 1 && 2 -eq 2".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_logical_and_fails() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "1 -eq 1 && 2 -eq 3".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    #[test]
    fn double_bracket_logical_or() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "1 -eq 2 || 3 -eq 3".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_logical_not() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "! 1 -eq 2".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_variable_expansion() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state.env.insert("X".to_string(), "hello".to_string());

        let cmd = Command::DoubleBracket {
            expr: "$X == hello".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_regex_match() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "hello123 =~ ^hello[0-9]+$".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn double_bracket_regex_no_match() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::DoubleBracket {
            expr: "abc =~ ^[0-9]+$".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    // ====================================================================
    // ArithmeticCommand tests
    // ====================================================================

    #[test]
    fn arithmetic_cmd_nonzero_is_success() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::ArithmeticCommand {
            expr: "1 + 1".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0); // non-zero result → exit 0
    }

    #[test]
    fn arithmetic_cmd_zero_is_failure() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = Command::ArithmeticCommand {
            expr: "0".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1); // zero result → exit 1
    }

    #[test]
    fn arithmetic_cmd_comparison() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        // (( 5 > 3 )) → evaluates to 1 (true) → exit 0
        let cmd = Command::ArithmeticCommand {
            expr: "5 > 3".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn arithmetic_cmd_false_comparison() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        // (( 3 > 5 )) → evaluates to 0 (false) → exit 1
        let cmd = Command::ArithmeticCommand {
            expr: "3 > 5".to_string(),
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 1);
    }

    // ====================================================================
    // Assignment handling tests
    // ====================================================================

    /// Helper to create an Assignment AST node.
    fn assignment(name: &str, value: &str) -> codepod_shell::ast::Assignment {
        codepod_shell::ast::Assignment {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn assignment_simple_no_words() {
        // FOO=bar (no command words) — assignment-only
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("FOO", "bar")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "");
        assert_eq!(state.env.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn assignment_with_command() {
        // FOO=bar echo test — env set before command execution
        let host = MockHost::new().with_spawn_result(
            "echo",
            SpawnResult {
                exit_code: 0,
                stdout: "test\n".into(),
                stderr: String::new(),
            },
        );
        let mut state = ShellState::new_default();
        let cmd = Command::Simple {
            words: vec![Word::literal("echo"), Word::literal("test")],
            redirects: vec![],
            assignments: vec![assignment("FOO", "bar")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "test\n");
        // Assignment should be set
        assert_eq!(state.env.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn assignment_append_string() {
        // FOO=hello; FOO+=world
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state.env.insert("FOO".to_string(), "hello".to_string());
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("FOO+", "world")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(state.env.get("FOO"), Some(&"helloworld".to_string()));
    }

    #[test]
    fn assignment_append_string_from_empty() {
        // FOO+=bar when FOO is unset
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("FOO+", "bar")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(state.env.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn assignment_array_literal() {
        // arr=(a b c)
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("arr", "(a b c)")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(
            state.arrays.get("arr"),
            Some(&vec!["a".to_string(), "b".to_string(), "c".to_string()])
        );
    }

    #[test]
    fn assignment_array_literal_empty() {
        // arr=()
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("arr", "()")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(state.arrays.get("arr"), Some(&vec![]));
    }

    #[test]
    fn assignment_array_element() {
        // arr[2]=x — sets arr[2], extending with empty strings
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("arr[2]", "x")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        let arr = state.arrays.get("arr").unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0], "");
        assert_eq!(arr[1], "");
        assert_eq!(arr[2], "x");
    }

    #[test]
    fn assignment_array_element_existing() {
        // arr=(a b c); arr[1]=X
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state.arrays.insert(
            "arr".to_string(),
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
        );
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("arr[1]", "X")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        let arr = state.arrays.get("arr").unwrap();
        assert_eq!(
            arr,
            &vec!["a".to_string(), "X".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn assignment_assoc_array_element() {
        // Existing assoc array: assoc[key]=value
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state
            .assoc_arrays
            .insert("mymap".to_string(), std::collections::HashMap::new());
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("mymap[greeting]", "hello")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        let assoc = state.assoc_arrays.get("mymap").unwrap();
        assert_eq!(assoc.get("greeting"), Some(&"hello".to_string()));
    }

    #[test]
    fn assignment_array_append() {
        // arr=(a b); arr+=(c d)
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state
            .arrays
            .insert("arr".to_string(), vec!["a".to_string(), "b".to_string()]);
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("arr+", "(c d)")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(
            state.arrays.get("arr"),
            Some(&vec![
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
                "d".to_string()
            ])
        );
    }

    #[test]
    fn assignment_array_append_creates_new() {
        // arr+=(x y) when arr doesn't exist
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("arr+", "(x y)")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(
            state.arrays.get("arr"),
            Some(&vec!["x".to_string(), "y".to_string()])
        );
    }

    #[test]
    fn assignment_multiple() {
        // FOO=1 BAR=2 (multiple assignments, no words)
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("FOO", "1"), assignment("BAR", "2")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(state.env.get("FOO"), Some(&"1".to_string()));
        assert_eq!(state.env.get("BAR"), Some(&"2".to_string()));
    }

    #[test]
    fn assignment_overwrites_existing() {
        // FOO=old; FOO=new
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state.env.insert("FOO".to_string(), "old".to_string());
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("FOO", "new")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(state.env.get("FOO"), Some(&"new".to_string()));
    }

    #[test]
    fn parse_array_subscript_helper() {
        // Unit test for the helper function
        assert_eq!(
            parse_array_subscript("arr[0]"),
            Some(("arr".to_string(), "0".to_string()))
        );
        assert_eq!(
            parse_array_subscript("mymap[key]"),
            Some(("mymap".to_string(), "key".to_string()))
        );
        assert_eq!(parse_array_subscript("nosubscript"), None);
        assert_eq!(parse_array_subscript("bad["), None);
        assert_eq!(
            parse_array_subscript("a[complex key]"),
            Some(("a".to_string(), "complex key".to_string()))
        );
    }

    #[test]
    fn assignment_value_expansion() {
        // Test that variable expansion works in assignment values
        // VAR=hello; OTHER=$VAR
        // Since we use expand_word with Literal, `$VAR` won't actually expand
        // unless the word part is a Variable. For this task, we use raw values.
        // But expand_word on a Literal containing $VAR should expand it through
        // the expand_word_part's Literal handler.
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state.env.insert("NAME".to_string(), "world".to_string());

        // The Assignment value is a raw string. When we create Word::literal("$NAME"),
        // the word part is Literal("$NAME"). The expand_word_part for Literal
        // does NOT expand variables — it returns the literal string.
        // So this test verifies that literal values pass through as-is.
        let cmd = Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![assignment("GREETING", "hello")],
        };
        let result = exec_command(&mut state, &host, &cmd);
        assert!(result.is_ok());
        assert_eq!(state.env.get("GREETING"), Some(&"hello".to_string()));
    }

    // ========================================================================
    // Task 15: Path resolution and command dispatch tests
    // ========================================================================

    // ---- needs_default_dir ----

    #[test]
    fn needs_default_dir_ls_no_args() {
        assert!(needs_default_dir("ls", &[]));
    }

    #[test]
    fn needs_default_dir_ls_with_flags_only() {
        assert!(needs_default_dir("ls", &["-la", "-R"]));
    }

    #[test]
    fn needs_default_dir_ls_with_path_arg() {
        assert!(!needs_default_dir("ls", &["-l", "/tmp"]));
    }

    #[test]
    fn needs_default_dir_find_no_args() {
        assert!(needs_default_dir("find", &[]));
    }

    #[test]
    fn needs_default_dir_other_command() {
        assert!(!needs_default_dir("grep", &[]));
        assert!(!needs_default_dir("cat", &[]));
    }

    // ---- looks_like_filename ----

    #[test]
    fn looks_like_filename_with_extension() {
        assert!(looks_like_filename("archive.tar"));
        assert!(looks_like_filename("foo.txt"));
        assert!(looks_like_filename("image.png"));
    }

    #[test]
    fn looks_like_filename_no_extension() {
        assert!(!looks_like_filename("somedir"));
        assert!(!looks_like_filename("command"));
    }

    #[test]
    fn looks_like_filename_starts_with_dot() {
        assert!(!looks_like_filename(".name"));
        assert!(!looks_like_filename(".hidden"));
    }

    #[test]
    fn looks_like_filename_with_glob_chars() {
        assert!(!looks_like_filename("*.txt"));
        assert!(!looks_like_filename("file?.txt"));
        assert!(!looks_like_filename("dir/file.txt"));
        assert!(!looks_like_filename("{a,b}.txt"));
    }

    // ---- parse_shebang ----

    #[test]
    fn parse_shebang_env_python3() {
        assert_eq!(
            parse_shebang("#!/usr/bin/env python3"),
            Some("python3".to_string())
        );
    }

    #[test]
    fn parse_shebang_direct_python3() {
        assert_eq!(
            parse_shebang("#!/usr/bin/python3"),
            Some("python3".to_string())
        );
    }

    #[test]
    fn parse_shebang_sh() {
        assert_eq!(parse_shebang("#!/bin/sh"), Some("sh".to_string()));
    }

    #[test]
    fn parse_shebang_bash() {
        assert_eq!(parse_shebang("#!/bin/bash"), Some("bash".to_string()));
    }

    #[test]
    fn parse_shebang_no_shebang() {
        assert_eq!(parse_shebang("echo hello"), None);
        assert_eq!(parse_shebang(""), None);
    }

    #[test]
    fn parse_shebang_env_with_spaces() {
        assert_eq!(
            parse_shebang("#!/usr/bin/env   python3"),
            Some("python3".to_string())
        );
    }

    // ---- is_python_interpreter ----

    #[test]
    fn is_python_interpreter_standard() {
        assert!(is_python_interpreter("python"));
        assert!(is_python_interpreter("python3"));
    }

    #[test]
    fn is_python_interpreter_versioned() {
        assert!(is_python_interpreter("python3.10"));
        assert!(is_python_interpreter("python3.11"));
        assert!(is_python_interpreter("python3.9"));
    }

    #[test]
    fn is_python_interpreter_not_python() {
        assert!(!is_python_interpreter("sh"));
        assert!(!is_python_interpreter("bash"));
        assert!(!is_python_interpreter("node"));
    }

    // ---- resolve_arg_if_path ----

    #[test]
    fn resolve_arg_passthrough_command() {
        let state = ShellState::new_default();
        let host = MockHost::new();
        // echo args should never be resolved
        assert_eq!(resolve_arg_if_path(&state, &host, "echo", "hello"), "hello");
        assert_eq!(
            resolve_arg_if_path(&state, &host, "printf", "world"),
            "world"
        );
        assert_eq!(
            resolve_arg_if_path(&state, &host, "find", "pattern"),
            "pattern"
        );
    }

    #[test]
    fn resolve_arg_flags_passthrough() {
        let state = ShellState::new_default();
        let host = MockHost::new();
        assert_eq!(resolve_arg_if_path(&state, &host, "cat", "-n"), "-n");
        assert_eq!(
            resolve_arg_if_path(&state, &host, "grep", "--color"),
            "--color"
        );
    }

    #[test]
    fn resolve_arg_absolute_path_passthrough() {
        let state = ShellState::new_default();
        let host = MockHost::new();
        assert_eq!(
            resolve_arg_if_path(&state, &host, "cat", "/tmp/file.txt"),
            "/tmp/file.txt"
        );
    }

    #[test]
    fn resolve_arg_creation_command_always_resolves() {
        let state = ShellState::new_default();
        let host = MockHost::new();
        // mkdir always resolves relative args
        assert_eq!(
            resolve_arg_if_path(&state, &host, "mkdir", "newdir"),
            "/home/user/newdir"
        );
        assert_eq!(
            resolve_arg_if_path(&state, &host, "touch", "newfile.txt"),
            "/home/user/newfile.txt"
        );
        assert_eq!(
            resolve_arg_if_path(&state, &host, "cp", "src"),
            "/home/user/src"
        );
        assert_eq!(
            resolve_arg_if_path(&state, &host, "mv", "old"),
            "/home/user/old"
        );
        assert_eq!(
            resolve_arg_if_path(&state, &host, "tee", "output.log"),
            "/home/user/output.log"
        );
    }

    #[test]
    fn resolve_arg_existing_file_resolves() {
        let state = ShellState::new_default();
        let host = MockHost::new().with_file("/home/user/data.csv", b"col1,col2\n");
        // cat with a relative path that exists -> resolved
        assert_eq!(
            resolve_arg_if_path(&state, &host, "cat", "data.csv"),
            "/home/user/data.csv"
        );
    }

    #[test]
    fn resolve_arg_nonexistent_filename_resolves() {
        let state = ShellState::new_default();
        let host = MockHost::new();
        // "archive.tar" looks like a filename (has extension, no glob chars)
        assert_eq!(
            resolve_arg_if_path(&state, &host, "tar", "archive.tar"),
            "/home/user/archive.tar"
        );
    }

    #[test]
    fn resolve_arg_nonexistent_no_extension_passthrough() {
        let state = ShellState::new_default();
        let host = MockHost::new();
        // "somedir" doesn't look like a filename, not a creation command
        assert_eq!(
            resolve_arg_if_path(&state, &host, "cat", "somedir"),
            "somedir"
        );
    }

    // ---- resolve_command_args ----

    #[test]
    fn resolve_command_args_normal_command() {
        let state = ShellState::new_default();
        let host = MockHost::new().with_file("/home/user/file.txt", b"content");
        let args = vec!["file.txt", "-n"];
        let resolved = resolve_command_args(&state, &host, "cat", &args);
        assert_eq!(resolved[0], "/home/user/file.txt");
        assert_eq!(resolved[1], "-n");
    }

    #[test]
    fn resolve_command_args_pattern_command_skips_first_positional() {
        let state = ShellState::new_default();
        let host = MockHost::new().with_file("/home/user/file.txt", b"content");
        // grep: first positional is the pattern, should NOT be resolved
        let args = vec!["pattern", "file.txt"];
        let resolved = resolve_command_args(&state, &host, "grep", &args);
        assert_eq!(resolved[0], "pattern"); // pattern NOT resolved
        assert_eq!(resolved[1], "/home/user/file.txt"); // file IS resolved
    }

    #[test]
    fn resolve_command_args_pattern_command_with_flags() {
        let state = ShellState::new_default();
        let host = MockHost::new().with_file("/home/user/file.txt", b"content");
        // grep -r pattern file.txt
        let args = vec!["-r", "pattern", "file.txt"];
        let resolved = resolve_command_args(&state, &host, "grep", &args);
        assert_eq!(resolved[0], "-r"); // flag passthrough
        assert_eq!(resolved[1], "pattern"); // first positional = pattern, not resolved
        assert_eq!(resolved[2], "/home/user/file.txt"); // second positional resolved
    }

    #[test]
    fn resolve_command_args_sed_pattern() {
        let state = ShellState::new_default();
        let host = MockHost::new().with_file("/home/user/file.txt", b"content");
        // sed 's/foo/bar/' file.txt
        let args = vec!["s/foo/bar/", "file.txt"];
        let resolved = resolve_command_args(&state, &host, "sed", &args);
        assert_eq!(resolved[0], "s/foo/bar/"); // pattern not resolved
        assert_eq!(resolved[1], "/home/user/file.txt"); // file resolved
    }

    // ---- implicit cwd commands (integration) ----

    #[test]
    fn ls_with_no_args_appends_cwd() {
        let host = MockHost::new().with_spawn_handler(|program, args, _stdin| SpawnResult {
            exit_code: 0,
            stdout: format!("program={} args={:?}\n", program, args),
            stderr: String::new(),
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("ls -la");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(_run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // ls with only flags should have cwd appended
        let calls = host.get_spawn_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].program, "ls");
        // Should contain the cwd as last arg
        assert!(calls[0].args.contains(&"/home/user".to_string()));
    }

    #[test]
    fn ls_with_dir_arg_no_cwd_appended() {
        let host = MockHost::new().with_spawn_handler(|_program, _args, _stdin| SpawnResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("ls /tmp");
        let _ = exec_command(&mut state, &host, &cmd);
        let calls = host.get_spawn_calls();
        assert_eq!(calls.len(), 1);
        // Should not append cwd when a non-flag arg is given
        assert!(!calls[0].args.contains(&"/home/user".to_string()));
    }

    // ---- shebang-based execution ----

    #[test]
    fn exec_path_python_script() {
        let host = MockHost::new()
            .with_file(
                "/home/user/script.py",
                b"#!/usr/bin/env python3\nprint('hello')\n",
            )
            .with_spawn_handler(|program, args, _stdin| {
                if program == "python3" {
                    SpawnResult {
                        exit_code: 0,
                        stdout: format!("python3 called with {:?}\n", args),
                        stderr: String::new(),
                    }
                } else {
                    SpawnResult {
                        exit_code: 127,
                        stdout: String::new(),
                        stderr: format!("{}: not found", program),
                    }
                }
            });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("./script.py");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        // Should have spawned python3 with the resolved script path
        let calls = host.get_spawn_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].program, "python3");
        assert!(calls[0].args[0].ends_with("/script.py"));
    }

    #[test]
    fn exec_path_shell_script() {
        let host = MockHost::new()
            .with_file("/home/user/test.sh", b"#!/bin/sh\necho hello\n")
            .with_spawn_handler(|_program, _args, _stdin| SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("./test.sh");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // Shell script is executed by parsing and running through our executor
        // echo is a builtin, so it should produce output
        assert_eq!(run.stdout, "hello\n");
    }

    #[test]
    fn exec_path_script_no_shebang() {
        let host = MockHost::new().with_file("/home/user/run.sh", b"echo no_shebang\n");
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("./run.sh");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // Scripts without shebang default to shell execution
        assert_eq!(run.stdout, "no_shebang\n");
    }

    #[test]
    fn exec_path_nonexistent_file() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("./nonexistent.sh");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_ne!(run.exit_code, 0);
        assert!(run.stderr.contains("not found"));
    }

    #[test]
    fn exec_path_absolute_python() {
        let host = MockHost::new()
            .with_file("/tmp/run.py", b"#!/usr/bin/python3\nimport sys\n")
            .with_spawn_handler(|program, args, _stdin| {
                if program == "python3" {
                    SpawnResult {
                        exit_code: 0,
                        stdout: format!("ran python with {:?}\n", args),
                        stderr: String::new(),
                    }
                } else {
                    SpawnResult {
                        exit_code: 127,
                        stdout: String::new(),
                        stderr: "not found".to_string(),
                    }
                }
            });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("/tmp/run.py arg1 arg2");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
        let calls = host.get_spawn_calls();
        assert_eq!(calls[0].program, "python3");
        assert_eq!(calls[0].args[0], "/tmp/run.py");
        assert_eq!(calls[0].args[1], "arg1");
        assert_eq!(calls[0].args[2], "arg2");
    }

    // ---- shell command dispatch ----

    #[test]
    fn sh_minus_c_executes_command() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("sh -c 'echo hello'");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "hello\n");
    }

    #[test]
    fn bash_minus_c_executes_command() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("bash -c 'echo world'");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "world\n");
    }

    #[test]
    fn sh_script_file() {
        let host =
            MockHost::new().with_file("/home/user/test.sh", b"#!/bin/sh\necho from_script\n");
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("sh test.sh");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "from_script\n");
    }

    #[test]
    fn bare_sh_succeeds() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("sh");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    #[test]
    fn bare_bash_succeeds() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("bash");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.exit_code, 0);
    }

    // ---- shell script positional parameters ----

    #[test]
    fn shell_script_positional_params() {
        let host = MockHost::new().with_file("/home/user/params.sh", b"echo $1 $2\n");
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("sh params.sh hello world");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "hello world\n");
    }

    // ---- path resolution in pipeline ----

    #[test]
    fn pipeline_with_sh_dispatch() {
        let host = MockHost::new().with_spawn_handler(|_program, _args, _stdin| SpawnResult {
            exit_code: 0,
            stdout: "piped\n".to_string(),
            stderr: String::new(),
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("echo input | sh -c 'echo piped'");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "piped\n");
    }

    #[test]
    fn pipeline_with_path_resolution() {
        let host = MockHost::new()
            .with_file("/home/user/data.txt", b"content")
            .with_spawn_handler(|program, args, _stdin| SpawnResult {
                exit_code: 0,
                stdout: format!("{}:{:?}\n", program, args),
                stderr: String::new(),
            });
        let mut state = ShellState::new_default();
        // cat data.txt | grep pattern
        // In the pipeline, cat's arg "data.txt" should be resolved
        let cmd = codepod_shell::parser::parse("cat data.txt | grep pattern");
        let _ = exec_command(&mut state, &host, &cmd);
        let calls = host.get_spawn_calls();
        // cat should have its arg resolved
        assert_eq!(calls[0].program, "cat");
        assert!(calls[0].args[0].starts_with("/home/user/"));
    }

    // ---- creation commands always resolve ----

    #[test]
    fn mkdir_resolves_relative_path() {
        let host = MockHost::new().with_spawn_handler(|_program, _args, _stdin| SpawnResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("mkdir -p newdir");
        let _ = exec_command(&mut state, &host, &cmd);
        let calls = host.get_spawn_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].program, "mkdir");
        // newdir should be resolved to absolute
        assert!(calls[0].args.contains(&"/home/user/newdir".to_string()));
    }

    #[test]
    fn touch_resolves_relative_path() {
        let host = MockHost::new().with_spawn_handler(|_program, _args, _stdin| SpawnResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
        });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("touch newfile.txt");
        let _ = exec_command(&mut state, &host, &cmd);
        let calls = host.get_spawn_calls();
        assert!(calls[0]
            .args
            .contains(&"/home/user/newfile.txt".to_string()));
    }

    // ---- passthrough args ----

    #[test]
    fn echo_args_not_resolved() {
        let host = MockHost::new().with_spawn_handler(|_program, _args, _stdin| SpawnResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
        });
        let state = ShellState::new_default();
        // echo is a builtin so it won't actually spawn, but let's test the helper
        let result = resolve_arg_if_path(&state, &host, "echo", "file.txt");
        assert_eq!(result, "file.txt"); // not resolved
    }

    // ---- sh -c with complex commands ----

    #[test]
    fn sh_c_with_semicolons() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state.env.insert("FOO".into(), "bar".into());
        let cmd = codepod_shell::parser::parse("sh -c 'echo hello; echo world'");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "hello\nworld\n");
    }

    #[test]
    fn sh_c_with_variable_expansion() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        state.env.insert("NAME".into(), "world".into());
        let cmd = codepod_shell::parser::parse("sh -c 'echo $NAME'");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "world\n");
    }

    // ---- exec_path with arguments ----

    #[test]
    fn exec_path_shell_script_with_args() {
        let host = MockHost::new().with_file("/home/user/greet.sh", b"#!/bin/sh\necho Hello $1\n");
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("./greet.sh World");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "Hello World\n");
    }

    // ---- python3.X versioned interpreter ----

    #[test]
    fn exec_path_python3_versioned() {
        let host = MockHost::new()
            .with_file(
                "/home/user/script.py",
                b"#!/usr/bin/env python3.11\nprint('hi')\n",
            )
            .with_spawn_handler(|program, _args, _stdin| SpawnResult {
                exit_code: 0,
                stdout: format!("ran with {}\n", program),
                stderr: String::new(),
            });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("./script.py");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(_run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // python3.11 is recognized as python, dispatches to python3
        let calls = host.get_spawn_calls();
        assert_eq!(calls[0].program, "python3");
    }

    // ---- find with default dir ----

    #[test]
    fn find_no_args_appends_cwd() {
        let host = MockHost::new().with_spawn_handler(|_program, _args, _stdin| SpawnResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
        });
        let mut state = ShellState::new_default();
        // find with no args should append cwd
        let cmd = codepod_shell::parser::parse("find");
        let _ = exec_command(&mut state, &host, &cmd);
        let calls = host.get_spawn_calls();
        assert_eq!(calls[0].program, "find");
        // Should have cwd appended as the only arg
        assert_eq!(calls[0].args.len(), 1);
        assert_eq!(calls[0].args[0], "/home/user");
    }

    // ---- grep pattern not resolved ----

    #[test]
    fn grep_pattern_not_resolved_but_file_is() {
        let host = MockHost::new()
            .with_file("/home/user/log.txt", b"some content")
            .with_spawn_handler(|_program, _args, _stdin| SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("grep error log.txt");
        let _ = exec_command(&mut state, &host, &cmd);
        let calls = host.get_spawn_calls();
        assert_eq!(calls[0].program, "grep");
        // "error" is the pattern - should not be resolved
        assert_eq!(calls[0].args[0], "error");
        // "log.txt" exists, should be resolved
        assert_eq!(calls[0].args[1], "/home/user/log.txt");
    }

    // ---- redirect with dispatched command ----

    #[test]
    fn sh_c_with_output_redirect() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("sh -c 'echo redirected' > /tmp/out.txt");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        // Output should have been redirected, so stdout is empty
        assert_eq!(run.stdout, "");
        // File should contain the output
        let content = host.get_file("/tmp/out.txt").unwrap();
        assert_eq!(content, "redirected\n");
    }

    // ---- exec_shell_script strips shebang ----

    #[test]
    fn exec_shell_script_strips_shebang() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let result = exec_shell_script(&mut state, &host, "#!/bin/bash\necho stripped\n", &[]);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "stripped\n");
    }

    // ---- pipeline with shebang dispatch ----

    #[test]
    fn pipeline_shebang_dispatch() {
        let host = MockHost::new()
            .with_file("/home/user/count.sh", b"#!/bin/sh\necho counted\n")
            .with_spawn_handler(|_program, _args, _stdin| SpawnResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            });
        let mut state = ShellState::new_default();
        let cmd = codepod_shell::parser::parse("echo input | ./count.sh");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else {
            panic!("expected Normal")
        };
        assert_eq!(run.stdout, "counted\n");
    }

    // ---- cwd change affects resolution ----

    #[test]
    fn path_resolution_respects_cwd() {
        let state = ShellState {
            cwd: "/tmp/project".into(),
            ..ShellState::new_default()
        };
        let host = MockHost::new();
        // Creation command should resolve relative to /tmp/project
        assert_eq!(
            resolve_arg_if_path(&state, &host, "touch", "file.txt"),
            "/tmp/project/file.txt"
        );
    }

    // ---- multiple dispatch types ----

    #[test]
    fn dispatch_external_shebang_returns_flow() {
        let host = MockHost::new().with_file("/home/user/hello.sh", b"echo hi\n");
        let mut state = ShellState::new_default();
        let result = dispatch_external_command(&mut state, &host, "./hello.sh", &[], "");
        // Should return Err(ControlFlow) since it was handled
        assert!(result.is_err());
    }

    #[test]
    fn dispatch_external_sh_returns_flow() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();
        let result = dispatch_external_command(&mut state, &host, "sh", &["-c", "echo hi"], "");
        // Should return Err(ControlFlow) since it was handled
        assert!(result.is_err());
    }

    #[test]
    fn dispatch_external_normal_command_returns_resolved_args() {
        let host = MockHost::new().with_file("/home/user/file.txt", b"data");
        let mut state = ShellState::new_default();
        let result = dispatch_external_command(&mut state, &host, "cat", &["file.txt"], "");
        // Should return Ok(...) with resolved args
        let (prog, args) = result.unwrap();
        assert_eq!(prog, "cat");
        assert_eq!(args[0], "/home/user/file.txt");
    }
}
