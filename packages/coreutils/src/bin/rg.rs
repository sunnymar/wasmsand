//! rg - ripgrep-like recursive code search

use std::env;
use std::process;

fn print_usage() {
    eprintln!("Usage: rg [OPTIONS] PATTERN [PATH ...]");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  -i, --ignore-case       Case insensitive search");
    eprintln!("  -s, --case-sensitive    Case sensitive search");
    eprintln!("  -S, --smart-case        Smart case (default)");
    eprintln!("  -F, --fixed-strings     Treat pattern as literal string");
    eprintln!("  -w, --word-regexp       Match whole words only");
    eprintln!("  -v, --invert-match      Invert match");
    eprintln!("  -n, --line-number       Show line numbers (default)");
    eprintln!("  -N, --no-line-number    Suppress line numbers");
    eprintln!("  -l, --files-with-matches  Print only filenames");
    eprintln!("  -c, --count             Print match count per file");
    eprintln!("  -t TYPE, --type TYPE    Filter by file type");
    eprintln!("  -T TYPE, --type-not TYPE  Exclude file type");
    eprintln!("  -g GLOB, --glob GLOB    Filter by glob pattern");
    eprintln!("  -A N, --after-context N   Show N lines after match");
    eprintln!("  -B N, --before-context N  Show N lines before match");
    eprintln!("  -C N, --context N       Show N lines before and after");
    eprintln!("  --hidden                Include hidden files");
    eprintln!("  --no-ignore             Don't respect gitignore");
    eprintln!("  --max-count N           Stop after N matches per file");
    eprintln!("  --max-depth N           Limit directory recursion depth");
    eprintln!("  --type-list             List known file types");
    eprintln!("  --help                  Show this help");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() || args.iter().any(|a| a == "--help") {
        print_usage();
        process::exit(2);
    }

    eprintln!("rg: not yet implemented");
    process::exit(1);
}
