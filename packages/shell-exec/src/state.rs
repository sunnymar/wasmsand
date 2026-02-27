use std::collections::{HashMap, HashSet};

use codepod_shell::ast::Command;

pub const MAX_SUBSTITUTION_DEPTH: u32 = 50;
pub const MAX_FUNCTION_DEPTH: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ShellFlag {
    Errexit,
    Nounset,
    Pipefail,
}

pub struct ShellState {
    pub env: HashMap<String, String>,
    pub arrays: HashMap<String, Vec<String>>,
    pub assoc_arrays: HashMap<String, HashMap<String, String>>,
    pub functions: HashMap<String, Command>,
    pub flags: HashSet<ShellFlag>,
    pub positional_args: Vec<String>,
    pub last_exit_code: i32,
    pub function_depth: u32,
    pub substitution_depth: u32,
    pub traps: HashMap<String, String>,
    pub local_var_stack: Vec<HashMap<String, Option<String>>>,
    pub history: Vec<String>,
    pub cwd: String,
    /// Seed for $RANDOM pseudo-random number generator.
    pub rng_seed: u64,
    /// Set by ${var:?msg} expansion to signal an error to the executor.
    pub param_error: Option<String>,
}

impl ShellState {
    pub fn new_default() -> Self {
        let mut env = HashMap::new();
        env.insert("HOME".into(), "/home/user".into());
        env.insert("PWD".into(), "/home/user".into());
        env.insert("USER".into(), "user".into());
        env.insert("PATH".into(), "/bin:/usr/bin".into());
        env.insert("PYTHONPATH".into(), "/usr/lib/python".into());
        env.insert("SHELL".into(), "/bin/sh".into());

        Self {
            env,
            arrays: HashMap::new(),
            assoc_arrays: HashMap::new(),
            functions: HashMap::new(),
            flags: HashSet::new(),
            positional_args: Vec::new(),
            last_exit_code: 0,
            function_depth: 0,
            substitution_depth: 0,
            traps: HashMap::new(),
            local_var_stack: Vec::new(),
            history: Vec::new(),
            cwd: "/home/user".into(),
            rng_seed: 12345, // deterministic default; host can override
            param_error: None,
        }
    }

    pub fn resolve_path(&self, path: &str) -> String {
        if path.starts_with('/') {
            return path.to_string();
        }
        if self.cwd == "/" {
            format!("/{path}")
        } else {
            format!("{}/{path}", self.cwd)
        }
    }
}
