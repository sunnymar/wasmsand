#[cfg(test)]
pub mod mock {
    use std::collections::{HashMap, HashSet};

    use crate::host::{CancelStatus, HostError, HostInterface, SpawnResult, StatInfo, WriteMode};

    /// An in-memory mock implementation of `HostInterface` for testing.
    pub struct MockHost {
        files: HashMap<String, Vec<u8>>,
        dirs: HashSet<String>,
        tools: HashSet<String>,
        spawn_results: HashMap<String, SpawnResult>,
        glob_results: HashMap<String, Vec<String>>,
    }

    impl Default for MockHost {
        fn default() -> Self {
            Self::new()
        }
    }

    impl MockHost {
        pub fn new() -> Self {
            Self {
                files: HashMap::new(),
                dirs: HashSet::new(),
                tools: HashSet::new(),
                spawn_results: HashMap::new(),
                glob_results: HashMap::new(),
            }
        }

        /// Register a tool name as available.
        pub fn with_tool(mut self, name: &str) -> Self {
            self.tools.insert(name.to_string());
            self
        }

        /// Register a pre-configured spawn result for a command name.
        pub fn with_spawn_result(mut self, cmd: &str, result: SpawnResult) -> Self {
            self.spawn_results.insert(cmd.to_string(), result);
            self
        }

        /// Add a file with the given content.
        pub fn with_file(mut self, path: &str, content: &[u8]) -> Self {
            self.files.insert(path.to_string(), content.to_vec());
            self
        }

        /// Add a directory.
        pub fn with_dir(mut self, path: &str) -> Self {
            self.dirs.insert(path.to_string());
            self
        }

        /// Register pre-configured glob results for a pattern.
        pub fn with_glob_result(mut self, pattern: &str, matches: Vec<String>) -> Self {
            self.glob_results.insert(pattern.to_string(), matches);
            self
        }
    }

    impl HostInterface for MockHost {
        fn spawn(
            &self,
            program: &str,
            _args: &[&str],
            _env: &[(&str, &str)],
            _cwd: &str,
            _stdin: &str,
        ) -> Result<SpawnResult, HostError> {
            if let Some(result) = self.spawn_results.get(program) {
                Ok(result.clone())
            } else {
                Ok(SpawnResult {
                    exit_code: 127,
                    stdout: String::new(),
                    stderr: format!("{program}: command not found"),
                })
            }
        }

        fn has_tool(&self, name: &str) -> bool {
            self.tools.contains(name)
        }

        fn check_cancel(&self) -> CancelStatus {
            CancelStatus::Running
        }

        fn time_ms(&self) -> u64 {
            0
        }

        fn stat(&self, path: &str) -> Result<StatInfo, HostError> {
            if let Some(data) = self.files.get(path) {
                Ok(StatInfo {
                    exists: true,
                    is_file: true,
                    is_dir: false,
                    is_symlink: false,
                    size: data.len() as u64,
                    mode: 0o644,
                    mtime_ms: 0,
                })
            } else if self.dirs.contains(path) {
                Ok(StatInfo {
                    exists: true,
                    is_file: false,
                    is_dir: true,
                    is_symlink: false,
                    size: 0,
                    mode: 0o755,
                    mtime_ms: 0,
                })
            } else {
                Ok(StatInfo {
                    exists: false,
                    is_file: false,
                    is_dir: false,
                    is_symlink: false,
                    size: 0,
                    mode: 0,
                    mtime_ms: 0,
                })
            }
        }

        fn read_file(&self, path: &str) -> Result<String, HostError> {
            match self.files.get(path) {
                Some(data) => String::from_utf8(data.clone())
                    .map_err(|e| HostError::IoError(format!("invalid UTF-8: {e}"))),
                None => Err(HostError::NotFound(path.to_string())),
            }
        }

        fn write_file(&self, _path: &str, _data: &str, _mode: WriteMode) -> Result<(), HostError> {
            // Note: MockHost uses interior mutability only when needed.
            // For testing write_file we'd need RefCell; stub for now.
            Ok(())
        }

        fn readdir(&self, path: &str) -> Result<Vec<String>, HostError> {
            let prefix = if path.ends_with('/') {
                path.to_string()
            } else {
                format!("{path}/")
            };
            let mut entries = HashSet::new();
            for key in self.files.keys() {
                if let Some(rest) = key.strip_prefix(&prefix) {
                    if let Some(name) = rest.split('/').next() {
                        if !name.is_empty() {
                            entries.insert(name.to_string());
                        }
                    }
                }
            }
            for key in &self.dirs {
                if let Some(rest) = key.strip_prefix(&prefix) {
                    if let Some(name) = rest.split('/').next() {
                        if !name.is_empty() {
                            entries.insert(name.to_string());
                        }
                    }
                }
            }
            let mut result: Vec<String> = entries.into_iter().collect();
            result.sort();
            Ok(result)
        }

        fn mkdir(&self, _path: &str) -> Result<(), HostError> {
            // Stub: in a full implementation we'd use RefCell for mutability.
            Ok(())
        }

        fn remove(&self, _path: &str, _recursive: bool) -> Result<(), HostError> {
            // Stub
            Ok(())
        }

        fn chmod(&self, _path: &str, _mode: u32) -> Result<(), HostError> {
            Ok(())
        }

        fn glob(&self, pattern: &str) -> Result<Vec<String>, HostError> {
            Ok(self.glob_results.get(pattern).cloned().unwrap_or_default())
        }

        fn rename(&self, _from: &str, _to: &str) -> Result<(), HostError> {
            Ok(())
        }

        fn symlink(&self, _target: &str, _link_path: &str) -> Result<(), HostError> {
            Ok(())
        }

        fn readlink(&self, path: &str) -> Result<String, HostError> {
            Err(HostError::NotFound(path.to_string()))
        }
    }
}
