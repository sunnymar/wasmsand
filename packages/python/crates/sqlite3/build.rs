use std::env;
use std::path::PathBuf;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // packages/python/crates/sqlite3 -> packages/sqlite
    let sqlite_dir = manifest
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("sqlite");

    let sqlite_src = sqlite_dir.join("src");

    let mut build = cc::Build::new();

    // If targeting wasm32, locate wasi-sdk and set the compiler explicitly.
    if target.contains("wasm32") {
        let wasi_sdk = find_wasi_sdk();
        let compiler = wasi_sdk.join("bin").join("clang");
        let sysroot = wasi_sdk.join("share").join("wasi-sysroot");

        build.compiler(&compiler);
        build.flag(format!("--sysroot={}", sysroot.display()));
        build.flag("--target=wasm32-wasi");

        // WASI emulation defines
        build.define("_WASI_EMULATED_SIGNAL", None);
        build.define("_WASI_EMULATED_PROCESS_CLOCKS", None);
        build.define("_WASI_EMULATED_GETPID", None);

        // Link wasi emulation libs
        println!(
            "cargo:rustc-link-search=native={}/lib/wasm32-wasi",
            sysroot.display()
        );
        println!("cargo:rustc-link-lib=static=wasi-emulated-signal");
        println!("cargo:rustc-link-lib=static=wasi-emulated-process-clocks");
        println!("cargo:rustc-link-lib=static=wasi-emulated-getpid");
    }

    // SQLite compile flags (matching packages/sqlite/Makefile)
    build.define("SQLITE_THREADSAFE", "0");
    build.define("SQLITE_OMIT_WAL", None);
    build.define("SQLITE_OMIT_LOAD_EXTENSION", None);
    build.define("SQLITE_OMIT_DEPRECATED", None);
    build.define("SQLITE_DEFAULT_LOCKING_MODE", "1");
    build.define("SQLITE_DQS", "0");
    build.define("SQLITE_NOHAVE_SYSTEM", None);

    build
        .file(sqlite_src.join("sqlite3.c"))
        .include(&sqlite_src)
        .opt_level(2)
        .warnings(false);

    build.compile("sqlite3");

    println!(
        "cargo:rerun-if-changed={}",
        sqlite_src.join("sqlite3.c").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        sqlite_src.join("sqlite3.h").display()
    );
}

/// Locate the wasi-sdk installation directory.
fn find_wasi_sdk() -> PathBuf {
    // 1. Explicit env var
    if let Ok(p) = env::var("WASI_SDK_PATH") {
        let path = PathBuf::from(p);
        if path.exists() {
            return path;
        }
    }

    // 2. Glob under $HOME/.local/share/wasi-sdk-*
    if let Ok(home) = env::var("HOME") {
        let share = PathBuf::from(&home).join(".local").join("share");
        if let Ok(entries) = std::fs::read_dir(&share) {
            let mut candidates: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("wasi-sdk"))
                        .unwrap_or(false)
                })
                .collect();
            candidates.sort();
            if let Some(last) = candidates.last() {
                return last.clone();
            }
        }
    }

    // 3. /opt/wasi-sdk
    let opt = PathBuf::from("/opt/wasi-sdk");
    if opt.exists() {
        return opt;
    }

    panic!("Could not find wasi-sdk. Set WASI_SDK_PATH or install to ~/.local/share/wasi-sdk-*");
}
