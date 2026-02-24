//! du - estimate file space usage

use std::env;
use std::fs;
use std::path::Path;
use std::process;

struct Options {
    summary: bool,
    human: bool,
    all: bool,
    max_depth: Option<usize>,
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1}G", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1}M", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1}K", bytes as f64 / 1024.0)
    } else {
        format!("{}B", bytes)
    }
}

fn format_size(bytes: u64, human: bool) -> String {
    if human {
        human_size(bytes)
    } else {
        bytes.to_string()
    }
}

fn du_walk(path: &Path, opts: &Options, depth: usize) -> u64 {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("du: cannot access '{}': {}", path.display(), e);
            return 0;
        }
    };

    if meta.is_file() {
        let size = meta.len();
        if opts.all || depth == 0 {
            println!("{}\t{}", format_size(size, opts.human), path.display());
        }
        return size;
    }

    if !meta.is_dir() {
        return 0;
    }

    let mut total: u64 = 0;

    let mut entries: Vec<_> = match fs::read_dir(path) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(e) => {
            eprintln!("du: cannot read directory '{}': {}", path.display(), e);
            return 0;
        }
    };
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let child = entry.path();
        let child_meta = match fs::metadata(&child) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if child_meta.is_file() {
            let size = child_meta.len();
            total += size;
            if opts.all && !opts.summary {
                if let Some(max) = opts.max_depth {
                    if depth < max {
                        println!("{}\t{}", format_size(size, opts.human), child.display());
                    }
                } else {
                    println!("{}\t{}", format_size(size, opts.human), child.display());
                }
            }
        } else if child_meta.is_dir() {
            let recurse = if let Some(max) = opts.max_depth {
                depth < max
            } else {
                true
            };
            if recurse {
                total += du_walk(&child, opts, depth + 1);
            } else {
                // Still count size even if we don't recurse into it for display
                total += dir_total_size(&child);
            }
        }
    }

    // Print directory line unless -s (summary prints only at depth 0)
    if !opts.summary || depth == 0 {
        if let Some(max) = opts.max_depth {
            if depth <= max {
                println!("{}\t{}", format_size(total, opts.human), path.display());
            }
        } else {
            println!("{}\t{}", format_size(total, opts.human), path.display());
        }
    }

    total
}

/// Count total bytes in a directory tree without printing.
fn dir_total_size(path: &Path) -> u64 {
    let mut total: u64 = 0;
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.filter_map(|e| e.ok()) {
            let child = entry.path();
            if let Ok(m) = fs::metadata(&child) {
                if m.is_file() {
                    total += m.len();
                } else if m.is_dir() {
                    total += dir_total_size(&child);
                }
            }
        }
    }
    total
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut opts = Options {
        summary: false,
        human: false,
        all: false,
        max_depth: None,
    };
    let mut paths: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-d" || arg == "--max-depth" {
            i += 1;
            if i >= args.len() {
                eprintln!("du: missing argument to '{}'", arg);
                process::exit(1);
            }
            opts.max_depth = match args[i].parse() {
                Ok(n) => Some(n),
                Err(_) => {
                    eprintln!("du: invalid depth '{}'", args[i]);
                    process::exit(1);
                }
            };
        } else if arg.starts_with('-') && arg != "-" {
            // Parse combined flags like -sh, -ash, etc.
            for ch in arg[1..].chars() {
                match ch {
                    's' => opts.summary = true,
                    'h' => opts.human = true,
                    'a' => opts.all = true,
                    _ => {
                        eprintln!("du: invalid option -- '{}'", ch);
                        process::exit(1);
                    }
                }
            }
        } else {
            paths.push(arg.clone());
        }
        i += 1;
    }

    if paths.is_empty() {
        paths.push(".".to_string());
    }

    for path in &paths {
        du_walk(Path::new(path), &opts, 0);
    }
}
