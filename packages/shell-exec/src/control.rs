use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub execution_time_ms: u64,
}

impl RunResult {
    pub fn empty() -> Self {
        Self {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            execution_time_ms: 0,
        }
    }

    pub fn success(stdout: String) -> Self {
        Self {
            exit_code: 0,
            stdout,
            stderr: String::new(),
            execution_time_ms: 0,
        }
    }

    pub fn error(code: i32, stderr: String) -> Self {
        Self {
            exit_code: code,
            stdout: String::new(),
            stderr,
            execution_time_ms: 0,
        }
    }
}

#[derive(Debug)]
pub enum ControlFlow {
    Normal(RunResult),
    Break(u32),
    Continue(u32),
    Return(i32),
    Exit(i32, String, String),
    Cancelled(CancelReason),
}

#[derive(Debug, Clone, Copy)]
pub enum CancelReason {
    Timeout,
    Cancelled,
}

#[derive(Debug)]
pub enum ShellError {
    ParseError(String),
    HostError(String),
    SubstitutionTooDeep,
    FunctionTooDeep,
}

impl std::fmt::Display for ShellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ParseError(msg) => write!(f, "parse error: {msg}"),
            Self::HostError(msg) => write!(f, "host error: {msg}"),
            Self::SubstitutionTooDeep => write!(f, "maximum command substitution depth exceeded"),
            Self::FunctionTooDeep => write!(f, "maximum function call depth exceeded"),
        }
    }
}
