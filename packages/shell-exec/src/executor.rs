use codepod_shell::ast::Command;

use crate::control::{ControlFlow, RunResult, ShellError};
use crate::expand::{
    expand_braces, expand_globs, expand_words_with_splitting, restore_brace_sentinels,
};
use crate::host::HostInterface;
use crate::state::ShellState;

/// Execute a parsed `Command` AST node.
///
/// Currently only the `Command::Simple` variant is implemented.
/// All other variants return an empty `RunResult`.
pub fn exec_command(
    state: &mut ShellState,
    host: &dyn HostInterface,
    cmd: &Command,
) -> Result<ControlFlow, ShellError> {
    match cmd {
        Command::Simple {
            words,
            redirects: _,
            assignments: _,
        } => {
            if words.is_empty() {
                // Assignment-only command; nothing to spawn.
                return Ok(ControlFlow::Normal(RunResult::empty()));
            }

            let expanded = expand_words_with_splitting(state, words);
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

            // Convert env HashMap to the slice format expected by spawn.
            let env_pairs: Vec<(&str, &str)> = state
                .env
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();

            let spawn_result = host
                .spawn(cmd_name, &args, &env_pairs, &state.cwd, "")
                .map_err(|e| ShellError::HostError(e.to_string()))?;

            state.last_exit_code = spawn_result.exit_code;

            Ok(ControlFlow::Normal(RunResult {
                exit_code: spawn_result.exit_code,
                stdout: spawn_result.stdout,
                stderr: spawn_result.stderr,
                execution_time_ms: 0,
            }))
        }

        // All other command variants are stubs for now.
        _ => Ok(ControlFlow::Normal(RunResult::empty())),
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
}
