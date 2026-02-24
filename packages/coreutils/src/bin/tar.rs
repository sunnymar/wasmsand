//! tar - archive utility
//!
//! Supports create (-c), extract (-x), and list (-t) modes.
//! Supports gzip compression (-z) via flate2.

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process;

#[derive(PartialEq)]
enum Mode {
    Create,
    Extract,
    List,
}

struct Options {
    mode: Option<Mode>,
    file: Option<String>,
    gzip: bool,
    verbose: bool,
    directory: Option<String>,
    paths: Vec<String>,
}

fn parse_args() -> Options {
    let args: Vec<String> = env::args().collect();
    let mut opts = Options {
        mode: None,
        file: None,
        gzip: false,
        verbose: false,
        directory: None,
        paths: Vec::new(),
    };

    let mut i = 1;
    // Handle tar-style first arg without dash (e.g. "tar czf archive.tar.gz dir")
    if i < args.len() && !args[i].starts_with('-') && looks_like_flags(&args[i]) {
        let flags = args[i].clone();
        i += 1;
        for ch in flags.chars() {
            match ch {
                'c' => opts.mode = Some(Mode::Create),
                'x' => opts.mode = Some(Mode::Extract),
                't' => opts.mode = Some(Mode::List),
                'z' => opts.gzip = true,
                'v' => opts.verbose = true,
                'f' => {
                    if i < args.len() {
                        opts.file = Some(args[i].clone());
                        i += 1;
                    }
                }
                'C' => {
                    if i < args.len() {
                        opts.directory = Some(args[i].clone());
                        i += 1;
                    }
                }
                _ => {
                    eprintln!("tar: unknown option '{}'", ch);
                    process::exit(1);
                }
            }
        }
    }

    while i < args.len() {
        let arg = &args[i];
        if arg == "-c" || arg == "--create" {
            opts.mode = Some(Mode::Create);
        } else if arg == "-x" || arg == "--extract" {
            opts.mode = Some(Mode::Extract);
        } else if arg == "-t" || arg == "--list" {
            opts.mode = Some(Mode::List);
        } else if arg == "-z" || arg == "--gzip" {
            opts.gzip = true;
        } else if arg == "-v" || arg == "--verbose" {
            opts.verbose = true;
        } else if arg == "-f" {
            i += 1;
            if i >= args.len() {
                eprintln!("tar: option '-f' requires an argument");
                process::exit(1);
            }
            opts.file = Some(args[i].clone());
        } else if arg == "-C" || arg == "--directory" {
            i += 1;
            if i >= args.len() {
                eprintln!("tar: option '-C' requires an argument");
                process::exit(1);
            }
            opts.directory = Some(args[i].clone());
        } else if arg.starts_with('-') && arg.len() > 1 {
            // Combined flags like -czf, -xzf
            let chars: Vec<char> = arg[1..].chars().collect();
            let mut j = 0;
            while j < chars.len() {
                match chars[j] {
                    'c' => opts.mode = Some(Mode::Create),
                    'x' => opts.mode = Some(Mode::Extract),
                    't' => opts.mode = Some(Mode::List),
                    'z' => opts.gzip = true,
                    'v' => opts.verbose = true,
                    'f' => {
                        // Rest of this arg or next arg is the filename
                        let rest: String = chars[j + 1..].iter().collect();
                        if !rest.is_empty() {
                            opts.file = Some(rest);
                        } else {
                            i += 1;
                            if i >= args.len() {
                                eprintln!("tar: option '-f' requires an argument");
                                process::exit(1);
                            }
                            opts.file = Some(args[i].clone());
                        }
                        j = chars.len(); // consumed rest
                        continue;
                    }
                    'C' => {
                        i += 1;
                        if i >= args.len() {
                            eprintln!("tar: option '-C' requires an argument");
                            process::exit(1);
                        }
                        opts.directory = Some(args[i].clone());
                    }
                    _ => {
                        eprintln!("tar: unknown option '{}'", chars[j]);
                        process::exit(1);
                    }
                }
                j += 1;
            }
        } else {
            opts.paths.push(arg.clone());
        }
        i += 1;
    }

    if opts.mode.is_none() {
        eprintln!("tar: must specify one of -c, -x, -t");
        process::exit(1);
    }

    opts
}

/// Check if a string looks like tar flags (no path separators, alphanumeric).
fn looks_like_flags(s: &str) -> bool {
    !s.contains('/') && !s.contains('.') && s.chars().all(|c| c.is_ascii_alphanumeric())
}

fn collect_paths(base: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    collect_recursive(base, &mut result);
    result.sort();
    result
}

fn collect_recursive(path: &Path, result: &mut Vec<PathBuf>) {
    result.push(path.to_path_buf());
    if path.is_dir() {
        let mut entries: Vec<_> = match fs::read_dir(path) {
            Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
            Err(_) => return,
        };
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            collect_recursive(&entry.path(), result);
        }
    }
}

