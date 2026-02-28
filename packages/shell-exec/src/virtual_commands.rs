//! Virtual commands — curl, wget, pkg, pip.
//!
//! Command logic runs entirely in the sandbox (Rust). Only I/O crosses to the
//! host via `HostInterface::fetch` / `register_tool`.

use crate::control::RunResult;
use crate::host::{HostInterface, WriteMode};
use crate::state::ShellState;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub const VIRTUAL_COMMANDS: &[&str] = &["curl", "wget", "pkg", "pip"];

pub fn is_virtual_command(name: &str) -> bool {
    VIRTUAL_COMMANDS.contains(&name)
}

pub fn try_virtual_command(
    state: &mut ShellState,
    host: &dyn HostInterface,
    cmd: &str,
    args: &[String],
    stdin: &str,
) -> Option<RunResult> {
    match cmd {
        "curl" => Some(cmd_curl(state, host, args, stdin)),
        "wget" => Some(cmd_wget(state, host, args)),
        "pkg" => Some(cmd_pkg(state, host, args)),
        "pip" => Some(cmd_pip(state, host, args)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// curl
// ---------------------------------------------------------------------------

fn cmd_curl(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
    stdin: &str,
) -> RunResult {
    let mut method = None::<String>;
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut data = None::<String>;
    let mut output_file = None::<String>;
    let mut silent = false;
    let mut head_only = false;
    let mut follow_redirects = false;
    let mut url = None::<String>;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-X" => {
                i += 1;
                if i < args.len() {
                    method = Some(args[i].clone());
                }
            }
            "-H" => {
                i += 1;
                if i < args.len() {
                    if let Some(colon) = args[i].find(':') {
                        let name = args[i][..colon].trim().to_string();
                        let value = args[i][colon + 1..].trim().to_string();
                        headers.push((name, value));
                    }
                }
            }
            "-d" | "--data" => {
                i += 1;
                if i < args.len() {
                    data = Some(args[i].clone());
                }
            }
            "-o" => {
                i += 1;
                if i < args.len() {
                    output_file = Some(args[i].clone());
                }
            }
            "-s" | "--silent" => silent = true,
            "-I" | "--head" => head_only = true,
            "-L" | "--location" => follow_redirects = true,
            "-sS" | "-Ss" => silent = true,
            _ => {
                if !arg.starts_with('-') {
                    url = Some(arg.clone());
                }
            }
        }
        i += 1;
    }

    let url = match url {
        Some(u) => u,
        None => return RunResult::error(1, "curl: no URL specified\n".into()),
    };

    // Check for network configuration
    let has_network = state.env.contains_key("CODEPOD_NETWORK");
    if !has_network {
        // We still try the fetch — the host will return an error if no network
        // bridge is configured. This lets the error message come from the host.
    }

    // Determine method
    let method = method.unwrap_or_else(|| {
        if data.is_some() {
            "POST".to_string()
        } else {
            "GET".to_string()
        }
    });

    // Auto-add Content-Type for -d
    if data.is_some()
        && !headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("content-type"))
    {
        headers.push((
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        ));
    }

    // If data comes from stdin (- means read from stdin)
    let body = match data.as_deref() {
        Some("-") => Some(stdin),
        Some(d) => Some(d),
        None => None,
    };

    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    let _ = follow_redirects; // follow-redirect is handled by the host fetch
    let _ = silent; // silence progress output (we don't output progress anyway)

    let result = host.fetch(&url, &method, &header_refs, body);

    if let Some(ref err) = result.error {
        return RunResult::error(1, format!("curl: {err}\n"));
    }

    if head_only {
        let mut out = format!("HTTP/{} {}\r\n", result.status, status_text(result.status));
        for (name, value) in &result.headers {
            out.push_str(&format!("{}: {}\r\n", name, value));
        }
        out.push_str("\r\n");
        return RunResult::success(out);
    }

    if let Some(ref file) = output_file {
        let resolved = state.resolve_path(file);
        if let Err(e) = host.write_file(&resolved, &result.body, WriteMode::Truncate) {
            return RunResult::error(1, format!("curl: failed to write {file}: {e}\n"));
        }
        return RunResult::empty();
    }

    RunResult::success(result.body)
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// wget
// ---------------------------------------------------------------------------

