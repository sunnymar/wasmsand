//! Virtual commands — curl, wget, pkg, pip.
//!
//! Command logic runs entirely in the sandbox (Rust). Only I/O crosses to the
//! host via `HostInterface::fetch` / `register_tool`.

use crate::control::RunResult;
use crate::host::{HostInterface, WriteMode};
use crate::state::ShellState;
use crate::{shell_eprint, shell_print};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub const VIRTUAL_COMMANDS: &[&str] = &["curl", "wget", "pkg", "pip"];

/// Packages built into the sandbox runtime (compiled in or pre-installed as shims).
/// These are always available regardless of pip install state.
const BUILTIN_PACKAGES: &[(&str, &str)] = &[
    ("numpy", "1.26.4"),
    ("matplotlib", "3.8.0"),
    ("Pillow", "10.4.0"),
    ("requests", "2.32.0"),
];

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
    // Virtual commands write via shell_print! → fd 1.  When stdout_fd
    // differs from 1 (pipeline pipe, redirect, command substitution),
    // dup2 stdout_fd onto fd 1 so the output reaches the right target.
    let do_dup2 = state.stdout_fd != 1;
    let saved_fd1 = if do_dup2 { host.dup(1).ok() } else { None };
    if do_dup2 {
        let _ = host.dup2(state.stdout_fd, 1);
    }

    let result = match cmd {
        "curl" => Some(cmd_curl(state, host, args, stdin)),
        "wget" => Some(cmd_wget(state, host, args)),
        "pkg" => Some(cmd_pkg(state, host, args)),
        "pip" => Some(cmd_pip(state, host, args)),
        _ => None,
    };

    if let Some(fd) = saved_fd1 {
        let _ = host.dup2(fd, 1);
        let _ = host.close_fd(fd);
    }

    result
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
        Some(u) => {
            if !u.contains("://") {
                format!("https://{u}")
            } else {
                u
            }
        }
        None => {
            shell_eprint!("{}", "curl: no URL specified\n");
            return RunResult::exit(1);
        }
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
        shell_eprint!("curl: {err}\n");
        return RunResult::exit(1);
    }

    if head_only {
        let mut out = format!("HTTP/{} {}\r\n", result.status, status_text(result.status));
        for (name, value) in &result.headers {
            out.push_str(&format!("{}: {}\r\n", name, value));
        }
        out.push_str("\r\n");
        shell_print!("{}", out);
        return RunResult::empty();
    }

    if let Some(ref file) = output_file {
        let resolved = state.resolve_path(file);
        if let Err(e) = host.write_file(&resolved, result.body.as_bytes(), WriteMode::Truncate) {
            shell_eprint!("curl: failed to write {file}: {e}\n");
            return RunResult::exit(1);
        }
        return RunResult::empty();
    }

    shell_print!("{}", result.body);
    RunResult::empty()
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
                // Handle combined flags like -qO-
                if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
                    let chars: Vec<char> = arg[1..].chars().collect();
                    let mut j = 0;
                    while j < chars.len() {
                        match chars[j] {
                            'q' => quiet = true,
                            'O' => {
                                // Rest of this arg is the output file
                                let rest: String = chars[j + 1..].iter().collect();
                                if !rest.is_empty() {
                                    output_file = Some(rest);
                                } else {
                                    // Next arg is the output file
                                    i += 1;
                                    if i < args.len() {
                                        output_file = Some(args[i].clone());
                                    }
                                }
                                break;
                            }
                            _ => {}
                        }
                        j += 1;
                    }
                } else if !arg.starts_with('-') {
                    url = Some(arg.clone());
                }
            }
        }
        i += 1;
    }

    let url = match url {
        Some(u) => {
            // Auto-prepend https:// if no scheme (like real wget, but https for browser compat)
            if !u.contains("://") {
                format!("https://{u}")
            } else {
                u
            }
        }
        None => {
            shell_eprint!("{}", "wget: no URL specified\n");
            return RunResult::exit(1);
        }
    };

    let result = host.fetch(&url, "GET", &[], None);

    if let Some(ref err) = result.error {
        shell_eprint!("wget: {err}\n");
        return RunResult::exit(1);
    }

    // -O - means write to stdout
    if output_file.as_deref() == Some("-") {
        shell_print!("{}", result.body);
        return RunResult::empty();
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
    if let Err(e) = host.write_file(&resolved, result.body.as_bytes(), WriteMode::Truncate) {
        shell_eprint!("wget: failed to write {filename}: {e}\n");
        return RunResult::exit(1);
    }

    if !quiet {
        shell_eprint!("saved to {filename}\n");
    }

    RunResult::empty()
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
struct PipPolicy {
    enabled: bool,
    #[serde(rename = "allowedPackages")]
    allowed_packages: Option<Vec<String>>,
    #[serde(rename = "blockedPackages")]
    blocked_packages: Option<Vec<String>>,
    #[serde(rename = "maxPackages")]
    max_packages: Option<usize>,
}

fn read_pip_policy(host: &dyn HostInterface) -> Option<PipPolicy> {
    let json = host.read_file_str("/etc/codepod/pip-policy.json").ok()?;
    serde_json::from_str(&json).ok()
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
        shell_eprint!("{}", "pkg: usage: pkg <install|remove|list|info> [args]\n");
        return RunResult::exit(1);
    }

    let subcmd = args[0].as_str();
    let sub_args = &args[1..];

    match subcmd {
        "install" => pkg_install(state, host, sub_args),
        "remove" => pkg_remove(state, host, sub_args),
        "list" => pkg_list(host),
        "info" => pkg_info(host, sub_args),
        other => {
            shell_eprint!("pkg: unknown subcommand '{other}'\n");
            RunResult::exit(1)
        }
    }
}