fn create_archive(opts: &Options) {
    let mut builder = tar::Builder::new(Vec::new());

    for src_path in &opts.paths {
        let base = Path::new(src_path);
        let paths = collect_paths(base);
        for path in &paths {
            let raw_name = path.to_string_lossy();
            // Strip leading '/' — tar archives use relative paths
            let name = raw_name.trim_start_matches('/');
            if opts.verbose {
                eprintln!("{}", name);
            }
            let meta = match fs::metadata(path) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("tar: {}: {}", path.display(), e);
                    continue;
                }
            };
            let mut header = tar::Header::new_gnu();
            if meta.is_dir() {
                header.set_entry_type(tar::EntryType::Directory);
                header.set_size(0);
                header.set_mode(0o755);
                let dir_name = if name.ends_with('/') {
                    name.to_string()
                } else {
                    format!("{}/", name)
                };
                if let Err(e) = builder.append_data(&mut header, dir_name, io::empty()) {
                    eprintln!("tar: {}: {}", path.display(), e);
                }
            } else {
                let data = match fs::read(path) {
                    Ok(d) => d,
                    Err(e) => {
                        eprintln!("tar: {}: {}", path.display(), e);
                        continue;
                    }
                };
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                if let Err(e) = builder.append_data(&mut header, name, &data[..]) {
                    eprintln!("tar: {}: {}", path.display(), e);
                }
            }
        }
    }

    let archive_data = match builder.into_inner() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("tar: {}", e);
            process::exit(1);
        }
    };

    let output_data = if opts.gzip {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        if let Err(e) = encoder.write_all(&archive_data) {
            eprintln!("tar: gzip compression failed: {}", e);
            process::exit(1);
        }
        match encoder.finish() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("tar: gzip compression failed: {}", e);
                process::exit(1);
            }
        }
    } else {
        archive_data
    };

    if let Some(ref file) = opts.file {
        if let Err(e) = fs::write(file, &output_data) {
            eprintln!("tar: {}: {}", file, e);
            process::exit(1);
        }
    } else {
        let stdout = io::stdout();
        let mut out = stdout.lock();
        if let Err(e) = out.write_all(&output_data) {
            eprintln!("tar: {}", e);
            process::exit(1);
        }
    }
}

fn read_archive_data(opts: &Options) -> Vec<u8> {
    if let Some(ref file) = opts.file {
        match fs::read(file) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("tar: {}: {}", file, e);
                process::exit(1);
            }
        }
    } else {
        let mut data = Vec::new();
        if let Err(e) = io::stdin().read_to_end(&mut data) {
            eprintln!("tar: stdin: {}", e);
            process::exit(1);
        }
        data
    }
}

fn get_archive_reader(data: &[u8], gzip: bool) -> Box<dyn Read + '_> {
    if gzip {
        Box::new(GzDecoder::new(data))
    } else {
        Box::new(data)
    }
}

fn extract_archive(opts: &Options) {
    let data = read_archive_data(opts);
    let reader = get_archive_reader(&data, opts.gzip);
    let mut archive = tar::Archive::new(reader);

    let dest = opts
        .directory
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    let entries = match archive.entries() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("tar: {}", e);
            process::exit(1);
        }
    };

    for entry in entries {
        let mut entry = match entry {
            Ok(e) => e,
            Err(e) => {
                eprintln!("tar: {}", e);
                continue;
            }
        };

        let path = match entry.path() {
            Ok(p) => p.to_path_buf(),
            Err(e) => {
                eprintln!("tar: {}", e);
                continue;
            }
        };

        if opts.verbose {
            eprintln!("{}", path.display());
        }

        let full_path = dest.join(&path);

        match entry.header().entry_type() {
            tar::EntryType::Directory => {
                if let Err(e) = fs::create_dir_all(&full_path) {
                    eprintln!("tar: {}: {}", full_path.display(), e);
                }
            }
            tar::EntryType::Regular | tar::EntryType::GNUSparse => {
                // Ensure parent directory exists
                if let Some(parent) = full_path.parent() {
                    if let Err(e) = fs::create_dir_all(parent) {
                        eprintln!("tar: {}: {}", parent.display(), e);
                        continue;
                    }
                }
                let mut content = Vec::new();
                if let Err(e) = entry.read_to_end(&mut content) {
                    eprintln!("tar: {}: {}", path.display(), e);
                    continue;
                }
                if let Err(e) = fs::write(&full_path, &content) {
                    eprintln!("tar: {}: {}", full_path.display(), e);
                }
            }
            _ => {}
        }
    }
}

fn list_archive(opts: &Options) {
    let data = read_archive_data(opts);
    let reader = get_archive_reader(&data, opts.gzip);
    let mut archive = tar::Archive::new(reader);

    let entries = match archive.entries() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("tar: {}", e);
            process::exit(1);
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                eprintln!("tar: {}", e);
                continue;
            }
        };

        let path = match entry.path() {
            Ok(p) => p.to_path_buf(),
            Err(e) => {
                eprintln!("tar: {}", e);
                continue;
            }
        };

        if opts.verbose {
            let size = entry.header().size().unwrap_or(0);
            let mode = entry.header().mode().unwrap_or(0);
            eprintln!("{:o} {:>8} {}", mode, size, path.display());
        }
        println!("{}", path.display());
    }
}

fn main() {
    let opts = parse_args();

    match opts.mode.as_ref().unwrap() {
        Mode::Create => create_archive(&opts),
        Mode::Extract => extract_archive(&opts),
        Mode::List => list_archive(&opts),
    }
}