fn cmd_wget(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    let mut output_file = None::<String>;
    let mut quiet = false;
    let mut url = None::<String>;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-O" => {
                i += 1;
                if i < args.len() {
                    output_file = Some(args[i].clone());
                }
            }
            "-q" | "--quiet" => quiet = true,
            _ => {
                if !arg.starts_with('-') {
                    url = Some(arg.clone());
                }
            }
        }
        i += 1;
    }

    let url = match url {
        Some(u) => u,
        None => return RunResult::error(1, "wget: no URL specified\n".into()),
    };

    let result = host.fetch(&url, "GET", &[], None);

    if let Some(ref err) = result.error {
        return RunResult::error(1, format!("wget: {err}\n"));
    }

    // -O - means write to stdout
    if output_file.as_deref() == Some("-") {
        return RunResult::success(result.body);
    }

    // Determine output filename
    let filename = match output_file {
        Some(f) => f,
        None => {
            // Extract basename from URL
            let path = url.split('?').next().unwrap_or(&url);
            let basename = path.rsplit('/').next().unwrap_or("index.html");
            if basename.is_empty() {
                "index.html".to_string()
            } else {
                basename.to_string()
            }
        }
    };

    let resolved = state.resolve_path(&filename);
    if let Err(e) = host.write_file(&resolved, &result.body, WriteMode::Truncate) {
        return RunResult::error(1, format!("wget: failed to write {filename}: {e}\n"));
    }

    let stderr = if quiet {
        String::new()
    } else {
        format!("saved to {filename}\n")
    };

    RunResult {
        exit_code: 0,
        stdout: String::new(),
        stderr,
        execution_time_ms: 0,
    }
}

