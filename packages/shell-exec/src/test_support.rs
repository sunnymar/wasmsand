#[cfg(test)]
pub mod mock {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    use crate::host::{
        CancelStatus, FetchResult, HostError, HostInterface, SpawnResult, StatInfo, WriteMode,
    };

    /// A recorded spawn invocation, for test assertions.
    #[derive(Debug, Clone)]
    pub struct SpawnCall {
        pub program: String,
        pub args: Vec<String>,
        pub stdin: String,
    }

    /// An in-memory mock implementation of `HostInterface` for testing.
    ///
    /// Uses `RefCell` for the files map so that `write_file` can mutate state
    /// through a `&self` reference (as required by the `HostInterface` trait).
    pub struct MockHost {
        files: RefCell<HashMap<String, Vec<u8>>>,
        dirs: HashSet<String>,
        tools: HashSet<String>,
        spawn_results: HashMap<String, SpawnResult>,
        glob_results: HashMap<String, Vec<String>>,
        /// Records every spawn invocation for later assertion.
        spawn_calls: RefCell<Vec<SpawnCall>>,
        /// Optional dynamic spawn handler: receives (program, args, stdin) and
        /// returns a SpawnResult. When set, this takes priority over
        /// `spawn_results`.
        spawn_handler: Option<Box<dyn Fn(&str, &[&str], &str) -> SpawnResult>>,
        /// Pre-configured fetch results keyed by URL.
        fetch_results: HashMap<String, FetchResult>,
        /// Extension names mapped to their invoke results.
        extensions: HashMap<String, SpawnResult>,
        /// Records register_tool calls for test assertions.
        registered_tools: RefCell<Vec<(String, String)>>,
    }

    impl Default for MockHost {
        fn default() -> Self {
            Self::new()
        }
    }

    impl MockHost {
        pub fn new() -> Self {
            Self {
                files: RefCell::new(HashMap::new()),
                dirs: HashSet::new(),
                tools: HashSet::new(),
                spawn_results: HashMap::new(),
                glob_results: HashMap::new(),
                spawn_calls: RefCell::new(Vec::new()),
                spawn_handler: None,
                fetch_results: HashMap::new(),
                extensions: HashMap::new(),
                registered_tools: RefCell::new(Vec::new()),
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
        pub fn with_file(self, path: &str, content: &[u8]) -> Self {
            self.files
                .borrow_mut()
                .insert(path.to_string(), content.to_vec());
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

        /// Register a dynamic spawn handler that receives (program, args, stdin)
        /// and returns a SpawnResult. Takes priority over `spawn_results`.
        pub fn with_spawn_handler<F>(mut self, handler: F) -> Self
        where
            F: Fn(&str, &[&str], &str) -> SpawnResult + 'static,
        {
            self.spawn_handler = Some(Box::new(handler));
            self
        }

        /// Read a file's content from the mock filesystem (for test assertions).
        pub fn get_file(&self, path: &str) -> Option<String> {
            self.files
                .borrow()
                .get(path)
                .and_then(|data| String::from_utf8(data.clone()).ok())
        }

        /// Retrieve all recorded spawn calls for test assertions.
        pub fn get_spawn_calls(&self) -> Vec<SpawnCall> {
            self.spawn_calls.borrow().clone()
        }

        /// Register a pre-configured fetch result for a URL.
        pub fn with_fetch_result(mut self, url: &str, result: FetchResult) -> Self {
            self.fetch_results.insert(url.to_string(), result);
            self
        }

        /// Register an extension that returns a pre-configured result.
        pub fn with_extension(mut self, name: &str, result: SpawnResult) -> Self {
            self.extensions.insert(name.to_string(), result);
            self
        }

        /// Retrieve all recorded register_tool calls for test assertions.
        pub fn get_registered_tools(&self) -> Vec<(String, String)> {
            self.registered_tools.borrow().clone()
        }
    }

    impl HostInterface for MockHost {
        fn spawn(
            &self,
            program: &str,
            args: &[&str],
            _env: &[(&str, &str)],
            _cwd: &str,
            stdin: &str,
        ) -> Result<SpawnResult, HostError> {
            // Record the call for later assertion.
            self.spawn_calls.borrow_mut().push(SpawnCall {
                program: program.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
                stdin: stdin.to_string(),
            });

            // Dynamic handler takes priority.
            if let Some(ref handler) = self.spawn_handler {
                return Ok(handler(program, args, stdin));
            }

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
            let files = self.files.borrow();
            if let Some(data) = files.get(path) {
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
            match self.files.borrow().get(path) {
                Some(data) => String::from_utf8(data.clone())
                    .map_err(|e| HostError::IoError(format!("invalid UTF-8: {e}"))),
                None => Err(HostError::NotFound(path.to_string())),
            }
        }

        fn write_file(&self, path: &str, data: &str, mode: WriteMode) -> Result<(), HostError> {
            let mut files = self.files.borrow_mut();
            match mode {
                WriteMode::Truncate => {
                    files.insert(path.to_string(), data.as_bytes().to_vec());
                }
                WriteMode::Append => {
                    let entry = files.entry(path.to_string()).or_default();
                    entry.extend_from_slice(data.as_bytes());
                }
            }
            Ok(())
        }

        fn readdir(&self, path: &str) -> Result<Vec<String>, HostError> {
            let prefix = if path.ends_with('/') {
                path.to_string()
            } else {
                format!("{path}/")
            };
            let files = self.files.borrow();
            let mut entries = HashSet::new();
            for key in files.keys() {
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
            Ok(())
        }

        fn remove(&self, _path: &str, _recursive: bool) -> Result<(), HostError> {
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

        fn fetch(
            &self,
            url: &str,
            _method: &str,
            _headers: &[(&str, &str)],
            _body: Option<&str>,
        ) -> FetchResult {
            if let Some(result) = self.fetch_results.get(url) {
                return result.clone();
            }
            FetchResult {
                ok: false,
                status: 0,
                headers: vec![],
                body: String::new(),
                error: Some("networking not configured".to_string()),
            }
        }

        fn extension_invoke(
            &self,
            name: &str,
            _args: &[&str],
            _stdin: &str,
            _env: &[(&str, &str)],
            _cwd: &str,
        ) -> Result<SpawnResult, HostError> {
            if let Some(result) = self.extensions.get(name) {
                return Ok(result.clone());
            }
            Err(HostError::NotFound(format!("{name}: extension not found")))
        }

        fn register_tool(&self, name: &str, wasm_path: &str) -> Result<(), HostError> {
            self.registered_tools
                .borrow_mut()
                .push((name.to_string(), wasm_path.to_string()));
            Ok(())
        }

        fn is_extension(&self, name: &str) -> bool {
            self.extensions.contains_key(name)
        }
    }
}