fn read_pkg_policy(host: &dyn HostInterface) -> Option<PkgPolicy> {
    let json = host.read_file_str("/etc/codepod/pkg-policy.json").ok()?;
    serde_json::from_str(&json).ok()
}

fn read_pkg_metadata(host: &dyn HostInterface) -> Vec<PkgInfo> {
    host.read_file_str("/usr/share/pkg/packages.json")
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn write_pkg_metadata(host: &dyn HostInterface, packages: &[PkgInfo]) {
    if let Ok(json) = serde_json::to_string_pretty(packages) {
        let _ = host.write_file("/usr/share/pkg/packages.json", json.as_bytes(), WriteMode::Truncate);
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
        shell_eprint!("{}", "pkg install: no URL specified\n");
        return RunResult::exit(1);
    }

    let url = &args[0];

    // Read policy
    let policy = match read_pkg_policy(host) {
        Some(p) => p,
        None => {
            shell_eprint!("{}", "pkg: package manager is disabled\n");
            return RunResult::exit(1);
        }
    };

    if !policy.enabled {
        shell_eprint!("{}", "pkg: package manager is disabled\n");
        return RunResult::exit(1);
    }

    // Check host against allowedHosts
    if let Some(ref allowed) = policy.allowed_hosts {
        let host_name = match extract_host(url) {
            Some(h) => h,
            None => {
                shell_eprint!("pkg install: invalid URL: {url}\n");
                return RunResult::exit(1);
            }
        };
        if !matches_host_list(&host_name, allowed) {
            shell_eprint!("pkg install: Host '{host_name}' is not in the allowed hosts list\n");
            return RunResult::exit(1);
        }
    }

    let mut packages = read_pkg_metadata(host);
    let name = pkg_name_from_url(url);

    // Check duplicate
    if packages.iter().any(|p| p.name == name) {
        shell_eprint!("pkg install: Package '{name}' is already installed\n");
        return RunResult::exit(1);
    }

    // Check max installed
    if let Some(max) = policy.max_installed_packages {
        if packages.len() >= max {
            shell_eprint!("pkg install: Maximum of {max} packages reached\n");
            return RunResult::exit(1);
        }
    }

    // Fetch the WASM binary
    let result = host.fetch(url, "GET", &[], None);
    if let Some(ref err) = result.error {
        shell_eprint!("pkg install: download failed: {err}\n");
        return RunResult::exit(1);
    }
    if !result.ok {
        shell_eprint!(
            "pkg install: download failed with status {}\n",
            result.status
        );
        return RunResult::exit(1);
    }

    let size = result.body.len();

    // Check size limit
    if let Some(max_bytes) = policy.max_package_bytes {
        if size > max_bytes {
            shell_eprint!("pkg install: Package size {size} exceeds limit of {max_bytes} bytes\n");
            return RunResult::exit(1);
        }
    }

    // Ensure directories exist
    let _ = host.mkdir("/usr/share/pkg");
    let _ = host.mkdir("/usr/share/pkg/bin");

    // Write binary to VFS
    let wasm_path = format!("/usr/share/pkg/bin/{name}.wasm");
    if let Err(e) = host.write_file(&wasm_path, result.body.as_bytes(), WriteMode::Truncate) {
        shell_eprint!("pkg install: failed to write binary: {e}\n");
        return RunResult::exit(1);
    }

    // Update metadata
    let info = PkgInfo {
        name: name.clone(),
        url: url.clone(),
        size,
        installed_at: host.time() as u64,
    };
    packages.push(info);
    write_pkg_metadata(host, &packages);

    // Register with host process manager
    if let Err(e) = host.register_tool(&name, &wasm_path) {
        let _ = state; // suppress unused warning
        shell_eprint!("pkg install: failed to register tool: {e}\n");
        return RunResult::exit(1);
    }

    shell_print!("Installed {name}\n");
    RunResult::empty()
}

fn pkg_remove(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    let _ = state;

    if args.is_empty() {
        shell_eprint!("{}", "pkg remove: no package specified\n");
        return RunResult::exit(1);
    }

    let name = &args[0];

    // Read policy
    let policy = match read_pkg_policy(host) {
        Some(p) => p,
        None => {
            shell_eprint!("{}", "pkg: package manager is disabled\n");
            return RunResult::exit(1);
        }
    };
    if !policy.enabled {
        shell_eprint!("{}", "pkg: package manager is disabled\n");
        return RunResult::exit(1);
    }

    let mut packages = read_pkg_metadata(host);

    if !packages.iter().any(|p| p.name == *name) {
        shell_eprint!("pkg remove: '{name}' is not installed\n");
        return RunResult::exit(1);
    }

    // Delete binary
    let wasm_path = format!("/usr/share/pkg/bin/{name}.wasm");
    let _ = host.remove(&wasm_path, false);

    // Update metadata
    packages.retain(|p| p.name != *name);
    write_pkg_metadata(host, &packages);

    shell_print!("Removed {name}\n");
    RunResult::empty()
}

fn pkg_list(host: &dyn HostInterface) -> RunResult {
    let policy = match read_pkg_policy(host) {
        Some(p) => p,
        None => {
            shell_eprint!("{}", "pkg: package manager is disabled\n");
            return RunResult::exit(1);
        }
    };
    if !policy.enabled {
        shell_eprint!("{}", "pkg: package manager is disabled\n");
        return RunResult::exit(1);
    }

    let packages = read_pkg_metadata(host);
    if packages.is_empty() {
        return RunResult::empty();
    }

    let mut out = String::new();
    for p in &packages {
        out.push_str(&format!("{}\t{}\t{}\n", p.name, p.url, p.size));
    }
    shell_print!("{}", out);
    RunResult::empty()
}

fn pkg_info(host: &dyn HostInterface, args: &[String]) -> RunResult {
    if args.is_empty() {
        shell_eprint!("{}", "pkg info: no package specified\n");
        return RunResult::exit(1);
    }

    let policy = match read_pkg_policy(host) {
        Some(p) => p,
        None => {
            shell_eprint!("{}", "pkg: package manager is disabled\n");
            return RunResult::exit(1);
        }
    };
    if !policy.enabled {
        shell_eprint!("{}", "pkg: package manager is disabled\n");
        return RunResult::exit(1);
    }

    let name = &args[0];
    let packages = read_pkg_metadata(host);
    match packages.iter().find(|p| p.name == *name) {
        Some(p) => {
            let out = format!(
                "Name: {}\nURL: {}\nSize: {} bytes\nInstalled: {}\n",
                p.name, p.url, p.size, p.installed_at
            );
            shell_print!("{}", out);
            RunResult::empty()
        }
        None => {
            shell_eprint!("pkg info: '{name}' not found\n");
            RunResult::exit(1)
        }
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

// -- Remote package registry ------------------------------------------------

/// Package index from the remote codepod registry (index.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryIndex {
    #[allow(dead_code)]
    version: u32,
    packages: std::collections::HashMap<String, RegistryPackage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryPackage {
    version: String,
    summary: String,
    wasm: Option<String>,
    wheel: String,
    #[serde(default)]
    depends: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    size_bytes: usize,
    /// Native module WASM path in registry (loaded via bridge, not as a tool).
    /// When present, pip install downloads this WASM and generates a bridge shim.
    #[serde(default)]
    native_wasm: Option<String>,
    /// The import name for the native module (e.g. "_numpy_native").
    /// If omitted, defaults to "_{name}_native".
    #[serde(default)]
    native_module_name: Option<String>,
}

/// Default registry URL. Override with CODEPOD_REGISTRY env var.
const DEFAULT_REGISTRY_URL: &str = "https://codepod-sandbox.github.io/packages";

/// Fetch the registry index, using a cached copy if available.
fn fetch_registry_index(
    state: &ShellState,
    host: &dyn HostInterface,
) -> Result<RegistryIndex, String> {
    let cache_path = "/etc/codepod/registry-index.json";
    if let Ok(cached) = host.read_file_str(cache_path) {
        if let Ok(index) = serde_json::from_str::<RegistryIndex>(&cached) {
            return Ok(index);
        }
    }

    let base_url = state
        .env
        .get("CODEPOD_REGISTRY")
        .cloned()
        .unwrap_or_else(|| DEFAULT_REGISTRY_URL.to_string());
    let url = format!("{base_url}/index.json");

    let result = host.fetch(&url, "GET", &[], None);
    if let Some(ref err) = result.error {
        return Err(format!("failed to fetch registry: {err}"));
    }
    if !result.ok {
        return Err(format!("registry returned status {}", result.status));
    }

    let index: RegistryIndex = serde_json::from_str(&result.body)
        .map_err(|e| format!("invalid registry index: {e}"))?;

    let _ = host.mkdir("/etc/codepod");
    let _ = host.write_file(cache_path, result.body.as_bytes(), WriteMode::Truncate);

    Ok(index)
}

/// Recursively resolve dependencies from the registry index.
fn resolve_registry_deps(
    index: &RegistryIndex,
    name: &str,
    installed: &[PipInstalledEntry],
    visited: &mut std::collections::HashSet<String>,
    result: &mut Vec<String>,
) {
    let name_lower = name.to_lowercase();
    if visited.contains(&name_lower) {
        return;
    }
    if installed
        .iter()
        .any(|i| i.name.to_lowercase() == name_lower)
    {
        return;
    }
    if BUILTIN_PACKAGES
        .iter()
        .any(|(n, _)| n.to_lowercase() == name_lower)
    {
        return;
    }

    visited.insert(name_lower);

    if let Some(pkg) = index.packages.get(name) {
        for dep in &pkg.depends {
            resolve_registry_deps(index, dep, installed, visited, result);
        }
    }

    result.push(name.to_string());
}

fn cmd_pip(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    if args.is_empty() {
        shell_eprint!(
            "{}",
            "pip: usage: pip <install|uninstall|list|show> [args]\n"
        );
        return RunResult::exit(1);
    }

    let subcmd = args[0].as_str();
    let sub_args = &args[1..];

    match subcmd {
        "install" => pip_install(state, host, sub_args),
        "uninstall" => pip_uninstall(state, host, sub_args),
        "list" => pip_list(host),
        "show" => pip_show(state, host, sub_args),
        other => {
            shell_eprint!("pip: unknown command '{other}'\n");
            RunResult::exit(1)
        }
    }
}

fn read_pip_registry(host: &dyn HostInterface) -> Vec<PipRegistryEntry> {
    host.read_file_str("/etc/codepod/pip-registry.json")
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn read_pip_installed(host: &dyn HostInterface) -> Vec<PipInstalledEntry> {
    host.read_file_str("/etc/codepod/pip-installed.json")
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn write_pip_installed(host: &dyn HostInterface, installed: &[PipInstalledEntry]) {
    if let Ok(json) = serde_json::to_string(installed) {
        let _ = host.write_file(
            "/etc/codepod/pip-installed.json",
            json.as_bytes(),
            WriteMode::Truncate,
        );
    }
}

fn read_extension_meta(host: &dyn HostInterface) -> Vec<ExtensionMeta> {
    host.read_file_str("/etc/codepod/extensions.json")
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
    // Filter out flags
    let mut no_cache = false;
    let names: Vec<&str> = args
        .iter()
        .map(|s| s.as_str())
        .filter(|a| {
            if *a == "--no-cache" {
                no_cache = true;
                return false;
            }
            !a.starts_with('-')
        })
        .collect();

    if names.is_empty() {
        shell_eprint!("{}", "pip install: no package specified\n");
        return RunResult::exit(1);
    }

    // Check pip policy
    let pip_policy = read_pip_policy(host);
    if let Some(ref policy) = pip_policy {
        if !policy.enabled {
            shell_eprint!("{}", "pip install: package installation is disabled by policy\n");
            return RunResult::exit(1);
        }
    }
    // If no policy file exists, allow install (backwards compat)

    let installed = read_pip_installed(host);

    // Enforce max packages
    if let Some(ref policy) = pip_policy {
        if let Some(max) = policy.max_packages {
            if installed.len() >= max {
                shell_eprint!("pip install: maximum of {max} packages reached\n");
                return RunResult::exit(1);
            }
        }
    }

    // Check builtins and already-installed first
    let mut to_resolve: Vec<&str> = Vec::new();
    for name in &names {
        let name_lower = name.to_lowercase();
        if BUILTIN_PACKAGES
            .iter()
            .any(|(n, _)| n.to_lowercase() == name_lower)
        {
            shell_print!("Requirement already satisfied: {name}\n");
            continue;
        }
        if installed
            .iter()
            .any(|i| i.name.to_lowercase() == name_lower)
        {
            shell_print!("Requirement already satisfied: {name}\n");
            continue;
        }
        // Check allow/block lists
        if let Some(ref policy) = pip_policy {
            if let Some(ref allowed) = policy.allowed_packages {
                if !allowed.iter().any(|a| a.to_lowercase() == name_lower) {
                    shell_eprint!("pip install: {name} is not in the allowed packages list\n");
                    return RunResult::exit(1);
                }
            }
            if let Some(ref blocked) = policy.blocked_packages {
                if blocked.iter().any(|b| b.to_lowercase() == name_lower) {
                    shell_eprint!("pip install: {name} is blocked by policy\n");
                    return RunResult::exit(1);
                }
            }
        }
        to_resolve.push(name);
    }

    if to_resolve.is_empty() {
        return RunResult::empty();
    }

    if no_cache {
        let _ = host.remove("/etc/codepod/registry-index.json", false);
    }

    // Try local registry (extension-provided packages)
    let local_registry = read_pip_registry(host);

    // Fetch remote registry index
    let remote_index = match fetch_registry_index(state, host) {
        Ok(idx) => idx,
        Err(e) => {
            shell_eprint!("Warning: {e}\n");
            RegistryIndex {
                version: 1,
                packages: std::collections::HashMap::new(),
            }
        }
    };

    // Resolve dependencies
    let mut install_order: Vec<String> = Vec::new();
    let mut visited = std::collections::HashSet::new();
    for name in &to_resolve {
        resolve_registry_deps(&remote_index, name, &installed, &mut visited, &mut install_order);
    }

    if install_order.is_empty() {
        shell_print!("{}", "Requirement already satisfied\n");
        return RunResult::empty();
    }

    let base_url = state
        .env
        .get("CODEPOD_REGISTRY")
        .cloned()
        .unwrap_or_else(|| DEFAULT_REGISTRY_URL.to_string());

    let mut new_installed = read_pip_installed(host);
    let mut installed_names: Vec<String> = Vec::new();

    for pkg_name in &install_order {
        // Try local registry first (extension packages with inline files)
        if let Some(local_pkg) = local_registry.iter().find(|p| p.name == *pkg_name) {
            let _ = host.mkdir("/usr/lib/python");
            for (path, content) in &local_pkg.files {
                let full_path = format!("/usr/lib/python/{path}");
                if let Some((parent, _)) = full_path.rsplit_once('/') {
                    let _ = host.mkdir(parent);
                }
                let _ = host.write_file(&full_path, content.as_bytes(), WriteMode::Truncate);
            }
            new_installed.push(PipInstalledEntry {
                name: local_pkg.name.clone(),
                version: local_pkg.version.clone(),
            });
            installed_names.push(format!("{}-{}", local_pkg.name, local_pkg.version));
            continue;
        }

        // Try remote registry
        if let Some(pkg) = remote_index.packages.get(pkg_name) {
            shell_print!("Downloading {pkg_name}-{}...\n", pkg.version);

            // Download and install WASM binary if present
            if let Some(ref wasm_path) = pkg.wasm {
                let wasm_url = format!("{base_url}/{wasm_path}");
                let result = host.fetch(&wasm_url, "GET", &[], None);
                if result.error.is_some() || !result.ok {
                    let err = result
                        .error
                        .unwrap_or_else(|| format!("status {}", result.status));
                    shell_eprint!("pip install: failed to download {pkg_name}.wasm: {err}\n");
                    return RunResult::exit(1);
                }
                let wasm_bytes = result.body_bytes();
                let _ = host.mkdir("/usr/share/pkg/bin");
                let dest = format!("/usr/share/pkg/bin/{pkg_name}.wasm");
                // Write binary as raw bytes via base64 workaround — the body_bytes()
                // decoded from base64 are the real WASM bytes. We need write_file to
                if let Err(e) = host.write_file(&dest, &wasm_bytes, WriteMode::Truncate) {
                    shell_eprint!("pip install: failed to write WASM: {e}\n");
                    return RunResult::exit(1);
                }
                if let Err(e) = host.register_tool(pkg_name, &dest) {
                    shell_eprint!("pip install: failed to register tool: {e}\n");
                    return RunResult::exit(1);
                }
            }

            // Download and extract wheel
            let wheel_url = format!("{base_url}/{}", pkg.wheel);
            let result = host.fetch(&wheel_url, "GET", &[], None);
            if result.error.is_some() || !result.ok {
                let err = result
                    .error
                    .unwrap_or_else(|| format!("status {}", result.status));
                shell_eprint!("pip install: failed to download wheel: {err}\n");
                return RunResult::exit(1);
            }

            let wheel_bytes = result.body_bytes();
            match crate::wheel::extract_wheel(&wheel_bytes) {
                Ok(files) => {
                    let _ = host.mkdir("/usr/lib/python");
                    for file in &files {
                        let full_path = format!("/usr/lib/python/{}", file.path);
                        if let Some((parent, _)) = full_path.rsplit_once('/') {
                            let _ = host.mkdir(parent);
                        }
                        let _ = host.write_file(&full_path, file.content.as_bytes(), WriteMode::Truncate);
                    }
                    shell_print!(
                        "  Installed {} files for {pkg_name}\n",
                        files.len()
                    );
                }
                Err(e) => {
                    shell_eprint!("pip install: failed to extract wheel: {e}\n");
                    return RunResult::exit(1);
                }
            }

            // Download and load native module WASM if present
            if let Some(ref native_path) = pkg.native_wasm {
                let native_url = format!("{base_url}/{native_path}");
                shell_print!("  Downloading native module...\n");
                let result = host.fetch(&native_url, "GET", &[], None);
                if result.error.is_some() || !result.ok {
                    let err = result.error.unwrap_or_else(|| format!("status {}", result.status));
                    shell_eprint!("pip install: failed to download native WASM: {err}\n");
                    return RunResult::exit(1);
                }
                let native_bytes = result.body_bytes();
                let _ = host.mkdir("/usr/share/pkg/native");
                let dest = format!("/usr/share/pkg/native/{pkg_name}.wasm");
                if let Err(e) = host.write_file(&dest, &native_bytes, WriteMode::Truncate) {
                    shell_eprint!("pip install: failed to write native WASM: {e}\n");
                    return RunResult::exit(1);
                }
                // Signal host to load as native module
                let reg_name = format!("__native__{pkg_name}");
                let _ = host.register_tool(&reg_name, &dest);

                // Generate bridge shim: _<name>_native.py
                // Uses module-level __getattr__ (PEP 562) to route ALL calls
                let mod_name = pkg.native_module_name.as_deref()
                    .unwrap_or_else(|| Box::leak(format!("_{pkg_name}_native").into_boxed_str()));
                let shim = format!(
                    "import _codepod, json\n\
                     def __getattr__(name):\n\
                     \x20   def _bridge(*args, **kwargs):\n\
                     \x20       payload = list(args)\n\
                     \x20       if kwargs: payload.append(kwargs)\n\
                     \x20       r = json.loads(_codepod.native_call(\"{pkg_name}\", name, json.dumps(payload)))\n\
                     \x20       if isinstance(r, dict) and 'ok' in r:\n\
                     \x20           if not r['ok']: raise RuntimeError(r.get('error', name + ' failed'))\n\
                     \x20           return r.get('result', r)\n\
                     \x20       return r\n\
                     \x20   return _bridge\n"
                );
                let _ = host.mkdir("/usr/lib/python");
                let shim_path = format!("/usr/lib/python/{mod_name}.py");
                let _ = host.write_file(&shim_path, shim.as_bytes(), WriteMode::Truncate);
                shell_print!("  Generated bridge shim {mod_name}.py\n");
            }

            new_installed.push(PipInstalledEntry {
                name: pkg_name.clone(),
                version: pkg.version.clone(),
            });
            installed_names.push(format!("{pkg_name}-{}", pkg.version));
        } else {
            // Check extensions as last resort
            let extensions = read_extension_meta(host);
            if extensions
                .iter()
                .any(|e| e.python_package.is_some() && e.name == *pkg_name)
            {
                continue;
            }
            shell_eprint!(
                "ERROR: Could not find a version that satisfies the requirement {pkg_name}\n"
            );
            return RunResult::exit(1);
        }
    }

    write_pip_installed(host, &new_installed);

    if !installed_names.is_empty() {
        shell_print!(
            "Successfully installed {}\n",
            installed_names.join(" ")
        );
    }
    RunResult::empty()
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
        shell_eprint!("{}", "pip uninstall: no package specified\n");
        return RunResult::exit(1);
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
            shell_eprint!("pip uninstall: '{name}' is not installed\n");
            return RunResult::exit(1);
        }
    }

    write_pip_installed(host, &installed);
    shell_print!("{}", out);
    RunResult::empty()
}

fn pip_list(host: &dyn HostInterface) -> RunResult {
    let installed = read_pip_installed(host);
    let extensions = read_extension_meta(host);

    let mut entries: Vec<(String, String)> = Vec::new();

    // Built-in packages (compiled into the binary or pre-installed as shims)
    for &(name, version) in BUILTIN_PACKAGES {
        entries.push((name.to_string(), version.to_string()));
    }

    // Pip-installed packages
    for pkg in &installed {
        if !entries.iter().any(|(n, _)| n == &pkg.name) {
            entries.push((pkg.name.clone(), pkg.version.clone()));
        }
    }
    // Extension-provided packages
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

    shell_print!("{}", out);
    RunResult::empty()
}

fn pip_show(state: &ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    if args.is_empty() {
        shell_eprint!("{}", "pip show: no package specified\n");
        return RunResult::exit(1);
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
        shell_print!(
            "Name: {}\nVersion: {}\nSummary: {}\nStatus: {}\n",
            pkg.name,
            pkg.version,
            pkg.summary,
            status
        );
        return RunResult::empty();
    }

    // Check extensions — also try listing files from VFS
    if let Some(ext) = extensions.iter().find(|e| e.name == *name) {
        if let Some(ref py) = ext.python_package {
            let mut out = format!(
                "Name: {}\nVersion: {}\nSummary: {}\nStatus: available\n",
                ext.name,
                py.version,
                py.summary.as_deref().unwrap_or("")
            );
            // List files in the package directory
            let pkg_dir = format!("/usr/lib/python/{}", ext.name);
            if let Ok(files) = host.readdir(&pkg_dir) {
                if !files.is_empty() {
                    out.push_str("Files:\n");
                    for f in &files {
                        out.push_str(&format!("  {f}\n"));
                    }
                }
            }
            shell_print!("{}", out);
            return RunResult::empty();
        }
    }

    // Check built-in packages
    let name_lower = name.to_lowercase();
    if let Some((bname, bver)) = BUILTIN_PACKAGES.iter().find(|(n, _)| n.to_lowercase() == name_lower) {
        shell_print!(
            "Name: {}\nVersion: {}\nSummary: Built-in sandbox package\nLocation: (compiled-in)\n",
            bname,
            bver
        );
        return RunResult::empty();
    }

    // Check remote registry
    if let Ok(index) = fetch_registry_index(state, host) {
        let name_lower = name.to_lowercase();
        if let Some((rname, pkg)) = index
            .packages
            .iter()
            .find(|(k, _)| k.to_lowercase() == name_lower)
        {
            let status = if installed.iter().any(|i| i.name.to_lowercase() == name_lower) {
                "installed"
            } else {
                "available (not installed)"
            };
            shell_print!(
                "Name: {}\nVersion: {}\nSummary: {}\nStatus: {}\n",
                rname,
                pkg.version,
                pkg.summary,
                status
            );
            return RunResult::empty();
        }
    }

    shell_eprint!("pip show: package '{name}' not found\n");
    RunResult::exit(1)
}