// ---------------------------------------------------------------------------
// pkg
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PkgPolicy {
    enabled: bool,
    #[serde(rename = "allowedHosts")]
    allowed_hosts: Option<Vec<String>>,
    #[serde(rename = "maxPackageBytes")]
    max_package_bytes: Option<usize>,
    #[serde(rename = "maxInstalledPackages")]
    max_installed_packages: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PkgInfo {
    name: String,
    url: String,
    size: usize,
    #[serde(rename = "installedAt")]
    installed_at: u64,
}

fn cmd_pkg(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    if args.is_empty() {
        return RunResult::error(
            1,
            "pkg: usage: pkg <install|remove|list|info> [args]\n".into(),
        );
    }

    let subcmd = args[0].as_str();
    let sub_args = &args[1..];

    match subcmd {
        "install" => pkg_install(state, host, sub_args),
        "remove" => pkg_remove(state, host, sub_args),
        "list" => pkg_list(host),
        "info" => pkg_info(host, sub_args),
        other => RunResult::error(1, format!("pkg: unknown subcommand '{other}'\n")),
    }
}

fn read_pkg_policy(host: &dyn HostInterface) -> Option<PkgPolicy> {
    let json = host.read_file("/etc/codepod/pkg-policy.json").ok()?;
    serde_json::from_str(&json).ok()
}

fn read_pkg_metadata(host: &dyn HostInterface) -> Vec<PkgInfo> {
    host.read_file("/usr/share/pkg/packages.json")
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn write_pkg_metadata(host: &dyn HostInterface, packages: &[PkgInfo]) {
    if let Ok(json) = serde_json::to_string_pretty(packages) {
        let _ = host.write_file("/usr/share/pkg/packages.json", &json, WriteMode::Truncate);
    }
}

fn matches_host_list(host_name: &str, list: &[String]) -> bool {
    for pattern in list {
        if let Some(suffix) = pattern.strip_prefix("*.") {
            if host_name.ends_with(suffix)
                && host_name.len() > suffix.len()
                && host_name.as_bytes()[host_name.len() - suffix.len() - 1] == b'.'
            {
                return true;
            }
        } else if host_name == pattern {
            return true;
        }
    }
    false
}

/// Extract hostname from a URL string.
fn extract_host(url: &str) -> Option<String> {
    // Simple URL parsing: skip scheme, extract host
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = after_scheme.split('/').next()?;
    let host = host.split(':').next()?; // strip port
    Some(host.to_string())
}

/// Extract the package name from a URL (basename without .wasm extension).
fn pkg_name_from_url(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let basename = path.rsplit('/').next().unwrap_or("package");
    basename
        .strip_suffix(".wasm")
        .unwrap_or(basename)
        .to_string()
}

fn pkg_install(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    if args.is_empty() {
        return RunResult::error(1, "pkg install: no URL specified\n".into());
    }

    let url = &args[0];

    // Read policy
    let policy = match read_pkg_policy(host) {
        Some(p) => p,
        None => return RunResult::error(1, "pkg: package manager is disabled\n".into()),
    };

    if !policy.enabled {
        return RunResult::error(1, "pkg: package manager is disabled\n".into());
    }

    // Check host against allowedHosts
    if let Some(ref allowed) = policy.allowed_hosts {
        let host_name = match extract_host(url) {
            Some(h) => h,
            None => return RunResult::error(1, format!("pkg install: invalid URL: {url}\n")),
        };
        if !matches_host_list(&host_name, allowed) {
            return RunResult::error(
                1,
                format!("pkg install: Host '{host_name}' is not in the allowed hosts list\n"),
            );
        }
    }

    let mut packages = read_pkg_metadata(host);
    let name = pkg_name_from_url(url);

    // Check duplicate
    if packages.iter().any(|p| p.name == name) {
        return RunResult::error(
            1,
            format!("pkg install: Package '{name}' is already installed\n"),
        );
    }

    // Check max installed
    if let Some(max) = policy.max_installed_packages {
        if packages.len() >= max {
            return RunResult::error(
                1,
                format!("pkg install: Maximum of {max} packages reached\n"),
            );
        }
    }

    // Fetch the WASM binary
    let result = host.fetch(url, "GET", &[], None);
    if let Some(ref err) = result.error {
        return RunResult::error(1, format!("pkg install: download failed: {err}\n"));
    }
    if !result.ok {
        return RunResult::error(
            1,
            format!(
                "pkg install: download failed with status {}\n",
                result.status
            ),
        );
    }

    let size = result.body.len();

    // Check size limit
    if let Some(max_bytes) = policy.max_package_bytes {
        if size > max_bytes {
            return RunResult::error(
                1,
                format!("pkg install: Package size {size} exceeds limit of {max_bytes} bytes\n"),
            );
        }
    }

    // Ensure directories exist
    let _ = host.mkdir("/usr/share/pkg");
    let _ = host.mkdir("/usr/share/pkg/bin");

    // Write binary to VFS
    let wasm_path = format!("/usr/share/pkg/bin/{name}.wasm");
    if let Err(e) = host.write_file(&wasm_path, &result.body, WriteMode::Truncate) {
        return RunResult::error(1, format!("pkg install: failed to write binary: {e}\n"));
    }

    // Update metadata
    let info = PkgInfo {
        name: name.clone(),
        url: url.clone(),
        size,
        installed_at: host.time_ms(),
    };
    packages.push(info);
    write_pkg_metadata(host, &packages);

    // Register with host process manager
    if let Err(e) = host.register_tool(&name, &wasm_path) {
        let _ = state; // suppress unused warning
        return RunResult::error(1, format!("pkg install: failed to register tool: {e}\n"));
    }

    RunResult::success(format!("Installed {name}\n"))
}

fn pkg_remove(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    let _ = state;

    if args.is_empty() {
        return RunResult::error(1, "pkg remove: no package specified\n".into());
    }

    let name = &args[0];

    // Read policy
    let policy = match read_pkg_policy(host) {
        Some(p) => p,
        None => return RunResult::error(1, "pkg: package manager is disabled\n".into()),
    };
    if !policy.enabled {
        return RunResult::error(1, "pkg: package manager is disabled\n".into());
    }

    let mut packages = read_pkg_metadata(host);

    if !packages.iter().any(|p| p.name == *name) {
        return RunResult::error(1, format!("pkg remove: '{name}' is not installed\n"));
    }

    // Delete binary
    let wasm_path = format!("/usr/share/pkg/bin/{name}.wasm");
    let _ = host.remove(&wasm_path, false);

    // Update metadata
    packages.retain(|p| p.name != *name);
    write_pkg_metadata(host, &packages);

    RunResult::success(format!("Removed {name}\n"))
}

fn pkg_list(host: &dyn HostInterface) -> RunResult {
    let policy = match read_pkg_policy(host) {
        Some(p) => p,
        None => return RunResult::error(1, "pkg: package manager is disabled\n".into()),
    };
    if !policy.enabled {
        return RunResult::error(1, "pkg: package manager is disabled\n".into());
    }

    let packages = read_pkg_metadata(host);
    if packages.is_empty() {
        return RunResult::empty();
    }

    let mut out = String::new();
    for p in &packages {
        out.push_str(&format!("{}\t{}\t{}\n", p.name, p.url, p.size));
    }
    RunResult::success(out)
}

fn pkg_info(host: &dyn HostInterface, args: &[String]) -> RunResult {
    if args.is_empty() {
        return RunResult::error(1, "pkg info: no package specified\n".into());
    }

    let policy = match read_pkg_policy(host) {
        Some(p) => p,
        None => return RunResult::error(1, "pkg: package manager is disabled\n".into()),
    };
    if !policy.enabled {
        return RunResult::error(1, "pkg: package manager is disabled\n".into());
    }

    let name = &args[0];
    let packages = read_pkg_metadata(host);
    match packages.iter().find(|p| p.name == *name) {
        Some(p) => {
            let out = format!(
                "Name: {}\nURL: {}\nSize: {} bytes\nInstalled: {}\n",
                p.name, p.url, p.size, p.installed_at
            );
            RunResult::success(out)
        }
        None => RunResult::error(1, format!("pkg info: '{name}' not found\n")),
    }
}

// ---------------------------------------------------------------------------
// pip
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PipRegistryEntry {
    name: String,
    version: String,
    summary: String,
    dependencies: Vec<String>,
    #[serde(default)]
    native: bool,
    #[serde(default)]
    files: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PipInstalledEntry {
    name: String,
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExtensionMeta {
    name: String,
    description: Option<String>,
    #[serde(rename = "hasCommand")]
    has_command: Option<bool>,
    #[serde(rename = "pythonPackage")]
    python_package: Option<ExtPyPkg>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExtPyPkg {
    version: String,
    summary: Option<String>,
}

fn cmd_pip(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    if args.is_empty() {
        return RunResult::error(
            1,
            "pip: usage: pip <install|uninstall|list|show> [args]\n".into(),
        );
    }

    let subcmd = args[0].as_str();
    let sub_args = &args[1..];

    match subcmd {
        "install" => pip_install(state, host, sub_args),
        "uninstall" => pip_uninstall(state, host, sub_args),
        "list" => pip_list(host),
        "show" => pip_show(host, sub_args),
        other => RunResult::error(1, format!("pip: unknown command '{other}'\n")),
    }
}

fn read_pip_registry(host: &dyn HostInterface) -> Vec<PipRegistryEntry> {
    host.read_file("/etc/codepod/pip-registry.json")
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn read_pip_installed(host: &dyn HostInterface) -> Vec<PipInstalledEntry> {
    host.read_file("/etc/codepod/pip-installed.json")
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn write_pip_installed(host: &dyn HostInterface, installed: &[PipInstalledEntry]) {
    if let Ok(json) = serde_json::to_string(installed) {
        let _ = host.write_file(
            "/etc/codepod/pip-installed.json",
            &json,
            WriteMode::Truncate,
        );
    }
}

fn read_extension_meta(host: &dyn HostInterface) -> Vec<ExtensionMeta> {
    host.read_file("/etc/codepod/extensions.json")
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Resolve a package name + transitive dependencies, topologically sorted.
fn resolve_deps(registry: &[PipRegistryEntry], name: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut visited = std::collections::HashSet::new();

    fn visit(
        registry: &[PipRegistryEntry],
        name: &str,
        visited: &mut std::collections::HashSet<String>,
        result: &mut Vec<String>,
    ) {
        if visited.contains(name) {
            return;
        }
        visited.insert(name.to_string());
        if let Some(pkg) = registry.iter().find(|p| p.name == name) {
            for dep in &pkg.dependencies {
                visit(registry, dep, visited, result);
            }
        }
        result.push(name.to_string());
    }

    visit(registry, name, &mut visited, &mut result);
    result
}

fn pip_install(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    let _ = state;

    // Filter out flags
    let names: Vec<&str> = args
        .iter()
        .map(|s| s.as_str())
        .filter(|a| !a.starts_with('-'))
        .collect();

    if names.is_empty() {
        return RunResult::error(1, "pip install: no package specified\n".into());
    }

    let registry = read_pip_registry(host);
    let mut installed = read_pip_installed(host);

    let mut all_to_install = Vec::new();
    for name in &names {
        // Check registry
        if !registry.iter().any(|p| p.name == *name) {
            // Check extensions
            let extensions = read_extension_meta(host);
            if extensions
                .iter()
                .any(|e| e.python_package.is_some() && e.name == *name)
            {
                // Extension-provided package — already available
                continue;
            }
            let available: Vec<&str> = registry.iter().map(|p| p.name.as_str()).collect();
            return RunResult::error(
                1,
                format!(
                    "pip install: package '{name}' not found in registry\nAvailable: {}\n",
                    available.join(", ")
                ),
            );
        }

        let deps = resolve_deps(&registry, name);
        for dep in deps {
            if !all_to_install.contains(&dep) && !installed.iter().any(|i| i.name == dep) {
                all_to_install.push(dep);
            }
        }
    }

    if all_to_install.is_empty() {
        return RunResult::success("Requirement already satisfied\n".into());
    }

    // Install each package: write Python files to VFS
    let mut out = String::new();
    for pkg_name in &all_to_install {
        if let Some(pkg) = registry.iter().find(|p| p.name == *pkg_name) {
            // Ensure /usr/lib/python exists
            let _ = host.mkdir("/usr/lib/python");

            for (path, content) in &pkg.files {
                let full_path = format!("/usr/lib/python/{path}");
                // Ensure parent dirs exist
                if let Some(parent) = full_path.rsplit_once('/') {
                    let _ = host.mkdir(parent.0);
                }
                let _ = host.write_file(&full_path, content, WriteMode::Truncate);
            }

            installed.push(PipInstalledEntry {
                name: pkg.name.clone(),
                version: pkg.version.clone(),
            });
        }
    }

    write_pip_installed(host, &installed);

    out.push_str(&format!(
        "Successfully installed {}\n",
        all_to_install.join(" ")
    ));

    RunResult::success(out)
}

fn pip_uninstall(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    let _ = state;

    // Filter out flags (like -y)
    let names: Vec<&str> = args
        .iter()
        .map(|s| s.as_str())
        .filter(|a| !a.starts_with('-'))
        .collect();

    if names.is_empty() {
        return RunResult::error(1, "pip uninstall: no package specified\n".into());
    }

    let registry = read_pip_registry(host);
    let mut installed = read_pip_installed(host);

    let mut out = String::new();
    for name in &names {
        if let Some(pos) = installed.iter().position(|p| p.name == *name) {
            // Remove Python files from VFS
            if let Some(pkg) = registry.iter().find(|p| p.name == *name) {
                // Collect directories to remove (deduplicated)
                let mut dirs_to_remove = std::collections::HashSet::new();
                for path in pkg.files.keys() {
                    let full_path = format!("/usr/lib/python/{path}");
                    let _ = host.remove(&full_path, false);
                    // Track parent directory for cleanup
                    if let Some(slash) = full_path.rfind('/') {
                        dirs_to_remove.insert(full_path[..slash].to_string());
                    }
                }
                // Remove package directories (deepest first)
                let mut dirs: Vec<String> = dirs_to_remove.into_iter().collect();
                dirs.sort_by_key(|b| std::cmp::Reverse(b.len()));
                for dir in &dirs {
                    let _ = host.remove(dir, true);
                }
            }
            installed.remove(pos);
            out.push_str(&format!("Successfully uninstalled {name}\n"));
        } else {
            return RunResult::error(1, format!("pip uninstall: '{name}' is not installed\n"));
        }
    }

    write_pip_installed(host, &installed);
    RunResult::success(out)
}

fn pip_list(host: &dyn HostInterface) -> RunResult {
    let installed = read_pip_installed(host);
    let extensions = read_extension_meta(host);

    if installed.is_empty() && extensions.is_empty() {
        return RunResult::success("Package    Version\n---------- -------\n".into());
    }

    let mut entries: Vec<(String, String)> = Vec::new();
    for pkg in &installed {
        entries.push((pkg.name.clone(), pkg.version.clone()));
    }
    // Add extension-provided packages
    for ext in &extensions {
        if let Some(ref py) = ext.python_package {
            if !entries.iter().any(|(n, _)| n == &ext.name) {
                entries.push((ext.name.clone(), py.version.clone()));
            }
        }
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let name_width = entries
        .iter()
        .map(|(n, _)| n.len())
        .max()
        .unwrap_or(7)
        .max(7);
    let mut out = format!("{:<width$} Version\n", "Package", width = name_width);
    out.push_str(&format!("{} -------\n", "-".repeat(name_width)));
    for (name, version) in &entries {
        out.push_str(&format!(
            "{:<width$} {}\n",
            name,
            version,
            width = name_width
        ));
    }

    RunResult::success(out)
}

fn pip_show(host: &dyn HostInterface, args: &[String]) -> RunResult {
    if args.is_empty() {
        return RunResult::error(1, "pip show: no package specified\n".into());
    }

    let name = &args[0];
    let registry = read_pip_registry(host);
    let installed = read_pip_installed(host);
    let extensions = read_extension_meta(host);

    // Check registry
    if let Some(pkg) = registry.iter().find(|p| p.name == *name) {
        let status = if installed.iter().any(|i| i.name == *name) {
            "installed"
        } else {
            "available"
        };
        return RunResult::success(format!(
            "Name: {}\nVersion: {}\nSummary: {}\nStatus: {}\n",
            pkg.name, pkg.version, pkg.summary, status
        ));
    }

    // Check extensions
    if let Some(ext) = extensions.iter().find(|e| e.name == *name) {
        if let Some(ref py) = ext.python_package {
            return RunResult::success(format!(
                "Name: {}\nVersion: {}\nSummary: {}\nStatus: available\n",
                ext.name,
                py.version,
                py.summary.as_deref().unwrap_or("")
            ));
        }
    }

    RunResult::error(1, format!("pip show: package '{name}' not found\n"))
}
